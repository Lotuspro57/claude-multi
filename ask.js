// Ask tab engine: types a question into the real, signed-in AI pages (hidden), picks the best
// one for the kind of question, and moves on to the next one if a page is full or not signed in.
// It drives web pages, so a site redesign can break one site; the others keep working.

const SITES = [
  { key: 'claude', host: /(^|\.)claude\.ai$/, fresh: 'https://claude.ai/new',
    input: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[aria-label*="Send" i]'], stop: ['button[aria-label*="Stop" i]'],
    reply: ['[data-testid="assistant-message"]', '.font-claude-response', '.font-claude-message'] },
  { key: 'chatgpt', host: /(^|\.)(chatgpt\.com|chat\.openai\.com)$/, fresh: 'https://chatgpt.com/',
    input: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'], stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    reply: ['[data-message-author-role="assistant"]'] },
  { key: 'deepseek', host: /(^|\.)deepseek\.com$/, fresh: 'https://chat.deepseek.com/',
    input: ['textarea', 'div[contenteditable="true"]'], send: [], stop: [],
    reply: ['.ds-markdown', '.ds-markdown--block'] },
  { key: 'perplexity', host: /(^|\.)perplexity\.ai$/, fresh: 'https://www.perplexity.ai/',
    input: ['#ask-input', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'], stop: ['button[aria-label*="Stop" i]'],
    reply: ['[id^="markdown-content"]', 'div.prose'] },
  { key: 'grok', host: /(^|\.)(grok\.com|x\.ai)$/, fresh: 'https://grok.com/',
    input: ['textarea', 'div[contenteditable="true"]'], send: ['button[aria-label*="Submit" i]', 'button[type="submit"]'], stop: ['button[aria-label*="Stop" i]'],
    reply: ['.message-bubble', '[class*="response"]'] },
  { key: 'copilot', host: /(^|\.)copilot\.microsoft\.com$/, fresh: 'https://copilot.microsoft.com/',
    input: ['textarea', 'div[contenteditable="true"]'], send: ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'], stop: ['button[aria-label*="Stop" i]'],
    reply: ['[data-content="ai-message"]', '[data-testid="message-ai"]'] },
  { key: 'mistral', host: /(^|\.)mistral\.ai$/, fresh: 'https://chat.mistral.ai/chat',
    input: ['textarea', 'div[contenteditable="true"]'], send: ['button[type="submit"]', 'button[aria-label*="Send" i]'], stop: ['button[aria-label*="Stop" i]'],
    reply: ['[data-message-part-type="answer"]', '[data-testid="assistant-message"]'] }
];
const GENERIC = { key: 'generic', input: ['textarea', 'div[contenteditable="true"]'], send: ['button[type="submit"]', 'button[aria-label*="Send" i]'], stop: ['button[aria-label*="Stop" i]'], reply: [] };

// Which AI first, by the kind of question
const PREFS = {
  code: ['claude', 'chatgpt', 'deepseek', 'mistral', 'grok', 'copilot', 'perplexity'],
  research: ['perplexity', 'chatgpt', 'claude', 'grok', 'copilot', 'deepseek', 'mistral'],
  writing: ['claude', 'chatgpt', 'mistral', 'deepseek', 'copilot', 'grok', 'perplexity'],
  general: ['claude', 'chatgpt', 'deepseek', 'grok', 'copilot', 'perplexity', 'mistral']
};
function classify(q) {
  if (/\b(code|function|bug|error|script|python|javascript|typescript|java|sql|regex|compile|debug|html|css|react|node|api|program|algorithm|stack ?trace)\b/i.test(q)) return 'code';
  if (/\b(latest|news|today|current|price|who is|sources?|cite|statistics|stats|20\d\d|compare|versus|vs|review|best)\b/i.test(q)) return 'research';
  if (/\b(write|email|essay|rewrite|translate|summari[sz]e|story|poem|letter|caption|post|improve|proofread)\b/i.test(q)) return 'writing';
  return 'general';
}
const LIMIT_RE = /(usage limit|reached (your|the|our) .{0,30}limit|message limit|rate limit|too many requests|out of (free )?messages|limit (reached|exceeded)|you('| a)?re (out of|over)|exceeded (your|the) (current )?quota|come back (at|in|after)|upgrade to (continue|keep)|try again (later|tomorrow|in))/i;
const LOGIN_RE = /(log ?in|sign ?in|sign up|continue with google|welcome back)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
function siteFor(s) { const h = hostOf(s.url); return SITES.find((x) => x.host.test(h)) || null; }

module.exports = function createAsk(deps) {
  const jobs = new Map(); // job id -> { cancelled }

  async function loadFresh(wc, site, url) {
    const target = url;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; wc.removeListener('did-stop-loading', fin); wc.removeListener('did-fail-load', fin); resolve(); } };
      wc.once('did-stop-loading', fin);
      wc.once('did-fail-load', fin);
      setTimeout(fin, 25000);
      wc.loadURL(target).catch(() => fin());
    });
    await sleep(1500);
  }

  // runs inside the page
  function pageScript(site, prompt, phase) {
    return `(async () => {
      const site = ${JSON.stringify(site)};
      const prompt = ${JSON.stringify(prompt)};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const vis = (e) => e && e.getClientRects().length > 0 && !e.disabled;
      const first = (list) => { for (const s of list) { const all = [...document.querySelectorAll(s)].filter(vis); if (all.length) return all[all.length - 1]; } return null; };
      const replies = () => { for (const s of site.reply) { const all = [...document.querySelectorAll(s)]; if (all.length) return all; } return []; };
      const bodyText = () => (document.body ? document.body.innerText : '');
      if (${JSON.stringify(phase)} === 'probe') {
        let inp = null;
        for (let i = 0; i < 40 && !inp; i++) { inp = first(site.input); if (!inp) await sleep(500); }
        return { hasInput: !!inp, url: location.href, text: bodyText().slice(0, 3000) };
      }
      if (${JSON.stringify(phase)} === 'send') {
        const inp = first(site.input);
        if (!inp) return { ok: false };
        const baseCount = replies().length;
        const baseText = bodyText();
        inp.focus();
        if (inp.tagName === 'TEXTAREA' || inp.tagName === 'INPUT') {
          const setter = Object.getOwnPropertyDescriptor(inp.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
          setter.call(inp, prompt);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, prompt);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await sleep(600);
        const btn = site.send.length ? first(site.send) : null;
        let how = 'none';
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); how = 'button'; }
        else {
          const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          inp.dispatchEvent(new KeyboardEvent('keydown', o)); inp.dispatchEvent(new KeyboardEvent('keypress', o)); inp.dispatchEvent(new KeyboardEvent('keyup', o));
          how = 'enter';
        }
        window.__askBase = { count: baseCount, text: baseText.length, limit: ${LIMIT_RE.toString()}.test(baseText) };
        return { ok: true, how };
      }
      // read
      const base = window.__askBase || { count: 0, text: 0, limit: false };
      const list = replies();
      const stopping = site.stop.length ? !!first(site.stop) : false;
      const text = bodyText();
      let reply = '';
      if (list.length > base.count) reply = (list[list.length - 1].innerText || '').trim();
      if (!reply) {
        // fallback for any page: whatever appeared after the question we typed
        const i = text.lastIndexOf(prompt.slice(0, 40));
        if (i >= 0) {
          let rest = text.slice(i + Math.min(prompt.length, 4000)).trim();
          rest = rest.replace(/^(Copy|Edit|Share|Retry)\s*/i, '');
          if (rest.length > 1) reply = rest.slice(0, 20000);
        }
      }
      const limitNow = !base.limit && ${LIMIT_RE.toString()}.test(text);
      return { reply, stopping, limitNow, hasInput: !!first(site.input), len: text.length };
    })()`;
  }

  async function runOn(jobState, svc, prompt, emit) {
    const site = siteFor(svc) || GENERIC;
    const view = deps.ensureView(svc.id);
    if (!view) return { ok: false, status: 'failed', note: 'Could not open' };
    const wc = view.webContents;
    emit('trying', 'Opening ' + svc.name + '...');
    await loadFresh(wc, site, site.fresh || svc.url);
    if (jobState.cancelled) return { ok: false, status: 'cancelled' };

    const probe = await wc.executeJavaScript(pageScript(site, prompt, 'probe')).catch(() => null);
    if (!probe || !probe.hasInput) {
      const t = (probe && probe.text) || '';
      if (LOGIN_RE.test(t) || /login|signin|auth/i.test((probe && probe.url) || '')) return { ok: false, status: 'login', note: 'Not signed in' };
      return { ok: false, status: 'failed', note: 'Could not find the message box' };
    }
    if (LIMIT_RE.test(probe.text)) return { ok: false, status: 'limit', note: 'Limit reached' };

    emit('trying', 'Asking ' + svc.name + '...');
    const sent = await wc.executeJavaScript(pageScript(site, prompt, 'send')).catch(() => null);
    if (!sent || !sent.ok) return { ok: false, status: 'failed', note: 'Could not type the question' };
    if (sent.how === 'enter') {
      // real key press as a backup in case the page ignores synthetic keys
      await sleep(1500);
      try { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); } catch (e) {}
    }

    const started = Date.now();
    let last = '', stable = 0;
    while (Date.now() - started < 180000) {
      if (jobState.cancelled) return { ok: false, status: 'cancelled' };
      await sleep(1500);
      const r = await wc.executeJavaScript(pageScript(site, prompt, 'read')).catch(() => null);
      if (!r) continue;
      if (r.limitNow && !r.reply) return { ok: false, status: 'limit', note: 'Limit reached' };
      if (r.limitNow && r.reply && r.reply.length < 400 && LIMIT_RE.test(r.reply)) return { ok: false, status: 'limit', note: 'Limit reached' };
      if (r.reply) {
        if (r.reply === last && !r.stopping) stable++; else { stable = 0; last = r.reply; }
        emit('trying', 'Answer coming in from ' + svc.name + '...', last);
        if (stable >= 3) return { ok: true, status: 'done', text: last };
      } else if (Date.now() - started > 45000 && !r.stopping) {
        return { ok: false, status: 'failed', note: 'No answer appeared' };
      }
    }
    if (last) return { ok: true, status: 'done', text: last };
    return { ok: false, status: 'failed', note: 'Timed out' };
  }

  function candidates(prompt, only) {
    const all = deps.getServices().filter((s) => !s.external);
    if (only && only.length) return only.map((id) => all.find((s) => s.id === id)).filter(Boolean);
    const kind = classify(prompt);
    const pref = PREFS[kind];
    const rank = (s) => {
      const st = siteFor(s);
      const i = st ? pref.indexOf(st.key) : pref.length + 1;
      return i < 0 ? pref.length : i;
    };
    const pctOf = (s) => { const u = deps.getUsage(s.id); return u && u[0] ? u[0].pct : 0; };
    const list = all.filter((s) => !(s.kind === 'claude' && pctOf(s) >= 95));
    // by preference; among the Claude accounts the emptiest one first
    list.sort((a, b) => (rank(a) - rank(b)) || (a.kind === 'claude' && b.kind === 'claude' ? pctOf(a) - pctOf(b) : 0));
    return { kind, list };
  }

  async function start(req) {
    const job = String(req && req.job || Date.now());
    const prompt = String(req && req.prompt || '').trim();
    if (!prompt) return;
    const state = { cancelled: false };
    jobs.set(job, state);
    const mode = req.mode === 'several' ? 'several' : 'best';
    const emitFor = (svc) => (status, note, text) => deps.send('ask-update', { job, id: svc.id, name: svc.name, status, note, text });
    try {
      if (mode === 'several') {
        const list = candidates(prompt, req.ids || []);
        deps.send('ask-update', { job, plan: list.map((s) => ({ id: s.id, name: s.name })) });
        await Promise.all(list.map(async (svc) => {
          const emit = emitFor(svc);
          const r = await runOn(state, svc, prompt, emit);
          emit(r.status, r.note, r.text);
        }));
      } else {
        const c = candidates(prompt);
        deps.send('ask-update', { job, kind: c.kind, plan: c.list.map((s) => ({ id: s.id, name: s.name })) });
        let got = false;
        for (const svc of c.list) {
          if (state.cancelled) break;
          const emit = emitFor(svc);
          const r = await runOn(state, svc, prompt, emit);
          emit(r.status, r.note, r.text);
          if (r.ok) { got = true; break; }
        }
        if (!got && !state.cancelled) deps.send('ask-update', { job, finished: true, none: true });
      }
    } catch (e) {
      deps.send('ask-update', { job, error: String(e && e.message || e) });
    } finally {
      deps.send('ask-update', { job, finished: true });
      jobs.delete(job);
    }
  }
  function cancel(job) { const j = jobs.get(String(job)); if (j) j.cancelled = true; }
  return { start, cancel, classify };
};
