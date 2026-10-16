const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const TAB_H = 46;
const USAGE_URL = 'https://claude.ai/settings/usage';
const REFRESH_MS = 5 * 60 * 1000;
const SHARED = 'persist:shared';

// Look like normal Chrome so Google and other sign-ins accept the embedded pages.
const UA = app.userAgentFallback
  .replace(/ Electron\/\S+/, '')
  .replace(/ claude-multi\/\S+/i, '')
  .replace(/ Claude Multi\/\S+/i, '');

// Claude 1-4 keep the same partitions as the earlier version, so logins saved before are kept.
const DEFAULTS = [
  { id: 'claude1', name: 'Claude 1', url: 'https://claude.ai/', kind: 'claude', badge: '1', partition: 'persist:acct0' },
  { id: 'claude2', name: 'Claude 2', url: 'https://claude.ai/', kind: 'claude', badge: '2', partition: 'persist:acct1' },
  { id: 'claude3', name: 'Claude 3', url: 'https://claude.ai/', kind: 'claude', badge: '3', partition: 'persist:acct2' },
  { id: 'claude4', name: 'Claude 4', url: 'https://claude.ai/', kind: 'claude', badge: '4', partition: 'persist:acct3' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', partition: 'persist:svc-chatgpt' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/', partition: 'persist:svc-gemini' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', partition: 'persist:svc-grok' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', partition: 'persist:svc-deepseek' },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', partition: 'persist:svc-perplexity' },
  { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com/', partition: 'persist:svc-copilot' },
  { id: 'notebooklm', name: 'NotebookLM', url: 'https://notebooklm.google.com/', partition: 'persist:svc-notebooklm' },
  { id: 'mistral', name: 'Mistral', url: 'https://chat.mistral.ai/', partition: 'persist:svc-mistral' }
];

let win, ui, uiReady = false;
let services = [];
const views = new Map(); // service id -> WebContentsView (only for opened services)
let order = [];          // ids of opened services, in the order they were opened
let active = null;       // id of the visible service, or null for the home screen
let servicesFile;

function loadServices() {
  servicesFile = path.join(app.getPath('userData'), 'services.json');
  try {
    const data = JSON.parse(fs.readFileSync(servicesFile, 'utf8'));
    if (Array.isArray(data) && data.length) { services = data; return; }
  } catch (e) {}
  // Everything except the four Claude accounts shares one saved login by default.
  services = DEFAULTS.map((s) => ({ ...s, partition: s.kind === 'claude' ? s.partition : SHARED }));
}
function unsharedPartition(id) {
  const d = DEFAULTS.find((x) => x.id === id);
  return d ? d.partition : 'persist:svc-' + id;
}
function saveServices() {
  try { fs.writeFileSync(servicesFile, JSON.stringify(services, null, 2)); } catch (e) {}
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function pushState() {
  if (!uiReady || !ui || ui.webContents.isDestroyed()) return;
  ui.webContents.send('state', { services, order, active });
}
function sendUsage(payload) {
  if (!uiReady || !ui || ui.webContents.isDestroyed()) return;
  ui.webContents.send('usage', payload);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (active === null) {
    ui.setBounds({ x: 0, y: 0, width, height });
  } else {
    ui.setBounds({ x: 0, y: 0, width, height: TAB_H });
  }
  for (const [id, v] of views) {
    if (id === active) {
      v.setVisible(true);
      v.setBounds({ x: 0, y: TAB_H, width, height: Math.max(0, height - TAB_H) });
    } else {
      v.setVisible(false);
    }
  }
  // keep the top bar above every service view
  win.contentView.addChildView(ui);
}

function createView(s) {
  const viewPrefs = { partition: s.partition, preload: path.join(__dirname, 'webauthn-off.js') };
  const v = new WebContentsView({ webPreferences: viewPrefs });
  v.webContents.setUserAgent(UA);
  const myHost = hostOf(s.url);
  v.webContents.setWindowOpenHandler(({ url }) => {
    const h = hostOf(url);
    const authHosts = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com|auth0\.com|openai\.com|anthropic\.com)$/;
    if (authHosts.test(h)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 700, autoHideMenuBar: true, webPreferences: viewPrefs }
      };
    }
    if (h && myHost && (h === myHost || h.endsWith('.' + myHost) || myHost.endsWith('.' + h))) {
      v.webContents.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  v.webContents.loadURL(s.url);
  return v;
}

function openService(id) {
  const s = services.find((x) => x.id === id);
  if (!s) return;
  if (!views.has(id)) {
    const v = createView(s);
    views.set(id, v);
    order.push(id);
    win.contentView.addChildView(v);
  }
  active = id;
  layout();
  pushState();
}

function showHome() {
  active = null;
  layout();
  pushState();
}

function closeService(id) {
  const v = views.get(id);
  if (v) {
    try { win.contentView.removeChildView(v); } catch (e) {}
    try { v.webContents.close(); } catch (e) {}
    views.delete(id);
  }
  order = order.filter((x) => x !== id);
  if (active === id) active = order.length ? order[order.length - 1] : null;
  layout();
  pushState();
}

// Reads the usage page of a Claude account in a hidden window that shares that account's saved login.
function fetchUsage(partition) {
  return new Promise((resolve) => {
    const hidden = new BrowserWindow({
      show: false,
      width: 1000,
      height: 900,
      webPreferences: { partition, backgroundThrottling: false }
    });
    hidden.webContents.setUserAgent(UA);
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { hidden.destroy(); } catch (e) {}
      resolve(result);
    };
    timer = setTimeout(() => finish({ error: 'Timed out' }), 30000);
    hidden.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const url = hidden.webContents.getURL();
          if (/\/login|\/logout|\/onboarding/.test(url)) return finish({ error: 'Not logged in' });
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
          finish(items.length ? { items } : { error: 'No usage numbers found' });
        } catch (e) {
          finish({ error: String(e.message || e) });
        }
      }, 5000);
    });
    hidden.webContents.once('did-fail-load', () => finish({ error: 'Could not load usage page' }));
    hidden.loadURL(USAGE_URL);
  });
}

