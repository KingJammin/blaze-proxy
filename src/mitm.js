'use strict';

// The transparent-interception listener: an HTTP CONNECT proxy that terminates
// TLS only for the hosts blaze cares about, hands decrypted model requests to
// the existing routing engine, and blind-tunnels everything else.
//
// Two deliberate constraints:
//   * Blast radius. `launchctl setenv` is machine-global, so unrelated apps may
//     point here. Any host outside INTERCEPT_HOSTS is spliced byte-for-byte
//     without decryption — we never hold their plaintext or their trust.
//   * WebSocket upgrades are refused with 426, which makes Codex downgrade to
//     HTTP after a single attempt and without printing a warning, so the
//     normal per-model rules apply. See the upgrade handler for the measured
//     comparison against 501/403/404/400.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fzstd = require('fzstd');

const transparent = require('./transparent');
const captureLib = require('./capture');

// The ChatGPT-native request body is NOT the public Responses API shape. It
// carries ChatGPT-only fields, and a strict server rejects the whole request:
// vLLM parses an unrecognised field into a pydantic ValidatorIterator and then
// cannot pickle it across a tensor-parallel worker boundary —
//   "cannot pickle 'pydantic_core._pydantic_core.ValidatorIterator' object"
// — which failed EVERY conversation once transparent mode routed all traffic
// through this path. So translate to the documented shape before handing it to
// the engine: keep what the Responses API defines, drop the rest.
const RESPONSES_API_FIELDS = new Set([
  'model', 'input', 'instructions', 'stream', 'max_output_tokens',
  'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls',
  'reasoning', 'text', 'metadata', 'store', 'truncation', 'user'
]);

const droppedOnce = new Set();

// Input item types the Responses API understands. Anything else is ChatGPT
// interior furniture and a strict server rejects the request.
const RESPONSES_ITEM_TYPES = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning', 'item_reference'
]);

// Turn one ChatGPT tool declaration into a standard function tool.
// Codex ships namespace-style groups ({name:'functions', tools:[...]}) as well
// as flat definitions, so handle both and flatten.
function toFunctionTools(raw, out = []) {
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw)) { for (const t of raw) toFunctionTools(t, out); return out; }
  // A namespace/group wrapper: recurse into whatever collection it carries.
  for (const key of ['tools', 'functions', 'definitions']) {
    if (Array.isArray(raw[key])) { toFunctionTools(raw[key], out); return out; }
  }
  if (raw.type === 'function' && (raw.name || raw.function?.name)) { out.push(raw); return out; }
  if (raw.name && (raw.parameters || raw.description)) {
    out.push({
      type: 'function',
      name: raw.name,
      description: raw.description,
      parameters: raw.parameters || { type: 'object', properties: {} }
    });
  }
  return out;
}

// Sanitise `input` and HOIST any tools hidden inside it.
//
// Codex does not send a top-level `tools` array — it ships tool definitions
// inside an input item of type `additional_tools`. That item is what a strict
// endpoint chokes on, but simply dropping it would silently remove every
// function the model can call: a loud 400 traded for quiet capability loss.
// So lift the tools out, then drop the item.
function sanitizeInput(input, onDrop) {
  if (!Array.isArray(input)) return { input, hoistedTools: [] };
  const hoistedTools = [];
  const kept = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') { kept.push(item); continue; }
    const type = item.type;
    // Items without a type are plain messages in practice.
    if (type === undefined || RESPONSES_ITEM_TYPES.has(type)) { kept.push(item); continue; }
    if (item.tools || item.functions) {
      toFunctionTools(item.tools || item.functions, hoistedTools);
      onDrop?.(`input-item:${type} (hoisted ${hoistedTools.length} tools)`);
    } else {
      onDrop?.(`input-item:${type}`);
    }
  }
  return { input: kept, hoistedTools };
}

