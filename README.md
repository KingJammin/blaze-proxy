# Blaze Proxy

Desktop AI model router. Point your AI tools at `http://127.0.0.1:8789/v1` and Blaze Proxy decides, per model, whether a request passes through to its real provider untouched or is intercepted and served by **your own endpoint** (a local GPU box, a homelab tunnel, any OpenAI-compatible server).

- **Toggle per model** — flip `gpt-5.3-codex-spark` to your DGX while `gpt-5.6-terra` keeps going to ChatGPT.
- **Route all** — one switch to intercept everything.
- **Dynamic** — rules live in `~/.blaze-proxy/config.json`, hot-applied via a localhost control API. No restarts, no code edits.
- **Desktop UI** — Electron app (Blaze-styled) with live request tail; the proxy itself runs fine headless.
- **Codex-grade plumbing** — zstd request sniffing, `/v1/models` catalog patching (in-place, schema-safe), WebSocket pass-through tunneling, SSE keep-alive heartbeats while slow local models think, terminal `response.failed` events instead of dead sockets.

> ### Transparent mode (macOS, opt-in, off by default)

Routes the Codex/ChatGPT app through blaze with **no client configuration at all** — no `config.toml` edits, no profile. Blaze becomes the machine's HTTPS proxy for OpenAI hosts, terminates TLS with its own local CA, refuses WebSocket upgrades so Codex falls back to HTTP (`"Falling back from WebSockets to HTTPS transport"`), and routes the decrypted request through the normal engine.

```bash
blaze-proxy transparent status          # is it on, is the CA valid, are any clients stale?
blaze-proxy transparent off             # panic button — clears the machine proxy even if the daemon is dead
blaze-proxy transparent off --remove-ca # ...and delete the CA
```

Enable it by setting `transparent: { "enabled": true }` in config (a Settings toggle is coming), then **restart client apps once** — `launchctl` environment only reaches processes started afterwards, which is the single most common "why isn't it working" cause. `transparent status` flags clients that predate the change.

**Read before enabling:**
- **It is machine-global.** `launchctl setenv HTTPS_PROXY` affects every GUI app launched afterwards, not just Codex. Blaze **blind-tunnels every host except `chatgpt.com`/`openai.com`** — those connections are spliced byte-for-byte and never decrypted — but they do transit this process.
- **Fail-open is built in and tested.** Teardown runs on exit, SIGINT/SIGTERM/SIGHUP/SIGQUIT, and uncaught exceptions; the daemon self-heals a stale environment at startup if a previous run was killed outright. In transparent mode a fatal error deliberately exits (clearing the environment) rather than staying up broken.
- **The CA private key is a real local secret** — mode 600, generated on your machine, never synced. It is *not* installed into the system keychain and needs no admin password: trust is scoped to processes reading `CODEX_CA_CERTIFICATE`.
- **Multiple client builds share one environment.** `launchctl` is machine-global, so every ChatGPT/Codex build on the box points here — including sandboxed or App-Translocated copies whose `HOME` is not yours. Those resolve paths against their own container, so the CA path is always published absolute (asserted, never `~`), and `transparent status` lists every running build when it finds more than one.
- If OpenAI ever adds certificate pinning, this breaks as a TLS error; `transparent off` restores normality immediately.

**Debugging a failing endpoint.** `"captureFailures": true` writes the request and response of *failing* intercepted calls to `~/.blaze-proxy/failed-requests` (mode 600, capped at 200 files). These files contain conversation content, so it is off by default, announced loudly in the log while on, and meant to be switched off once you've found the trigger.

