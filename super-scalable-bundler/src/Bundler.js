import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import babylon from 'babylon';

const readFile = promisify(fs.readFile);

export default class Bundler {
  constructor(entryFilePath) {
    this.entryFilePath = entryFilePath;
    this.processQueue = [];
  }
  
  async bundle() {
    await this.processAsset(this.entryFilePath);
  }

  async processAsset(filePath) {
    let fileContents = await readFile(filePath, 'utf8');
    console.log(fileContents);
  }
}
