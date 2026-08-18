'use strict';

// The transparent-interception listener: an HTTP CONNECT proxy that terminates
// TLS only for the hosts blaze cares about, hands decrypted model requests to
// the existing routing engine, and blind-tunnels everything else.
//
// Two deliberate constraints:
//   * Blast radius. `launchctl setenv` is machine-global, so unrelated apps may
//     point here. Any host outside INTERCEPT_HOSTS is spliced byte-for-byte
//     without decryption — we never hold their plaintext or their trust.
//   * WebSocket upgrades are refused with 501. The handshake carries no model,
//     so the choice cannot be per-model; refusing makes Codex fall back to
//     HTTP ("Falling back from WebSockets to HTTPS transport"), where the
//     normal per-model rules apply. The refusal must be stable — Codex retries
//     several times before downgrading.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const transparent = require('./transparent');

// Only these hosts are decrypted. Everything else is tunneled blind.
const INTERCEPT_HOSTS = /(^|\.)(chatgpt\.com|openai\.com)$/;
// Where Codex posts conversations; blaze serves the same shape at /v1/responses.
const RESPONSES_RE = /\/backend-api\/codex\/responses\/?$|\/v1\/responses\/?$/;

function createMitmServer({ blazePort, onEvent }) {
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
        // Hand to blaze's own engine: it sniffs the model (zstd-aware) and
        // decides intercept vs pass, exactly as for a directly-configured client.
        out = http.request({
          host: '127.0.0.1', port: blazePort, path: '/v1/responses', method: 'POST',
          headers: { ...headers, host: `127.0.0.1:${blazePort}`, 'content-length': body.length }
        }, onUpstream);
        emit({ kind: 'mitm', route: 'to-engine', dest: host, status: 0, ms: 0 });
      } else {
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

module.exports = { createMitmServer, INTERCEPT_HOSTS, RESPONSES_RE };
