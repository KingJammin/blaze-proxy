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
const os = require('os');
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
  // launchctl is MACHINE-GLOBAL: BLAZE_CONFIG_DIR isolates our files but not
  // the user's environment. Tests must set BLAZE_NO_MACHINE_ENV=1 or they will
  // silently unset a real user's proxy variables (this happened — a test run
  // disabled transparent mode on a live machine).
  if (process.env.BLAZE_NO_MACHINE_ENV === '1') return;
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

// ————— containerised clients —————
//
// An absolute path does NOT mean the same thing to every process. Codex running
// inside a container (Parall virtualises HOME) resolves
//   /Users/<me>/.blaze-proxy/ca/blaze-ca.pem
// against its own root, i.e. <container>/.blaze-proxy/ca/blaze-ca.pem, which
// does not exist — so the CA is unreachable even though it is absolute,
// tilde-free, and perfectly readable from our namespace. Readability checks run
// from the daemon cannot see this class of failure at all.
//
// Mirroring the CA (public cert only — never the key) into each container root
// is what makes transparent mode genuinely zero-config for these builds.
const CONTAINER_PARENTS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Parall')
];

function containerRoots() {
  const roots = [];
  for (const parent of CONTAINER_PARENTS) {
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      roots.push(path.join(parent, entry.name));
    }
  }
  return roots;
}

// Copy the CA cert to where each containerised client will actually look.
function mirrorCAIntoContainers() {
  if (!caExists()) return [];
  const source = fs.readFileSync(CA_CERT);
  const results = [];
  for (const root of containerRoots()) {
    const target = path.join(root, '.blaze-proxy', 'ca', 'blaze-ca.pem');
    try {
      let identical = false;
      try { identical = fs.readFileSync(target).equals(source); } catch { /* missing */ }
      if (!identical) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, source, { mode: 0o644 }); // public cert, never the key
      }
      results.push({ root, target, ok: true, updated: !identical });
    } catch (err) {
      results.push({ root, target, ok: false, error: err.message });
    }
  }
  return results;
}

// Remove the mirrored copies again, so disabling leaves nothing behind.
function unmirrorCA() {
  const removed = [];
  for (const root of containerRoots()) {
    const dir = path.join(root, '.blaze-proxy');
    try {
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); }
    } catch { /* best effort */ }
  }
  return removed;
}


// ————— clients that bypass transparent mode by talking to blaze directly —————
//
// A client configured with the NATIVE provider pointed at blaze's own port
// (openai_base_url = http://127.0.0.1:<blaze>) opens a WebSocket straight to
// the main listener, where it can only be tunnelled — so every conversation
// reaches the provider while transparent mode reports perfectly healthy,
// because transparent mode IS healthy; it is being bypassed upstream of
// itself. This cost hours once and looks identical to a CA fault, a stale
// process, or a routing mistake, so the tooling should name it.
//
// Containerised builds read <container>/.codex/config.toml, NOT ~/.codex —
// there were four config files on one machine and only the first was edited.
function codexConfigPaths() {
  const paths = [];
  const home = os.homedir();
  const add = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === 'config.toml' || name.endsWith('.config.toml')) paths.push(path.join(dir, name));
    }
  };
  add(path.join(home, '.codex'));
  for (const root of containerRoots()) add(path.join(root, '.codex'));
  return paths;
}

function shadowingConfigs(blazePort) {
  const hits = [];
  const portRe = new RegExp(`127\\.0\\.0\\.1:${blazePort}|localhost:${blazePort}`);
  for (const file of codexConfigPaths()) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('#')) continue;
      // openai_base_url overrides the NATIVE provider, which speaks WebSocket.
      if (/^openai_base_url\s*=/.test(line) && portRe.test(line)) {
        hits.push({ file, line, severity: 'bypass' });
      }
    }
  }
  return hits;
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
  require('./platform').requireMac('Transparent mode');
  const ca = ensureCA();
  // The CA path is consumed by client apps whose HOME is NOT ours — sandboxed
  // and translocated ChatGPT builds resolve a relative or ~-prefixed path
  // against their own container and fail with "No such file or directory".
  // Absolute, literal, no tilde: assert rather than assume.
  if (!path.isAbsolute(CA_CERT) || CA_CERT.includes('~')) {
    throw new Error(`refusing to publish a non-absolute CA path: ${CA_CERT}`);
  }
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
  // Containerised clients resolve our absolute CA path inside their own root.
  const mirrored = mirrorCAIntoContainers();
  return { proxyUrl, caCert: CA_CERT, caCreated: ca.created, mirrored };
}

