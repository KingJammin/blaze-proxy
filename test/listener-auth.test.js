'use strict';

// Listener-scoped keystore enforcement (v0.3.0). Uses a temp BLAZE_CONFIG_DIR
// and a mock upstream; loopback-only sockets, so 'lan' behavior is exercised
// through the controlAllowed/listenerAuth pure functions plus config.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-lauth-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const keysLib = require('../src/keys');
const { createServer, controlAllowed } = require('../src/proxy');
const configLib = require('../src/config');

let mockEndpoint, proxy, proxyPort, plaintext;

before(async () => {
  // Mock LLM endpoint so intercepted requests terminate locally.
  mockEndpoint = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock-dest', output: [], upstreamAuth: req.headers.authorization || null }));
  });
  await new Promise((r) => mockEndpoint.listen(0, '127.0.0.1', r));

  const base = configLib.load();
  const mockOrigin = `http://127.0.0.1:${mockEndpoint.address().port}`;
  const cfg = {
    ...base,
    proxyEnabled: true,
    routeAll: true,
    // this test exercises the /v1/models PASS-THROUGH path, not the local catalog
    modelsCatalog: 'upstream',
    endpoint: `${mockOrigin}/v1`,
    endpointAuth: { type: 'value', value: 'endpoint-secret' },
    // Catalog upstream = the endpoint itself (ben1's shape).
    upstreams: { ...base.upstreams, responses: `${mockOrigin}/v1` },
    listenerAuth: { loopback: 'keys', lan: 'open' },
    controlToken: 'ctl-token'
  };
  ({ server: proxy } = createServer(cfg));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;
  ({ plaintext } = keysLib.issue('edge-user'));
});

after(() => { proxy?.close(); mockEndpoint?.close(); });

function request(pathname, { method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const MODEL_BODY = JSON.stringify({ model: 'anything', input: 'hi', stream: false });

test('keys-mode listener: model request without key → 401', async () => {
  const res = await request('/v1/responses', { headers: { 'Content-Type': 'application/json' }, body: MODEL_BODY });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(JSON.parse(res.body).error.type, 'unauthorized');
});

test('keys-mode listener: valid key → intercepted, and the bzp key is NOT what reaches the endpoint', async () => {
  const res = await request('/v1/responses', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintext}` },
    body: MODEL_BODY
  });
  assert.strictEqual(res.status, 200);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.upstreamAuth, 'Bearer endpoint-secret', 'endpoint sees the endpoint key, never the caller bzp key');
});

test('keys-mode listener: revoked key → 401 on next request', async () => {
  const { plaintext: doomed } = keysLib.issue('doomed-edge');
  const ok = await request('/v1/responses', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${doomed}` }, body: MODEL_BODY });
  assert.strictEqual(ok.status, 200);
  keysLib.revoke({ name: 'doomed-edge' });
  const denied = await request('/v1/responses', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${doomed}` }, body: MODEL_BODY });
  assert.strictEqual(denied.status, 401);
});

test('loopback control trust is WITHDRAWN when loopback listener is keys-mode', async () => {
  const noToken = await request('/__blaze/state', { method: 'GET' });
  assert.strictEqual(noToken.status, 403, 'loopback caller must not be trusted when an edge fronts loopback');
  const withToken = await request('/__blaze/state', { method: 'GET', headers: { Authorization: 'Bearer ctl-token' } });
  assert.strictEqual(withToken.status, 200, 'controlToken restores management access');
});

test('healthz stays open regardless', async () => {
  const res = await request('/healthz', { method: 'GET' });
  assert.strictEqual(res.status, 200);
});

test('WS upgrade without key is refused on keys-mode listener', async () => {
  const net = require('net');
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write('GET /v1/responses HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString()));
    sock.on('error', reject);
    setTimeout(() => sock.destroy(), 3000);
  });
  assert.ok(reply.startsWith('HTTP/1.1 401'), `expected 401 refusal, got: ${reply.slice(0, 40)}`);
});

test('controlAllowed pure function: loopback trust follows listenerAuth.loopback', () => {
  const open = { listenerAuth: { loopback: 'open' }, controlToken: '' };
  const keyed = { listenerAuth: { loopback: 'keys' }, controlToken: 't' };
  assert.strictEqual(controlAllowed(open, '127.0.0.1', ''), true);
  assert.strictEqual(controlAllowed(keyed, '127.0.0.1', ''), false);
  assert.strictEqual(controlAllowed(keyed, '127.0.0.1', 'Bearer t'), true);
  assert.strictEqual(controlAllowed({}, '127.0.0.1', ''), true, 'absent listenerAuth = legacy loopback trust');
});

test('endpoint-bound pass-through (e.g. /v1/models) attaches the endpoint key', async () => {
  // The defect: catalog fetches pass through with the caller's gateway key
  // stripped and nothing attached — vLLM 401s. Endpoint-bound pass-throughs
  // must carry the endpoint bearer; foreign-bound ones must not.
  const res = await request('/v1/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${plaintext}` }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).upstreamAuth, 'Bearer endpoint-secret',
    'catalog fetch must reach the endpoint WITH the endpoint key, not keyless');
});

test('apikey endpoint stores outbound key (config fallback) and reports masked descriptor', async () => {
  const put = await request('/__blaze/apikey', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ctl-token' },
    body: JSON.stringify({ key: 'bzp_new_outbound_key_1234' })
  });
  assert.strictEqual(put.status, 200);
  const out = JSON.parse(put.body);
  assert.strictEqual(out.stored, 'config');
  assert.deepStrictEqual(out.apiKey, { set: true, last4: '1234' });

  const state = await request('/__blaze/state', { method: 'GET', headers: { Authorization: 'Bearer ctl-token' } });
  const parsed = JSON.parse(state.body);
  assert.strictEqual(parsed.config.endpointAuth.value, '(set)', 'state must never echo the stored key');
  assert.deepStrictEqual(parsed.apiKey, { set: true, last4: '1234' });

  // the new outbound key is what the endpoint now sees
  const res = await request('/v1/responses', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintext}` },
    body: MODEL_BODY
  });
  assert.strictEqual(JSON.parse(res.body).upstreamAuth, 'Bearer bzp_new_outbound_key_1234');
});
