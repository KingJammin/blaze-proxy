'use strict';

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const configLib = require('../src/config');

let daemon = null;

function daemonAlive(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureDaemon(port) {
  if (await daemonAlive(port)) return 'already-running';
  daemon = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'blaze-proxy.js'), 'start'], {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonAlive(port)) return 'spawned';
  }
  return 'failed';
}

async function createWindow() {
  const cfg = configLib.load();
  const port = Number(process.env.BLAZE_PORT || cfg.port);
  const daemonState = await ensureDaemon(port);

  const win = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Blaze Proxy',
    backgroundColor: '#101010',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { port: String(port), daemon: daemonState }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Stop the daemon on quit. Uses the control API rather than killing our child
// handle, so it also stops a daemon that was already running when we opened
// (state 'already-running') — the app owns proxy lifetime either way.
function stopDaemon(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/__blaze/shutdown', method: 'POST', timeout: 3000 },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Proxy lifetime is tied to the app: closing the window stops routing.
  app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  const cfg = configLib.load();
  const port = Number(process.env.BLAZE_PORT || cfg.port);
  stopDaemon(port).then(() => {
    // Belt and braces: if the daemon ignored the shutdown request, kill the
    // child we spawned. detached:false already ties it to us, but an
    // already-running daemon has no child handle.
    if (daemon && !daemon.killed) { try { daemon.kill('SIGTERM'); } catch { /* gone */ } }
    app.quit();
  });
});
