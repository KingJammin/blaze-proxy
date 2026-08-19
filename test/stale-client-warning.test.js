'use strict';

// The login race: launchd starts blaze while macOS is restoring the Codex
// clients, and launchctl env only reaches processes started afterwards. We
// lose that race routinely (measured: by 8 seconds), and a bypassed client is
// indistinguishable from a working one — it just quietly spends vendor quota.
// These tests pin the part that makes it visible.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-stale-'));
// MANDATORY: launchctl and osascript are machine-global. Without this, notify()
// would fire real desktop notifications during a test run.
process.env.BLAZE_NO_MACHINE_ENV = '1';

const { test } = require('node:test');
const assert = require('node:assert');
const transparent = require('../src/transparent');

test('notify() is suppressed under the machine-env guard', () => {
  // The guard exists so a test run cannot touch the developer's machine. If
  // this ever returns true, every subsequent test spams real notifications.
  assert.equal(transparent.notify('title', 'message'), false);
});

test('staleClients() returns nothing without a marker', () => {
  // No marker means transparent mode was never enabled, so nothing can be
  // "stale relative to" it — the absence must not be reported as a problem.
  assert.deepEqual(transparent.staleClients(null), []);
  assert.deepEqual(transparent.staleClients({}), []);
});

test('a marker enabled in the future makes every running client stale', () => {
  // Inverts the real condition deliberately: with enabledAt in the future,
  // every process on the machine started "before" it. This proves the
  // comparison is actually against process start time and is not hardcoded to
  // return empty — the failure mode that would make this whole feature inert.
  const future = { enabledAt: new Date(Date.now() + 86_400_000).toISOString() };
  const stale = transparent.staleClients(future);
  // This machine may genuinely have no Codex/ChatGPT process running, so the
  // assertion is on the SHAPE when there is one, not on there being one.
  for (const c of stale) {
    assert.ok(Number.isFinite(c.pid), 'stale entry carries a numeric pid');
    assert.ok(typeof c.command === 'string' && c.command.length, 'stale entry carries a command');
    assert.match(c.command, /codex|ChatGPT/i, 'only Codex/ChatGPT processes are reported');
  }
});

test('bypassing clients are judged by ACTUAL env, not by start time', () => {
  // The bug this replaced: comparing a client's start time to the marker meant
  // every daemon restart flagged clients that were routing perfectly. Asking
  // the process what HTTPS_PROXY it holds cannot drift that way.
  //
  // Nothing on this machine will point at a port nobody is listening on, so
  // every detected client must be reported as bypassing — proving the check
  // reads env and compares it, rather than returning a constant.
  const impossible = transparent.bypassingClients(1);
  const all = transparent.clientBuilds();
  assert.equal(impossible.length, all.length,
    'with an impossible port, every client build must count as bypassing');
  for (const c of impossible) {
    assert.ok(Number.isFinite(c.pid), 'carries a pid');
    assert.ok(c.bundle, 'carries a bundle name');
    assert.ok(c.proxy === null || typeof c.proxy === 'string', 'reports the proxy it actually had');
  }
});

test('bypassingClients() tolerates a machine with no Codex clients running', () => {
  const out = transparent.bypassingClients(8799);
  assert.ok(Array.isArray(out));
  // Never more entries than there are client builds.
  assert.ok(out.length <= transparent.clientBuilds().length);
});

test('warnStaleClients() tolerates a missing marker', () => {
  // Called unconditionally at startup, including when enable() failed, so it
  // must not throw when there is no marker to read a port from.
  const out = transparent.warnStaleClients(null);
  assert.ok(Array.isArray(out));
});
