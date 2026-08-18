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
    case 'transparent': {
      // Works WITHOUT a running daemon on purpose: if transparent mode ever
      // strands the machine's network, `blaze-proxy transparent off` must fix
      // it even when nothing else is alive.
      const t = require('../src/transparent');
      const sub = process.argv[3] || 'status';
      if (sub === 'off') {
        const res = t.disable({ removeCA: process.argv.includes('--remove-ca') });
        const saved = configLib.load();
        saved.transparent = { ...(saved.transparent || {}), enabled: false };
        configLib.save(saved);
        console.log(`Transparent mode OFF. Environment cleared: ${res.cleared}${res.caRemoved ? ', CA removed' : ''}.`);
        console.log('Restart client apps so they drop the old proxy environment.');
      } else if (sub === 'status') {
        const report = t.doctor(Number(cfg.transparent?.port || 8799));
        const on = Boolean(cfg.transparent?.enabled);
        console.log(`transparent mode: ${on ? 'enabled in config' : 'disabled in config'}`);
        // When it's off, unset variables are the CORRECT state, not failures.
        for (const c of report.checks) {
          const label = c.ok ? 'ok  ' : (on ? 'FAIL' : 'off ');
          console.log(`  ${label}  ${c.name} — ${c.detail}`);
        }
        if (!on && report.checks.some((c) => c.ok && /HTTPS_PROXY|CODEX_CA/.test(c.name))) {
          console.log('  WARN  environment is set while config says disabled — run `blaze-proxy transparent off`');
        }
        const stale = t.staleClients(report.marker);
        if (stale.length) {
          console.log('  WARN  these clients started BEFORE the environment was set and will ignore it:');
          for (const s of stale) console.log(`          pid ${s.pid} (${s.started}) ${s.command}`);
          console.log('        restart them to pick it up.');
        }
      } else {
        console.error('usage: blaze-proxy transparent <status|off [--remove-ca]>');
        process.exit(1);
      }
      break;
    }
    case 'keys': {
      const keysLib = require('../src/keys');
      const sub = process.argv[3];
      const argOf = (flag) => {
        const i = process.argv.indexOf(flag);
        return i > -1 ? process.argv[i + 1] : undefined;
      };
      try {
        if (sub === 'issue') {
          const name = argOf('--name');
          if (!name) { console.error('usage: blaze-proxy keys issue --name NAME'); process.exit(1); }
          const { plaintext, record } = keysLib.issue(name);
          console.log(`Issued key "${record.name}" (id ${record.id}).`);
          console.log('');
          console.log(`  ${plaintext}`);
          console.log('');
          console.log('This plaintext is shown ONCE and stored only as a hash — save it now.');
        } else if (sub === 'revoke') {
          const count = keysLib.revoke({ id: argOf('--id'), name: argOf('--name') });
          console.log(`Revoked ${count} key(s). Takes effect on the next request — no restart needed.`);
        } else if (sub === 'list') {
          const records = keysLib.list();
          if (!records.length) return console.log('No keys issued.');
          for (const r of records) {
            console.log(`${r.revokedAt ? 'revoked' : 'active '}  ${r.id}  ${r.name}  created ${r.createdAt}${r.revokedAt ? `  revoked ${r.revokedAt}` : ''}`);
          }
        } else {
          console.error('usage: blaze-proxy keys <issue --name NAME | revoke --name NAME|--id ID | list>');
          process.exit(1);
        }
      } catch (err) {
        console.error(`keys ${sub}: ${err.message}`);
        process.exit(1);
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
      console.log('usage: blaze-proxy <start|stop|status|app|keys|transparent>');
      process.exitCode = 1;
  }
}

main();
