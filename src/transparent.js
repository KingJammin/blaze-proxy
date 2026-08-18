'use strict';

// Transparent interception: become the machine's HTTPS proxy so Codex (and the
// ChatGPT app) route through blaze with no client config at all.
//
// SAFETY FIRST. Once `launchctl setenv HTTPS_PROXY` points at us, every GUI app
// launched afterwards tries to reach the network through this process. If we
// vanish without clearing those variables, newly launched apps lose HTTPS —
// not just Codex. So:
//   * enabling writes a marker file recording exactly what we set;
//   * every exit path clears the environment, synchronously;
//   * startup self-heals: a marker with no live daemon means a previous run
//     died badly, and we clear the variables before doing anything else.
// Teardown is deliberately more defensive than the feature it protects.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { CONFIG_DIR } = require('./config');

const CA_DIR = path.join(CONFIG_DIR, 'ca');
const CA_KEY = path.join(CA_DIR, 'blaze-ca.key');
const CA_CERT = path.join(CA_DIR, 'blaze-ca.pem');
const LEAF_DIR = path.join(CA_DIR, 'leaves');
const MARKER = path.join(CONFIG_DIR, 'transparent-active.json');

// Variables we set machine-wide for GUI apps. Kept in one place so teardown
// can never drift from setup.
const ENV_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'WSS_PROXY', 'NO_PROXY', 'CODEX_CA_CERTIFICATE'];

function launchctl(args) {
  execFileSync('/bin/launchctl', args, { timeout: 5000, stdio: 'ignore' });
}

// ————— teardown (the part that must never fail) —————

function clearEnv() {
  if (process.platform !== 'darwin') return false;
  let cleared = false;
  for (const name of ENV_VARS) {
    try { launchctl(['unsetenv', name]); cleared = true; } catch { /* keep going: clear as much as possible */ }
  }
  try { fs.unlinkSync(MARKER); } catch { /* already gone */ }
  return cleared;
}

function markerExists() {
  try { fs.accessSync(MARKER); return true; } catch { return false; }
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { return null; }
}

// Called at startup before anything else. If a marker survives from a previous
// process, that process is gone — its proxy vars point at nothing.
function selfHealOnStart() {
  if (!markerExists()) return false;
  const marker = readMarker();
  if (marker && marker.pid && processAlive(marker.pid)) return false; // another live daemon owns it
  console.error('blaze-proxy: found stale transparent-mode environment from a previous run — clearing it');
  clearEnv();
  return true;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Register teardown on every exit path we can observe. SIGKILL cannot be
// caught — that case is covered by selfHealOnStart() on the next launch.
let hooksInstalled = false;
function installTeardownHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const teardown = () => { if (markerExists()) clearEnv(); };
  process.on('exit', teardown);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => { teardown(); process.exit(0); });
  }
  process.on('uncaughtException', (err) => {
    console.error(`blaze-proxy: uncaught exception with transparent mode active: ${err?.stack || err}`);
    teardown();
    process.exit(1);
  });
}

// ————— CA lifecycle —————

function caExists() {
  try { fs.accessSync(CA_KEY); fs.accessSync(CA_CERT); return true; } catch { return false; }
}

function ensureCA() {
  if (caExists()) return { key: CA_KEY, cert: CA_CERT, created: false };
  fs.mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(LEAF_DIR, { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/openssl', ['genrsa', '-out', CA_KEY, '2048'], { timeout: 30000, stdio: 'ignore' });
  fs.chmodSync(CA_KEY, 0o600); // the CA key is a high-value local secret
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-new', '-nodes', '-key', CA_KEY, '-sha256', '-days', '365',
    '-out', CA_CERT, '-subj', '/CN=Blaze Proxy Local CA/O=Blaze Proxy'
  ], { timeout: 30000, stdio: 'ignore' });
  fs.chmodSync(CA_CERT, 0o644);
  return { key: CA_KEY, cert: CA_CERT, created: true };
}

function deleteCA() {
  try { fs.rmSync(CA_DIR, { recursive: true, force: true }); return true; } catch { return false; }
}

// Mint (and cache) a leaf certificate for one hostname, signed by our CA.
const leafCache = new Map();
function leafFor(hostname) {
  if (leafCache.has(hostname)) return leafCache.get(hostname);
  const safe = hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  const keyPath = path.join(LEAF_DIR, `${safe}.key`);
  const certPath = path.join(LEAF_DIR, `${safe}.pem`);
  const cnfPath = path.join(LEAF_DIR, `${safe}.cnf`);

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(LEAF_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cnfPath,
      `[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=DNS:${hostname}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    execFileSync('/usr/bin/openssl', ['genrsa', '-out', keyPath, '2048'], { timeout: 30000, stdio: 'ignore' });
    fs.chmodSync(keyPath, 0o600);
    const csrPath = path.join(LEAF_DIR, `${safe}.csr`);
    execFileSync('/usr/bin/openssl', ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=${hostname}`], { timeout: 30000, stdio: 'ignore' });
    execFileSync('/usr/bin/openssl', [
      'x509', '-req', '-in', csrPath, '-CA', CA_CERT, '-CAkey', CA_KEY, '-CAcreateserial',
      '-out', certPath, '-days', '365', '-sha256', '-extfile', cnfPath, '-extensions', 'ext'
    ], { timeout: 30000, stdio: 'ignore' });
    try { fs.unlinkSync(csrPath); } catch { /* best effort */ }
  }
  const pair = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  leafCache.set(hostname, pair);
  return pair;
}

