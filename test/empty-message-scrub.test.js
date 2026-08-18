'use strict';

// Codex driving a CUSTOM provider emits {role:'developer', content:''}, and
// strict endpoints (vLLM) answer 500: "Invalid message for role `developer`".
// Empty message items are dropped before forwarding — but tool calls, which
// legitimately carry no content, must survive.

const { test } = require('node:test');
const assert = require('node:assert');
const { scrubForEndpoint, scrubChatForEndpoint, isEmptyMessageItem } = require('../src/proxy');

test('the exact failing item is recognised as empty', () => {
  assert.strictEqual(isEmptyMessageItem({ role: 'developer', content: '' }), true);
});

test('empty variants are all recognised', () => {
  for (const content of ['', '   ', [], [{ type: 'input_text', text: '' }], [{ type: 'input_text', text: '  ' }], null]) {
    assert.strictEqual(isEmptyMessageItem({ role: 'user', content }), true, `not caught: ${JSON.stringify(content)}`);
  }
});

test('items with real content are kept', () => {
  assert.strictEqual(isEmptyMessageItem({ role: 'user', content: 'hello' }), false);
  assert.strictEqual(isEmptyMessageItem({ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }), false);
  assert.strictEqual(isEmptyMessageItem({ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }), false,
    'non-text parts are content too — never drop them');
});

test('tool-call items (no content field) are never dropped', () => {
  assert.strictEqual(isEmptyMessageItem({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }), false);
  assert.strictEqual(isEmptyMessageItem({ type: 'function_call_output', call_id: 'c1', output: '' }), false);
});

test('responses payload: empty developer message dropped, everything else intact', () => {
  const payload = {
    model: 'gpt-5.6-luna',
    input: [
      { role: 'developer', content: '' },
      { role: 'user', content: [{ type: 'input_text', text: 'Reply with pong' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' }
    ]
  };
  const out = scrubForEndpoint(payload, 'deepseek-ai/DeepSeek-V4-Flash-0731');
  assert.strictEqual(out.model, 'deepseek-ai/DeepSeek-V4-Flash-0731');
  assert.strictEqual(out.input.length, 2, 'only the empty developer message is removed');
  assert.strictEqual(out.input[0].role, 'user');
  assert.strictEqual(out.input[1].type, 'function_call');
});

test('chat/completions payload: empty messages dropped', () => {
  const out = scrubChatForEndpoint({
    model: 'gpt-5.6-luna',
    messages: [
      { role: 'developer', content: '' },
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'pong?' }
    ]
  }, 'local-model');
  assert.strictEqual(out.messages.length, 2);
  assert.deepStrictEqual(out.messages.map((m) => m.role), ['system', 'user']);
  assert.strictEqual(out.model, 'local-model');
});

test('scrub is non-destructive to the caller payload', () => {
  const payload = { model: 'x', input: [{ role: 'developer', content: '' }, { role: 'user', content: 'hi' }] };
  scrubForEndpoint(payload, 'dest');
  assert.strictEqual(payload.input.length, 2, 'original payload must not be mutated');
});
