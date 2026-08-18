'use strict';

// Opt-in debug capture for failing intercepted requests.
//
// PRIVACY: these files contain full request bodies — i.e. conversation
// content, prompts, and any code pasted into them. It is therefore:
//   * off unless explicitly enabled in config,
//   * written 0600 into a clearly named directory,
//   * announced loudly in the log whenever it is on,
//   * capped, so it cannot quietly consume the disk.
// It exists to pin down upstream payload bugs (e.g. a vLLM 400 that only a
// specific background-service payload shape triggers) and should be turned
// off again once the trigger is found.

const fs = require('fs');
const path = require('path');

const { CONFIG_DIR } = require('./config');

const CAPTURE_DIR = path.join(CONFIG_DIR, 'failed-requests');
const MAX_FILES = 200;
const MAX_BODY_BYTES = 1024 * 1024;

let announced = false;

function enabled(cfg) {
  return Boolean(cfg?.captureFailures);
}

function announceOnce(cfg) {
  if (!enabled(cfg) || announced) return;
  announced = true;
  console.warn(`blaze-proxy: captureFailures is ON — failing request bodies (conversation content) are being written to ${CAPTURE_DIR}. Turn it off when you're done.`);
}

// Record one failing exchange. Never throws: diagnostics must not break routing.
function record(cfg, { model, dest, status, requestBody, responseBody, note }) {
  if (!enabled(cfg)) return null;
  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true, mode: 0o700 });
    const existing = fs.readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.json')).sort();
    // Bounded: drop the oldest rather than filling the disk.
    while (existing.length >= MAX_FILES) {
      try { fs.unlinkSync(path.join(CAPTURE_DIR, existing.shift())); } catch { break; }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(CAPTURE_DIR, `${stamp}-${status}.json`);
    const clip = (buf) => {
      if (buf == null) return null;
      const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) + '…[truncated]' : text;
    };
    let parsedRequest = null;
    try { parsedRequest = JSON.parse(clip(requestBody)); } catch { /* keep raw only */ }
    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date().toISOString(),
      model, dest, status, note,
      request: parsedRequest ?? clip(requestBody),
      response: clip(responseBody)
    }, null, 2) + '\n', { mode: 0o600 });
    return file;
  } catch {
    return null; // capture is best-effort by design
  }
}

module.exports = { CAPTURE_DIR, enabled, announceOnce, record };
