'use strict';

const { execFileSync } = require('child_process');

let cached;

// Resolve the bearer key for the configured endpoint.
// Order: explicit env override → config value → macOS keychain lookup.
function endpointKey(cfg) {
  if (process.env.BLAZE_ENDPOINT_KEY) return process.env.BLAZE_ENDPOINT_KEY;
  const auth = cfg.endpointAuth || {};
  if (auth.type === 'value' && auth.value) return auth.value;
  if (auth.type === 'keychain') {
    if (cached !== undefined) return cached;
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

module.exports = { endpointKey };
