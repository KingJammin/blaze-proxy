'use strict';

// Transparent mode makes blaze the machine's HTTPS proxy. If it dies without
// clearing those variables, apps launched afterwards lose HTTPS. These tests
// cover the teardown contract, not the feature — teardown is the part that
// must never fail. They never call enable(), so no machine env is touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-tp-'));
// MANDATORY: launchctl is machine-global. Without this, clearEnv() inside a
// test unsets the developer's own HTTPS_PROXY/CODEX_CA_CERTIFICATE — which is
// exactly how a test run once disabled transparent mode on a live machine.
process.env.BLAZE_NO_MACHINE_ENV = '1';

const { test } = require('node:test');
const assert = require('node:assert');
const transparent = require('../src/transparent');
const { INTERCEPT_HOSTS, RESPONSES_RE } = require('../src/mitm');

function writeMarker(pid) {
  fs.mkdirSync(path.dirname(transparent.MARKER), { recursive: true });
  fs.writeFileSync(transparent.MARKER, JSON.stringify({ pid, port: 8799, enabledAt: new Date().toISOString() }));
}

test('a marker from a dead process is cleaned up at startup', () => {
  // pid 2^22 is above the macOS default max — reliably not a live process.
  writeMarker(4194303);
  const healed = transparent.selfHealOnStart();
  assert.strictEqual(healed, true, 'stale marker must trigger a cleanup');
  assert.strictEqual(transparent.markerExists(), false, 'marker removed');
});

test('a marker owned by a LIVE process is left alone', () => {
  writeMarker(process.pid);
  const healed = transparent.selfHealOnStart();
  assert.strictEqual(healed, false, 'another live daemon owns transparent mode — do not steal it');
  assert.strictEqual(transparent.markerExists(), true);
  fs.unlinkSync(transparent.MARKER);
});

test('no marker means nothing to heal', () => {
  assert.strictEqual(transparent.markerExists(), false);
  assert.strictEqual(transparent.selfHealOnStart(), false);
});

