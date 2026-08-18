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
const keychainLib = require('./keychain');
const { endpointKey } = keychainLib;
const keysLib = require('./keys');

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

// Models that asked to be served but have no rule in config. A hard-coded
// model list goes stale every time a provider ships a new name, and the
// symptom is silent: the request just passes through, with no toggle to find.
// Recording them lets the UI offer the toggle instead.
const unmanaged = new Map(); // model id → { count, lastSeen }

function noteUnmanaged(cfg, modelId) {
  if (!modelId || configLib.ruleFor(cfg, modelId)) return;
  const prev = unmanaged.get(modelId);
  unmanaged.set(modelId, { count: (prev?.count || 0) + 1, lastSeen: new Date().toISOString() });
}

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
// Is this a message-shaped item carrying no actual text? Codex emits e.g.
// {role:'developer', content:''} when driving a custom provider, and strict
// servers (vLLM) reject it with a 500. Tool calls legitimately have no
// content, so only items that HAVE a content field are considered.
function isEmptyMessageItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (!('content' in item)) return false;
  if (item.type && item.type !== 'message') return false;
  const content = item.content;
  if (content === '' || content == null) return true;
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    return content.every((part) => {
      if (typeof part === 'string') return part.trim() === '';
      if (!part || typeof part !== 'object') return false;
      const text = part.text ?? part.content;
      return typeof text === 'string' ? text.trim() === '' : false;
    });
  }
  if (typeof content === 'string') return content.trim() === '';
  return false;
}

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
      if (isEmptyMessageItem(item)) return [];
      return [item];
    });
  }
  return out;
}

// Chat Completions shape: same empty-message hazard in `messages`.
function scrubChatForEndpoint(payload, destModel) {
  const out = { ...payload, model: destModel };
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.filter((m) => !isEmptyMessageItem(m));
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
  const scrubbed = apiPath === '/responses'
    ? scrubForEndpoint(payload, destModel)
    : scrubChatForEndpoint(payload, destModel);
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
    // The status line was already sent, so an error arriving INSIDE the stream
    // (vLLM emits 500-ish payloads with 200 headers) would otherwise be logged
    // as a success. Watch the frames and report what the client actually got.
    let streamError = null;
    upstream.on('data', (chunk) => {
      if (!streamError) {
        const text = chunk.toString('utf8');
        if (/"type"\s*:\s*"error"|event:\s*(response\.failed|error)|"object"\s*:\s*"error"/.test(text)) {
          const m = text.match(/"message"\s*:\s*"([^"]{0,200})/);
          streamError = m ? m[1] : 'error event in stream';
        }
      }
      try { res.write(chunk); } catch { upstream.destroy(); }
    });
    upstream.on('end', () => {
      res.end();
      emitEvent({
        kind: 'request', model: requestedModel, route: 'intercepted', dest: destModel,
        status: streamError ? 502 : 200,
        ms: Date.now() - started,
        error: streamError || undefined
      });
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
// Resolve a configured upstream. The literal string "endpoint" is a sentinel
// meaning "this upstream IS my endpoint" — it resolves to cfg.endpoint and
// marks the pass-through for endpoint auth. This exists because address
// string-matching cannot know that 127.0.0.1:8000 and 192.168.0.117:8000 are
// the same vLLM (the exact bug hit on ben1); the operator states intent
// instead and no address comparison is involved.
function resolveUpstream(cfg, name) {
  const value = (cfg.upstreams || {})[name];
  if (value === 'endpoint') return { origin: cfg.endpoint, isEndpoint: true };
  return { origin: value, isEndpoint: false };
}

async function handlePassthrough(cfg, req, res, rawBody, origin, { patchModels = false, model = null, started = Date.now(), attachEndpointKey = false } = {}) {
  let protocol, host, port, prefix;
  try {
    ({ protocol, host, port, prefix } = originParts(origin));
  } catch {
    // A misconfigured upstream must degrade to a 502, never take the daemon
    // down (an unhandled throw here is fatal to the whole process in Node).
    const msg = JSON.stringify({
      error: { message: `blaze-proxy: upstream is not a valid URL: ${JSON.stringify(origin)} — check config.upstreams`, type: 'config_error' }
    });
    res.writeHead(502, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
    res.end(msg);
    emitEvent({ kind: 'request', model, route: 'config-error', status: 502, ms: Date.now() - started, error: `bad upstream: ${origin}` });
    return;
  }
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

  // Pass-throughs bound for the ENDPOINT itself (e.g. /v1/models on an
  // instance whose upstream is the local vLLM) need the endpoint key —
  // the caller's gateway key was stripped at the listener, and vLLM 401s
  // otherwise. Never overrides auth the client legitimately sent.
  // Trigger: the "endpoint" upstream sentinel (explicit intent, address-
  // agnostic) or an exact host:port match against cfg.endpoint.
  try {
    const ep = originParts(cfg.endpoint);
    const endpointBound = attachEndpointKey || (host === ep.host && port === ep.port);
    if (endpointBound && !headers.Authorization && !headers.authorization) {
      const outbound = endpointKey(cfg);
      if (outbound) headers.Authorization = `Bearer ${outbound}`;
    }
  } catch { /* unparsable endpoint — nothing to attach */ }

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
  // Valid JSON that isn't an object (null, a bare string, a number) has no
  // cards to patch — hand it back untouched rather than dereferencing it.
  if (!data || typeof data !== 'object') return body;

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
      if (staticPatches[id]) {
        // null means DELETE the field — some transports are selected by a
        // field's presence, not its value, so overwriting can't express it.
        for (const [field, value] of Object.entries(staticPatches[id])) {
          if (value === null) delete item[field];
          else item[field] = value;
        }
      }
    }
  };
  patchList(data.models, 'slug');
  patchList(data.data, 'id');
  return Buffer.from(JSON.stringify(data));
}

// ————— WebSocket tunnel (Codex native-model transport) —————
function wsTunnel(cfg, req, socket, head) {
  const responsesOrigin = cfg.upstreams.responses === 'endpoint' ? cfg.endpoint : cfg.upstreams.responses;
  const { protocol, host, port, prefix } = originParts(responsesOrigin);
  if (protocol !== 'https:') {
    // Plain-http upstreams (a local vLLM) don't speak the Codex WS protocol;
    // refuse cleanly rather than opening a TLS socket to an http port.
    socket.write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return socket.destroy();
  }
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
    // A WebSocket carries its model inside the encrypted stream, so routing
    // rules cannot apply to it. If ANY model is routed, say so plainly: this
    // conversation reached the provider despite the toggle.
    const anyRouted = cfg.routeAll || (cfg.providers || []).some((p) => (p.models || []).some((m) => m.route));
    emitEvent({
      kind: 'ws',
      route: anyRouted ? 'tunnel-bypass' : 'tunnel',
      dest: host,
      status: 101,
      ms: 0,
      note: anyRouted ? 'WebSocket conversation — routing rules cannot apply' : undefined
    });
  });
  const kill = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', kill);
  socket.on('error', kill);
}

