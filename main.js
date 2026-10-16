const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ACCOUNT_COUNT = 4;
const STRIP_H = 104;
const HOME_URL = 'https://claude.ai/';
const USAGE_URL = 'https://claude.ai/settings/usage';
const REFRESH_MS = 5 * 60 * 1000;

let win, ui;
let views = [];
let zoomed = -1;
let settingsFile;
let settings = { names: ['Account 1', 'Account 2', 'Account 3', 'Account 4'] };

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch (e) {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) {}
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width, height: STRIP_H });
  const colW = Math.floor(width / ACCOUNT_COUNT);
  views.forEach((v, i) => {
    if (zoomed >= 0) {
      v.setVisible(i === zoomed);
      v.setBounds({ x: 0, y: STRIP_H, width, height: height - STRIP_H });
    } else {
      v.setVisible(true);
      const x = i * colW;
      const w = i === ACCOUNT_COUNT - 1 ? width - x : colW;
      v.setBounds({ x, y: STRIP_H, width: w, height: height - STRIP_H });
    }
  });
}

function sendToUI(channel, payload) {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send(channel, payload);
}

// Reads the usage page of one account in a hidden window that shares that account's saved login.
function fetchUsage(i) {
  return new Promise((resolve) => {
    const hidden = new BrowserWindow({
      show: false,
      width: 1000,
      height: 900,
      webPreferences: { partition: 'persist:acct' + i, backgroundThrottling: false }
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { hidden.destroy(); } catch (e) {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: 'Timed out' }), 30000);
    hidden.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const url = hidden.webContents.getURL();
          if (/\/login|\/logout|\/onboarding/.test(url)) {
            clearTimeout(timer);
            return finish({ error: 'Not logged in' });
          }
          const text = await hidden.webContents.executeJavaScript('document.body.innerText');
          const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
          const items = [];
          for (let k = 0; k < lines.length; k++) {
            const m = lines[k].match(/(\d{1,3}(?:\.\d+)?)\s*%/);
            if (m) {
              let label = '';
              for (let b = k - 1; b >= Math.max(0, k - 3); b--) {
                if (!/%/.test(lines[b]) && lines[b].length < 60) { label = lines[b]; break; }
              }
              items.push({ label: label || 'Usage', pct: Math.min(100, parseFloat(m[1])), text: lines[k] });
            }
          }
          clearTimeout(timer);
          finish(items.length ? { items } : { error: 'No usage numbers found on page' });
        } catch (e) {
          clearTimeout(timer);
          finish({ error: String(e.message || e) });
        }
      }, 5000);
    });
    hidden.webContents.once('did-fail-load', () => {
      clearTimeout(timer);
      finish({ error: 'Could not load usage page' });
    });
    hidden.loadURL(USAGE_URL);
  });
}

async function refreshUsage(only) {
  const ids = only !== undefined ? [only] : [...Array(ACCOUNT_COUNT).keys()];
  for (const i of ids) {
    sendToUI('usage', { id: i, loading: true });
    const r = await fetchUsage(i);
    sendToUI('usage', { id: i, ts: Date.now(), ...r });
  }
}

function createWindow() {
  win = new BaseWindow({ width: 1800, height: 1000, title: 'Claude Multi' });

  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.contentView.addChildView(ui);
  ui.webContents.loadFile('index.html');

  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    const v = new WebContentsView({ webPreferences: { partition: 'persist:acct' + i } });
    win.contentView.addChildView(v);
    v.webContents.loadURL(HOME_URL);
    // keep external links out of the pane
    v.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/(.*\.)?(claude\.ai|anthropic\.com|google\.com|accounts\.google\.com|apple\.com)/.test(url)) {
        v.webContents.loadURL(url);
      } else {
        require('electron').shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    views.push(v);
  }

  win.on('resize', layout);
  layout();

  ui.webContents.once('did-finish-load', () => {
    sendToUI('init', { names: settings.names });
    setTimeout(() => refreshUsage(), 8000);
  });
  setInterval(() => refreshUsage(), REFRESH_MS);
}

ipcMain.on('rename', (e, { id, name }) => {
  settings.names[id] = name;
  saveSettings();
});
ipcMain.on('zoom', (e, id) => {
  zoomed = zoomed === id ? -1 : id;
  layout();
  sendToUI('zoomed', zoomed);
});
ipcMain.on('reload', (e, id) => views[id] && views[id].webContents.loadURL(HOME_URL));
ipcMain.on('refresh-usage', (e, id) => refreshUsage(id));

app.whenReady().then(() => {
  loadSettings();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