function disable({ removeCA = false } = {}) {
  const cleared = clearEnv();
  const unmirrored = unmirrorCA(); // never leave stray CAs in app containers
  const removed = removeCA ? deleteCA() : false;
  return { cleared, caRemoved: removed, unmirrored };
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
  checks.push({
    name: 'CODEX_CA_CERTIFICATE set to an absolute path',
    ok: Boolean(caEnv) && path.isAbsolute(caEnv) && !caEnv.includes('~'),
    detail: caEnv || '(unset)'
  });
  // Existence is not enough: client apps run as other bundles/sandboxes and
  // must be able to READ it. A CA that only our process can open still fails.
  let caReadable = false;
  try { fs.accessSync(caEnv || CA_CERT, fs.constants.R_OK); caReadable = true; } catch { /* not readable */ }
  checks.push({
    name: 'CA file exists and is readable',
    ok: caExists() && caReadable,
    detail: caExists() ? (caReadable ? CA_CERT : `${CA_CERT} — NOT READABLE`) : 'not generated'
  });

  let caExpiry = null;
  if (caExists()) {
    try {
      const out = execFileSync('/usr/bin/openssl', ['x509', '-enddate', '-noout', '-in', CA_CERT], { encoding: 'utf8', timeout: 5000 });
      caExpiry = out.replace('notAfter=', '').trim();
      checks.push({ name: 'CA not expired', ok: new Date(caExpiry) > new Date(), detail: caExpiry });
    } catch { /* openssl unavailable */ }
  }
  // The safety question is whether the process that set the machine proxy is
  // still ALIVE — a marker whose owner died means stranded environment. It is
  // NOT "is that me": the CLI runs this doctor from a different process by
  // definition, so comparing against process.pid failed on healthy systems,
  // and a doctor that always shows red is a doctor people stop reading.
  const ownerAlive = Boolean(marker) && processAlive(marker.pid);
  // Containerised clients (Parall) remap our absolute path into their own
  // root, so a daemon-side readability check cannot see their view at all.
  const roots = containerRoots();
  if (roots.length) {
    const missing = roots.filter((r) => {
      try { fs.accessSync(path.join(r, '.blaze-proxy', 'ca', 'blaze-ca.pem'), fs.constants.R_OK); return false; }
      catch { return true; }
    });
    checks.push({
      name: `CA mirrored into ${roots.length} app container(s)`,
      ok: missing.length === 0,
      detail: missing.length === 0
        ? 'all containers have a readable copy'
        : `MISSING in ${missing.length}: ${missing.map((m) => path.basename(m)).join(', ')} — containerised clients resolve /Users/... inside their own root`
    });
  }
  checks.push({
    name: 'marker owned by a live daemon',
    ok: ownerAlive,
    detail: marker
      ? `pid ${marker.pid}${ownerAlive ? (marker.pid === process.pid ? ' (this process)' : ' (running)') : ' — NOT RUNNING: run `blaze-proxy transparent off`'}`
      : '(no marker)'
  });
  return { checks, marker, caExpiry, ownerAlive };
}

// Was a client process started BEFORE the env was set? launchctl env only
// reaches processes launched afterwards, and this staleness has caused real
// confusion (an 18-hour-old Codex ignoring current settings).
// launchctl env is machine-global, so EVERY ChatGPT/Codex build on the box
// points here — including sandboxed or translocated copies with a different
// HOME and different auth. Naming them turns a confusing failure ("No such
// file or directory" against someone else's container) into an obvious one.
function clientBuilds() {
  const builds = [];
  try {
    const ps = execFileSync('/bin/ps', ['-Ao', 'pid,comm'], { encoding: 'utf8', timeout: 5000 });
    for (const line of ps.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*(?:ChatGPT|codex).*)$/i);
      if (!m) continue;
      if (/blaze/i.test(m[2])) continue;
      // Group by app bundle so N helper processes don't look like N installs.
      const bundle = (m[2].match(/^(.*?\.app)\//) || [null, m[2]])[1];
      if (!builds.some((b) => b.bundle === bundle)) builds.push({ pid: Number(m[1]), bundle });
    }
  } catch { /* ps unavailable */ }
  return builds;
}

