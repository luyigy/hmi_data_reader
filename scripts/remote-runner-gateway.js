#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const Module = require('node:module');
const { loadEnvConfig } = require('@next/env');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node' } });
const root = path.resolve(__dirname, '..');
loadEnvConfig(root);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  return originalResolve.call(this, typeof request === 'string' && request.startsWith('@/')
    ? path.join(root, 'src', request.slice(2)) : request, parent, isMain, options);
};
require('./remote-runner-gateway.ts');
