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

test('the responses path is recognised in both Codex and OpenAI shapes', () => {
  assert.ok(RESPONSES_RE.test('/backend-api/codex/responses'));
  assert.ok(RESPONSES_RE.test('/v1/responses'));
  assert.ok(!RESPONSES_RE.test('/backend-api/codex/models'));
});
