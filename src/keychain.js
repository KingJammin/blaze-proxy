'use strict';

const { execFileSync } = require('child_process');

let cached;
let warnedNoKeychain = false;

function clearCache() { cached = undefined; }

// Resolve the bearer key for the configured endpoint.
// Order: explicit env override → config value → macOS keychain lookup.
function endpointKey(cfg) {
  if (process.env.BLAZE_ENDPOINT_KEY) return process.env.BLAZE_ENDPOINT_KEY;
  const auth = cfg.endpointAuth || {};
  if (auth.type === 'value' && auth.value) return auth.value;
  if (auth.type === 'keychain') {
    if (cached !== undefined) return cached;
    if (process.platform !== 'darwin') {
      // Silently returning '' here looks like "no key configured" and sends
      // people hunting the wrong problem. Say what to do instead, once.
      if (!warnedNoKeychain) {
        warnedNoKeychain = true;
        console.error(`blaze-proxy: config wants the macOS keychain but this is ${process.platform} — set BLAZE_ENDPOINT_KEY, or endpointAuth {"type":"value"} in config.`);
      }
      cached = '';
      return cached;
    }
    try {
      cached = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-a', auth.account || process.env.USER,
        '-s', auth.service,
        '-w'
      ], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      cached = '';
    }
    return cached;
  }
  return '';
}

// Store a new outbound key where the current endpointAuth reads from:
// macOS keychain when configured (and available), else the config file.
// Returns 'keychain' or 'config'; on 'config' the caller must persist cfg.
function storeEndpointKey(cfg, key) {
  clearCache();
  const auth = cfg.endpointAuth || {};
  if (auth.type === 'keychain' && process.platform === 'darwin') {
    execFileSync('/usr/bin/security', [
      'add-generic-password', '-U',
      '-a', auth.account || process.env.USER,
      '-s', auth.service,
      '-w', key
    ], { timeout: 5000 });
    return 'keychain';
  }
  cfg.endpointAuth = { type: 'value', value: key };
  return 'config';
}

// Safe descriptor for the UI: never the key itself.
function describeEndpointKey(cfg) {
  const key = endpointKey(cfg);
  if (!key) return { set: false };
  return { set: true, last4: key.slice(-4) };
}

module.exports = { endpointKey, storeEndpointKey, describeEndpointKey, clearCache };
