'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { relay, fleetStatus, parseApiBase, targetFor } = require('../src/fleet');

// A stand-in dashboard-api. Records what it was asked, answers what it is told.
function upstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, seen.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// The relay under test, mounted the way proxy.js mounts it.
function relayServer(cfg, key) {
  const server = http.createServer((req, res) => relay(cfg, req, res, key));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('an HTTPS origin is required, with loopback HTTP allowed for local development', () => {
  assert.ok(parseApiBase('https://blaze.example.test'));
  assert.ok(parseApiBase('http://127.0.0.1:8080'));
  assert.ok(parseApiBase('http://localhost:8080'));
  for (const value of ['http://blaze.example.test', 'ftp://x', 'not a url', '', null, undefined, 'https://x?a=1', 'https://x#f']) {
    assert.strictEqual(parseApiBase(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('fleet status explains every not-ready reason distinctly', () => {
  assert.strictEqual(fleetStatus({}).code, 'fleet_disabled');
  assert.strictEqual(fleetStatus({ fleet: { enabled: true, apiBase: '' } }).code, 'fleet_not_configured');
  assert.strictEqual(fleetStatus({ fleet: { enabled: true, apiBase: 'http://evil.example' } }).code, 'fleet_address_invalid');
  assert.strictEqual(fleetStatus({ fleet: { enabled: true, apiBase: 'https://ok.example' } }).ok, true);
});

test('paths map onto the upstream and cannot escape the prefix', () => {
  const base = parseApiBase('https://blaze.example.test');
  assert.strictEqual(targetFor(base, '/__blaze/fleet/v1/snapshot').toString(), 'https://blaze.example.test/v1/snapshot');
  assert.strictEqual(targetFor(base, '/__blaze/fleet/v1/events?cursor=abc').toString(), 'https://blaze.example.test/v1/events?cursor=abc');
  assert.strictEqual(targetFor(base, '/__blaze/fleet').toString(), 'https://blaze.example.test/');
  for (const path of ['/__blaze/fleet/../../admin', '/__blaze/fleet//evil.example/x', '/__blaze/fleetish/v1']) {
    assert.strictEqual(targetFor(base, path), null, `expected ${path} to be refused`);
  }
});

test('the machine key is attached and the caller cannot substitute their own', async () => {
  const api = await upstream((req, res) => res.end('{"ok":true}'));
  const proxy = await relayServer({ fleet: { enabled: true, apiBase: api.base } }, 'bzp_machine_key');
  try {
    const response = await fetch(`${proxy.url}/__blaze/fleet/v1/snapshot`, {
      headers: { authorization: 'Bearer bzp_attacker_key', cookie: 'session=stolen', accept: 'application/json' }
    });
    assert.strictEqual(response.status, 200);
    const [seen] = api.seen;
    assert.strictEqual(seen.url, '/v1/snapshot');
    assert.strictEqual(seen.headers.authorization, 'Bearer bzp_machine_key');
    assert.strictEqual(seen.headers.cookie, undefined, 'a caller cookie must never reach the fleet API');
    assert.strictEqual(seen.headers.accept, 'application/json', 'ordinary headers still pass through');
  } finally {
    await proxy.close();
    await api.close();
  }
});

test('a set-cookie from the fleet API is not handed to the window', async () => {
  const api = await upstream((req, res) => {
    res.writeHead(200, { 'set-cookie': '__Host-blaze_session=abc; Path=/', 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = await relayServer({ fleet: { enabled: true, apiBase: api.base } }, 'k');
  try {
    const response = await fetch(`${proxy.url}/__blaze/fleet/v1/session`);
    assert.strictEqual(response.headers.get('set-cookie'), null);
    assert.strictEqual(response.headers.get('content-type'), 'application/json');
  } finally {
    await proxy.close();
    await api.close();
  }
});

test('request bodies and upstream status codes survive the hop', async () => {
  const api = await upstream((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"confirmationToken":"t"}');
  });
  const proxy = await relayServer({ fleet: { enabled: true, apiBase: api.base } }, 'k');
  try {
    const response = await fetch(`${proxy.url}/__blaze/fleet/v1/confirmations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobName: 'noop-1042' })
    });
    assert.strictEqual(response.status, 201);
    assert.deepStrictEqual(await response.json(), { confirmationToken: 't' });
    assert.strictEqual(api.seen[0].method, 'POST');
    assert.deepStrictEqual(JSON.parse(api.seen[0].body), { jobName: 'noop-1042' });
  } finally {
    await proxy.close();
    await api.close();
  }
});

test('SSE reaches the client unbuffered and tears the upstream down on disconnect', async () => {
  let closed;
  const closedUpstream = new Promise((resolve) => { closed = resolve; });
  const api = await upstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: dashboard\ndata: {"v":1}\n\n');
    // Deliberately never end: this is a live stream.
    res.on('close', () => closed());
  });
  const proxy = await relayServer({ fleet: { enabled: true, apiBase: api.base } }, 'k');
  try {
    const controller = new AbortController();
    const response = await fetch(`${proxy.url}/__blaze/fleet/v1/events`, { signal: controller.signal });
    assert.strictEqual(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString('utf8'), /data: \{"v":1\}/, 'the first event arrives before the stream ends');
    controller.abort();
    await closedUpstream;
  } finally {
    await proxy.close();
    await api.close();
  }
});

test('a not-ready fleet answers 503 with its reason instead of hanging', async () => {
  const proxy = await relayServer({ fleet: { enabled: false, apiBase: 'https://ok.example' } }, 'k');
  try {
    const response = await fetch(`${proxy.url}/__blaze/fleet/v1/snapshot`);
    assert.strictEqual(response.status, 503);
    assert.strictEqual((await response.json()).error, 'fleet_disabled');
  } finally {
    await proxy.close();
  }
});

test('an unreachable fleet API is a 502 that names the failure', async () => {
  const api = await upstream(() => undefined);
  const base = api.base;
  await api.close();
  const proxy = await relayServer({ fleet: { enabled: true, apiBase: base } }, 'k');
  try {
    const response = await fetch(`${proxy.url}/__blaze/fleet/v1/snapshot`);
    assert.strictEqual(response.status, 502);
    assert.strictEqual((await response.json()).error, 'fleet_unreachable');
  } finally {
    await proxy.close();
  }
});
