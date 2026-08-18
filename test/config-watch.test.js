'use strict';

// Hand-edits to config.json must apply without a restart (this gap cost real
// debugging time twice: a modelCardPatches edit and a new model entry that
// both looked ignored until the daemon was bounced).

const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-watch-'));
process.env.BLAZE_CONFIG_DIR = dir;
// Poll fast so the assertions stay deterministic when the suite runs its
// files in parallel and the box is loaded (1s polling + an 8s deadline was
// flaky under load — a flaky test is worse than no test).
process.env.BLAZE_CONFIG_WATCH_INTERVAL = '100';

const { test, after } = require('node:test');
const assert = require('node:assert');
const configLib = require('../src/config');

const CONFIG_PATH = path.join(dir, 'config.json');
after(() => { try { fs.unwatchFile(CONFIG_PATH); } catch {} });

function waitFor(predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

test('an external edit to config.json is picked up live', async () => {
  configLib.save({ ...configLib.load(), endpoint: 'https://before.example/v1' });
  let latest = null;
  configLib.watch((next) => { latest = next; });
  // fs.watchFile takes its baseline stat asynchronously; under a loaded
  // parallel suite an immediate write can land before that baseline exists
  // and would then never register as a change. Benign in production (the
  // daemon reads config at startup regardless), but the test must not race it.
  await new Promise((r) => setTimeout(r, 500));

  // Someone edits the file by hand.
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  onDisk.endpoint = 'https://after.example/v1';
  onDisk.providers[0].models.push({ id: 'gpt-9.9-brandnew', route: true, smart: false, dest: 'local' });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2) + '\n');

  await waitFor(() => latest !== null);
  assert.strictEqual(latest.endpoint, 'https://after.example/v1');
  assert.ok(latest.providers[0].models.some((m) => m.id === 'gpt-9.9-brandnew'),
    'a model added by hand must become routable without a restart');
});

test('our own save() does not trigger a reload callback', async () => {
  let calls = 0;
  configLib.watch(() => { calls++; });
  configLib.save({ ...configLib.load(), endpoint: 'https://self-written.example/v1' });
  await new Promise((r) => setTimeout(r, 2500));
  assert.strictEqual(calls, 0, 'writes made through save() are already in memory');
});

test('invalid JSON on disk is ignored rather than crashing or clearing config', async () => {
  let latest = null;
  configLib.watch((next) => { latest = next; });
  fs.writeFileSync(CONFIG_PATH, '{ this is not json');
  await new Promise((r) => setTimeout(r, 2500));
  assert.strictEqual(latest, null, 'a broken edit must not be applied');
  // and load() still refuses to explode
  assert.ok(configLib.load().providers.length > 0, 'load() falls back to defaults on unparsable config');
});