test('every variable we set is also a variable we clear', () => {
  // Drift between setup and teardown is how machines get stranded.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'transparent.js'), 'utf8');
  const setVars = [...src.matchAll(/launchctl\(\['setenv',\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(setVars.length >= 5, `expected several setenv calls, found ${setVars.length}`);
  for (const name of setVars) {
    assert.ok(transparent.ENV_VARS.includes(name), `${name} is set but missing from ENV_VARS, so teardown would leave it behind`);
  }
});

test('teardown hooks are registered for every catchable exit path', () => {
  transparent.installTeardownHooks();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    assert.ok(process.listenerCount(sig) > 0, `no teardown handler for ${sig}`);
  }
  assert.ok(process.listenerCount('exit') > 0, 'no teardown handler for exit');
  assert.ok(process.listenerCount('uncaughtException') > 0, 'a crash must still clear the machine proxy');
});

test('installTeardownHooks is idempotent (no listener leak on repeat calls)', () => {
  const before = process.listenerCount('SIGTERM');
  transparent.installTeardownHooks();
  transparent.installTeardownHooks();
  assert.strictEqual(process.listenerCount('SIGTERM'), before);
});

test('doctor passes when a DIFFERENT live process owns the marker (CLI case)', () => {
  // The CLI runs the doctor from its own process; comparing marker.pid to
  // process.pid reported FAIL on a perfectly healthy machine.
  writeMarker(process.ppid || process.pid); // a live pid that isn't necessarily us
  const report = transparent.doctor(8799);
  const check = report.checks.find((c) => /marker owned/.test(c.name));
  assert.strictEqual(check.ok, true, 'a live owner must pass regardless of who runs the doctor');
  assert.strictEqual(report.ownerAlive, true);
  fs.unlinkSync(transparent.MARKER);
});

test('doctor fails — correctly — when the marker owner is dead', () => {
  writeMarker(4194303);
  const report = transparent.doctor(8799);
  const check = report.checks.find((c) => /marker owned/.test(c.name));
  assert.strictEqual(check.ok, false, 'a dead owner means the machine proxy is stranded');
  assert.match(check.detail, /NOT RUNNING/);
  fs.unlinkSync(transparent.MARKER);
});

test('every test file touching transparent.js must opt out of machine env', () => {
  // Guard against the regression directly: a test file that calls into
  // transparent.js without BLAZE_NO_MACHINE_ENV=1 will mutate the developer's
  // real launchctl environment.
  const testDir = __dirname;
  for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(testDir, file), 'utf8');
    if (!/require\(.*transparent.*\)|require\(.*mitm.*\)/.test(src)) continue;
    assert.match(src, /BLAZE_NO_MACHINE_ENV\s*=\s*'1'/,
      `${file} exercises transparent/mitm but does not set BLAZE_NO_MACHINE_ENV=1`);
  }
});

test('launchctl is a no-op while BLAZE_NO_MACHINE_ENV=1', () => {
  // clearEnv() must be safe to call in tests: it should report "nothing
  // cleared" rather than reaching the machine.
  assert.strictEqual(process.env.BLAZE_NO_MACHINE_ENV, '1');
  assert.doesNotThrow(() => transparent.clearEnv());
});

test('only OpenAI hosts are decrypted; everything else is blind-tunneled', () => {
  for (const host of ['chatgpt.com', 'api.openai.com', 'auth.openai.com']) {
    assert.ok(INTERCEPT_HOSTS.test(host), `${host} should be intercepted`);
  }
  for (const host of ['api.anthropic.com', 'github.com', 'bank.example.com', 'notopenai.com', 'chatgpt.com.evil.net']) {
    assert.ok(!INTERCEPT_HOSTS.test(host), `${host} must NOT be decrypted — blast radius`);
  }
});

test('the WS refusal uses 426, the only code that downgrades silently', () => {
  // Measured against the real client: 426 → one attempt, silent fallback;
  // 501/403/404 → seven attempts plus a user-visible warning; 400 → the
  // client gives up and the request fails outright.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mitm.js'), 'utf8');
  assert.match(src, /HTTP\/1\.1 426 Upgrade Required/, 'WS refusal must be 426');
  assert.ok(!/HTTP\/1\.1 (501|400|403|404)[^\n]*\r\\n/.test(src.replace(/\/\/.*$/gm, '')),
    'no other rejection code should be written on the upgrade path');
});

test('the responses path is recognised in both Codex and OpenAI shapes', () => {
  assert.ok(RESPONSES_RE.test('/backend-api/codex/responses'));
  assert.ok(RESPONSES_RE.test('/v1/responses'));
  assert.ok(!RESPONSES_RE.test('/backend-api/codex/models'));
});

// ————— containerised clients —————
// An absolute path is not universal: Parall virtualises HOME, so
// /Users/<me>/.blaze-proxy/ca/blaze-ca.pem resolves INSIDE the container and
// is missing there. A daemon-side readability check cannot detect this.

test('CA is mirrored into container roots (public cert only, never the key)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-container-'));
  const parent = path.join(fakeHome, 'Library', 'Application Support', 'Parall');
  fs.mkdirSync(path.join(parent, 'ChatGPT (Test)'), { recursive: true });

  // Point the module's container scan at the fake home.
  const original = os.homedir;
  os.homedir = () => fakeHome;
  try {
    delete require.cache[require.resolve('../src/transparent')];
    const t2 = require('../src/transparent');
    t2.ensureCA();
    const results = t2.mirrorCAIntoContainers();
    assert.ok(results.length >= 1, 'the container should be found');
    for (const r of results) {
      assert.strictEqual(r.ok, true, r.error);
      assert.ok(fs.existsSync(r.target), 'the cert must exist where the container will look');
      assert.ok(fs.readFileSync(r.target, 'utf8').includes('BEGIN CERTIFICATE'));
      const keyBeside = path.join(path.dirname(r.target), 'blaze-ca.key');
      assert.ok(!fs.existsSync(keyBeside), 'the PRIVATE KEY must never be copied into an app container');
    }
    // and disabling cleans them up
    t2.unmirrorCA();
    for (const r of results) assert.ok(!fs.existsSync(r.target), 'mirrors must be removed on disable');
  } finally {
    os.homedir = original;
    delete require.cache[require.resolve('../src/transparent')];
  }
});

