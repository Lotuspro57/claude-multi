const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const TAB_H = 46;
const USAGE_URL = 'https://claude.ai/settings/usage';
const REFRESH_MS = 5 * 60 * 1000;
const SHARED = 'persist:shared';

// Look like normal Chrome so sign-ins accept the embedded pages.
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
let active = null;       // id of the main visible service, or null for the home screen
let split = null;        // id of the service shown beside the main one (split screen), or null
let focused = null;      // id of the service the user last clicked in (zoom target)
let servicesFile, stateFile;
let usageTimer = null;
let stateTimer = null;

// ---------- saved data (written safely so a crash can't leave a half-written file) ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bad'); } catch (e2) {}
    return fallback;
  }
}
function writeJson(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {}
}

function validService(s) {
  return s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.url === 'string' &&
    typeof s.partition === 'string' && /^https?:\/\//i.test(s.url);
}

function loadServices() {
  const dir = app.getPath('userData');
  servicesFile = path.join(dir, 'services.json');
  stateFile = path.join(dir, 'state.json');
  const data = readJson(servicesFile, null);
  if (Array.isArray(data)) {
    const clean = data.filter(validService);
    if (clean.length) { services = clean; return; }
  }
  // Everything except the four Claude accounts shares one saved login by default.
  services = DEFAULTS.map((s) => ({ ...s, partition: s.kind === 'claude' ? s.partition : SHARED }));
}
function unsharedPartition(id) {
  const d = DEFAULTS.find((x) => x.id === id);
  return d ? d.partition : 'persist:svc-' + id;
}
function saveServices() { writeJson(servicesFile, services); }

function currentState() {
  let bounds = null;
  let maximized = false;
  if (win && !win.isDestroyed()) {
    try { bounds = win.getNormalBounds(); maximized = win.isMaximized(); } catch (e) {}
  }
  return { bounds, maximized, order, active, split };
}
function saveStateNow() {
  clearTimeout(stateTimer);
  stateTimer = null;
  writeJson(stateFile, currentState());
}
function saveStateSoon() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(saveStateNow, 600);
}
function usableBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 60 && b.x + b.width > a.x + 60 && b.y < a.y + a.height - 60 && b.y + b.height > a.y + 20;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}

// ---------- helpers ----------

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
function find(id) { return services.find((x) => x.id === id); }

function visibleIds() {
  if (active === null) return [];
  const ids = [active];
  if (split && split !== active && views.has(split)) ids.push(split);
  return ids;
}
function focusId() {
  const vis = visibleIds();
  if (focused && vis.includes(focused)) return focused;
  return active;
}

function pushState() {
  if (!uiReady || !ui || ui.webContents.isDestroyed()) return;
  ui.webContents.send('state', { services, order, active, split, target: focusId() });
}
function sendToUI(channel, payload) {
  if (!uiReady || !ui || ui.webContents.isDestroyed()) return;
  ui.webContents.send(channel, payload);
}

// ---------- layout (home screen, single app, or split screen) ----------

function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  if (active === null) {
    ui.setBounds({ x: 0, y: 0, width, height });
  } else {
    ui.setBounds({ x: 0, y: 0, width, height: TAB_H });
  }
  const ids = visibleIds();
  const bodyH = Math.max(0, height - TAB_H);
  for (const [id, v] of views) {
    const i = ids.indexOf(id);
    if (i === -1) { v.setVisible(false); continue; }
    v.setVisible(true);
    if (ids.length === 1) {
      v.setBounds({ x: 0, y: TAB_H, width, height: bodyH });
    } else {
      const half = Math.floor(width / 2);
      const x = i === 0 ? 0 : half + 1;
      const w = i === 0 ? half - 1 : width - half - 1;
      v.setBounds({ x, y: TAB_H, width: Math.max(0, w), height: bodyH });
    }
  }
  // keep the top bar above every service view
  win.contentView.addChildView(ui);
}

// ---------- zoom ----------

function clampZoom(z) { return Math.min(3, Math.max(0.5, Math.round(z * 100) / 100)); }
function applyZoom(id) {
  const v = views.get(id);
  const s = find(id);
  if (v && s && !v.webContents.isDestroyed()) v.webContents.setZoomFactor(s.zoom || 1);
}
function changeZoom(id, dir) {
  const s = find(id);
  if (!s) return;
  if (dir === 'reset') s.zoom = 1;
  else s.zoom = clampZoom((s.zoom || 1) + (dir === 'in' ? 0.1 : -0.1));
  applyZoom(id);
  saveServices();
  pushState();
}

// ---------- service views ----------

