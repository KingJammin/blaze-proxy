'use strict';

// What actually works on the platform we're running on, stated explicitly.
//
// The core router (model rules, /v1/responses, /v1/chat/completions, control
// API, keystore, MCP gateway) is plain Node and portable. Everything that
// reaches into the operating system — machine-wide proxy environment, OS
// credential storage, CA generation and trust, process listing — is currently
// macOS-only. Rather than let a Windows or Linux user discover that one
// failure at a time, report it up front.
//
// Honesty rule for this file: only claim `supported: true` for something that
// has actually been exercised on that platform. Anything written but never run
// there is 'unvalidated', which reads differently from 'supported' on purpose.

const os = require('os');

const PLATFORM = process.platform;
const IS_MAC = PLATFORM === 'darwin';

function capabilities() {
  return {
    platform: PLATFORM,
    // The reason the daemon is worth installing anywhere.
    coreRouting: { supported: true, note: 'plain Node; no OS-specific calls' },
    mcpGateway: { supported: true },
    apiKeystore: { supported: true, note: 'sha256 keystore is pure Node' },

    osCredentialStore: {
      supported: IS_MAC,
      note: IS_MAC
        ? 'macOS keychain via /usr/bin/security'
        : 'no OS credential store on this platform — set BLAZE_ENDPOINT_KEY, or endpointAuth {type:"value"} in config'
    },
    transparentMode: {
      supported: IS_MAC,
      note: IS_MAC
        ? 'launchctl env + env-scoped CA trust (no admin required)'
        : 'macOS only today. A Windows port needs a different mechanism for env delivery, CA generation and CA trust — and on Windows, cert-store trust requires ELEVATION, so it would not keep the no-permission property macOS has.'
    },
    clientDiscovery: {
      supported: IS_MAC,
      note: IS_MAC ? '~/Library/Application Support container roots + /bin/ps' : 'paths and process listing are macOS-specific'
    },
    caGeneration: {
      supported: IS_MAC,
      note: 'requires the openssl binary. Node core cannot issue X.509 certificates (crypto.Certificate is SPKAC only), so a port needs either a bundled cert library or a platform openssl — Windows ships none in PATH by default.'
    }
  };
}

// One-line summary for logs and `status`.
function summary() {
  const caps = capabilities();
  if (IS_MAC) return 'macOS: all features available';
  const usable = ['core routing', 'MCP gateway', 'API keystore'];
  const missing = Object.entries(caps)
    .filter(([, v]) => v && typeof v === 'object' && v.supported === false)
    .map(([k]) => k);
  return `${PLATFORM}: ${usable.join(', ')} available; unavailable: ${missing.join(', ')}`;
}

// Guard for a feature that genuinely cannot work here. Throws a message that
// says what to do instead, rather than failing deeper down with a confusing
// ENOENT on a binary that does not exist.
function requireMac(feature) {
  if (IS_MAC) return;
  throw new Error(
    `${feature} is macOS-only in this release (running on ${PLATFORM}). ` +
    'Core routing works on this platform: point clients at the proxy port directly, ' +
    'and supply the endpoint key via the BLAZE_ENDPOINT_KEY environment variable.'
  );
}

function warnAtStartup(log = console.error) {
  if (IS_MAC) return;
  log(`blaze-proxy: ${summary()}`);
  log('blaze-proxy: transparent mode and OS keychain access are unavailable here; use BLAZE_ENDPOINT_KEY and configure clients directly.');
}

module.exports = { PLATFORM, IS_MAC, capabilities, summary, requireMac, warnAtStartup, homedir: os.homedir };
