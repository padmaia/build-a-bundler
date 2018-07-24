#!/usr/bin/env node
// @flow
'use strict';

require('babel-register');
const Bundler = require('./src/Bundler').default;

let bundler = new Bundler();

bundler.bundle();
