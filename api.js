// Universal Search engine: asks AI companies directly with the user's own API keys.
// Keys live only in the main process (encrypted with Windows when available) and are only
// ever sent to the company they belong to. Jobs are saved after every step, so a job that
// runs out of key can wait and carry on from the same step once a new key is added.

const path = require('path');

const PROVIDERS = {
  anthropic: { name: 'Claude', color: '#C2410C', model: 'claude-sonnet-5-5', price: [3, 15], help: 'console.anthropic.com' },
  openai: { name: 'ChatGPT', color: '#0F766E', model: 'gpt-4o', price: [2.5, 10], help: 'platform.openai.com/api-keys' },
  google: { name: 'Gemini', color: '#2563EB', model: 'gemini-2.5-flash', price: [0.3, 2.5], help: 'aistudio.google.com/apikey' },
  xai: { name: 'Grok', color: '#111111', model: 'grok-4', price: [3, 15], help: 'console.x.ai' },
  deepseek: { name: 'DeepSeek', color: '#4D6BFE', model: 'deepseek-chat', price: [0.28, 0.42], help: 'platform.deepseek.com' },
  mistral: { name: 'Mistral', color: '#F97316', model: 'mistral-large-latest', price: [2, 6], help: 'console.mistral.ai' },
  perplexity: { name: 'Perplexity', color: '#0E7490', model: 'sonar', price: [1, 1], help: 'perplexity.ai/settings/api' }
};
const ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  perplexity: 'https://api.perplexity.ai/chat/completions'
};
const PREFS = {
  code: ['anthropic', 'openai', 'deepseek', 'mistral', 'xai', 'google', 'perplexity'],
  research: ['perplexity', 'google', 'openai', 'anthropic', 'xai', 'deepseek', 'mistral'],
  writing: ['anthropic', 'openai', 'mistral', 'google', 'deepseek', 'xai', 'perplexity'],
  general: ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral', 'perplexity']
};
function classify(q) {
  if (/\b(code|function|bug|error|script|python|javascript|typescript|java|sql|regex|compile|debug|html|css|react|node|api|program|algorithm|stack ?trace)\b/i.test(q)) return 'code';
  if (/\b(latest|news|today|current|price|who is|sources?|cite|statistics|stats|20\d\d|compare|versus|vs|review|best)\b/i.test(q)) return 'research';
  if (/\b(write|email|essay|rewrite|translate|summari[sz]e|story|poem|letter|caption|post|improve|proofread)\b/i.test(q)) return 'writing';
  return 'general';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const uid = () => Math.random().toString(36).slice(2, 10);

function classifyErr(status, body) {
  const t = String(body || '').toLowerCase();
  if (status === 401) return 'invalid';
  if (status === 403 && /(api key|permission|unauthor|invalid)/.test(t)) return 'invalid';
  if (status === 402) return 'limit';
  if (/(credit balance|insufficient|quota|billing|out of credit|no credits|exceeded your current|balance is too low|spending limit|usage limit)/.test(t)) return 'limit';
  if (status === 429) return 'rate';
  if (status >= 500 || status === 529) return 'down';
  return 'error';
}

module.exports = function createApi({ dir, readJson, writeJson, safeStorage, send }) {
  const keysFile = path.join(dir, 'apikeys.json');
  const jobsFile = path.join(dir, 'searchjobs.json');
  let store = readJson(keysFile, null);
  if (!store || typeof store !== 'object' || !Array.isArray(store.keys)) store = { keys: [], settings: {} };
  store.settings = Object.assign({ dailyCap: 2, smart: true, order: Object.keys(PROVIDERS) }, store.settings || {});
  let jobs = readJson(jobsFile, []);
  if (!Array.isArray(jobs)) jobs = [];
  const running = new Map(); // job id -> { cancelled }

  // jobs that were running when the app closed wait for the user
  for (const j of jobs) {
    if (j.status === 'running') { j.status = 'paused'; j.needs = { providers: [], reason: 'The app was closed while this was running. Press Resume to carry on.' }; }
  }

  let saveT = null;
  function saveSoon() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { writeJson(keysFile, store); writeJson(jobsFile, jobs.slice(-40)); }, 400);
  }

  /* ---------- keys ---------- */
  function enc(text) {
    try { if (safeStorage && safeStorage.isEncryptionAvailable()) return { secure: true, blob: safeStorage.encryptString(text).toString('base64') }; } catch (e) {}
    return { secure: false, blob: Buffer.from(text, 'utf8').toString('base64') };
  }
  function dec(k) {
    try {
      const b = Buffer.from(k.blob, 'base64');
      return k.secure ? safeStorage.decryptString(b) : b.toString('utf8');
    } catch (e) { return ''; }
  }
  function rollover(k) {
    if (k.month !== month()) { k.month = month(); k.spent = 0; k.tin = 0; k.tout = 0; if (k.status === 'limit' && /budget/.test(k.note || '')) { k.status = 'ok'; k.note = ''; } }
  }
  function dailySpent() {
    if (store.settings.day !== today()) { store.settings.day = today(); store.settings.daySpent = 0; }
    return store.settings.daySpent || 0;
  }
  function addSpend(k, cost, tin, tout) {
    rollover(k);
    k.spent = (k.spent || 0) + cost; k.tin = (k.tin || 0) + tin; k.tout = (k.tout || 0) + tout;
    store.settings.daySpent = dailySpent() + cost;
    saveSoon();
  }
  function publicKey(k) {
    rollover(k);
    const secret = dec(k);
    return { id: k.id, provider: k.provider, label: k.label, last4: secret.slice(-4), model: k.model, budget: k.budget || 0, spent: +(k.spent || 0).toFixed(4), tin: k.tin || 0, tout: k.tout || 0, status: k.status, note: k.note || '', secure: !!k.secure, enabled: k.enabled !== false };
  }
  function listAll() {
    return {
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, color: p.color, model: p.model, help: p.help })),
      keys: store.keys.map(publicKey),
      settings: { dailyCap: store.settings.dailyCap, smart: store.settings.smart, order: store.settings.order, daySpent: +dailySpent().toFixed(4) }
    };
  }
  const usable = (k) => k.enabled !== false && k.status === 'ok' && !(k.budget > 0 && (k.spent || 0) >= k.budget);
  function keysFor(provider) { return store.keys.filter((k) => k.provider === provider); }

  /* ---------- one request to one company ---------- */
  async function call(provider, secret, model, prompt, maxTokens) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 150000);
    let res, bodyText;
    try {
      if (provider === 'anthropic') {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
        });
      } else if (provider === 'google') {
        res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': secret },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } })
        });
      } else {
        res = await fetch(ENDPOINTS[provider], {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
        });
      }
      bodyText = await res.text();
    } catch (e) {
      clearTimeout(timer);
      throw { kind: 'network', msg: e && e.name === 'AbortError' ? 'Timed out' : 'Network problem: ' + String(e && e.message || e) };
    }
    clearTimeout(timer);
    let data = null; try { data = JSON.parse(bodyText); } catch (e) {}
    if (!res.ok) {
      const msg = (data && (data.error && (data.error.message || data.error) || data.message)) || bodyText.slice(0, 200) || ('HTTP ' + res.status);
      throw { kind: classifyErr(res.status, bodyText), msg: String(msg).slice(0, 240), status: res.status };
    }
    let text = '', tin = 0, tout = 0;
    if (provider === 'anthropic') {
      text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      tin = data.usage && data.usage.input_tokens || 0; tout = data.usage && data.usage.output_tokens || 0;
    } else if (provider === 'google') {
      const c = data.candidates && data.candidates[0];
      text = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || '').join('') : '';
      tin = data.usageMetadata && data.usageMetadata.promptTokenCount || 0; tout = data.usageMetadata && data.usageMetadata.candidatesTokenCount || 0;
    } else {
      text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
      tin = data.usage && data.usage.prompt_tokens || 0; tout = data.usage && data.usage.completion_tokens || 0;
    }
    if (!text) throw { kind: 'error', msg: 'The AI returned an empty answer' };
    if (!tin) tin = Math.ceil(prompt.length / 4);
    if (!tout) tout = Math.ceil(text.length / 4);
    return { text, tin, tout };
  }
  const costOf = (provider, tin, tout) => (tin * PROVIDERS[provider].price[0] + tout * PROVIDERS[provider].price[1]) / 1e6;

  /* ---------- add / test a key ---------- */
  async function addKey(req) {
    const provider = String(req.provider || '');
    const secret = String(req.key || '').trim();
    if (!PROVIDERS[provider]) return { ok: false, error: 'Unknown company' };
    if (secret.length < 12 || /\s/.test(secret)) return { ok: false, error: 'That does not look like a key. Paste the whole key with no spaces.' };
    const model = String(req.model || '').trim() || PROVIDERS[provider].model;
    let status = 'ok', note = '';
    try { await call(provider, secret, model, 'Reply with the single word OK.', 16); }
    catch (e) {
      if (e.kind === 'invalid') return { ok: false, error: 'The company rejected this key (' + e.msg + ')' };
      if (e.kind === 'limit') { status = 'limit'; note = 'Key works but has no credit left'; }
      else if (e.kind === 'error' && e.status === 404) return { ok: false, error: 'The model name "' + model + '" was not accepted. Check it and try again. (' + e.msg + ')' };
      else if (e.kind === 'network') return { ok: false, error: e.msg };
      // rate/down/other: store it anyway
    }
    const e2 = enc(secret);
    const rec = { id: uid(), provider, label: String(req.label || '').trim() || (PROVIDERS[provider].name + ' key'), secure: e2.secure, blob: e2.blob, model, budget: Math.max(0, Number(req.budget) || 0), spent: 0, tin: 0, tout: 0, month: month(), status, note, enabled: true };
    // a key that replaces a dead one for the same company retires the dead ones that were "limit"
    if (status === 'ok') for (const k of keysFor(provider)) if (k.status === 'limit' || k.status === 'invalid') k.enabled = false;
    store.keys.push(rec);
    saveSoon();
    return { ok: true, id: rec.id, status };
  }
  function updateKey(req) {
    const k = store.keys.find((x) => x.id === req.id); if (!k) return;
    if (typeof req.model === 'string' && req.model.trim()) k.model = req.model.trim();
    if (Number.isFinite(req.budget)) k.budget = Math.max(0, req.budget);
    if (typeof req.enabled === 'boolean') k.enabled = req.enabled;
    if (req.reset) { k.status = 'ok'; k.note = ''; }
    saveSoon();
  }
  function removeKey(id) { store.keys = store.keys.filter((k) => k.id !== id); saveSoon(); }
  function setSettings(s) {
    if (Number.isFinite(s.dailyCap)) store.settings.dailyCap = Math.max(0, s.dailyCap);
    if (typeof s.smart === 'boolean') store.settings.smart = s.smart;
    if (Array.isArray(s.order)) { const o = s.order.filter((x) => PROVIDERS[x]); for (const p of Object.keys(PROVIDERS)) if (!o.includes(p)) o.push(p); store.settings.order = o; }
    saveSoon();
  }

  /* ---------- jobs ---------- */
  const snap = (job) => JSON.parse(JSON.stringify(job));
  function emit(job) { send('search-update', snap(job)); saveSoon(); }

  function orderFor(job) {
    const base = store.settings.smart ? PREFS[job.kind] : store.settings.order;
    return base.filter((p) => !(job.excluded || []).includes(p));
  }

  // runs one request, trying other keys and companies until one answers
  async function tryStep(job, step, state) {
    const candidates = step.provider ? [step.provider] : orderFor(job);
    const exhausted = new Set(); let noKey = true; let capHit = false;
    for (const provider of candidates) {
      for (const k of keysFor(provider)) {
        if (state.cancelled) return false;
        rollover(k);
        if (k.enabled === false) continue;
        noKey = false;
        if (k.status !== 'ok') { exhausted.add(provider); continue; }
        if (k.budget > 0 && k.spent >= k.budget) { exhausted.add(provider); step.trail.push({ provider, key: k.label, result: 'limit', note: 'Monthly budget for this key reached' }); continue; }
        if (store.settings.dailyCap > 0 && dailySpent() >= store.settings.dailyCap && !job.overrideCap) { capHit = true; break; }
        step.status = 'running'; step.provider = step.provider || null; step.trying = provider; emit(job);
        let attempt = 0;
        for (;;) {
          try {
            const t0 = Date.now();
            const r = await call(provider, dec(k), k.model, step.prompt || job.prompt, step.maxTokens || 4096);
            if (state.cancelled) return false;
            const cost = costOf(provider, r.tin, r.tout);
            addSpend(k, cost, r.tin, r.tout);
            step.status = 'done'; step.out = r.text; step.usedProvider = provider; step.tin = r.tin; step.tout = r.tout; step.cost = cost; step.ms = Date.now() - t0; step.note = '';
            step.trail.push({ provider, key: k.label, result: 'ok' });
            return true;
          } catch (e) {
            if (e.kind === 'rate' && attempt === 0) { attempt++; step.trail.push({ provider, key: k.label, result: 'rate', note: 'Busy, waiting a few seconds' }); emit(job); await sleep(5000); continue; }
            step.trail.push({ provider, key: k.label, result: e.kind, note: e.msg });
            if (e.kind === 'limit' || e.kind === 'invalid' || e.kind === 'rate') { k.status = e.kind === 'invalid' ? 'invalid' : 'limit'; k.note = e.kind === 'invalid' ? 'The company rejected this key' : (e.kind === 'rate' ? 'Rate limit (try again later)' : 'No credit or quota left'); exhausted.add(provider); saveSoon(); }
            break;
          }
        }
        emit(job);
      }
      if (capHit) break;
    }
    step.status = 'failed';
    if (capHit) { step.note = 'cap'; job.needs = { providers: [], reason: 'cap', text: 'Your daily spending cap of $' + store.settings.dailyCap.toFixed(2) + ' is reached.' }; return false; }
    const need = [...exhausted];
    step.note = noKey && !need.length ? 'nokey' : 'exhausted';
    step.needs = need;
    return false;
  }

  function makeSteps(job) {
    const active = orderFor(job).filter((p) => keysFor(p).some((k) => usable(k)));
    const mk = (label, provider, extra) => Object.assign({ id: uid(), label, provider: provider || null, status: 'pending', trail: [], out: '' }, extra || {});
    if (job.mode === 'compare') {
      const list = active.slice(0, 4);
      return (list.length ? list : [null]).map((p) => mk(p ? PROVIDERS[p].name : 'Answer', p));
    }
    if (job.mode === 'synthesize') {
      const list = active.slice(0, 3);
      const steps = (list.length ? list : [null]).map((p) => mk(p ? 'Ask ' + PROVIDERS[p].name : 'Ask', p, { phase: 1 }));
      steps.push(mk('Combine into the best answer', null, { phase: 2 }));
      return steps;
    }
    return [mk('Answer', null)];
  }

  async function exec(job, state) {
    job.status = 'running'; job.needs = null; emit(job);
    const pending = (arr) => arr.filter((s) => s.status === 'pending' || s.status === 'failed' || s.status === 'running');
    try {
      if (job.mode === 'best') {
        const s = job.steps[0];
        if (s.status !== 'done') { s.status = 'pending'; s.trail = s.trail || []; await tryStep(job, s, state); }
      } else if (job.mode === 'compare') {
        await Promise.all(pending(job.steps).map((s) => { s.status = 'pending'; return tryStep(job, s, state); }));
      } else {
        const p1 = job.steps.filter((s) => s.phase === 1);
        await Promise.all(pending(p1).map((s) => { s.status = 'pending'; return tryStep(job, s, state); }));
        const done1 = p1.filter((s) => s.status === 'done');
        const merge = job.steps.find((s) => s.phase === 2);
        if (done1.length && merge.status !== 'done' && !job.needs) {
          if (done1.length === 1) { merge.status = 'done'; merge.out = done1[0].out; merge.usedProvider = done1[0].usedProvider; merge.trail = [{ provider: done1[0].usedProvider, result: 'ok', note: 'Only one answer, nothing to combine' }]; }
          else {
            merge.prompt = 'You are combining answers from several AI assistants to one question.\n\nQuestion:\n' + job.prompt + '\n\n' + done1.map((s, i) => 'Answer ' + (i + 1) + ' (' + PROVIDERS[s.usedProvider].name + '):\n' + s.out).join('\n\n') +
              '\n\nWrite the single best answer. Keep what the answers agree on, resolve disagreements with your best judgement, and briefly say what is uncertain. Do not mention that you were given several answers.';
            merge.provider = null; merge.status = 'pending'; await tryStep(job, merge, state);
          }
        }
      }
    } catch (e) { job.error = String(e && e.message || e); }
    if (state.cancelled) { job.status = 'cancelled'; emit(job); running.delete(job.id); return; }

    // work out the result
    const done = job.steps.filter((s) => s.status === 'done');
    const failed = job.steps.filter((s) => s.status === 'failed');
    const last = job.mode === 'synthesize' ? job.steps[job.steps.length - 1] : null;
    const complete = job.mode === 'best' ? done.length === 1 : job.mode === 'compare' ? done.length > 0 : (last && last.status === 'done');
    job.final = job.mode === 'compare' ? { answers: done.map((s) => ({ provider: s.usedProvider, text: s.out, tin: s.tin, tout: s.tout, cost: s.cost, ms: s.ms })) }
      : (complete ? (() => { const s = job.mode === 'best' ? job.steps[0] : last; return { answers: [{ provider: s.usedProvider, text: s.out, tin: s.tin, tout: s.tout, cost: s.cost, ms: s.ms }] }; })() : null);
    job.spent = job.steps.reduce((n, s) => n + (s.cost || 0), 0);
    if (complete && (job.mode !== 'compare' || !failed.length || done.length)) {
      job.status = 'done'; job.needs = job.mode === 'compare' && failed.length ? { providers: failed.flatMap((s) => s.needs || []), reason: 'partial', text: failed.length + ' of the AIs could not answer.' } : null;
    } else {
      job.status = 'paused';
      if (!job.needs) {
        const prov = [...new Set(failed.flatMap((s) => s.needs || []))];
        const noKey = failed.some((s) => s.note === 'nokey');
        job.needs = { providers: prov, reason: noKey && !prov.length ? 'nokey' : 'limit', text: noKey && !prov.length ? 'No API key is set up yet. Add one to start.' : 'Out of credit or quota: ' + (prov.map((p) => PROVIDERS[p].name).join(', ') || 'all keys') + '. Your job is saved and waiting.' };
      }
    }
    emit(job); running.delete(job.id);
  }

  function start(req) {
    const prompt = String(req && req.prompt || '').trim();
    if (!prompt) return null;
    const mode = ['best', 'compare', 'synthesize'].includes(req.mode) ? req.mode : 'best';
    const job = { id: uid(), prompt, mode, kind: classify(prompt), created: Date.now(), status: 'running', excluded: [], steps: [], final: null, needs: null, spent: 0 };
    job.steps = makeSteps(job);
    jobs.push(job);
    const state = { cancelled: false }; running.set(job.id, state);
    exec(job, state);
    return job.id;
  }
  function resume(id, opts) {
    const job = jobs.find((j) => j.id === id); if (!job || running.has(id)) return;
    if (opts && opts.overrideCap) job.overrideCap = true;
    if (opts && opts.exclude) { job.excluded = [...new Set([...(job.excluded || []), opts.exclude])]; }
    // steps that were stuck get another go; finished ones are kept
    for (const s of job.steps) if (s.status === 'failed') { s.status = 'pending'; s.needs = []; if (opts && opts.exclude && s.provider === opts.exclude) s.provider = null; }
    // a compare/synthesize job started with no keys needs its steps rebuilt now that keys exist
    if (job.mode !== 'best' && !job.steps.some((s) => s.status === 'done') && !job.steps.some((s) => s.provider && s.phase !== 2)) { const old = job.steps; job.steps = makeSteps(job); if (!job.steps.length) job.steps = old; }
    const state = { cancelled: false }; running.set(id, state);
    exec(job, state);
  }
  function cancel(id) { const s = running.get(id); if (s) s.cancelled = true; const j = jobs.find((x) => x.id === id); if (j && j.status === 'paused') { j.status = 'cancelled'; emit(j); } }
  function listJobs() { return jobs.slice(-30).reverse().map((j) => ({ id: j.id, prompt: j.prompt, mode: j.mode, status: j.status, created: j.created, spent: j.spent || 0 })); }
  function getJob(id) { const j = jobs.find((x) => x.id === id); return j ? snap(j) : null; }
  function deleteJob(id) { jobs = jobs.filter((j) => j.id !== id); saveSoon(); }

  return { PROVIDERS, listAll, addKey, updateKey, removeKey, setSettings, start, resume, cancel, listJobs, getJob, deleteJob, flush: () => { clearTimeout(saveT); writeJson(keysFile, store); writeJson(jobsFile, jobs.slice(-40)); } };
};
