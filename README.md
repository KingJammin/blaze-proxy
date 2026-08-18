# Blaze Proxy

Desktop AI model router. Point your AI tools at `http://127.0.0.1:8789/v1` and Blaze Proxy decides, per model, whether a request passes through to its real provider untouched or is intercepted and served by **your own endpoint** (a local GPU box, a homelab tunnel, any OpenAI-compatible server).

- **Toggle per model** — flip `gpt-5.3-codex-spark` to your DGX while `gpt-5.6-terra` keeps going to ChatGPT.
- **Route all** — one switch to intercept everything.
- **Dynamic** — rules live in `~/.blaze-proxy/config.json`, hot-applied via a localhost control API. No restarts, no code edits.
- **Desktop UI** — Electron app (Blaze-styled) with live request tail; the proxy itself runs fine headless.
- **Codex-grade plumbing** — zstd request sniffing, `/v1/models` catalog patching (in-place, schema-safe), WebSocket pass-through tunneling, SSE keep-alive heartbeats while slow local models think, terminal `response.failed` events instead of dead sockets.

## Install

**npm**
```bash
npm install -g github:KingJammin/blaze-proxy
```

**Homebrew**
```bash
brew tap kingjammin/blaze-proxy https://github.com/KingJammin/blaze-proxy
brew install blaze-proxy
```

**curl**
```bash
curl -fsSL https://raw.githubusercontent.com/KingJammin/blaze-proxy/main/install.sh | bash
```

Headless machines: add `--omit=optional` (npm) or `BLAZE_HEADLESS=1` (curl) to skip the Electron download.

## Use

```bash
blaze-proxy start     # run the daemon (foreground)
blaze-proxy app       # open the desktop UI
blaze-proxy status    # what's routed where
blaze-proxy stop
```

Point clients at the proxy:
- **Codex CLI** — `~/.codex/config.toml`: `openai_base_url = "http://127.0.0.1:8789/v1"`
- **Any OpenAI-compatible client** — base URL `http://127.0.0.1:8789/v1`

### Endpoint

The endpoint is where intercepted requests go — any server speaking the OpenAI Responses and/or Chat Completions API (vLLM, SGLang, llama.cpp server, …). Set it in the UI's settings (gear icon) or in config. Default: `https://homeai.benpelo.com/v1`.

**Endpoint auth** (first match wins):
1. `BLAZE_ENDPOINT_KEY` environment variable
2. `endpointAuth: { "type": "value", "value": "sk-..." }` in config
3. macOS keychain: `endpointAuth: { "type": "keychain", "service": "<host>", "account": "<user>" }`

### Config

`~/.blaze-proxy/config.json` — created with defaults on first run. Providers → models → `{ route, dest, smart }`. `modelCardPatches` overlays fields onto the upstream `/v1/models` catalog (patched in place; cards are never replaced). Edit by hand or through the UI; changes apply immediately.

### Run at login (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.<you>.blaze-proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.you.blaze-proxy</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/blaze-proxy/bin/blaze-proxy.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.blaze-proxy.plist
```

## Architecture

One Node daemon (`src/proxy.js`), no framework, one dependency (`fzstd`):

| Path | Behavior |
|---|---|
| `POST /v1/responses`, `POST /v1/chat/completions` | Sniff `model` (zstd-aware) → intercepted (rewrite model, add endpoint bearer, forward) or pass-through |
| `GET /v1/models` | Pass-through + in-place card patches from config |
| `POST /v1/messages` | Pass-through to api.anthropic.com (translation planned) |
| `Upgrade: websocket` | Raw TLS byte-splice tunnel to the responses upstream |
| `/__blaze/*` | Control API: state, config, SSE event tail |
| `POST /api/codex/ps/mcp` | Clean 404 stub (Codex app-server probes this side-channel on custom base URLs; proxying the failure spams rmcp logs) |

### MCP gateway

Set `mcpUpstream` in config (e.g. `http://10.152.183.119:3100`) and blaze-proxy reverse-proxies everything under `/mcp` to it verbatim — path preserved, chunked request bodies and SSE responses streamed unbuffered (Streamable HTTP), connections held open. `/mcp` sits outside model routing **and** outside the master proxy toggle: the switch governs model interception, not your MCP server's uptime.

Access requires an API key (`Authorization: Bearer <key>`), managed by CLI:

```bash
blaze-proxy keys issue --name ben     # prints the plaintext ONCE; stores sha256 only
blaze-proxy keys list                 # ids, names, status — never plaintext
blaze-proxy keys revoke --name ben    # takes effect on the next request, no restart
```

Keys live hashed in `~/.blaze-proxy/keys.json` (mode 600, re-read on change). The gateway strips the key before forwarding — your MCP upstream never sees it.

### Control-plane security

Loopback callers always have control access (that's how the UI talks to the daemon). Remote callers are refused unless `controlToken` is set in config and sent as `Authorization: Bearer <token>` — with no token configured, a LAN-bound instance exposes the *proxy* to the network but never a config-rewrite endpoint. Instances started with a non-loopback `BLAZE_HOST` also get a loopback listener on the same port, so on-box management never needs the token. `/healthz` is always open for probes.

The Electron app is a pure client of `/__blaze/*` — closing the window never stops routing.

## Roadmap

Smart routing (cheapest-model-first escalation ladder), email/OTP login with config sync across machines, Anthropic protocol translation, live provider catalogs, signed .app with auto-update.

## License

MIT
