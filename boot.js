// Start-up file. Normally it runs the app built into the installed exe. If an update pack was
// installed from the Updates screen and is newer, it runs that instead, with no reinstall.
// If the updated version fails to start twice in a row it is thrown away automatically.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function cmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
const builtIn = path.join(__dirname, 'main.js');
let target = builtIn;
const activeFile = path.join(app.getPath('userData'), 'active.json');
try {
  const act = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
  const dir = path.join(app.getPath('userData'), 'app', String(act.version));
  if (act.fails >= 2 || cmp(act.version, app.getVersion()) <= 0 || !fs.existsSync(path.join(dir, 'main.js'))) {
    try { fs.unlinkSync(activeFile); } catch (e) {}
  } else {
    act.fails = (act.fails || 0) + 1;
    fs.writeFileSync(activeFile, JSON.stringify(act));
    target = path.join(dir, 'main.js');
    global.__patchOk = () => { try { act.fails = 0; fs.writeFileSync(activeFile, JSON.stringify(act)); } catch (e) {} };
  }
} catch (e) { /* no update installed */ }

try { require(target); }
catch (e) {
  if (target !== builtIn) { try { fs.unlinkSync(activeFile); } catch (x) {} require(builtIn); }
  else throw e;
}
