'use strict';

// API keystore for the MCP gateway. Plaintext keys are shown ONCE at issuance
// and never stored — only sha256 hashes land in ~/.blaze-proxy/keys.json.
// The file is re-read whenever its mtime changes, so revocation takes effect
// without restarting the daemon.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { CONFIG_DIR } = require('./config');

const KEYS_PATH = path.join(CONFIG_DIR, 'keys.json');

let cache = { mtimeMs: -1, records: [] };

function loadRecords() {
  let stat;
  try {
    stat = fs.statSync(KEYS_PATH);
  } catch {
    cache = { mtimeMs: -1, records: [] };
    return cache.records;
  }
  if (stat.mtimeMs !== cache.mtimeMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
      cache = { mtimeMs: stat.mtimeMs, records: Array.isArray(parsed) ? parsed : [] };
    } catch (err) {
      // Corrupt keystore: FAIL CLOSED (no keys validate) rather than throwing
      // in the request path, and say so once per change.
      console.error(`blaze-proxy: unreadable keystore at ${KEYS_PATH}: ${err.message} — all keys treated as invalid`);
      cache = { mtimeMs: stat.mtimeMs, records: [] };
    }
  }
  return cache.records;
}

function saveRecords(records) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = KEYS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, KEYS_PATH);
  cache = { mtimeMs: -1, records: [] }; // force re-read next access
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Issue a new key. Returns { plaintext, record } — plaintext exists only in
// this return value; print it once and let it go.
function issue(name) {
  if (!name || !/^[\w.-]{1,64}$/.test(name)) {
    throw new Error('key name must be 1-64 chars of letters, digits, dot, dash, underscore');
  }
  const records = [...loadRecords()];
  if (records.some((r) => r.name === name && !r.revokedAt)) {
    throw new Error(`an active key named "${name}" already exists — revoke it first or pick another name`);
  }
  const plaintext = 'bzp_' + crypto.randomBytes(32).toString('base64url');
  const record = {
    id: crypto.randomUUID(),
    name,
    keySha256: sha256Hex(plaintext),
    createdAt: new Date().toISOString(),
    revokedAt: null
  };
  records.push(record);
  saveRecords(records);
  return { plaintext, record };
}

// Revoke by id (exact) or name (all active keys with that name).
function revoke({ id, name }) {
  const records = [...loadRecords()];
  let hit = 0;
  for (const r of records) {
    if (r.revokedAt) continue;
    if ((id && r.id === id) || (name && r.name === name)) {
      r.revokedAt = new Date().toISOString();
      hit++;
    }
  }
  if (hit === 0) throw new Error('no active key matched');
  saveRecords(records);
  return hit;
}

function list() {
  return loadRecords().map(({ id, name, createdAt, revokedAt }) => ({ id, name, createdAt, revokedAt }));
}

// Validate a bearer value. Returns the matching active record or null.
function validate(bearer) {
  if (!bearer || typeof bearer !== 'string') return null;
  const digest = sha256Hex(bearer);
  const digestBuf = Buffer.from(digest, 'hex');
  for (const r of loadRecords()) {
    if (r.revokedAt || !r.keySha256) continue;
    const recordBuf = Buffer.from(r.keySha256, 'hex');
    if (recordBuf.length === digestBuf.length && crypto.timingSafeEqual(recordBuf, digestBuf)) {
      return r;
    }
  }
  return null;
}

module.exports = { KEYS_PATH, issue, revoke, list, validate };
