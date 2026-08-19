'use strict';

// A misconfigured upstream, or any throw in the routing path, must degrade to
// a 502 for that request — never terminate the daemon. (A bare "endpoint"
// string on a build that didn't understand the sentinel crash-looped a live
// deployment: unparsable URL → unhandled async throw → process exit.)

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-resil-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createServer, patchModelCards } = require('../src/proxy');
const configLib = require('../src/config');

let proxy, proxyPort;

before(async () => {
  const base = configLib.load();
  const cfg = {
    ...base,
    proxyEnabled: true,
    // this test probes the /v1/models PASS-THROUGH path, not the local catalog
    modelsCatalog: 'upstream',
    // Deliberately broken: not a URL, and not the sentinel.
    upstreams: { ...base.upstreams, responses: 'totally-not-a-url', chat: 'also::broken' }
  };
  ({ server: proxy } = createServer(cfg));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;
});

after(() => proxy?.close());

function req(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, path: pathname, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('unparsable upstream → 502 config_error, daemon survives', async () => {
  const res = await req('/v1/models');
  assert.strictEqual(res.status, 502);
  assert.strictEqual(JSON.parse(res.body).error.type, 'config_error');
});

test('daemon still serving after the bad-config request (no crash)', async () => {
  const health = await req('/healthz');
  assert.strictEqual(health.status, 200, 'process must still be alive and answering');
  const again = await req('/v1/responses', { method: 'POST', body: '{"model":"x","input":"y"}' });
  assert.strictEqual(again.status, 502, 'and still degrading cleanly rather than dying');
  const health2 = await req('/healthz');
  assert.strictEqual(health2.status, 200);
});

test('patchModelCards survives a vLLM-shaped catalog (not just chatgpt-shaped)', () => {
  // vLLM: {object:'list', data:[{id, object, owned_by, ...}]} — no `models`
  // array, no slugs. Must not throw and must leave unknown ids untouched.
  const vllm = Buffer.from(JSON.stringify({
    object: 'list',
    data: [{ id: 'deepseek-ai/DeepSeek-V4-Flash-0731', object: 'model', created: 1, owned_by: 'vllm', max_model_len: 983040 }]
  }));
  const cfg = {
    routeAll: true,
    // this test exercises the /v1/models PASS-THROUGH path, not the local catalog
    modelsCatalog: 'upstream',
    providers: [{ id: 'openai', models: [{ id: 'gpt-5.3-codex-spark', route: true }] }],
    modelCardPatches: { 'gpt-5.3-codex-spark': { context_window: 1048576 } }
  };
  const out = JSON.parse(patchModelCards(cfg, vllm).toString('utf8'));
  assert.strictEqual(out.data[0].id, 'deepseek-ai/DeepSeek-V4-Flash-0731');
  assert.strictEqual(out.data[0].max_model_len, 983040, 'vLLM fields preserved');
  assert.strictEqual(out.data[0].use_responses_lite, false, 'routeAll steering applies without crashing');
});

test('patchModelCards survives odd/hostile catalog bodies', () => {
  const cfg = { routeAll: false, providers: [], modelCardPatches: {} };
  for (const body of ['null', '[]', '{"data":null}', '{"models":"nope"}', '{"data":[null,"str",3]}', '""']) {
    assert.doesNotThrow(() => patchModelCards(cfg, Buffer.from(body)), `threw on ${body}`);
  }
});
