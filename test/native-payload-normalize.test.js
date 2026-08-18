'use strict';

// Transparent mode forwards Codex's CHATGPT-NATIVE body, which is not the
// public Responses API shape. Passing it through unmodified made vLLM answer
//   400 "cannot pickle 'pydantic_core._pydantic_core.ValidatorIterator' object"
// on EVERY conversation (3/3 transparent failed, 2/2 direct succeeded — same
// model, same daemon, same endpoint; payload shape was the only variable).
// These tests pin the translation.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-norm-'));
process.env.BLAZE_NO_MACHINE_ENV = '1';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeNativePayload } = require('../src/mitm');

// A realistic ChatGPT-native body: standard fields plus ChatGPT-only ones.
function nativeBody() {
  return {
    model: 'gpt-5.6-luna',
    instructions: 'You are Codex.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: true,
    reasoning: { effort: 'medium' },
    text: { verbosity: 'low' },
    tools: [
      { type: 'function', name: 'shell', parameters: { type: 'object' } },
      { type: 'local_shell' },
      { type: 'apply_patch', apply_patch_tool_type: 'freeform' }
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: true,
    // ChatGPT-only from here down — none of these belong to the public API:
    session_id: '01a0-uuid',
    conversation_id: 'conv_123',
    prompt_cache_key: 'abc',
    include: ['reasoning.encrypted_content'],
    safety_identifier: 'sid',
    service_tier: 'default',
    previous_response_id: 'resp_999',
    background: false
  };
}

test('ChatGPT-only fields are dropped', () => {
  const out = normalizeNativePayload(nativeBody());
  for (const gone of ['session_id', 'conversation_id', 'prompt_cache_key', 'include',
    'safety_identifier', 'service_tier', 'previous_response_id', 'background']) {
    assert.ok(!(gone in out), `${gone} must not reach a strict endpoint`);
  }
});

test('everything the Responses API defines survives', () => {
  const out = normalizeNativePayload(nativeBody());
  for (const kept of ['model', 'instructions', 'input', 'stream', 'reasoning', 'text',
    'tool_choice', 'parallel_tool_calls']) {
    assert.ok(kept in out, `${kept} is a real Responses API field and must be preserved`);
  }
  assert.deepStrictEqual(out.input, nativeBody().input, 'conversation content passes through untouched');
  assert.deepStrictEqual(out.reasoning, { effort: 'medium' });
});

test('bespoke ChatGPT tool types are removed, standard ones kept', () => {
  const out = normalizeNativePayload(nativeBody());
  assert.strictEqual(out.tools.length, 1);
  assert.strictEqual(out.tools[0].type, 'function');
  assert.strictEqual(out.tools[0].name, 'shell');
});

test('a tools array of only bespoke types is dropped entirely, not left empty', () => {
  const out = normalizeNativePayload({ model: 'm', input: [], tools: [{ type: 'local_shell' }] });
  assert.ok(!('tools' in out), 'an empty tools array can itself trip strict validators');
});

test('store:true is forced false — a local endpoint has nowhere to persist', () => {
  assert.strictEqual(normalizeNativePayload(nativeBody()).store, false);
});

test('dropped fields are reported once each, for diagnosis', () => {
  const seen = [];
  // Fresh keys so the module-level "announce once" set does not hide them.
  normalizeNativePayload({ model: 'm', input: [], zz_unique_field_a: 1, zz_unique_field_b: 2 }, (k) => seen.push(k));
  assert.deepStrictEqual(seen.sort(), ['zz_unique_field_a', 'zz_unique_field_b']);
});

test('non-object payloads are returned unchanged', () => {
  assert.strictEqual(normalizeNativePayload(null), null);
  assert.strictEqual(normalizeNativePayload('nope'), 'nope');
});

test('the result is JSON-serialisable and carries no ChatGPT-only keys', () => {
  const out = normalizeNativePayload(nativeBody());
  const round = JSON.parse(JSON.stringify(out));
  assert.deepStrictEqual(Object.keys(round).sort(), [
    'input', 'instructions', 'model', 'parallel_tool_calls', 'reasoning',
    'store', 'stream', 'text', 'tool_choice', 'tools'
  ]);
});

// ————— the real trigger: a nested input item, not a top-level field —————
// Peer testing against live vLLM, each field in isolation:
//   plain message input                     200
//   input[].type = "additional_tools"       400  <-- the ONLY failure
//   client_metadata / reasoning.context /
//   text.verbosity / include / prompt_cache_key  200
// A top-level allowlist cannot see it, because it lives inside `input`.

test('an additional_tools input item is removed', () => {
  const out = normalizeNativePayload({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'additional_tools', role: 'system', tools: [] }
    ]
  });
  assert.strictEqual(out.input.length, 1);
  assert.strictEqual(out.input[0].type, 'message');
});

test('tools inside that item are HOISTED, not discarded', () => {
  // Dropping them would trade a loud 400 for silent loss of function calling.
  const out = normalizeNativePayload({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [] },
      { type: 'additional_tools', role: 'system', tools: [
        { name: 'functions', tools: [
          { name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
          { name: 'apply_patch', description: 'edit files', parameters: { type: 'object' } }
        ] },
        { name: 'collaboration', tools: [
          { name: 'ask_user', description: 'ask', parameters: { type: 'object' } }
        ] }
      ] }
    ]
  });
  assert.ok(!out.input.some((i) => i.type === 'additional_tools'), 'the item itself must go');
  assert.ok(Array.isArray(out.tools), 'its tools must survive at top level');
  const names = out.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['apply_patch', 'ask_user', 'shell'],
    'every nested tool is hoisted and flattened across namespaces');
  for (const t of out.tools) {
    assert.strictEqual(t.type, 'function', 'hoisted tools must carry the standard function type');
    assert.ok(t.parameters, 'a function tool needs parameters');
  }
});

test('hoisted tools merge with any existing top-level tools', () => {
  const out = normalizeNativePayload({
    model: 'm',
    tools: [{ type: 'function', name: 'existing', parameters: { type: 'object' } }],
    input: [{ type: 'additional_tools', tools: [{ name: 'hoisted', parameters: { type: 'object' } }] }]
  });
  assert.deepStrictEqual(out.tools.map((t) => t.name).sort(), ['existing', 'hoisted']);
});

test('standard input item types are all preserved', () => {
  const input = [
    { type: 'message', role: 'user', content: [] },
    { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    { type: 'reasoning', summary: [] },
    { type: 'item_reference', id: 'x' },
    { role: 'user', content: 'untyped is a message in practice' }
  ];
  const out = normalizeNativePayload({ model: 'm', input });
  assert.strictEqual(out.input.length, input.length, 'nothing standard may be dropped');
});

test('an unknown input item with no tools is dropped and reported', () => {
  const seen = [];
  const out = normalizeNativePayload(
    { model: 'm', input: [{ type: 'zz_unknown_item_type', foo: 1 }] },
    (k) => seen.push(k)
  );
  assert.strictEqual(out.input.length, 0);
  assert.ok(seen.some((s) => s.includes('zz_unknown_item_type')), 'unknown item types stay visible');
});