let usageBusy = false;
async function refreshUsage(onlyId) {
  if (usageBusy) return;
  usageBusy = true;
  try {
    const targets = services.filter((s) => s.kind === 'claude' && (!onlyId || s.id === onlyId));
    for (const s of targets) {
      sendUsage({ id: s.id, loading: true });
      const r = await fetchUsage(s.partition);
      sendUsage({ id: s.id, ts: Date.now(), ...r });
    }
  } finally {
    usageBusy = false;
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BaseWindow({ width: 1500, height: 950, minWidth: 800, minHeight: 500, title: 'Multi AI', backgroundColor: '#14161c' });

  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.contentView.addChildView(ui);
  ui.webContents.loadFile('index.html');
  ui.webContents.once('did-finish-load', () => {
    uiReady = true;
    pushState();
    setTimeout(() => refreshUsage(), 6000);
  });

  win.on('resize', layout);
  win.on('closed', () => app.quit());
  layout();
  setInterval(() => refreshUsage(), REFRESH_MS);
}

ipcMain.on('open', (e, id) => openService(id));
ipcMain.on('home', () => showHome());
ipcMain.on('close', (e, id) => closeService(id));
ipcMain.on('reload-active', () => {
  if (active && views.get(active)) views.get(active).webContents.reload();
});
ipcMain.on('refresh-usage', (e, id) => refreshUsage(id));
ipcMain.on('save-service', (e, { id, name, url, shared }) => {
  name = String(name || '').trim();
  url = normalizeUrl(url);
  if (!name || !url) return;
  if (id) {
    const s = services.find((x) => x.id === id);
    if (s) {
      s.name = name;
      s.url = url;
      const wanted = shared ? SHARED : unsharedPartition(id);
      if (s.partition !== wanted) {
        closeService(id); // reopen it to use the new login storage
        s.partition = wanted;
      }
    }
  } else {
    const nid = 'c' + Date.now();
    services.push({ id: nid, name, url, partition: shared ? SHARED : 'persist:svc-' + nid });
  }
  saveServices();
  pushState();
});
ipcMain.on('delete-service', (e, id) => {
  closeService(id);
  services = services.filter((s) => s.id !== id);
  saveServices();
  pushState();
});

app.whenReady().then(() => {
  loadServices();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