// ————— configs that bypass transparent mode —————
// A client pointed at blaze's own port with the NATIVE provider opens a
// WebSocket to the main listener, which can only tunnel it — so traffic
// reaches the provider while transparent mode reports healthy. Containerised
// builds read <container>/.codex/config.toml, so one machine had FOUR configs
// and only the first was ever edited.

test('a config with openai_base_url pointing at blaze is flagged', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-shadow-'));
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'),
    'model = "gpt-5.6-luna"\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:8789/v1"\n');
  // and a container config, the one people forget
  const container = path.join(fakeHome, 'Library', 'Application Support', 'Parall', 'ChatGPT (X)', '.codex');
  fs.mkdirSync(container, { recursive: true });
  fs.writeFileSync(path.join(container, 'config.toml'), 'openai_base_url = "http://localhost:8789/v1"\n');

  const original = os.homedir;
  os.homedir = () => fakeHome;
  try {
    delete require.cache[require.resolve('../src/transparent')];
    const t2 = require('../src/transparent');
    const hits = t2.shadowingConfigs(8789);
    assert.strictEqual(hits.length, 2, 'both the home config AND the container config must be found');
    assert.ok(hits.every((h) => h.severity === 'bypass'));
    assert.ok(hits.some((h) => h.file.includes('Parall')), 'the container config is the one people miss');
  } finally {
    os.homedir = original;
    delete require.cache[require.resolve('../src/transparent')];
  }
});

test('a custom-provider config pointing at blaze is NOT flagged', () => {
  // wire_api="responses" has no WebSocket path, so it routes correctly —
  // flagging it would train people to ignore the warning.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-shadow2-'));
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'blaze.config.toml'),
    'model_provider = "blaze_local"\n[model_providers.blaze_local]\nbase_url = "http://127.0.0.1:8789/v1"\nwire_api = "responses"\n');
  const original = os.homedir;
  os.homedir = () => fakeHome;
  try {
    delete require.cache[require.resolve('../src/transparent')];
    const t2 = require('../src/transparent');
    assert.strictEqual(t2.shadowingConfigs(8789).length, 0);
  } finally {
    os.homedir = original;
    delete require.cache[require.resolve('../src/transparent')];
  }
});

test('commented-out settings are ignored', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-shadow3-'));
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'),
    '# openai_base_url = "http://127.0.0.1:8789/v1"\nmodel = "x"\n');
  const original = os.homedir;
  os.homedir = () => fakeHome;
  try {
    delete require.cache[require.resolve('../src/transparent')];
    const t2 = require('../src/transparent');
    assert.strictEqual(t2.shadowingConfigs(8789).length, 0);
  } finally {
    os.homedir = original;
    delete require.cache[require.resolve('../src/transparent')];
  }
});

// ————— platform honesty —————

test('the macOS guard permits macOS and refuses anything else', () => {
  const platform = require('../src/platform');
  if (platform.IS_MAC) {
    assert.doesNotThrow(() => platform.requireMac('Transparent mode'), 'must not block the platform it supports');
  } else {
    assert.throws(() => platform.requireMac('Transparent mode'), /macOS-only/);
  }
  // The refusal message must point somewhere useful on every platform, so
  // check the text itself rather than only the throw.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform.js'), 'utf8');
  assert.match(src, /BLAZE_ENDPOINT_KEY/, 'the guard should name the workaround');
  assert.match(src, /macOS-only/);
});

test('capabilities never claim support for OS features off macOS', () => {
  const platform = require('../src/platform');
  const caps = platform.capabilities();
  assert.strictEqual(caps.coreRouting.supported, true, 'the router is portable and must say so');
  assert.strictEqual(caps.apiKeystore.supported, true);
  if (!platform.IS_MAC) {
    for (const key of ['transparentMode', 'osCredentialStore', 'clientDiscovery', 'caGeneration']) {
      assert.strictEqual(caps[key].supported, false, `${key} must not claim support on ${process.platform}`);
    }
  }
});
