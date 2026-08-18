'use strict';

// Blaze Proxy daemon — a Node port of the two Python routers it replaces
// (hybrid_router.py, the model-splitting front on :8789, and server.py, the
// Responses-API adapter on :8787), collapsed into one config-driven process.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const fzstd = require('fzstd');

const configLib = require('./config');
const { endpointKey } = require('./keychain');

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length'
]);
const CLIENT_AUTH_HEADERS = new Set([
  'authorization', 'chatgpt-account-id', 'openai-organization', 'openai-project', 'x-api-key'
]);

// ————— event tail (feeds the UI's live activity) —————
const TAIL_MAX = 200;
const tail = [];
const tailClients = new Set();
let requestCount = 0;

function emitEvent(evt) {
  evt.ts = new Date().toISOString();
  tail.push(evt);
  if (tail.length > TAIL_MAX) tail.shift();
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of tailClients) res.write(line);
}

// ————— helpers —————
function originParts(origin) {
  const u = new URL(origin);
  return {
    protocol: u.protocol,
    host: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    prefix: u.pathname.replace(/\/$/, '')
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeBody(body, contentEncoding) {
  if (!body.length) return body;
  if ((contentEncoding || '').toLowerCase() === 'zstd') {
    return Buffer.from(fzstd.decompress(new Uint8Array(body)));
  }
  return body;
}

function sniffModel(decoded) {
  try {
    return JSON.parse(decoded.toString('utf8')).model || null;
  } catch {
    return null;
  }
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(false));
  });
}

function requestUpstream(options, body) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'https:' ? https : http;
    const req = mod.request(options, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ————— intercepted path: rewrite + forward to the configured endpoint —————

// Ported from server.py's request scrubbing: strip reasoning summaries the
// local model can't accept, and drop/rehydrate compaction items.
function scrubForEndpoint(payload, destModel) {
  const out = { ...payload, model: destModel };
  if (out.reasoning && typeof out.reasoning === 'object') {
    const r = { ...out.reasoning };
    delete r.summary;
    if (Object.keys(r).length === 0) delete out.reasoning;
    else out.reasoning = r;
  }
  if (Array.isArray(out.input)) {
    out.input = out.input.flatMap((item) => {
      if (!item || typeof item !== 'object') return [item];
      const type = String(item.type || '');
      if (type === 'compaction') {
        const enc = item.encrypted_content;
        if (typeof enc === 'string' && enc.startsWith('local:')) {
          try {
            const summary = Buffer.from(enc.slice(6), 'base64url').toString('utf8');
            return [{ role: 'system', content: [{ type: 'input_text', text: 'Prior compacted context:\n' + summary }] }];
          } catch { return []; }
        }
        return [];
      }
      if (type.toLowerCase().includes('compaction')) return [];
      return [item];
    });
  }
  return out;
}

async function openEndpointUpstream(cfg, endpointUrl, bodyJson, extraHeaders) {
  const { protocol, host, port } = originParts(endpointUrl);
  const key = endpointKey(cfg);
  const headers = {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity',
    'Content-Length': Buffer.byteLength(bodyJson),
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...extraHeaders
  };
  const attempts = cfg.upstreamAttempts || 3;
  const retryDelay = (cfg.upstreamRetryDelaySeconds || 3) * 1000;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await tcpProbe(host, port, 5000)) {
      try {
        const u = new URL(endpointUrl);
        return await requestUpstream({
          protocol, host, port,
          path: u.pathname + u.search,
          method: 'POST',
          headers,
          timeout: (cfg.upstreamTimeoutSeconds || 900) * 1000
        }, bodyJson);
      } catch (err) {
        lastError = err;
      }
    } else {
      lastError = new Error(`endpoint ${host}:${port} unreachable (connect probe failed)`);
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, retryDelay));
  }
  throw lastError || new Error('endpoint unreachable');
}

function writeStreamError(res, message) {
  // Terminal SSE event instead of a bare disconnect — Codex surfaces the
  // message instead of "stream closed before response.completed".
  const evt = { type: 'response.failed', response: { status: 'failed', error: { code: 'upstream_error', message } } };
  try {
    res.write(`event: response.failed\ndata: ${JSON.stringify(evt)}\n\n`);
    res.end();
  } catch { /* client already gone */ }
}

