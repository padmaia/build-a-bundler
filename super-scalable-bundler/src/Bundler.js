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
import { fork } from 'child_process';
import mapObj from 'map-obj';

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
    this.processQueue = new PQueue({ concurrency: 8 });
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
    let processed = await this.getProcessed(filePath);

    if (!processed) {
      processed = await this.processInWorker(filePath);
      await this.cache.put(`processed:${filePath}`, JSON.stringify(processed));
    }

    let { dependencyMap } = processed;

    Object.values(dependencyMap).forEach((depPath) => {
      if (!this.assetGraph.get(depPath)) this.createAsset(depPath);
    });
  }

  getProcessed(filePath) {
    return this.cache.get(`processed:${filePath}`)
      .then(
        (processed) => {
          return JSON.parse(processed)
        },
        (err) => {
          if (err.notFound) return null;
          throw err;
        }
      );
  }

  processInWorker(filePath) {
    return new Promise((resolve, reject) => {
      var worker = fork(path.join(__dirname, 'worker.js'));
      worker.on('message', (msg) => {
        resolve(msg);
        worker.kill('SIGINT');
      });

      worker.on('error', (err) => {
        reject(new Error('Worker failed to process asset', asset.filePath));
      });

      worker.send(filePath);
    });
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
      let { code, dependencyMap } = await this.getProcessed(asset.filePath);
      let mapping = mapObj(dependencyMap, (depRequest, depAsset) => [depRequest, depAsset.id]);
      let moduleWrapper = `${asset.id}: [
        function (require, module, exports) {
          ${code}
        },
        ${JSON.stringify(mapping)},
      ],`;

      await appendFile('dist/bundle.js', moduleWrapper);
    }

    await appendFile('dist/bundle.js', '})');
  }
}