// ————— MCP gateway (/mcp/*) —————
// Reverse-proxies Streamable-HTTP MCP traffic verbatim to cfg.mcpUpstream:
// path preserved, bodies streamed both ways (chunked POSTs in, SSE out, no
// buffering), connection held open. Gated by the hashed API keystore.
// Deliberately OUTSIDE model routing and the proxyEnabled toggle — the master
// switch governs model-traffic interception, not the MCP server's uptime.
function handleMcp(cfg, req, res, started) {
  if (!cfg.mcpUpstream) {
    const msg = JSON.stringify({ error: { message: 'no mcpUpstream configured', type: 'not_found' } });
    res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
    return res.end(msg);
  }

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const record = keysLib.validate(bearer);
  if (!record) {
    const msg = JSON.stringify({ error: { message: 'missing, unknown, or revoked API key', type: 'unauthorized' } });
    res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg), 'WWW-Authenticate': 'Bearer' });
    res.end(msg);
    emitEvent({ kind: 'mcp', route: 'denied', status: 401, ms: Date.now() - started });
    return;
  }

  const { protocol, host, port, prefix } = originParts(cfg.mcpUpstream);
  const incoming = new URL(req.url, 'http://x');
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === 'authorization') continue; // gateway key never reaches the upstream
    headers[name] = value;
  }
  headers.Host = host;
  // Chained-gateway mode: forward OUR outbound key upstream (e.g. a laptop
  // instance whose mcpUpstream is another blaze-proxy's public /mcp).
  if (cfg.mcpUpstreamAuth === 'apiKey') {
    const outbound = endpointKey(cfg);
    if (outbound) headers.Authorization = `Bearer ${outbound}`;
  }

  const mod = protocol === 'https:' ? https : http;
  const upstreamReq = mod.request({
    protocol, host, port,
    path: prefix + incoming.pathname + incoming.search,
    method: req.method,
    headers
  });
  upstreamReq.on('response', (upstream) => {
    const outHeaders = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (HOP_HEADERS.has(name.toLowerCase())) continue;
      outHeaders[name] = value;
    }
    res.writeHead(upstream.statusCode, outHeaders);
    res.flushHeaders?.();
    upstream.pipe(res); // unbuffered — SSE frames flow as they arrive
    upstream.on('end', () => {
      emitEvent({ kind: 'mcp', route: 'gateway', key: record.name, dest: host, status: upstream.statusCode, ms: Date.now() - started });
    });
  });
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      const msg = JSON.stringify({ error: { message: `mcp upstream unreachable: ${err.message}`, type: 'upstream_error' } });
      res.writeHead(502, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
      res.end(msg);
    } else {
      res.destroy();
    }
    emitEvent({ kind: 'mcp', route: 'gateway', key: record.name, dest: host, status: 502, ms: Date.now() - started, error: err.message });
  });
  req.pipe(upstreamReq); // chunked request bodies stream through untouched
  // Cancel propagation: IncomingMessage 'close' fires when the BODY completes,
  // so hook the response instead — it closes only when the client goes away.
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });
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