function createView(s) {
  const viewPrefs = { partition: s.partition, preload: path.join(__dirname, 'webauthn-off.js') };
  const v = new WebContentsView({ webPreferences: viewPrefs });
  const wc = v.webContents;
  wc.setUserAgent(UA);
  const myHost = hostOf(s.url);

  wc.setWindowOpenHandler(({ url }) => {
    const h = hostOf(url);
    const authHosts = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com|auth0\.com|openai\.com|anthropic\.com)$/;
    if (authHosts.test(h)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 700, autoHideMenuBar: true, webPreferences: viewPrefs }
      };
    }
    if (h && myHost && (h === myHost || h.endsWith('.' + myHost) || myHost.endsWith('.' + h))) {
      wc.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // zoom: keep each service's zoom level, and Ctrl +, Ctrl -, Ctrl 0 work inside the page
  wc.on('dom-ready', () => applyZoom(s.id));
  wc.on('did-navigate', () => applyZoom(s.id));
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    if (input.key === '=' || input.key === '+') { e.preventDefault(); changeZoom(s.id, 'in'); }
    else if (input.key === '-' || input.key === '_') { e.preventDefault(); changeZoom(s.id, 'out'); }
    else if (input.key === '0') { e.preventDefault(); changeZoom(s.id, 'reset'); }
  });

  // remember which pane the user is working in (zoom buttons act on it)
  wc.on('focus', () => {
    if (focused !== s.id) { focused = s.id; pushState(); }
  });

  // right-click inside a page: copy / paste / open link
  wc.on('context-menu', (e, p) => {
    const items = [];
    if (p.linkURL && /^https?:/i.test(p.linkURL)) {
      items.push({ label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'cut', enabled: p.editFlags.canCut });
      items.push({ role: 'copy', enabled: p.editFlags.canCopy });
      items.push({ role: 'paste', enabled: p.editFlags.canPaste });
      items.push({ role: 'selectAll' });
    } else if (p.selectionText) {
      items.push({ role: 'copy' });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Reload', click: () => wc.reload() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  // recover from a crashed page, and retry a few times if the network was down at start
  wc.on('render-process-gone', (e, d) => {
    if (d.reason !== 'clean-exit' && !wc.isDestroyed()) setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 800);
  });
  let retries = 0;
  wc.on('did-finish-load', () => { retries = 0; });
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || retries >= 3) return;
    retries++;
    setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(s.url); }, 5000);
  });

  wc.loadURL(s.url);
  return v;
}

function ensureView(id) {
  const s = find(id);
  if (!s) return null;
  if (!views.has(id)) {
    const v = createView(s);
    views.set(id, v);
    order.push(id);
    win.contentView.addChildView(v);
  }
  return views.get(id);
}

function openService(id) {
  if (!find(id)) return;
  ensureView(id);
  if (split === id) split = null;
  active = id;
  focused = id;
  layout();
  pushState();
  saveStateSoon();
}

function showHome() {
  active = null;
  layout();
  pushState();
  saveStateSoon();
}

function closeService(id) {
  const v = views.get(id);
  if (v) {
    try { win.contentView.removeChildView(v); } catch (e) {}
    try { v.webContents.close(); } catch (e) {}
    views.delete(id);
  }
  order = order.filter((x) => x !== id);
  if (focused === id) focused = null;
  if (split === id) split = null;
  if (active === id) {
    if (split && views.has(split)) { active = split; split = null; }
    else active = order.length ? order[order.length - 1] : null;
  }
  layout();
  pushState();
  saveStateSoon();
}

// ---------- split screen ----------

function setSplit(id) {
  if (!find(id) || active === null || id === active) return;
  ensureView(id);
  split = id;
  focused = id;
  layout();
  pushState();
  saveStateSoon();
}
function closeSplit() {
  split = null;
  layout();
  pushState();
  saveStateSoon();
}
function swapSplit() {
  if (!split || active === null) return;
  const t = active;
  active = split;
  split = t;
  layout();
  pushState();
  saveStateSoon();
}

// ---------- Claude usage (reads each account's usage page in a hidden window) ----------

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
      sendToUI('usage', { id: s.id, loading: true });
      const r = await fetchUsage(s.partition);
      sendToUI('usage', { id: s.id, ts: Date.now(), ...r });
    }
  } finally {
    usageBusy = false;
  }
}

// ---------- window ----------

