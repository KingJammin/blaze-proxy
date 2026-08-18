'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.BLAZE_CONFIG_DIR || path.join(os.homedir(), '.blaze-proxy');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// The default destination every routed model points at until changed in the UI.
const DEFAULT_DEST = 'deepseek-ai/DeepSeek-V4-Flash-0731';

const DEFAULTS = {
  port: 8789,
  endpoint: 'https://homeai.benpelo.com/v1',
  endpointAuth: { type: 'keychain', service: 'homeai.benpelo.com', account: 'bpelo' },
  proxyEnabled: true,
  routeAll: false,
  upstreams: {
    responses: 'https://chatgpt.com/backend-api/codex',
    chat: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com'
  },
  providers: [
    {
      id: 'openai', name: 'OpenAI', passthrough: 'chatgpt.com',
      models: [
        { id: 'gpt-5.6-terra', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'gpt-5.6-luna', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'gpt-5.3-codex-spark', route: true, smart: false, dest: DEFAULT_DEST, alias: true }
      ]
    },
    {
      id: 'anthropic', name: 'Anthropic', passthrough: 'api.anthropic.com',
      models: [
        { id: 'claude-fable-5', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'claude-sonnet-5', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'claude-haiku-4-5', route: false, smart: false, dest: DEFAULT_DEST }
      ]
    },
    {
      id: 'google', name: 'Google', passthrough: 'generativelanguage.googleapis.com',
      models: [
        { id: 'gemini-3.5-pro', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'gemini-3.5-flash', route: false, smart: false, dest: DEFAULT_DEST }
      ]
    },
    {
      id: 'xai', name: 'xAI', passthrough: 'api.x.ai',
      models: [
        { id: 'grok-5', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'grok-5-mini', route: false, smart: false, dest: DEFAULT_DEST }
      ]
    },
    {
      id: 'deepseek', name: 'DeepSeek', passthrough: 'api.deepseek.com',
      models: [
        { id: 'deepseek-v4', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'deepseek-v4-reasoner', route: false, smart: false, dest: DEFAULT_DEST }
      ]
    },
    {
      id: 'moonshot', name: 'Moonshot AI', passthrough: 'api.moonshot.ai',
      models: [
        { id: 'kimi-k3', route: false, smart: false, dest: DEFAULT_DEST },
        { id: 'kimi-k3-thinking', route: false, smart: false, dest: DEFAULT_DEST }
      ]
    }
  ],
  // Patched onto the real upstream /v1/models cards IN PLACE — never replace a card
  // wholesale (a hand-rolled card once lacked `truncation_policy` and broke every
  // model's catalog refresh, not just the patched one).
  modelCardPatches: {
    'gpt-5.3-codex-spark': {
      context_window: 1048576,
      max_context_window: 1048576,
      use_responses_lite: false
    }
  },
  // Remote access to /__blaze/* requires this token (Authorization: Bearer).
  // Empty = remote control refused entirely; loopback callers never need it.
  controlToken: '',
  // MCP gateway: when set, /mcp/* reverse-proxies here verbatim (Streamable
  // HTTP), gated by the hashed API keystore (blaze-proxy keys ...).
  // Empty = /mcp answers 404.
  mcpUpstream: '',
  heartbeatSeconds: 12,
  upstreamAttempts: 3,
  upstreamRetryDelaySeconds: 3,
  upstreamTimeoutSeconds: 900
};

function load() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`blaze-proxy: unreadable config at ${CONFIG_PATH}: ${err.message} — using defaults`);
    }
  }
  const merged = { ...structuredClone(DEFAULTS), ...cfg };
  // Deep-default only the maps whose absence would crash the router.
  merged.upstreams = { ...DEFAULTS.upstreams, ...(cfg.upstreams || {}) };
  if (!Array.isArray(merged.providers) || merged.providers.length === 0) {
    merged.providers = structuredClone(DEFAULTS.providers);
  }
  return merged;
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
}

// Flatten providers into a model-id → rule lookup.
function ruleFor(cfg, modelId) {
  if (!modelId) return null;
  for (const provider of cfg.providers) {
    for (const model of provider.models) {
      if (model.id === modelId) return { provider, model };
    }
  }
  return null;
}

// A request is intercepted when its model's toggle is on, or routeAll is on.
function shouldIntercept(cfg, modelId) {
  if (!cfg.proxyEnabled) return false;
  const hit = ruleFor(cfg, modelId);
  if (hit && hit.model.route) return true;
  if (cfg.routeAll) return true;
  return false;
}

function destFor(cfg, modelId) {
  const hit = ruleFor(cfg, modelId);
  return (hit && hit.model.dest) || DEFAULT_DEST;
}

module.exports = { CONFIG_DIR, CONFIG_PATH, DEFAULTS, DEFAULT_DEST, load, save, ruleFor, shouldIntercept, destFor };