// ————— enable / disable —————

function enable(port) {
  if (process.platform !== 'darwin') throw new Error('transparent mode currently supports macOS only');
  const ca = ensureCA();
  installTeardownHooks();
  const proxyUrl = `http://127.0.0.1:${port}`;
  launchctl(['setenv', 'HTTPS_PROXY', proxyUrl]);
  launchctl(['setenv', 'HTTP_PROXY', proxyUrl]);
  launchctl(['setenv', 'ALL_PROXY', proxyUrl]);
  launchctl(['setenv', 'WSS_PROXY', proxyUrl]);
  launchctl(['setenv', 'NO_PROXY', '127.0.0.1,localhost']);
  launchctl(['setenv', 'CODEX_CA_CERTIFICATE', CA_CERT]);
  fs.writeFileSync(MARKER, JSON.stringify({
    pid: process.pid, port, enabledAt: new Date().toISOString(), vars: ENV_VARS, caCert: CA_CERT
  }, null, 2) + '\n');
  return { proxyUrl, caCert: CA_CERT, caCreated: ca.created };
}

function disable({ removeCA = false } = {}) {
  const cleared = clearEnv();
  const removed = removeCA ? deleteCA() : false;
  return { cleared, caRemoved: removed };
}

// ————— doctor —————

function envValue(name) {
  try {
    return execFileSync('/bin/launchctl', ['getenv', name], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return ''; }
}

function doctor(port) {
  const checks = [];
  const marker = readMarker();
  const proxyUrl = `http://127.0.0.1:${port}`;

  const httpsProxy = envValue('HTTPS_PROXY');
  checks.push({
    name: 'HTTPS_PROXY points at this daemon',
    ok: httpsProxy === proxyUrl,
    detail: httpsProxy || '(unset)'
  });
  const caEnv = envValue('CODEX_CA_CERTIFICATE');
  checks.push({ name: 'CODEX_CA_CERTIFICATE set', ok: Boolean(caEnv), detail: caEnv || '(unset)' });
  checks.push({ name: 'CA files present', ok: caExists(), detail: caExists() ? CA_CERT : 'not generated' });

  let caExpiry = null;
  if (caExists()) {
    try {
      const out = execFileSync('/usr/bin/openssl', ['x509', '-enddate', '-noout', '-in', CA_CERT], { encoding: 'utf8', timeout: 5000 });
      caExpiry = out.replace('notAfter=', '').trim();
      checks.push({ name: 'CA not expired', ok: new Date(caExpiry) > new Date(), detail: caExpiry });
    } catch { /* openssl unavailable */ }
  }
  checks.push({
    name: 'marker owned by this process',
    ok: Boolean(marker) && marker.pid === process.pid,
    detail: marker ? `pid ${marker.pid}` : '(no marker)'
  });
  return { checks, marker, caExpiry };
}

// Was a client process started BEFORE the env was set? launchctl env only
// reaches processes launched afterwards, and this staleness has caused real
// confusion (an 18-hour-old Codex ignoring current settings).
function staleClients(marker) {
  if (!marker?.enabledAt) return [];
  const since = new Date(marker.enabledAt).getTime();
  const stale = [];
  try {
    const ps = execFileSync('/bin/ps', ['-Ao', 'pid,lstart,comm'], { encoding: 'utf8', timeout: 5000 });
    for (const line of ps.split('\n')) {
      if (!/codex|ChatGPT/i.test(line)) continue;
      const m = line.trim().match(/^(\d+)\s+(.{24})\s+(.*)$/);
      if (!m) continue;
      const started = new Date(m[2]).getTime();
      if (Number.isFinite(started) && started < since) stale.push({ pid: Number(m[1]), started: m[2].trim(), command: m[3] });
    }
  } catch { /* ps unavailable */ }
  return stale;
}

module.exports = {
  CA_DIR, CA_CERT, CA_KEY, MARKER, ENV_VARS,
  ensureCA, caExists, deleteCA, leafFor,
  enable, disable, clearEnv, selfHealOnStart, installTeardownHooks,
  doctor, staleClients, markerExists, readMarker
};
