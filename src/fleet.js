'use strict';

// Fleet relay: /__blaze/fleet/* → the Blaze dashboard-api, with this machine's
// stored endpoint key attached as the bearer.
//
// The renderer never sees the key. It talks only to loopback, which keeps the
// window's CSP at `connect-src http://127.0.0.1:*` and lets EventSource (which
// cannot set headers) consume the dashboard's SSE stream.
//
// Access control is the caller's job: this module is mounted behind the same
// controlAllowed() gate as the rest of /__blaze, so setting
// listenerAuth.loopback='keys' withdraws fleet access along with config writes.

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Headers that describe THIS hop and must not be forwarded, plus the client's
// own Authorization — the relay attaches the machine key itself, and a caller
// must never be able to override or smuggle a different credential upstream.
const STRIPPED = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'authorization', 'cookie', 'origin', 'referer'
]);

// An apiBase pointing at plain HTTP on the public internet would send the key
// in clear text. Loopback is allowed so a locally-run dashboard-api can be
// developed against.
function parseApiBase(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.search || url.hash) return null;
  return url;
}

function fleetStatus(cfg) {
  const fleet = cfg.fleet || {};
  const base = parseApiBase(fleet.apiBase);
  if (!fleet.enabled) return { ok: false, code: 'fleet_disabled', message: 'Fleet is turned off in settings.' };
  if (!fleet.apiBase) return { ok: false, code: 'fleet_not_configured', message: 'No fleet API address is configured.' };
  if (!base) return { ok: false, code: 'fleet_address_invalid', message: 'The fleet API address must be an HTTPS origin (or loopback HTTP).' };
  return { ok: true, base };
}

// Map /__blaze/fleet/v1/snapshot → <apiBase>/v1/snapshot, preserving the query.
// Rejects anything that escapes the prefix rather than normalising it, so a
// crafted path can never reach an unrelated upstream route.
const PREFIX = '/__blaze/fleet';
function targetFor(base, requestUrl) {
  const incoming = new URL(requestUrl, 'http://x');
  // Check the NORMALISED path: `new URL` resolves `..` before we ever see it,
  // so a traversal attempt arrives here already rewritten — and would map to
  // the upstream root instead of being refused if we only inspected the tail.
  if (!incoming.pathname.startsWith(PREFIX)) return null;
  const suffix = incoming.pathname.slice(PREFIX.length);
  if (suffix && !suffix.startsWith('/')) return null;
  if (/(^|\/)\.\.?(\/|$)/.test(suffix)) return null;
  if (suffix.includes('//')) return null;
  // Percent-encoded separators survive normalisation here but may be decoded
  // upstream, which would reopen the traversal we just closed.
  if (/%2e|%2f/i.test(suffix)) return null;
  const target = new URL(base.toString().replace(/\/$/, '') + (suffix || '/'));
  target.search = incoming.search;
  return target;
}

function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIPPED.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// Relay one request. `key` is the machine's endpoint key; an empty key still
// forwards (the upstream answers 401) rather than guessing — the UI shows the
// upstream's own reason instead of a locally invented one.
function relay(cfg, req, res, key) {
  const status = fleetStatus(cfg);
  const json = (code, value) => {
    const body = JSON.stringify(value);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (!status.ok) return json(503, { error: status.code, message: status.message });

  const target = targetFor(status.base, req.url);
  if (!target) return json(400, { error: 'fleet_path_invalid', message: 'That fleet path is not routable.' });

  const transport = target.protocol === 'https:' ? https : http;
  const headers = forwardHeaders(req.headers);
  headers.host = target.host;
  if (key) headers.authorization = `Bearer ${key}`;

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    },
    (upstreamRes) => {
      const outbound = { ...upstreamRes.headers };
      // The dashboard-api sets cookies for its browser deployment. Nothing on
      // loopback should adopt them, and forwarding them would put a session
      // credential into a window that is supposed to hold only the key.
      delete outbound['set-cookie'];
      // The Electron window is a file:// origin, so every relay call is
      // cross-origin and needs this — same as the rest of the control API.
      // Wildcard is safe precisely because the relay accepts no credentials
      // from the caller: there is no ambient authority to borrow.
      outbound['access-control-allow-origin'] = '*';
      res.writeHead(upstreamRes.statusCode || 502, outbound);
      upstreamRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    json(502, { error: 'fleet_unreachable', message: `Could not reach the fleet API: ${err.message}` });
  });

  req.pipe(upstream);
  // SSE streams end when the CLIENT goes away, not when its (empty) request
  // body finishes — so tear down on the response, or every closed window
  // leaves an upstream event stream running.
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
}

module.exports = { relay, fleetStatus, parseApiBase, targetFor };