function normalizeNativePayload(payload, onDrop) {
  if (!payload || typeof payload !== 'object') return payload;
  const report = (key) => {
    if (!onDrop) return;
    if (droppedOnce.has(key)) return;
    droppedOnce.add(key);
    onDrop(key);
  };
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESPONSES_API_FIELDS.has(key)) out[key] = value;
    else report(key);
  }

  // Nested first: the request-killing field lives inside `input`, where a
  // top-level allowlist cannot see it.
  const { input, hoistedTools } = sanitizeInput(out.input, report);
  if (Array.isArray(out.input)) out.input = input;
  if (hoistedTools.length) {
    out.tools = [...(Array.isArray(out.tools) ? out.tools : []), ...hoistedTools];
  }
  // ChatGPT ships bespoke tool types (local_shell, freeform apply_patch) that a
  // generic endpoint does not model. Keep the standard ones; dropping an
  // unknown tool costs a capability, sending it costs the whole request.
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.filter((t) => {
      const keep = t && (t.type === 'function' || t.type === 'web_search' || t.type === 'web_search_preview');
      if (!keep && t?.type && !droppedOnce.has(`tool:${t.type}`)) {
        droppedOnce.add(`tool:${t.type}`);
        onDrop?.(`tool:${t.type}`);
      }
      return keep;
    });
    if (out.tools.length === 0) delete out.tools;
  }
  // `store: true` asks the server to persist the response server-side; a local
  // endpoint has nowhere to put it.
  if (out.store === true) out.store = false;
  return out;
}

// Only these hosts are decrypted. Everything else is tunneled blind.
const INTERCEPT_HOSTS = /(^|\.)(chatgpt\.com|openai\.com)$/;
// Where Codex posts conversations; blaze serves the same shape at /v1/responses.
const RESPONSES_RE = /\/backend-api\/codex\/responses\/?$|\/v1\/responses\/?$/;

