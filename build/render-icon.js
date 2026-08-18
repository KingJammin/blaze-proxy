'use strict';

// Renders build/icon.svg to a 1024x1024 PNG *with alpha* (qlmanage flattens
// SVG transparency to white, so we rasterize via an offscreen Electron page).
// Usage: npx electron build/render-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body>${svg}</body></html>`;

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true }
  });
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon-1024.png'), image.toPNG());
  console.log('wrote build/icon-1024.png', image.getSize());
  app.exit(0);
});
