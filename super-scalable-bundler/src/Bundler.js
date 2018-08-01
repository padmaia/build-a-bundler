import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import traverse from 'babel-traverse';
import PQueue from 'p-queue';
import { transformFromAst, File as BabelFile } from 'babel-core';
import findUp from 'find-up';
import mkdirpCb from 'mkdirp';
import resolveFrom from 'resolve-from';
import level from 'level';

// can't use import syntax on these
const babylon = require('babylon');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdirp = promisify(mkdirpCb);
const appendFile = promisify(fs.appendFile);

let currId = 0;

export default class Bundler {
  constructor(entryFilePath) {
    this.entryFilePath = entryFilePath;
    this.processQueue = new PQueue({ concurrency: 25 });
    this.assetGraph = new Map();
  }
  
  async bundle() {
    await this.init();

    await this.processAssets();

    await this.packageAssetsIntoBundles();

    await this.cleanup();

    console.log(chalk.green('Done!'))
  }

  async init() {
    this.cwd = process.cwd();
    
    let babelConfigPath = await findUp('.babelrc');
    this.babelConfig = JSON.parse(await readFile(babelConfigPath));
    this.babelFile = new BabelFile(this.babelConfig);

    this.cache = level(path.join(this.cwd, '.bundler-cache'));
  }

  async cleanup() {
    await this.cache.close();
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
    let ast = babylon.parse(fileContents, {
      sourceType: 'module',
      plugins: this.babelFile.parserOpts.plugins
    });

    let dependencyRequests = [];
    traverse(ast, {
      ImportDeclaration: ({ node }) => {
        dependencyRequests.push(node.source.value);
      },
    });

    let dependencyMap = new Map();
    dependencyRequests.forEach((moduleRequest) => {
      let srcDir = path.dirname(filePath);
      let dependencyPath = resolveFrom(srcDir, moduleRequest);

      let dependencyAsset = this.assetGraph.get(dependencyPath) || this.createAsset(dependencyPath);
      dependencyMap.set(moduleRequest, dependencyAsset);
    });

    let { plugins, presets } = this.babelConfig;
    let { code } = transformFromAst(ast, null, { plugins, presets });

    // asset.code = code;
    await this.cache.put(`generated:${filePath}`, code);
    asset.dependencyMap = dependencyMap;
  }

  async packageAssetsIntoBundles() {
    await mkdirp('dist');
    
    // wrapper code taken from https://github.com/ronami/minipack/blob/master/src/minipack.js
    const topWrapper = `
      (function(modules) {
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
      })({`; 
    await writeFile('dist/bundle.js', topWrapper, 'utf8');

    for (let [filePath, asset] of this.assetGraph) {
      let code = await this.cache.get(`generated:${asset.filePath}`);
      let mapping = {};
      asset.dependencyMap.forEach((depAsset, key) => mapping[key] = depAsset.id);
      let moduleWrapper = `${asset.id}: [
        function (require, module, exports) {
          ${code}
        },
        ${JSON.stringify(mapping)},
      ],`;

      await appendFile('dist/bundle.js', moduleWrapper);
    }

    await appendFile('dist/bundle.js', '})');

    // // wrapper code taken from https://github.com/ronami/minipack/blob/master/src/minipack.js
    // const result = `
    //   (function(modules) {
    //     function require(id) {
    //       const [fn, mapping] = modules[id];

    //       function localRequire(name) {
    //         return require(mapping[name]);
    //       }

    //       const module = { exports : {} };

    //       fn(localRequire, module, module.exports);

    //       return module.exports;
    //     }

    //     require(0);
    //   })({${modules}})
    // `;

    
    // await writeFile('dist/bundle.js', result, 'utf8');
  }
}
