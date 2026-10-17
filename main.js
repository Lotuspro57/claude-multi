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
      win.contentView.addChildView(v);
      layout();
      pushState();
    }
  }
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
  return v;
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BaseWindow({ width: 1500, height: 950, minWidth: 800, minHeight: 500, title: 'Multi AI', backgroundColor: '#14161c' });

  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.contentView.addChildView(ui);
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

function loadServices() {
  servicesFile = path.join(app.getPath('userData'), 'services.json');
  try {
    const data = JSON.parse(fs.readFileSync(servicesFile, 'utf8'));
    if (Array.isArray(data) && data.length) {
      const normalized = data
        .map((service, index) => sanitizeService(service, `svc-${index}`))
        .filter(Boolean);
      if (normalized.length) {
        services = normalized;
        return;
      }
    }
  } catch (e) {}
  services = DEFAULTS.map((s) => ({ ...s, partition: s.kind === 'claude' ? s.partition : SHARED }));
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
