'use strict';

// The failure-capture hook records conversation content, so its OFF-by-default
// behaviour matters as much as its on behaviour.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BLAZE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-cap-'));

const { test } = require('node:test');
const assert = require('node:assert');
const capture = require('../src/capture');

const SAMPLE = {
  model: 'gpt-5.6-luna',
  dest: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  status: 400,
  requestBody: JSON.stringify({ model: 'x', input: [{ role: 'user', content: 'secret prompt' }] }),
  responseBody: '{"message":"cannot pickle ValidatorIterator","code":400}'
};

test('disabled by default — nothing is written', () => {
  assert.strictEqual(capture.enabled({}), false);
  assert.strictEqual(capture.record({}, SAMPLE), null);
  assert.strictEqual(fs.existsSync(capture.CAPTURE_DIR), false, 'no directory should even be created');
});

test('enabled: writes request AND response, mode 600', () => {
  const file = capture.record({ captureFailures: true }, SAMPLE);
  assert.ok(file, 'a capture file should be returned');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.status, 400);
  assert.strictEqual(saved.model, 'gpt-5.6-luna');
  assert.deepStrictEqual(saved.request.input[0].content, 'secret prompt', 'request body is the whole point');
  assert.match(saved.response, /cannot pickle/);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'conversation content must not be world-readable');
});

test('capture never throws, even on unserialisable input', () => {
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => capture.record({ captureFailures: true }, { ...SAMPLE, requestBody: circular }));
});

test('non-JSON request bodies are kept as raw text', () => {
  const file = capture.record({ captureFailures: true }, { ...SAMPLE, requestBody: 'not json at all' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.request, 'not json at all');
});

test('file count is bounded so it cannot fill the disk', () => {
  for (let i = 0; i < 210; i++) capture.record({ captureFailures: true }, { ...SAMPLE, status: 400 + (i % 5) });
  const files = fs.readdirSync(capture.CAPTURE_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length <= 200, `expected the directory to stay bounded, found ${files.length}`);
});
