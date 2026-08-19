'use strict';

// The ben1 catalog bug: endpoint and catalog upstream were the SAME server
// under DIFFERENT address strings (192.168.0.117 vs 127.0.0.1), so the
// host:port equality guard never fired and vLLM got a keyless catalog fetch.
// The fix is the "endpoint" upstream sentinel — explicit intent, no address
// comparison. These tests pin both the sentinel and the sharp edge it papers
// over.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-sentinel-'));
process.env.BLAZE_ENDPOINT_KEY = 'env-endpoint-key';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const keysLib = require('../src/keys');
const { createServer } = require('../src/proxy');
const configLib = require('../src/config');

let mock, plaintext;

before(async () => {
  mock = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sawAuth: req.headers.authorization || null }));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  ({ plaintext } = keysLib.issue('sentinel-test'));
});

after(() => mock?.close());

function serveWith(upstreamsResponses, endpointHost) {
  const base = configLib.load();
  const port = mock.address().port;
  const cfg = {
    ...base,
    routeAll: true,
    // this test exercises the /v1/models PASS-THROUGH path, not the local catalog
    modelsCatalog: 'upstream',
    // endpoint uses a DIFFERENT address string than the literal upstream but
    // resolves to the SAME server — exactly the ben1 shape (192.168.0.117 vs
    // 127.0.0.1 both being the one vLLM). Here: localhost vs 127.0.0.1.
    endpoint: `http://${endpointHost}:${port}/v1`,
    upstreams: { ...base.upstreams, responses: upstreamsResponses ?? `http://127.0.0.1:${port}/v1` },
    endpointAuth: { type: 'keychain', service: 'no-such-service', account: 'nobody' },
    listenerAuth: { loopback: 'keys', lan: 'open' },
    controlToken: 't'
  };
  const { server } = createServer(cfg);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function getModels(server) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: '/v1/models', method: 'GET', headers: { Authorization: `Bearer ${plaintext}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('"endpoint" sentinel attaches the endpoint key regardless of address strings', async () => {
  const server = await serveWith('endpoint', 'localhost');
  try {
    const res = await getModels(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sawAuth, 'Bearer env-endpoint-key',
      'sentinel must resolve to cfg.endpoint AND carry the endpoint bearer (env-resolved)');
  } finally { server.close(); }
});

test('literal upstream with a mismatched address string does NOT attach (the documented sharp edge)', async () => {
  const server = await serveWith(null, 'localhost'); // literal 127.0.0.1 upstream vs 192.168.0.117 endpoint
  try {
    const res = await getModels(server);
    assert.strictEqual(res.body.sawAuth, null,
      'address-mismatched literals cannot be inferred equal — use the sentinel for catalog-is-endpoint setups');
  } finally { server.close(); }
});

test('exact-match literal still attaches (v0.3.1 behavior preserved)', async () => {
  const server = await serveWith(`http://127.0.0.1:${mock.address().port}/v1`, '127.0.0.1');
  try {
    const res = await getModels(server);
    assert.strictEqual(res.body.sawAuth, 'Bearer env-endpoint-key');
  } finally { server.close(); }
});