function createMitmServer({ blazePort, onEvent, getConfig }) {
  const emit = (evt) => { try { onEvent?.(evt); } catch { /* never let logging break routing */ } };

  // Inner TLS server: receives the decrypted stream for intercepted hosts.
  const inner = https.createServer({
    SNICallback: (servername, cb) => {
      try {
        const { key, cert } = transparent.leafFor(servername);
        cb(null, tls.createSecureContext({ key, cert }));
      } catch (err) {
        emit({ kind: 'mitm', route: 'leaf-error', dest: servername, status: 500, error: err.message });
        cb(err);
      }
    }
  }, (req, res) => {
    const host = req.headers.host || 'unknown';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const isModelPost = req.method === 'POST' && RESPONSES_RE.test(req.url.split('?')[0]);
      const headers = { ...req.headers };
      delete headers['content-length'];
      delete headers.host;

      const onUpstream = (upRes) => {
        const outHeaders = { ...upRes.headers };
        delete outHeaders['transfer-encoding'];
        res.writeHead(upRes.statusCode, outHeaders);
        upRes.pipe(res);
      };

      let out;
      if (isModelPost) {
        // Translate the ChatGPT-native body into the documented Responses
        // shape before the engine sees it, then send it uncompressed so the
        // content-encoding header can't disagree with the bytes.
        let forwardBody = body;
        let normalized = false;
        let raw = null;
        try {
          const encoding = (req.headers['content-encoding'] || '').toLowerCase();
          raw = encoding === 'zstd' ? Buffer.from(fzstd.decompress(new Uint8Array(body))) : body;
          const parsed = JSON.parse(raw.toString('utf8'));
          forwardBody = Buffer.from(JSON.stringify(normalizeNativePayload(parsed, (key) => {
            emit({ kind: 'mitm', route: 'normalized', dest: host, status: 0, ms: 0, note: `dropped ChatGPT-only field: ${key}` });
          })));
          normalized = true;
        } catch (err) {
          // Unparsable → forward untouched rather than dropping the request.
          emit({ kind: 'mitm', route: 'normalize-skipped', dest: host, status: 0, ms: 0, error: err.message });
        }
        const fwdHeaders = { ...headers, host: `127.0.0.1:${blazePort}`, 'content-length': forwardBody.length };
        if (normalized) delete fwdHeaders['content-encoding'];
        // Capture the ORIGINAL native body when the exchange fails. The engine's
        // own capture can't help here: this path commits SSE headers before the
        // error appears mid-stream, so the failure class most worth recording
        // was the one it missed. Watching the response body catches both.
        const watched = (upRes) => {
          const cfg = getConfig?.();
          if (captureLib.enabled(cfg)) {
            const chunks2 = [];
            let bad = upRes.statusCode >= 400;
            upRes.on('data', (c) => {
              if (chunks2.length < 64) chunks2.push(c);
              if (!bad && /"type"\s*:\s*"error"|ValidatorIterator|BadRequestError|response\.failed/.test(c.toString('utf8'))) bad = true;
            });
            upRes.on('end', () => {
              if (!bad) return;
              captureLib.record(cfg, {
                model: 'native-transparent', dest: host, status: upRes.statusCode,
                requestBody: raw ? raw.toString('utf8') : body.toString('utf8'),
                responseBody: Buffer.concat(chunks2).toString('utf8'),
                note: 'ChatGPT-native body received by the transparent listener (pre-normalisation)'
              });
            });
          }
          onUpstream(upRes);
        };
        out = http.request({
          host: '127.0.0.1', port: blazePort, path: '/v1/responses', method: 'POST', headers: fwdHeaders
        }, watched);
        emit({ kind: 'mitm', route: 'to-engine', dest: host, status: 0, ms: 0 });
        if (forwardBody.length) out.write(forwardBody);
        out.on('error', (err) => {
          emit({ kind: 'mitm', route: 'to-engine', dest: host, status: 502, error: err.message });
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `blaze transparent forward failed: ${err.message}`, type: 'proxy_error' } }));
        });
        out.end();
        return;
      }
      {
        out = https.request({
          host, port: 443, path: req.url, method: req.method,
          headers: { ...headers, host }, servername: host
        }, onUpstream);
      }
      out.on('error', (err) => {
        emit({ kind: 'mitm', route: isModelPost ? 'to-engine' : 'forward', dest: host, status: 502, error: err.message });
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `blaze transparent forward failed: ${err.message}`, type: 'proxy_error' } }));
      });
      if (body.length) out.write(body);
      out.end();
    });
  });

  // Refusing here is what makes transparent interception work at all.
  //
  // 426 specifically, measured across rejection codes against the real client:
  //   426 → 1 upgrade attempt, immediate downgrade, NO user-visible warning
  //   501 → 7 attempts, downgrade, prints "Falling back from WebSockets…"
  //   403/404 → 7 attempts, downgrade, also prints a warning
  //   400 → client gives up entirely; the request FAILS
  // It is also the semantically honest answer: we are telling the client to
  // use a different protocol, not claiming the endpoint is unimplemented.
  inner.on('upgrade', (req, socket) => {
    emit({ kind: 'mitm', route: 'ws-refused', dest: req.headers.host || '?', status: 426, ms: 0 });
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
  inner.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  const proxy = http.createServer((req, res) => {
    // Plain-HTTP proxying (rare here) — pass it straight through.
    const target = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`);
    const out = http.request({
      host: target.hostname, port: target.port || 80, path: target.pathname + target.search,
      method: req.method, headers: { ...req.headers, host: target.host }
    }, (upRes) => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(out);
  });

  proxy.on('connect', (req, clientSocket, head) => {
    const [host, rawPort] = req.url.split(':');
    const port = Number(rawPort) || 443;
    if (!INTERCEPT_HOSTS.test(host)) {
      // Blind tunnel: never decrypt, never hold plaintext for unrelated apps.
      const up = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        clientSocket.pipe(up);
        up.pipe(clientSocket);
      });
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
      return;
    }
    clientSocket.on('error', () => clientSocket.destroy());
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) clientSocket.unshift(head);
    inner.emit('connection', clientSocket);
  });

  return proxy;
}

module.exports = { createMitmServer, INTERCEPT_HOSTS, RESPONSES_RE, normalizeNativePayload };
