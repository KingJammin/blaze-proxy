'use strict';

// Blaze Proxy renderer — a pure client of the daemon's /__blaze/* control API.

const params = new URLSearchParams(location.search);
const PORT = params.get('port') || '8789';
const BASE = `http://127.0.0.1:${PORT}`;

// Verified brand marks (Simple Icons). xAI ships no vector mark, so it gets a
// neutral geometric X rather than another company's trademark.
const LOGOS = {
  openai: { bg: '#f4f4f5', fg: '#0b0b0b', path: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z' },
  anthropic: { bg: '#d97757', fg: '#fff', path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z' },
  google: { bg: '#4285f4', fg: '#fff', path: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z' },
  xai: { bg: '#000000', fg: '#fff', stroke: true, path: 'M4 4L20 20M20 4L4 20' },
  deepseek: { bg: '#5786fe', fg: '#fff', path: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45' },
  moonshot: { bg: '#1a1a2e', fg: '#e8e8f0', path: 'm1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866' }
};

let config = null;
let saveTimer = null;

const $ = (id) => document.getElementById(id);

function logoHTML(providerId, name) {
  const l = LOGOS[providerId];
  if (!l) {
    return `<span class="plogo" style="background:#3f3f46">${(name || '?').charAt(0).toUpperCase()}</span>`;
  }
  const border = (l.bg === '#000000' || l.bg === '#1a1a2e' || l.bg === '#f4f4f5') ? ';border:1px solid var(--line-strong)' : '';
  const svg = l.stroke
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${l.fg}" stroke-width="2.6" stroke-linecap="round"><path d="${l.path}"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="${l.fg}"><path d="${l.path}"/></svg>`;
  return `<span class="plogo" style="background:${l.bg}${border}">${svg}</span>`;
}

async function fetchState() {
  const res = await fetch(`${BASE}/__blaze/state`);
  return res.json();
}

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fetch(`${BASE}/__blaze/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
  }, 150);
}

function render() {
  document.body.classList.toggle('off', !config.proxyEnabled);
  $('masterToggle').classList.toggle('on', config.proxyEnabled);
  $('masterToggle').setAttribute('aria-checked', String(config.proxyEnabled));
  $('masterCopy').innerHTML = config.proxyEnabled
    ? `Intercepting model traffic on <b>127.0.0.1:${PORT}</b> — apps pointed here are being routed.`
    : `Stopped. Requests to 127.0.0.1:${PORT} are refused until you turn the proxy back on.`;

  const allModels = config.providers.flatMap((p) => p.models);
  const allOn = allModels.length > 0 && allModels.every((m) => m.route);
  $('routeAll').classList.toggle('on', config.routeAll || allOn);
  $('routeAll').setAttribute('aria-checked', String(config.routeAll || allOn));

  const grid = $('providers');
  grid.innerHTML = '';
  for (const provider of config.providers) {
    const card = document.createElement('div');
    card.className = 'card';
    const onCount = provider.models.filter((m) => m.route).length;
    const head = document.createElement('div');
    head.className = 'pcard-head';
    head.innerHTML = `${logoHTML(provider.id, provider.name)}
      <div class="pname"><b></b><span class="cnt">${onCount ? `<b>${onCount}</b>` : '0'} of ${provider.models.length} routed</span></div>
      <button class="rsw ${onCount === provider.models.length && provider.models.length ? 'on' : ''}" role="switch" aria-label="Route all ${provider.name} models"><span class="knob"></span></button>`;
    head.querySelector('.pname b').textContent = provider.name;
    head.querySelector('.rsw').addEventListener('click', () => {
      const turnOn = !provider.models.every((m) => m.route);
      provider.models.forEach((m) => { m.route = turnOn; });
      saveConfig(); render();
    });
    card.appendChild(head);

    for (const model of provider.models) {
      const row = document.createElement('div');
      const effectiveRoute = model.route || config.routeAll;
      row.className = 'row ' + (effectiveRoute ? (model.smart ? 'smart-on' : 'intercepted') : '');
      const mini = effectiveRoute
        ? (model.smart ? `smart (stored) · → ${model.dest}` : `→ ${model.dest}`)
        : `pass-through to ${provider.passthrough || 'provider'}`;
      const miniClass = effectiveRoute ? (model.smart ? 'to-smart' : 'to-local') : 'off';
      row.innerHTML = `
        <div class="m-name-wrap">
          <div class="m-name"><span></span>${model.alias ? ' <span class="alias">ALIAS</span>' : ''}</div>
          <div class="dest-mini ${miniClass}"></div>
        </div>
        <button class="rsw ${model.route ? 'on' : ''}" role="switch" aria-label="Route ${model.id}"><span class="knob"></span></button>
        <button class="dots" aria-label="Settings for ${model.id}"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="2.5" r="1.4"/><circle cx="7" cy="7" r="1.4"/><circle cx="7" cy="11.5" r="1.4"/></svg></button>`;
      row.querySelector('.m-name span').textContent = model.id;
      row.querySelector('.dest-mini').textContent = mini;
      row.querySelector('.rsw').addEventListener('click', () => {
        model.route = !model.route;
        saveConfig(); render();
      });
      row.querySelector('.dots').addEventListener('click', () => openModal(model));
      card.appendChild(row);
    }
    grid.appendChild(card);
  }
}

// ————— per-model modal —————
let activeModel = null;
function openModal(model) {
  activeModel = model;
  $('modalTitle').textContent = model.id;
  $('modalDest').value = model.dest || '';
  $('modalSmart').classList.toggle('on', Boolean(model.smart));
  $('modal').classList.toggle('smart-on', Boolean(model.smart));
  $('overlay').hidden = false;
}
$('modalClose').addEventListener('click', () => { $('overlay').hidden = true; activeModel = null; });
$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) { $('overlay').hidden = true; activeModel = null; } });
$('modalDest').addEventListener('change', () => {
  if (!activeModel) return;
  activeModel.dest = $('modalDest').value.trim();
  saveConfig(); render();
});
$('modalSmart').addEventListener('click', () => {
  if (!activeModel) return;
  activeModel.smart = !activeModel.smart;
  $('modalSmart').classList.toggle('on', activeModel.smart);
  $('modal').classList.toggle('smart-on', activeModel.smart);
  saveConfig(); render();
});

// ————— master + route-all —————
$('masterToggle').addEventListener('click', () => {
  config.proxyEnabled = !config.proxyEnabled;
  saveConfig(); render();
});
$('routeAll').addEventListener('click', () => {
  const turnOn = !$('routeAll').classList.contains('on');
  config.routeAll = turnOn;
  config.providers.forEach((p) => p.models.forEach((m) => { m.route = turnOn; }));
  saveConfig(); render();
});

// ————— settings —————
function paintApiKeyHint(desc) {
  $('apiKeyHint').textContent = desc && desc.set
    ? `Set · ends ····${desc.last4}. One key authorizes everything — model requests and MCP.`
    : 'Not set. One key authorizes everything — model requests and MCP.';
}
$('settingsBtn').addEventListener('click', async () => {
  $('endpointField').value = config.endpoint;
  $('portField').value = PORT;
  $('apiKeyField').value = '';
  try {
    const state = await fetchState();
    paintApiKeyHint(state.apiKey);
  } catch { /* hint keeps last text */ }
  $('settingsOverlay').hidden = false;
});
$('apiKeyField').addEventListener('change', async () => {
  const key = $('apiKeyField').value.trim();
  if (!key) return;
  try {
    const res = await fetch(`${BASE}/__blaze/apikey`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const out = await res.json();
    if (out.ok) {
      $('apiKeyField').value = '';
      paintApiKeyHint(out.apiKey);
    } else {
      $('apiKeyHint').textContent = `Could not save: ${out.error}`;
    }
  } catch (e) {
    $('apiKeyHint').textContent = `Could not save: ${e.message}`;
  }
});
$('settingsClose').addEventListener('click', () => { $('settingsOverlay').hidden = true; });
$('settingsOverlay').addEventListener('click', (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').hidden = true; });
$('endpointField').addEventListener('change', () => {
  config.endpoint = $('endpointField').value.trim();
  saveConfig();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('overlay').hidden = true; $('settingsOverlay').hidden = true; activeModel = null; }
});

// ————— live tail —————
let reqCount = 0;
let localCount = 0;
function addLogRow(evt) {
  if (evt.kind !== 'request') return;
  $('logEmpty')?.remove();
  reqCount++;
  if (evt.route === 'intercepted' && evt.status === 200) localCount++;
  $('statReq').textContent = reqCount.toLocaleString();
  $('statLocal').textContent = localCount.toLocaleString();

  const log = $('log');
  const el = document.createElement('div');
  el.className = 'log-row';
  const badge = evt.status >= 400 ? ['err', String(evt.status)]
    : evt.route === 'intercepted' ? ['local', 'LOCAL'] : ['pass', 'PASS'];
  const t = (evt.ts || '').slice(11, 19);
  el.innerHTML = `<span class="t"></span><span class="req"></span><span class="served"></span><span class="ms"></span><span class="badge ${badge[0]}">${badge[1]}</span>`;
  el.querySelector('.t').textContent = t;
  el.querySelector('.req').textContent = evt.model || '—';
  el.querySelector('.served').textContent = '→ ' + (evt.route === 'intercepted' ? (evt.dest || 'endpoint') : (evt.dest || 'pass-through')) + (evt.error ? ` · ${evt.error}` : '');
  el.querySelector('.ms').textContent = `${evt.ms} ms`;
  log.insertBefore(el, log.firstChild);
  while (log.children.length > 12) log.removeChild(log.lastChild);
}

function connectTail() {
  const es = new EventSource(`${BASE}/__blaze/tail`);
  es.onmessage = (e) => { try { addLogRow(JSON.parse(e.data)); } catch { /* ignore */ } };
  es.onerror = () => { $('connState').textContent = 'daemon unreachable'; $('connState').classList.add('bad'); };
  es.onopen = () => { $('connState').textContent = ''; $('connState').classList.remove('bad'); };
}

// ————— boot —————
(async function boot() {
  try {
    const state = await fetchState();
    config = state.config;
    render();
    connectTail();
  } catch {
    $('connState').textContent = `daemon not running on :${PORT}`;
    $('connState').classList.add('bad');
    $('masterCopy').textContent = `Could not reach the proxy daemon on 127.0.0.1:${PORT}. Start it with: blaze-proxy start`;
  }
})();
