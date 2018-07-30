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

// can't use import syntax on these
const babelTypes = require('babel-types');
const babylon = require('babylon');
const walk = require('babylon-walk');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdirp = promisify(mkdirpCb);

let currId = 0;

// replace object properties
function morph(object, newProperties) {
  for (let key in object) {
    delete object[key];
  }

  for (let key in newProperties) {
    object[key] = newProperties[key];
  }
}

// from babel-types. remove when we upgrade to babel 7.
// https://github.com/babel/babel/blob/0189b387026c35472dccf45d14d58312d249f799/packages/babel-types/src/index.js#L347
function matchesPattern(member, match, allowPartial) {
  // not a member expression
  if (!babelTypes.isMemberExpression(member)) return false;

  const parts = Array.isArray(match) ? match : match.split('.');
  const nodes = [];

  let node;
  for (node = member; babelTypes.isMemberExpression(node); node = node.object) {
    nodes.push(node.property);
  }
  nodes.push(node);

  if (nodes.length < parts.length) return false;
  if (!allowPartial && nodes.length > parts.length) return false;

  for (let i = 0, j = nodes.length - 1; i < parts.length; i++, j--) {
    const node = nodes[j];
    let value;
    if (babelTypes.isIdentifier(node)) {
      value = node.name;
    } else if (babelTypes.isStringLiteral(node)) {
      value = node.value;
    } else {
      return false;
    }

    if (parts[i] !== value) return false;
  }

  return true;
};

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
      let res = evaluateExpression(node.test);
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

    return this.processQueue.onIdle();
  }

  addToProcessQueue(asset) {
    this.processQueue.add(() => this.processAsset(asset));
  }

  createAsset(filePath) {
    let id = currId++;
    let asset = { id, filePath };
    this.assetGraph.set(filePath, asset);
    this.addToProcessQueue(asset);
    return asset;
  }

  async processAsset(asset) {
    let { id, filePath } = asset;
    let fileContents = await readFile(filePath, 'utf8');
    let originalAst = babylon.parse(fileContents, {
      sourceType: 'module',
      plugins: this.babelFile.parserOpts.plugins
    });

    // inline environment variables
    walk.simple(originalAst, {
      MemberExpression(node) {
        // Inline environment variables accessed on process.env
        if (matchesPattern(node.object, 'process.env')) {
          let key = babelTypes.toComputedKey(node);
          if (babelTypes.isStringLiteral(key)) {
            let val = babelTypes.valueToNode(process.env[key.value]);
            morph(node, val);
          }
        }
      }
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

      let dependencyAsset = this.assetGraph.get(dependencyPath) || this.createAsset(dependencyPath);
      dependencyMap.set(moduleRequest, dependencyAsset);
    });

    asset.code = code;
    asset.dependencyMap = dependencyMap;
  }

  async packageAssetsIntoBundles() {
    let modules = '';

    this.assetGraph.forEach((asset) => {
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
