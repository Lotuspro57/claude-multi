const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, shell, Menu, clipboard } = require('electron');
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

// Split-screen state
let splitMode = false;
const split = { left: null, right: null };

// zoom factors per service id
const zooms = new Map();

function sanitizeService(s, fallbackId) {
  if (!s || typeof s !== 'object') return null;
  const name = String(s.name || '').trim();
  const url = normalizeUrl(s.url);
  if (!name || !url) return null;
  const partition = s.partition || (s.kind === 'claude' ? s.partition || DEFAULTS.find((d) => d.id === s.id)?.partition || 'persist:acct0' : SHARED);
  return {
    ...s,
    id: String(s.id || fallbackId || `svc-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    name,
    url,
    partition
  };
}

function loadServices() {
  servicesFile = path.join(app.getPath('userData'), 'services.json');
  try {
    const raw = fs.readFileSync(servicesFile, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      const next = data
        .map((s, index) => sanitizeService(s, `svc-${index}`))
        .filter(Boolean);
      if (next.length) {
        services = next;
        return;
      }
    }
  } catch (e) {}
  services = DEFAULTS.map((s) => ({ ...s, partition: s.kind === 'claude' ? s.partition : SHARED }));
}

function saveServices() {
  try {
    const dir = path.dirname(servicesFile);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(servicesFile, JSON.stringify(services, null, 2));
  } catch (e) {}
}

function normalizeUrl(u) {
  u = String(u || '').trim().replace(/[\s\u00A0]+/g, '');
  if (!u) return '';
  let next = u;
  if (!/^https?:\/\//i.test(next)) next = 'https://' + next;
  try {
    const parsed = new URL(next);
    if (!parsed.hostname) return '';
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${pathname}`;
  } catch (e) {
    return '';
  }
}

function pushState() {
  if (!uiReady || !ui || ui.webContents.isDestroyed()) return;
  ui.webContents.send('state', { services, order, active, splitMode, split });
}
function sendUsage(payload) {
  if (!uiReady || !ui || ui.webContents.isDestroyed()) return;
  ui.webContents.send('usage', payload);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (!splitMode) {
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
  } else {
    // split mode: top bar remains, show both left and right
    ui.setBounds({ x: 0, y: 0, width, height: TAB_H });
    const contentH = Math.max(0, height - TAB_H);
    const half = Math.floor(width / 2);
    for (const [id, v] of views) {
      if (id === split.left) {
        v.setVisible(true);
        v.setBounds({ x: 0, y: TAB_H, width: half, height: contentH });
      } else if (id === split.right) {
        v.setVisible(true);
        v.setBounds({ x: half, y: TAB_H, width: width - half, height: contentH });
      } else {
        v.setVisible(false);
      }
    }
  }
  // keep the top bar above every service view
  try { win.contentView.addChildView(ui); } catch (e) {}
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
  v.webContents.on('did-fail-load', () => {
    if (v.webContents.getURL() === 'about:blank') return;
  });
  v.webContents.loadURL(s.url);
  // initialize zoom
  zooms.set(s.id, 1);
  return v;
}

function ensureServiceWindow() {
  if (!win) return;
  const activeView = active && views.get(active);
  if (activeView && activeView.webContents && !activeView.webContents.isDestroyed()) return;
  if (active) {
    const s = services.find((x) => x.id === active);
    if (s) {
      const v = createView(s);
      views.set(active, v);
      order = order.includes(active) ? order : [...order, active];
      try { win.contentView.addChildView(v); } catch (e) {}
      layout();
      pushState();
    }
  }
}

function openService(id) {
  const s = services.find((x) => x.id === id);
  if (!s) return;
  if (!views.has(id)) {
    const v = createView(s);
    views.set(id, v);
    order.push(id);
    try { win.contentView.addChildView(v); } catch (e) {}
  }
  // exit split mode
  splitMode = false;
  split.left = null; split.right = null;
  active = id;
  layout();
  pushState();
}

function openServiceInSide(id, side) {
  const s = services.find((x) => x.id === id);
  if (!s) return;
  if (!views.has(id)) {
    const v = createView(s);
    views.set(id, v);
    try { win.contentView.addChildView(v); } catch (e) {}
  }
  splitMode = true;
  if (side === 'left') split.left = id; else split.right = id;
  // ensure the other side is assigned to something (prefer last opened)
  if (!split.left && order.length) split.left = order[order.length - 1];
  if (!split.right && order.length) split.right = order[order.length - 2] || order[0];
  // make sure both views exist
  [split.left, split.right].forEach((sid) => {
    if (sid && !views.has(sid)) {
      const sv = services.find((x) => x.id === sid);
      if (sv) {
        const v = createView(sv);
        views.set(sid, v);
        try { win.contentView.addChildView(v); } catch (e) {}
      }
    }
  });
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
  if (split.left === id) split.left = null;
  if (split.right === id) split.right = null;
  if (active === id) active = order.length ? order[order.length - 1] : null;
  // if split sides emptied, leave splitMode if at least one side remains
  if (!split.left && !split.right) splitMode = false;
  layout();
  pushState();
}

function setZoomFor(id, factor) {
  const v = views.get(id);
  if (!v || !v.webContents || v.webContents.isDestroyed()) return;
  zooms.set(id, factor);
  try { v.webContents.setZoomFactor(factor); } catch (e) {}
}

function adjustZoom(delta) {
  // target active if not split, otherwise left if exists
  if (!splitMode) {
    if (!active) return;
    const cur = zooms.get(active) || 1;
    const next = Math.max(0.25, Math.min(5, cur + delta));
    setZoomFor(active, next);
  } else {
    const target = split.left || split.right;
    if (!target) return;
    const cur = zooms.get(target) || 1;
    const next = Math.max(0.25, Math.min(5, cur + delta));
    setZoomFor(target, next);
  }
}

function resetZoom() {
  if (!splitMode) {
    if (!active) return;
    setZoomFor(active, 1);
  } else {
    if (split.left) setZoomFor(split.left, 1);
    if (split.right) setZoomFor(split.right, 1);
  }
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
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
          if (/\/login|\/logout|\/onboarding/.test(url) || !url || url === 'about:blank') return finish({ error: 'Not logged in' });
          const body = await hidden.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
          const text = String(body || '');
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
  try { win.contentView.addChildView(ui); } catch (e) {}
  ui.webContents.loadFile(path.join(__dirname, 'index.html'));
  ui.webContents.once('did-finish-load', () => {
    uiReady = true;
    pushState();
    setTimeout(() => refreshUsage(), 6000);
  });

  win.on('resize', layout);
  win.on('closed', () => app.quit());
  layout();
  setInterval(() => refreshUsage(), REFRESH_MS);
  ensureServiceWindow();
}

ipcMain.on('open', (e, id) => openService(id));
ipcMain.on('home', () => { splitMode = false; split.left = null; split.right = null; active = null; layout(); pushState(); });
ipcMain.on('close', (e, id) => closeService(id));
ipcMain.on('reload-active', () => {
  if (!splitMode) {
    if (active && views.get(active)) views.get(active).webContents.reload();
  } else {
    if (split.left && views.get(split.left)) views.get(split.left).webContents.reload();
    if (split.right && views.get(split.right)) views.get(split.right).webContents.reload();
  }
});
ipcMain.on('refresh-usage', (e, id) => refreshUsage(id));
ipcMain.on('zoom-in', () => adjustZoom(0.1));
ipcMain.on('zoom-out', () => adjustZoom(-0.1));
ipcMain.on('zoom-reset', () => resetZoom());
ipcMain.on('open-split', (e, id, side) => openServiceInSide(id, side || 'left'));

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
        closeService(id);
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

ipcMain.on('show-service-menu', (e, id, x, y) => {
  const s = services.find((xv) => xv.id === id);
  if (!s) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: () => openService(id) },
    { label: 'Open Left (Split)', click: () => openServiceInSide(id, 'left') },
    { label: 'Open Right (Split)', click: () => openServiceInSide(id, 'right') },
    { type: 'separator' },
    { label: 'Copy URL', click: () => { try { clipboard.writeText(s.url); } catch (e) {} } },
    { label: 'Edit', click: () => { if (uiReady && ui && !ui.webContents.isDestroyed()) ui.webContents.send('menu-action', { action: 'edit', id }); } },
    { label: 'Remove', click: () => { if (uiReady && ui && !ui.webContents.isDestroyed()) ui.webContents.send('menu-action', { action: 'delete', id }); } }
  ]);
  try { menu.popup({ window: win }); } catch (e) { menu.popup(); }
});

app.whenReady().then(() => {
  loadServices();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

function unsharedPartition(id) {
  const d = DEFAULTS.find((x) => x.id === id);
  return d ? d.partition : 'persist:svc-' + id;
}