// Which listener class did a connection arrive on? Classified by the LOCAL
// (listener-side) address, so it stays correct even with a 0.0.0.0 bind.
function listenerClass(socket) {
  return isLoopback(socket.localAddress) ? 'loopback' : 'lan';
}

function listenerAuthMode(cfg, socket) {
  return (cfg.listenerAuth || {})[listenerClass(socket)] || 'open';
}

// Loopback trust for the control API holds ONLY while the loopback listener
// is 'open'. When an edge tunnel fronts loopback (ngrok → 127.0.0.1), the
// operator sets listenerAuth.loopback='keys' — and that must ALSO withdraw
// control trust, or the public edge inherits config-rewrite access.
function controlAllowed(cfg, remoteAddress, authHeader) {
  const loopbackTrusted = ((cfg.listenerAuth || {}).loopback || 'open') === 'open';
  if (isLoopback(remoteAddress) && loopbackTrusted) return true;
  const token = cfg.controlToken;
  if (!token) return false;
  return authHeader === `Bearer ${token}`;
}

// Validate a model-path request against the keystore. Returns the key record
// (request may proceed, header consumed) or null (already responded 401).
function enforceModelKey(req, res, started) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const record = keysLib.validate(bearer);
  if (!record) {
    const msg = JSON.stringify({ error: { message: 'missing, unknown, or revoked API key', type: 'unauthorized' } });
    res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg), 'WWW-Authenticate': 'Bearer' });
    res.end(msg);
    emitEvent({ kind: 'request', route: 'denied', status: 401, ms: Date.now() - started });
    return null;
  }
  // The gateway key must never travel upstream (intercepts attach the
  // endpoint key themselves; pass-throughs would leak it).
  delete req.headers.authorization;
  return record;
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
    // Config is scrubbed of any inline key value; apiKey is a safe descriptor.
    const safeCfg = { ...state.cfg };
    if (safeCfg.endpointAuth?.type === 'value') safeCfg.endpointAuth = { type: 'value', value: '(set)' };
    return json(200, {
      running: true,
      version: require('../package.json').version,
      requestCount,
      apiKey: keychainLib.describeEndpointKey(state.cfg),
      unmanaged: [...unmanaged.entries()].map(([id, v]) => ({ id, ...v })),
      config: safeCfg
    });
  }
  if (url.pathname === '/__blaze/apikey' && req.method === 'PUT') {
    return readBody(req).then((body) => {
      try {
        const { key } = JSON.parse(body.toString('utf8'));
        if (!key || typeof key !== 'string' || key.length < 8) throw new Error('key missing or too short');
        const where = keychainLib.storeEndpointKey(state.cfg, key.trim());
        if (where === 'config') configLib.save(state.cfg);
        emitEvent({ kind: 'config', route: 'apikey-updated' });
        json(200, { ok: true, stored: where, apiKey: keychainLib.describeEndpointKey(state.cfg) });
      } catch (err) {
        json(400, { ok: false, error: err.message });
      }
    });
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

  // Every request runs inside this guard: a throw anywhere in the routing
  // path becomes a 502 for that one request. Without it an unhandled async
  // rejection terminates the process and drops ALL traffic (how a single bad
  // upstream string once crash-looped a deployment).
  const server = http.createServer((req, res) => {
    handleRequest(state, req, res).catch((err) => {
      console.error(`blaze-proxy: unhandled error on ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        const msg = JSON.stringify({ error: { message: `blaze-proxy internal error: ${err.message}`, type: 'proxy_error' } });
        res.writeHead(502, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msg) });
        res.end(msg);
      } else {
        res.destroy();
      }
    });
  });

  async function handleRequest(state, req, res) {
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

    // MCP gateway rides ABOVE model routing and the master toggle, and must
    // run before readBody() — it streams the request body itself.
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return handleMcp(state.cfg, req, res, started);
    }

    const cfg = state.cfg;
    if (listenerAuthMode(cfg, req.socket) === 'keys' && !enforceModelKey(req, res, started)) {
      return;
    }
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
      const up = resolveUpstream(cfg, 'responses');
      return handlePassthrough(cfg, req, res, rawBody, up.origin, { patchModels: true, started, attachEndpointKey: up.isEndpoint });
    }
    if (isAnthropic) {
      const up = resolveUpstream(cfg, 'anthropic');
      return handlePassthrough(cfg, req, res, rawBody, up.origin, { started, attachEndpointKey: up.isEndpoint });
    }
    if ((isResponses || isChat) && req.method === 'POST') {
      let model = null;
      try {
        model = sniffModel(decodeBody(rawBody, req.headers['content-encoding']));
      } catch { /* undecodable body → pass through untouched */ }

      noteUnmanaged(cfg, model);
      if (model && configLib.shouldIntercept(cfg, model)) {
        const payload = JSON.parse(decodeBody(rawBody, req.headers['content-encoding']).toString('utf8'));
        const apiPath = isResponses ? '/responses' : '/chat/completions';
        return handleIntercept(cfg, req, res, payload, null, apiPath, started);
      }
      const up = resolveUpstream(cfg, isResponses ? 'responses' : 'chat');
      return handlePassthrough(cfg, req, res, rawBody, up.origin, { model, started, attachEndpointKey: up.isEndpoint });
    }
    // Anything else on /v1 rides the responses upstream (Codex misc endpoints).
    {
      const up = resolveUpstream(cfg, 'responses');
      return handlePassthrough(cfg, req, res, rawBody, up.origin, { started, attachEndpointKey: up.isEndpoint });
    }
  }

  server.on('upgrade', (req, socket, head) => {
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return socket.destroy();
    }
    // A key-gated listener gates WS upgrades too — otherwise the edge could
    // use us as a free unauthenticated tunnel to the responses upstream.
    if (listenerAuthMode(state.cfg, socket) === 'keys') {
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!keysLib.validate(bearer)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return socket.destroy();
      }
      delete req.headers.authorization;
    }
    wsTunnel(state.cfg, req, socket, head);
  });

  return { server, state };
}

function start() {
  const cfg = configLib.load();
  configLib.save(cfg); // materialize defaults on first run

  // Last-resort guards: a router that stays up serving errors beats one that
  // exits and drops every connection. Per-request faults are already caught;
  // these cover anything that escapes (upstream socket callbacks, timers).
  process.on('unhandledRejection', (err) => {
    console.error(`blaze-proxy: unhandled rejection (continuing): ${err?.stack || err}`);
  });
  process.on('uncaughtException', (err) => {
    console.error(`blaze-proxy: uncaught exception (continuing): ${err?.stack || err}`);
  });

  // Surface config mistakes at startup instead of at first request.
  for (const [name, value] of Object.entries(cfg.upstreams || {})) {
    if (value === 'endpoint') continue;
    try { new URL(value); }
    catch { console.error(`blaze-proxy: WARNING upstreams.${name} is not a valid URL (${JSON.stringify(value)}) — requests routed there will 502. Use a full URL or the literal "endpoint".`); }
  }
  const { server, state } = createServer(cfg);

  // Hand-edits to config.json apply without a restart (this cost real
  // debugging time twice before it existed).
  configLib.watch((next) => {
    state.cfg = next;
    emitEvent({ kind: 'config', route: 'reloaded-from-disk' });
  });

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

module.exports = { createServer, start, patchModelCards, controlAllowed, scrubForEndpoint, scrubChatForEndpoint, isEmptyMessageItem };

if (require.main === module) start();