async function handleIntercept(cfg, req, res, payload, rule, apiPath, started) {
  const destModel = configLib.destFor(cfg, payload.model);
  const requestedModel = payload.model;
  const scrubbed = apiPath === '/responses' ? scrubForEndpoint(payload, destModel) : { ...payload, model: destModel };
  const wantsStream = Boolean(payload.stream);
  const endpointUrl = cfg.endpoint.replace(/\/$/, '') + apiPath;
  const bodyJson = JSON.stringify(scrubbed);

  if (!wantsStream) {
    try {
      const upstream = await openEndpointUpstream(cfg, endpointUrl, bodyJson);
      const chunks = [];
      for await (const c of upstream) chunks.push(c);
      const body = Buffer.concat(chunks);
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/json',
        'Content-Length': body.length,
        'x-blaze-route': 'intercepted',
        'x-blaze-dest': destModel
      });
      res.end(body);
      emitEvent({ kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel, status: upstream.statusCode, ms: Date.now() - started });
    } catch (err) {
      const msg = JSON.stringify({ error: { message: `blaze-proxy endpoint failure: ${err.message}`, type: 'upstream_error' } });
      res.writeHead(502, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
      res.end(msg);
      emitEvent({ kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel, status: 502, ms: Date.now() - started, error: err.message });
    }
    return;
  }

  // Streaming: commit to SSE immediately and heartbeat while the endpoint
  // thinks — Codex's idle-SSE watchdog kills quiet connections well before
  // our upstream timeout (learned the hard way in server.py).
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    'x-blaze-route': 'intercepted',
    'x-blaze-dest': destModel
  });
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { /* closed */ }
  }, (cfg.heartbeatSeconds || 12) * 1000);

  try {
    const upstream = await openEndpointUpstream(cfg, endpointUrl, bodyJson);
    if (upstream.statusCode !== 200) {
      const chunks = [];
      for await (const c of upstream) chunks.push(c);
      clearInterval(heartbeat);
      writeStreamError(res, `endpoint returned HTTP ${upstream.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`);
      emitEvent({ kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel, status: upstream.statusCode, ms: Date.now() - started });
      return;
    }
    clearInterval(heartbeat);
    upstream.on('data', (chunk) => { try { res.write(chunk); } catch { upstream.destroy(); } });
    upstream.on('end', () => {
      res.end();
      emitEvent({ kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel, status: 200, ms: Date.now() - started });
    });
    upstream.on('error', (err) => {
      writeStreamError(res, `stream interrupted: ${err.message}`);
      emitEvent({ kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel, status: 200, ms: Date.now() - started, error: err.message });
    });
    req.on('close', () => upstream.destroy());
  } catch (err) {
    clearInterval(heartbeat);
    writeStreamError(res, `blaze-proxy endpoint failure: ${err.message}`);
    emitEvent({ kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel, status: 502, ms: Date.now() - started, error: err.message });
  }
}

// ————— pass-through path —————
async function handlePassthrough(cfg, req, res, rawBody, origin, { patchModels = false, model = null, started = Date.now() } = {}) {
  const { protocol, host, port, prefix } = originParts(origin);
  const incoming = new URL(req.url, 'http://x');
  // Map /v1/... onto the upstream's own prefix (chatgpt backend has no /v1).
  let path = incoming.pathname;
  if (path === '/v1') path = '/';
  else if (path.startsWith('/v1/')) path = path.slice(3);
  path = prefix + path + incoming.search;

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers['Accept-Encoding'] = 'identity';
  headers.Host = host;
  if (rawBody.length) headers['Content-Length'] = rawBody.length;

  try {
    const upstream = await requestUpstream({ protocol, host, port, path, method: req.method, headers, timeout: 900000 }, rawBody.length ? rawBody : null);

    if (patchModels) {
      const chunks = [];
      for await (const c of upstream) chunks.push(c);
      let body = Buffer.concat(chunks);
      body = patchModelCards(cfg, body);
      const outHeaders = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'content-encoding') continue;
        outHeaders[name] = value;
      }
      outHeaders['Content-Length'] = body.length;
      res.writeHead(upstream.statusCode, outHeaders);
      res.end(body);
    } else {
      const outHeaders = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (HOP_HEADERS.has(name.toLowerCase())) continue;
        outHeaders[name] = value;
      }
      outHeaders.Connection = 'close';
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
    }
    emitEvent({ kind: 'request', model, route: 'pass', dest: host, status: upstream.statusCode, ms: Date.now() - started });
  } catch (err) {
    const msg = JSON.stringify({ error: { message: `blaze-proxy pass-through failure: ${err.message}`, type: 'proxy_error' } });
    res.writeHead(502, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
    res.end(msg);
    emitEvent({ kind: 'request', model, route: 'pass', dest: host, status: 502, ms: Date.now() - started, error: err.message });
  }
}

