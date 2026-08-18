'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { patchModelCards } = require('../src/proxy');

function catalog() {
  return Buffer.from(JSON.stringify({
    models: [
      { slug: 'gpt-5.6-terra', use_responses_lite: true, context_window: 400000, truncation_policy: { mode: 'tokens', limit: 10000 } },
      { slug: 'gpt-5.6-luna', use_responses_lite: true, context_window: 272000 },
      { slug: 'gpt-5.3-codex-spark', use_responses_lite: true, context_window: 128000 },
      { slug: 'gpt-5.2-codex', use_responses_lite: true, context_window: 272000 }
    ],
    data: [
      { id: 'gpt-5.6-terra', use_responses_lite: true }
    ]
  }));
}

function cfgWith(overrides) {
  return {
    routeAll: false,
    providers: [
      { id: 'openai', models: [
        { id: 'gpt-5.6-terra', route: true },
        { id: 'gpt-5.6-luna', route: false },
        { id: 'gpt-5.3-codex-spark', route: true }
      ]}
    ],
    modelCardPatches: {
      'gpt-5.3-codex-spark': { context_window: 1048576, use_responses_lite: false }
    },
    ...overrides
  };
}

function parse(buf) { return JSON.parse(buf.toString('utf8')); }
function card(data, slug) { return data.models.find((m) => m.slug === slug); }

test('routed models get use_responses_lite forced off (WS-gap fix)', () => {
  const out = parse(patchModelCards(cfgWith({}), catalog()));
  assert.strictEqual(card(out, 'gpt-5.6-terra').use_responses_lite, false, 'routed terra forced to HTTP');
  assert.strictEqual(card(out, 'gpt-5.3-codex-spark').use_responses_lite, false, 'routed spark forced to HTTP');
});

test('unrouted models keep their upstream transport', () => {
  const out = parse(patchModelCards(cfgWith({}), catalog()));
  assert.strictEqual(card(out, 'gpt-5.6-luna').use_responses_lite, true, 'unrouted luna untouched');
  assert.strictEqual(card(out, 'gpt-5.2-codex').use_responses_lite, true, 'unknown-to-config model untouched');
});

test('routeAll forces HTTP for every card, even models not in config', () => {
  const out = parse(patchModelCards(cfgWith({ routeAll: true }), catalog()));
  for (const slug of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex-spark', 'gpt-5.2-codex']) {
    assert.strictEqual(card(out, slug).use_responses_lite, false, `${slug} forced to HTTP under routeAll`);
  }
});

test('static modelCardPatches still apply and win on conflicts', () => {
  const out = parse(patchModelCards(cfgWith({}), catalog()));
  assert.strictEqual(card(out, 'gpt-5.3-codex-spark').context_window, 1048576);
});

test('cards are patched in place — upstream-only fields survive', () => {
  const out = parse(patchModelCards(cfgWith({}), catalog()));
  assert.deepStrictEqual(card(out, 'gpt-5.6-terra').truncation_policy, { mode: 'tokens', limit: 10000 },
    'fields we never mention must pass through untouched');
});

test('data[] array (id-keyed) is patched too', () => {
  const out = parse(patchModelCards(cfgWith({}), catalog()));
  assert.strictEqual(out.data.find((m) => m.id === 'gpt-5.6-terra').use_responses_lite, false);
});

test('non-JSON body passes through unchanged', () => {
  const junk = Buffer.from('<html>upstream error page</html>');
  assert.strictEqual(patchModelCards(cfgWith({}), junk), junk);
});