### Codex: use a custom provider, or routing can't reach you
> Routing works by reading the model out of an HTTP request. Under its **native** provider (`model_provider = "openai"`), the Codex CLI talks to models ChatGPT actually serves — `gpt-5.6-terra`, `gpt-5.6-luna` — over a **WebSocket**, which carries its model inside the stream. The proxy can only tunnel those, never redirect them, so toggling such a model has no effect and the request still reaches the provider and still costs money. Measured, not assumed: stripping `use_responses_lite`, `tool_mode`, `multi_agent_version`, and `supported_in_api` from the model card does not move Codex off that path.
>
> **The fix is provider-level.** A custom provider with `wire_api = "responses"` has no WebSocket option, so Codex speaks HTTP POST — which the proxy can sniff and intercept, for real model names. Put this in a standalone profile file (current Codex rejects `[profiles.X]` inside `config.toml`):
>
> ```toml
> # ~/.codex/blaze.config.toml
> model = "gpt-5.6-luna"
> model_provider = "blaze_local"
>
> [model_providers.blaze_local]
> base_url = "http://127.0.0.1:8789/v1"
> wire_api = "responses"
> ```
> ```bash
> codex exec --profile blaze  "…"     # now intercepted → your endpoint
> ```
>
> Everything else needs no special setup: any OpenAI-compatible HTTP client, and alias model names Codex has no native path for (e.g. `gpt-5.3-codex-spark`), route normally.
>
> When a rule is active and a WebSocket opens anyway, the live tail marks it **BYPASS** rather than letting a toggle look effective when it isn't.

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

> Use this **only** if you want routing independent of the desktop app. With the
> launchd agent loaded, `KeepAlive` will respawn the daemon moments after the app
> shuts it down on quit, defeating app-owned lifetime. Pick one model, not both.

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

### When your upstream IS your endpoint

On an instance whose catalog/pass-through upstream is the same server as `endpoint` (a local vLLM fronting everything), set the upstream to the literal string `"endpoint"`:

```json
"upstreams": { "responses": "endpoint", "chat": "endpoint" }
```

That resolves to `endpoint` **and** attaches the endpoint key to pass-throughs — including `GET /v1/models`, which otherwise reaches the endpoint with no credential (the caller's gateway key is stripped at the listener) and 401s. The sentinel states intent rather than comparing addresses, because `127.0.0.1:8000` and `192.168.0.117:8000` can be the same server and no string match can know it. An upstream written as a literal URL only gets the key when it matches `endpoint` exactly.

### One key for everything (listener-scoped auth)

The same `bzp_` keys that gate `/mcp` can gate **model paths** too, per listener class:

```json
"listenerAuth": { "loopback": "keys", "lan": "open" }
```

`keys` mode requires a valid keystore key on `/v1/*` (HTTP **and** WebSocket upgrades) and strips it before forwarding; `open` (the default) keeps pre-v0.3.0 behavior. Classes are decided by the *listener-side* address, so a fleet can keep its LAN listener open for pods while an ngrok tunnel fronting the loopback listener is fully key-gated. **Setting `loopback: "keys"` also withdraws the control API's loopback trust** — set `controlToken` first or you'll lock yourself out of management.

In the app, Settings → **API key** stores your personal `bzp_` key (macOS keychain; masked, never echoed) and the daemon uses it as the outbound Authorization for intercepted model requests — and for `/mcp` forwards when `mcpUpstreamAuth: "apiKey"` is set (chained-gateway mode; the default `"none"` keeps the upstream credential-free).

### Control-plane security

Loopback callers always have control access (that's how the UI talks to the daemon). Remote callers are refused unless `controlToken` is set in config and sent as `Authorization: Bearer <token>` — with no token configured, a LAN-bound instance exposes the *proxy* to the network but never a config-rewrite endpoint. Instances started with a non-loopback `BLAZE_HOST` also get a loopback listener on the same port, so on-box management never needs the token. `/healthz` is always open for probes.

The Electron app owns proxy lifetime: opening it starts the daemon if one isn't already up, and quitting it calls `POST /__blaze/shutdown` to stop routing. Run the daemon under launchd instead (see "Run at login") if you want routing to survive the app being closed — the two models are mutually exclusive.

## Roadmap

Smart routing (cheapest-model-first escalation ladder), email/OTP login with config sync across machines, Anthropic protocol translation, live provider catalogs, signed .app with auto-update.

## License

MIT
