import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import traverse from 'babel-traverse';
//import walk from 'babylon-walk';
import PQueue from 'p-queue';
import { transformFromAst, File as BabelFile } from 'babel-core';
import findUp from 'find-up';
import mkdirpCb from 'mkdirp';
import prettyFormat from 'pretty-format';
import resolveFrom from 'resolve-from';

// can't use import syntax on babylon
const babelTypes = require('babel-types');
const babylon = require('babylon');
const walk = require('babylon-walk');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdirp = promisify(mkdirpCb);

let currId = 0;

function evaluateExpression(node) {
  // Wrap the node in a standalone program so we can traverse it
  node = babelTypes.file(babelTypes.program([babelTypes.expressionStatement(node)]));

  // Find the first expression and evaluate it.
  let res = null;
  traverse(node, {
    Expression(path) {
      res = path.evaluate();
      path.stop();
    }
  });

  return res;
}

function hasBinding(node, name) {
  if (Array.isArray(node)) {
    return node.some(ancestor => hasBinding(ancestor, name));
  } else if (
    babelTypes.isProgram(node) ||
    babelTypes.isBlockStatement(node) ||
    babelTypes.isBlock(node)
  ) {
    return node.body.some(statement => hasBinding(statement, name));
  } else if (
    babelTypes.isFunctionDeclaration(node) ||
    babelTypes.isFunctionExpression(node) ||
    babelTypes.isArrowFunctionExpression(node)
  ) {
    return (
      (node.id !== null && node.id.name === name) ||
      node.params.some(
        param => babelTypes.isIdentifier(param) && param.name === name
      )
    );
  } else if (babelTypes.isVariableDeclaration(node)) {
    return node.declarations.some(declaration => declaration.id.name === name);
  }

  return false;
}

function isInFalsyBranch(ancestors) {
  // Check if any ancestors are if statements
  let falsyBranch = ancestors.some((node, index) => {
    if (babelTypes.isIfStatement(node)) {
      console.log('found an if statement');
      let res = evaluateExpression(node.test);
      console.log(res.confident);
      if (res && res.confident) {

        // If the test is truthy, exclude the dep if it is in the alternate branch.
        // If the test if falsy, exclude the dep if it is in the consequent branch.
        let child = ancestors[index + 1];
        return res.value ? child === node.alternate : child === node.consequent;
      }
    }
  });

  return falsyBranch;
}

export default class Bundler {
  constructor(entryFilePath) {
    this.entryFilePath = entryFilePath;
    this.processQueue = new PQueue();
    this.assetGraph = new Map();
    this.cwd = process.cwd();
  }
  
  async bundle() {
    await this.init();

    await this.processAssets();

    await this.packageAssetsIntoBundles();

    console.log(chalk.green('Done!'))
  }

  async init() {
    let babelConfigPath = await findUp('.babelrc');
    this.babelConfig = JSON.parse(await readFile(babelConfigPath));
    this.babelFile = new BabelFile(this.babelConfig);
  }

  processAssets() {
    let entryAsset = this.createAsset(this.entryFilePath);
    this.addToProcessQueue(entryAsset);

    return this.processQueue.onIdle();
  }

  addToProcessQueue(asset) {
    this.processQueue.add(() => this.processAsset(asset));
  }

  createAsset(filePath) {
    let id = currId++;
    let asset = { id, filePath };
    return asset;
  }

  async processAsset({ id, filePath }) {
    let fileContents = await readFile(filePath, 'utf8');
    let originalAst = babylon.parse(fileContents, {
      sourceType: 'module',
      plugins: this.babelFile.parserOpts.plugins
    });

    let { plugins, presets } = this.babelConfig;
    let { code, ast } = transformFromAst(originalAst, null, { plugins, presets });

    let dependencyRequests = [];
    walk.ancestor(ast, {
      ImportDeclaration: ({ node }) => {
        dependencyRequests.push(node.source.value);
      },
      CallExpression(node, ancestors) {
        let {callee, arguments: args} = node;
        let isRequire =
          babelTypes.isIdentifier(callee) &&
          callee.name === 'require' &&
          args.length === 1 &&
          babelTypes.isStringLiteral(args[0]) &&
          !hasBinding(ancestors, 'require') &&
          !isInFalsyBranch(ancestors);
    
        if (isRequire) {
          dependencyRequests.push(args[0].value);
        }
      },
    });

    let dependencyMap = new Map();
    dependencyRequests.forEach((moduleRequest) => {
      let srcDir = path.dirname(filePath);
      let dependencyPath = resolveFrom(srcDir, moduleRequest);
      if (!this.assetGraph.has(dependencyPath)) {
        let dependencyAsset = this.createAsset(dependencyPath);
        dependencyMap.set(moduleRequest, dependencyAsset);
        this.addToProcessQueue(dependencyAsset);
      }
    });

    this.assetGraph.set(filePath, {
      id,
      code,
      filePath,
      dependencyMap,
    });
  }

  async packageAssetsIntoBundles() {
    let modules = '';

    this.assetGraph.forEach((asset) => {
      console.log(asset.id);
      let mapping = {};
      asset.dependencyMap.forEach((depAsset, key) => mapping[key] = depAsset.id);
      modules += `${asset.id}: [
        function (require, module, exports) {
          ${asset.code}
        },
        ${JSON.stringify(mapping)},
      ],`;
    });

    // wrapper code taken from https://github.com/ronami/minipack/blob/master/src/minipack.js
    const result = `
      (function(modules) {
        console.log(modules)
        function require(id) {
          console.log(id)
          console.log(modules[id])
          const [fn, mapping] = modules[id];

          function localRequire(name) {
            return require(mapping[name]);
          }

          const module = { exports : {} };

          fn(localRequire, module, module.exports);

          return module.exports;
        }

        require(0);
      })({${modules}})
    `;

    await mkdirp('dist');
    await writeFile('dist/bundle.js', result, 'utf8');

    return result;
  }
}
