'use strict';

// Third-party OpenAI-compatible clients (Cursor, Zed, Continue, aider,
// LibreChat) call GET /v1/models to validate an endpoint. Proxying that
// upstream returned 401 for anyone without ChatGPT credentials, so those
// clients rejected the configuration — a strange limitation for a proxy whose
// purpose is serving your own endpoint. Codex must keep pass-through-and-patch.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-cat-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { localModelsCatalog, looksLikeChatGPTClient } = require('../src/proxy');
const configLib = require('../src/config');

test('catalog is OpenAI-shaped and lists configured models', () => {
  const cat = localModelsCatalog(configLib.load());
  assert.strictEqual(cat.object, 'list');
  assert.ok(Array.isArray(cat.data) && cat.data.length > 0);
  for (const m of cat.data) {
    assert.ok(typeof m.id === 'string' && m.id.length, 'every entry needs an id');
    assert.strictEqual(m.object, 'model');
    assert.ok('owned_by' in m, 'clients read owned_by');
  }
  assert.ok(cat.data.some((m) => m.id === 'gpt-5.3-codex-spark'));
});

test('the endpoint destination is servable even when no rule names it', () => {
  const cat = localModelsCatalog(configLib.load());
  assert.ok(cat.data.some((m) => m.id.includes('DeepSeek-V4-Flash')),
    'a client should be able to ask for the destination model directly');
});

test('routed state is exposed for pickers, without breaking the standard shape', () => {
  const cat = localModelsCatalog({
    providers: [{ id: 'openai', models: [
      { id: 'routed-one', route: true, dest: 'local-dest' },
      { id: 'passthrough-one', route: false, dest: 'local-dest' }
    ] }]
  });
  const routed = cat.data.find((m) => m.id === 'routed-one');
  const plain = cat.data.find((m) => m.id === 'passthrough-one');
  assert.strictEqual(routed.blaze.routed, true);
  assert.strictEqual(plain.blaze.routed, false);
});

test('routeAll marks everything routed', () => {
  const cat = localModelsCatalog({ routeAll: true, providers: [{ id: 'x', models: [{ id: 'a', route: false }] }] });
  assert.strictEqual(cat.data[0].blaze.routed, true);
});

test('duplicate model ids across providers appear once', () => {
  const cat = localModelsCatalog({ providers: [
    { id: 'a', models: [{ id: 'same' }] },
    { id: 'b', models: [{ id: 'same' }] }
  ] });
  assert.strictEqual(cat.data.filter((m) => m.id === 'same').length, 1);
});

// ————— who gets the local catalog —————

test('Codex is recognised and keeps upstream pass-through', () => {
  assert.strictEqual(looksLikeChatGPTClient({ headers: { 'chatgpt-account-id': 'acct_1' }, url: '/v1/models' }), true);
  assert.strictEqual(looksLikeChatGPTClient({ headers: {}, url: '/v1/models?client_version=0.148.0' }), true);
  assert.strictEqual(looksLikeChatGPTClient({ headers: { authorization: 'Bearer eyJhbGciOi.x.y' }, url: '/v1/models' }), true);
});

test('third-party clients get the local catalog', () => {
  // Cursor with a user-supplied OpenAI key, a keystore key, or no auth at all.
  assert.strictEqual(looksLikeChatGPTClient({ headers: { authorization: 'Bearer sk-proj-abc123' }, url: '/v1/models' }), false);
  assert.strictEqual(looksLikeChatGPTClient({ headers: { authorization: 'Bearer bzp_abc' }, url: '/v1/models' }), false);
  assert.strictEqual(looksLikeChatGPTClient({ headers: {}, url: '/v1/models' }), false);
});
