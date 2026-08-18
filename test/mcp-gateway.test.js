'use strict';

// Integration tests for the /mcp gateway + hashed keystore, run against a
// real proxy server and a mock Streamable-HTTP upstream on ephemeral ports.
// BLAZE_CONFIG_DIR is pointed at a temp dir BEFORE requiring the modules so
// the keystore and config never touch the real ~/.blaze-proxy.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-test-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const keysLib = require('../src/keys');
const { createServer } = require('../src/proxy');
const configLib = require('../src/config');

let mockUpstream, proxy, proxyPort, plaintext;
const seen = [];

before(async () => {
  // Mock MCP upstream: records requests; SSE endpoint emits two frames with a
  // delay so buffering would be observable; echo endpoint returns the body.
  mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url, method: req.method, auth: req.headers.authorization || null, body: Buffer.concat(chunks).toString() });
      if (req.url.endsWith('/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => { res.write('data: second\n\n'); res.end(); }, 150);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString() }));
      }
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));

  const cfg = {
    ...configLib.load(),
    proxyEnabled: false, // gateway must work even with the master toggle OFF
    mcpUpstream: `http://127.0.0.1:${mockUpstream.address().port}`
  };
  ({ server: proxy } = createServer(cfg));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;

  ({ plaintext } = keysLib.issue('test-key'));
});

after(() => {
  proxy?.close();
  mockUpstream?.close();
});

function request(pathname, { method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: pathname, method, headers }, (res) => {
      const chunks = [];
      const arrivals = [];
      res.on('data', (c) => { chunks.push(c); arrivals.push(Date.now()); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers, arrivals }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('no key → 401, upstream never sees the request', async () => {
  const before = seen.length;
  const res = await request('/mcp/tools', { body: '{}' , headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(JSON.parse(res.body).error.type, 'unauthorized');
  assert.strictEqual(seen.length, before, 'unauthorized request must not reach the upstream');
});

test('wrong key → 401', async () => {
  const res = await request('/mcp/tools', { headers: { Authorization: 'Bearer bzp_not_a_real_key' } });
  assert.strictEqual(res.status, 401);
});

test('valid key → proxied verbatim, path preserved, gateway key stripped', async () => {
  const res = await request('/mcp/tools/call?x=1', {
    headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
    body: '{"hello":"mcp"}'
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).echoed, '{"hello":"mcp"}');
  const last = seen[seen.length - 1];
  assert.strictEqual(last.path, '/mcp/tools/call?x=1', 'full path incl. /mcp prefix and query reaches the upstream');
  assert.strictEqual(last.auth, null, 'gateway API key must not leak to the upstream');
});

test('SSE streams through unbuffered', async () => {
  const res = await request('/mcp/sse', { headers: { Authorization: `Bearer ${plaintext}` } });
  assert.strictEqual(res.headers['content-type'], 'text/event-stream');
  assert.ok(res.body.includes('data: first') && res.body.includes('data: second'));
  assert.ok(res.arrivals.length >= 2, 'frames must arrive as separate chunks');
  assert.ok(res.arrivals[res.arrivals.length - 1] - res.arrivals[0] >= 100,
    'second frame must arrive later — a buffered gateway would deliver everything at once');
});

test('revocation applies without restart', async () => {
  const { plaintext: doomed } = keysLib.issue('doomed-key');
  const ok = await request('/mcp/ping', { headers: { Authorization: `Bearer ${doomed}` } });
  assert.strictEqual(ok.status, 200);
  keysLib.revoke({ name: 'doomed-key' });
  const denied = await request('/mcp/ping', { headers: { Authorization: `Bearer ${doomed}` } });
  assert.strictEqual(denied.status, 401, 'revoked key must fail on the very next request');
});

test('model routing paths still refuse while proxyEnabled=false (gateway is exempt, models are not)', async () => {
  const res = await request('/v1/responses', { headers: { 'Content-Type': 'application/json' }, body: '{"model":"x"}' });
  assert.strictEqual(res.status, 503);
});

test('keystore hygiene: file holds hashes only, mode 600', () => {
  const raw = fs.readFileSync(keysLib.KEYS_PATH, 'utf8');
  assert.ok(!raw.includes(plaintext), 'plaintext must never be written to disk');
  assert.ok(raw.includes('keySha256'));
  const mode = fs.statSync(keysLib.KEYS_PATH).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});