// A macOS notification is the only channel that reaches the operator when the
// daemon starts at login: nobody is reading a launchd log at 09:55. Best
// effort by design — a machine without osascript, or a notification the user
// has muted, must never keep the proxy from starting.
function notify(title, message) {
  if (process.platform !== 'darwin') return false;
  if (process.env.BLAZE_NO_MACHINE_ENV === '1') return false;
  const esc = (s) => String(s).replace(/[\\"]/g, '\\$&');
  try {
    execFileSync('/usr/bin/osascript',
      ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`],
      { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Which running clients are actually NOT routed.
//
// This asks each process what environment it holds, rather than comparing its
// start time to our marker. Timestamps get this wrong in both directions: every
// daemon restart moves the marker, so clients that already hold the env — and
// are routing perfectly — all look stale at once (observed: the daemon restarted
// and flagged a ChatGPT.app that was demonstrably routed). `ps eww` reports the
// environment a process was actually started with, which is the thing that
// decides whether it reaches us, so it is the only honest test.
//
// Values can contain spaces (CA paths do), so match to the next VAR= boundary
// rather than splitting on whitespace.
function bypassingClients(port) {
  const want = `http://127.0.0.1:${port}`;
  // Judge per BUNDLE across ALL of its processes, not one representative pid.
  // An app accumulates helpers over its lifetime, and a helper started before
  // the env was published holds a different environment from the app that
  // spawned it — so picking any single pid reports whichever one it happened to
  // find first. A build is only genuinely unrouted when NOTHING under it can
  // reach us; if the main process holds the proxy, new conversations route.
  const byBundle = new Map();
  let ps = '';
  try {
    ps = execFileSync('/bin/ps', ['-Ao', 'pid,comm'], { encoding: 'utf8', timeout: 5000 });
  } catch { return []; }

  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*(?:ChatGPT|codex).*)$/i);
    if (!m) continue;
    if (/blaze/i.test(m[2])) continue;
    const pid = Number(m[1]);
    const bundle = (m[2].match(/^(.*?\.app)\//) || [null, m[2]])[1];

    let env = '';
    try {
      env = execFileSync('/bin/ps', ['eww', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    } catch { continue; } // process gone, or not ours to inspect
    // Values contain spaces (CA paths do), so match to the next VAR= boundary.
    const pm = env.match(/HTTPS_PROXY=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\s*$)/);
    const proxy = pm ? pm[1].trim() : '';

    const cur = byBundle.get(bundle) || { bundle, pid, proxy: null, routed: false };
    if (proxy === want) { cur.routed = true; cur.proxy = proxy; cur.pid = pid; }
    byBundle.set(bundle, cur);
  }

  return [...byBundle.values()].filter((b) => !b.routed).map(({ bundle, pid, proxy }) => ({ bundle, pid, proxy: proxy || null }));
}

// The login race: launchctl env only reaches processes started AFTER we set
// it, and at login the Codex clients are restored by macOS at the same moment
// launchd starts us — measured, we lost by 8 seconds. We cannot win that race
// (publishing earlier does not help; the clients are already up), and we will
// not restart someone's apps unasked. What we CAN do is refuse to fail
// silently: a bypassed client burns vendor quota and looks exactly like a
// working one, so say so out loud, at the moment we know.
function warnStaleClients(marker, port) {
  const mitmPort = Number(port || marker?.port) || 8799;
  const bypassing = bypassingClients(mitmPort);
  if (!bypassing.length) return bypassing;
  console.warn(`blaze-proxy: ${bypassing.length} client build(s) have no route to this proxy — THEY WILL USE VENDOR QUOTA:`);
  for (const c of bypassing) {
    console.warn(`  ${c.bundle}  (pid ${c.pid}, HTTPS_PROXY=${c.proxy || 'unset'})`);
  }
  console.warn('blaze-proxy: restart them to route through blaze (`blaze-proxy transparent status` lists every pid)');
  notify('Blaze Proxy — clients not routed',
    `${bypassing.length} Codex/ChatGPT build(s) are going straight to the vendor. Restart them.`);
  return bypassing;
}

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
  doctor, staleClients, warnStaleClients, bypassingClients, notify, clientBuilds, markerExists, readMarker,
  containerRoots, mirrorCAIntoContainers, unmirrorCA, codexConfigPaths, shadowingConfigs
};