// Patch fields onto real upstream model cards IN PLACE. Never replace a card:
// a hand-maintained clone once lacked `truncation_policy` and Codex's strict
// deserializer rejected the whole catalog.
//
// Two patch sources, applied in order:
//   1. Transport steering (the WS-gap fix): Codex speaks WebSocket to models
//      whose card advertises the "responses lite" transport, and WS traffic
//      is an opaque tunnel our rule engine can't inspect. So every model with
//      an active Route rule (or all models under routeAll) gets
//      `use_responses_lite: false` stamped on, forcing NEW Codex threads onto
//      HTTP POST where interception actually applies. When the rule turns
//      off, the next catalog fetch serves the upstream truth again.
//   2. Static `modelCardPatches` from config (e.g. context_window overrides),
//      which win over transport steering on conflicts.
function patchModelCards(cfg, body) {
  const staticPatches = cfg.modelCardPatches || {};
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { return body; }

  const routedIds = new Set();
  for (const provider of cfg.providers || []) {
    for (const model of provider.models || []) {
      if (model.route) routedIds.add(model.id);
    }
  }

  const patchList = (items, key) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = item.slug || item[key];
      if (cfg.routeAll || routedIds.has(id)) item.use_responses_lite = false;
      if (staticPatches[id]) Object.assign(item, staticPatches[id]);
    }
  };
  patchList(data.models, 'slug');
  patchList(data.data, 'id');
  return Buffer.from(JSON.stringify(data));
}