function createWindow() {
  Menu.setApplicationMenu(null);
  const saved = readJson(stateFile, {});
  const b = usableBounds(saved.bounds) || {};
  const opts = {
    width: b.width || 1500,
    height: b.height || 950,
    minWidth: 800,
    minHeight: 500,
    title: 'Multi AI',
    backgroundColor: '#2c303a'
  };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) { opts.x = b.x; opts.y = b.y; }
  win = new BaseWindow(opts);
  if (saved.maximized) win.maximize();

  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.contentView.addChildView(ui);
  ui.webContents.on('render-process-gone', () => {
    uiReady = false;
    setTimeout(() => { if (!ui.webContents.isDestroyed()) ui.webContents.reload(); }, 500);
  });
  ui.webContents.on('did-finish-load', () => {
    uiReady = true;
    pushState();
  });
  ui.webContents.loadFile('index.html');

  // reopen the apps that were open last time
  if (Array.isArray(saved.order)) {
    saved.order.filter((id) => find(id)).forEach((id) => ensureView(id));
    if (saved.active && views.has(saved.active)) active = saved.active;
    if (saved.split && views.has(saved.split) && saved.split !== active) split = saved.split;
    if (active === null) split = null;
    focused = active;
  }

  win.on('resize', () => { layout(); saveStateSoon(); });
  win.on('move', saveStateSoon);
  win.on('maximize', () => { layout(); saveStateSoon(); });
  win.on('unmaximize', () => { layout(); saveStateSoon(); });
  win.on('close', saveStateNow);
  win.on('closed', () => app.quit());
  layout();

  setTimeout(() => refreshUsage(), 6000);
  usageTimer = setInterval(() => refreshUsage(), REFRESH_MS);
}

// ---------- messages from the interface ----------

ipcMain.on('open', (e, id) => openService(id));
ipcMain.on('home', () => showHome());
ipcMain.on('close', (e, id) => closeService(id));
ipcMain.on('reload-active', () => {
  const id = focusId();
  if (id && views.get(id)) views.get(id).webContents.reload();
});
ipcMain.on('refresh-usage', (e, id) => refreshUsage(id));

ipcMain.on('zoom', (e, dir) => {
  const id = focusId();
  if (id) changeZoom(id, dir);
});
ipcMain.on('zoom-id', (e, { id, dir }) => changeZoom(id, dir));

ipcMain.on('split-close', () => closeSplit());
ipcMain.on('split-swap', () => swapSplit());
ipcMain.on('split-menu', () => {
  const items = [];
  const others = order.filter((id) => id !== active && find(id));
  others.forEach((id) => {
    items.push({
      label: 'Show ' + find(id).name + ' beside this',
      type: 'radio',
      checked: split === id,
      click: () => setSplit(id)
    });
  });
  if (!others.length) items.push({ label: 'Open another app first (right-click an app to add it)', enabled: false });
  if (split) {
    items.push({ type: 'separator' });
    items.push({ label: 'Swap sides', click: () => swapSplit() });
    items.push({ label: 'Close split screen', click: () => closeSplit() });
  }
  Menu.buildFromTemplate(items).popup({ window: win });
});

ipcMain.on('context-menu', (e, id) => {
  const s = find(id);
  if (!s) return;
  const opened = views.has(id);
  const items = [
    { label: 'Open', click: () => openService(id) },
    {
      label: 'Show beside current app (split screen)',
      enabled: active !== null && active !== id,
      click: () => setSplit(id)
    }
  ];
  if (split === id) items.push({ label: 'Close split screen', click: () => closeSplit() });
  items.push(
    { type: 'separator' },
    { label: 'Zoom in  (Ctrl +)', click: () => changeZoom(id, 'in') },
    { label: 'Zoom out  (Ctrl -)', click: () => changeZoom(id, 'out') },
    { label: 'Reset zoom  (Ctrl 0)', click: () => changeZoom(id, 'reset') },
    { type: 'separator' },
    { label: 'Reload', enabled: opened, click: () => views.get(id) && views.get(id).webContents.reload() },
    { label: 'Close (login stays saved)', enabled: opened, click: () => closeService(id) },
    { type: 'separator' },
    { label: 'Edit...', click: () => { showHome(); sendToUI('edit', id); } }
  );
  Menu.buildFromTemplate(items).popup({ window: win });
});

ipcMain.on('save-service', (e, { id, name, url, shared }) => {
  name = String(name || '').trim();
  url = normalizeUrl(url);
  if (!name || !url) return;
  if (id) {
    const s = find(id);
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

// ---------- start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit(); // a second copy would fight over the saved logins
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('before-quit', () => {
    clearInterval(usageTimer);
    if (win && !win.isDestroyed()) saveStateNow();
  });
  app.whenReady().then(() => {
    loadServices();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
