'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { controlAllowed } = require('../src/proxy');

test('loopback callers are always allowed, token or not', () => {
  assert.strictEqual(controlAllowed({ controlToken: '' }, '127.0.0.1', ''), true);
  assert.strictEqual(controlAllowed({ controlToken: 'secret' }, '127.0.0.1', ''), true, 'loopback needs no token even when one is set');
  assert.strictEqual(controlAllowed({ controlToken: '' }, '::1', ''), true);
  assert.strictEqual(controlAllowed({ controlToken: '' }, '::ffff:127.0.0.1', ''), true);
});

test('remote callers are refused when no token is configured', () => {
  assert.strictEqual(controlAllowed({ controlToken: '' }, '192.168.0.50', ''), false);
  assert.strictEqual(controlAllowed({}, '10.0.0.7', 'Bearer anything'), false, 'no token configured = no remote control, ever');
});

test('remote callers need the exact bearer token', () => {
  const cfg = { controlToken: 's3cret' };
  assert.strictEqual(controlAllowed(cfg, '192.168.0.50', 'Bearer s3cret'), true);
  assert.strictEqual(controlAllowed(cfg, '192.168.0.50', 'Bearer wrong'), false);
  assert.strictEqual(controlAllowed(cfg, '192.168.0.50', 's3cret'), false, 'must be a Bearer header, not a bare value');
  assert.strictEqual(controlAllowed(cfg, '192.168.0.50', ''), false);
});