// ————— WebSocket tunnel (Codex native-model transport) —————
function wsTunnel(cfg, req, socket, head) {
  const { host, port, prefix } = originParts(cfg.upstreams.responses);
  const upstream = tls.connect({ host, port, servername: host }, () => {
    const incoming = new URL(req.url, 'http://x');
    let path = incoming.pathname;
    if (path.startsWith('/v1/')) path = path.slice(3);
    path = prefix + path + incoming.search;

    const lines = [`${req.method} ${path} HTTP/1.1`, `Host: ${host}`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'host') continue;
      lines.push(`${name}: ${value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    emitEvent({ kind: 'ws', route: 'tunnel', dest: host, status: 101, ms: 0 });
  });
  const kill = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', kill);
  socket.on('error', kill);
}

// ————— control API for the UI (/__blaze/*) —————

// Control-plane access: loopback callers are always trusted (the UI); remote
// callers need the configured controlToken — and with no token configured,
// remote control is refused outright. This is the bind-split: instances that
// bind a LAN address (e.g. a fleet router) expose the *proxy* to the network
// but never an open config-rewrite endpoint.
function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function controlAllowed(cfg, remoteAddress, authHeader) {
  if (isLoopback(remoteAddress)) return true;
  const token = cfg.controlToken;
  if (!token) return false;
  return authHeader === `Bearer ${token}`;
}

function handleControl(state, req, res) {
  const url = new URL(req.url, 'http://x');
  const json = (status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  if (url.pathname !== '/healthz' && !controlAllowed(state.cfg, req.socket.remoteAddress, req.headers.authorization || '')) {
    return json(403, {
      error: 'control API is loopback-only',
      hint: 'manage from 127.0.0.1, or set controlToken in config and send Authorization: Bearer <token>'
    });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  if (url.pathname === '/__blaze/state' && req.method === 'GET') {
    return json(200, { running: true, version: require('../package.json').version, requestCount, config: state.cfg });
  }
  if (url.pathname === '/__blaze/config' && req.method === 'PUT') {
    return readBody(req).then((body) => {
      try {
        const next = JSON.parse(body.toString('utf8'));
        state.cfg = { ...state.cfg, ...next };
        configLib.save(state.cfg);
        emitEvent({ kind: 'config', route: 'updated' });
        json(200, { ok: true, config: state.cfg });
      } catch (err) {
        json(400, { ok: false, error: err.message });
      }
    });
  }
  if (url.pathname === '/__blaze/tail' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    for (const evt of tail.slice(-50)) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    tailClients.add(res);
    req.on('close', () => tailClients.delete(res));
    return;
  }
  if (url.pathname === '/__blaze/shutdown' && req.method === 'POST') {
    json(200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (url.pathname === '/healthz') {
    return json(200, { ok: true });
  }
  return json(404, { error: 'unknown control path' });
}

// ————— server —————
function createServer(initialCfg) {
  const state = { cfg: initialCfg };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');

    if (url.pathname.startsWith('/__blaze/') || url.pathname === '/healthz') {
      return handleControl(state, req, res);
    }

    // Codex's app-server probes this MCP side-channel whenever base_url is
    // overridden; no upstream serves it and proxying the failure produces
    // noisy rmcp "fatal worker" log spam in every run. Answer a clean 404.
    if (url.pathname === '/api/codex/ps/mcp') {
      const msg = JSON.stringify({ error: { message: 'mcp side-channel not supported by blaze-proxy', type: 'not_found' } });
      res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
      res.end(msg);
      emitEvent({ kind: 'request', model: null, route: 'stub', dest: 'mcp-side-channel', status: 404, ms: 0 });
      return;
    }

    const cfg = state.cfg;
    if (!cfg.proxyEnabled) {
      const msg = JSON.stringify({ error: { message: 'blaze-proxy is turned off', type: 'proxy_disabled' } });
      res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
      emitEvent({ kind: 'request', route: 'refused', status: 503, ms: 0 });
      return res.end(msg);
    }

    requestCount++;
    const rawBody = await readBody(req);
    const isModels = /\/models\/?$/.test(url.pathname.split('?')[0]) || url.pathname.startsWith('/v1/models');
    const isResponses = url.pathname.replace(/\/$/, '').endsWith('/responses');
    const isChat = url.pathname.replace(/\/$/, '').endsWith('/chat/completions');
    const isAnthropic = url.pathname.startsWith('/v1/messages');

    if (isModels) {
      return handlePassthrough(cfg, req, res, rawBody, cfg.upstreams.responses, { patchModels: true, started });
    }
    if (isAnthropic) {
      return handlePassthrough(cfg, req, res, rawBody, cfg.upstreams.anthropic, { started });
    }
    if ((isResponses || isChat) && req.method === 'POST') {
      let model = null;
      try {
        model = sniffModel(decodeBody(rawBody, req.headers['content-encoding']));
      } catch { /* undecodable body → pass through untouched */ }

      if (model && configLib.shouldIntercept(cfg, model)) {
        const payload = JSON.parse(decodeBody(rawBody, req.headers['content-encoding']).toString('utf8'));
        const apiPath = isResponses ? '/responses' : '/chat/completions';
        return handleIntercept(cfg, req, res, payload, null, apiPath, started);
      }
      const origin = isResponses ? cfg.upstreams.responses : cfg.upstreams.chat;
      return handlePassthrough(cfg, req, res, rawBody, origin, { model, started });
    }
    // Anything else on /v1 rides the responses upstream (Codex misc endpoints).
    return handlePassthrough(cfg, req, res, rawBody, cfg.upstreams.responses, { started });
  });

  server.on('upgrade', (req, socket, head) => {
    if ((req.headers.upgrade || '').toLowerCase() === 'websocket') {
      wsTunnel(state.cfg, req, socket, head);
    } else {
      socket.destroy();
    }
  });

  return { server, state };
}

function start() {
  const cfg = configLib.load();
  configLib.save(cfg); // materialize defaults on first run
  const { server, state } = createServer(cfg);
  const host = process.env.BLAZE_HOST || '127.0.0.1';
  const port = Number(process.env.BLAZE_PORT || cfg.port);
  server.listen(port, host, () => {
    console.log(`blaze-proxy listening on http://${host}:${port} (endpoint: ${cfg.endpoint})`);
  });

  // LAN-bound instances also get a loopback listener so local management
  // (CLI, UI, curl from the box itself) never needs the control token.
  let aux = null;
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    aux = http.createServer(server.listeners('request')[0]);
    for (const listener of server.listeners('upgrade')) aux.on('upgrade', listener);
    aux.listen(port, '127.0.0.1', () => {
      console.log(`blaze-proxy control listener on http://127.0.0.1:${port}`);
    });
  }
  return { server, state, aux };
}

module.exports = { createServer, start, patchModelCards, controlAllowed };

if (require.main === module) start();
