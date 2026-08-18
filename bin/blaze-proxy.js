#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const configLib = require('../src/config');

const cmd = process.argv[2] || 'start';
const cfg = configLib.load();
const port = Number(process.env.BLAZE_PORT || cfg.port);

function control(method, controlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: controlPath, method, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  switch (cmd) {
    case 'start': {
      require('../src/proxy').start();
      break;
    }
    case 'status': {
      try {
        const { body } = await control('GET', '/__blaze/state');
        const state = JSON.parse(body);
        console.log(`blaze-proxy v${state.version} running on :${port}`);
        console.log(`endpoint: ${state.config.endpoint}`);
        console.log(`proxy enabled: ${state.config.proxyEnabled} · route all: ${state.config.routeAll}`);
        const routed = state.config.providers.flatMap((p) => p.models.filter((m) => m.route).map((m) => m.id));
        console.log(`routed models: ${routed.length ? routed.join(', ') : '(none)'}`);
        console.log(`requests served: ${state.requestCount}`);
      } catch {
        console.log(`blaze-proxy is not running on :${port}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'stop': {
      try {
        await control('POST', '/__blaze/shutdown');
        console.log('blaze-proxy stopped');
      } catch {
        console.log(`blaze-proxy is not running on :${port}`);
      }
      break;
    }
    case 'app': {
      let electron;
      try {
        electron = require('electron'); // resolves to the binary path string
      } catch {
        console.error('The desktop app needs Electron, which was not installed (optional dependency).');
        console.error('Run: npm install -g electron   — or reinstall without --omit=optional');
        process.exit(1);
      }
      const child = spawn(electron, [path.join(__dirname, '..', 'app', 'main.js')], { stdio: 'inherit', detached: false });
      child.on('exit', (code) => process.exit(code || 0));
      break;
    }
    default:
      console.log('usage: blaze-proxy <start|stop|status|app>');
      process.exitCode = 1;
  }
}

main();
