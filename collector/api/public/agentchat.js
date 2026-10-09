/* THE ASSISTANT'S WINDOW — a button at the bottom of every page; on the
   desktop a docked window, on the phone the whole screen with a minimise.
   ──────────────────────────────────────────────────────────────────────────
   The operator (2026-10-09): "It's not a page, it's a chat button at the
   bottom with chat window in desktop and a whole complete chat on phone with
   minimize option." So it lives on <body>, outside #app and #m: every view
   replaces #view wholesale, and a conversation must survive the reader moving
   from the Drivers page to the Money page mid-answer.

   What it shows beside every answer, because "never invent data" is only as
   good as the reader's ability to check it:
     · the CHIPS above the box — the dates, driver, car, fleet and platform the
       conversation is working with — each removable with ×, which the next
       question sends as `clear`;
     · "How I got this" under an answer — every result it stands on, in the
       server's words, with the assumption each one made ("last week = the
       last full Monday-to-Sunday week") and any refusal or error;
     · that the lighter model answered, when it did;
     · that an answer is the figures as measured rather than written up, when
       the check refused the model's own words twice.

   It sends the page the reader is on (the view, its dates, fleet and
   platform) so "why is this behind?" means this page. It keeps nothing
   itself: the conversation is on the server, which forgets it after 24 hours,
   and "New chat" forgets it at once. */

const API = { state: '/api/agent/state', chat: '/api/agent/chat', fresh: '/api/agent/new' };
const OPEN_KEY = 'ak-open';
const SUGGEST = [
  'How many trips did the fleet complete yesterday?',
  'Top 5 drivers by completed trips last week',
  'Are we on track for the month target?',
  'Cash trips this month by driver, as Excel',
];

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};
const isPhone = () => document.documentElement.dataset.ui === 'phone';

/* ── formatting a table cell the way the pages do ──────────────────────── */
const DSHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MSHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function cell(v, kind) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  const num = typeof v === 'number' || (kind !== 'text' && kind !== 'date' && v !== '' && Number.isFinite(n));
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}/.test(String(v))) {
    const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
    return `${DSHORT[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MSHORT[d.getUTCMonth()]}`;
  }
  if (!num) return String(v);
  const f = (dp) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sign = n < 0 ? '−' : '';
  if (kind === 'aed') return `${sign}${f(2)}`;
  if (kind === 'int') return `${sign}${f(0)}`;
  if (kind === 'km') return `${sign}${f(Math.abs(n) >= 100 ? 0 : 1)}`;
  if (kind === 'pct') return `${sign}${f(1)}%`;
  return Number.isInteger(n) ? `${sign}${f(0)}` : `${sign}${f(2)}`;
}
const NUMERIC = new Set(['aed', 'int', 'km', 'pct', 'num', 'num2', 'pts']);

/* ── the answer's text: paragraphs, lists, bold — and where the tables and
   files go, at the place the model put them. Escaped first, always. ─── */
function renderText(text, blocks) {
  const wrap = h('div', 'ak-text');
  const lines = String(text || '').split('\n');
  let list = null; let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = h('p');
    p.innerHTML = para.map((l) => inline(l)).join('<br>');
    wrap.append(p); para = [];
  };
  const flushList = () => { if (list) { wrap.append(list); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const mark = /^\s*\[\[\s*(table|file)\s+(r\d+)\s*\]\]\s*$/i.exec(line);
    if (mark) {
      flushPara(); flushList();
      const b = blocks[`${mark[1].toLowerCase()}:${mark[2]}`];
      if (b) { wrap.append(b); b.dataset.placed = '1'; }
      continue;
    }
    const li = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      if (!list || (ordered ? list.tagName !== 'OL' : list.tagName !== 'UL')) { flushList(); list = h(ordered ? 'ol' : 'ul'); }
      const item = h('li'); item.innerHTML = inline(li[1]); list.append(item);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return wrap;
}
const inline = (s) => esc(s)
  .replace(/\[\[\s*(table|file)\s+r\d+\s*\]\]/gi, '')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');

function renderTable(t) {
  const box = h('div');
  const wrap = h('div', 'ak-tablewrap');
  const table = h('table', 'ak-table');
  const cap = h('caption', null, t.title || '');
  table.append(cap);
  const thead = h('thead'); const tr = h('tr');
  for (const c of t.columns || []) {
    const th = h('th', NUMERIC.has(c.kind) ? 'n' : null, c.kind === 'aed' ? `${c.label} (AED)` : c.label);
    tr.append(th);
  }
  thead.append(tr); table.append(thead);
  const tb = h('tbody');
  for (const row of t.rows || []) {
    const r = h('tr');
    /* A comparison's rows each carry their own format (trips, dirhams,
       percentages in one column). */
    for (const c of t.columns || []) {
      const kind = c.kind === 'num' && row.__kind ? (c.key === 'change_pct' ? 'pct' : row.__kind) : c.kind;
      r.append(h('td', NUMERIC.has(c.kind) ? 'n' : null, cell(row[c.key], kind)));
    }
    tb.append(r);
  }
  table.append(tb); wrap.append(table); box.append(wrap);
  if ((t.total_rows || 0) > (t.rows || []).length) {
    box.append(h('div', 'ak-more', `Showing ${(t.rows || []).length} of ${t.total_rows.toLocaleString('en-US')} rows — ask for it as an Excel file to get all of them.`));
  }
  return box;
}
function renderFile(f) {
  const a = h('a', 'ak-file');
  a.href = f.url; a.setAttribute('download', '');
  a.innerHTML = `<span aria-hidden="true">⬇</span><span><b>${esc(f.title || 'Excel file')}.xlsx</b><br><small>${f.rows != null ? `${Number(f.rows).toLocaleString('en-US')} rows · ` : ''}kept for 24 hours</small></span>`;
  return a;
}

/* ── the widget ───────────────────────────────────────────────────────── */
let mounted = false;
export function mountAssistant() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  /* BEFORE arkiv.css, never after it: the Arkiv skin wins every tie by being
     the last stylesheet in the document (test/arkiv_skin.test.mjs), and an
     appended link took that place — 1 check failed in the full suite. The
     widget's own rules are all .ak-* classes, so they lose nothing by order. */
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/agentchat.css';
  const arkiv = document.querySelector('link[rel=stylesheet][href="/arkiv.css"]');
  if (arkiv) arkiv.parentNode.insertBefore(css, arkiv);
  else document.head.append(css);

  const fab = h('button', 'ak-fab');
  fab.type = 'button'; fab.hidden = true;
  fab.setAttribute('aria-label', 'Ask the assistant');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>';
  const dot = h('span', 'ak-dot'); dot.hidden = true; fab.append(dot);

  const panel = h('section', 'ak-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Assistant');
  const head = h('header', 'ak-head');
  const title = h('div', 'ak-title');
  title.innerHTML = '<b>Ask FleetMirror</b><span>Answers from the dashboard’s own figures · read-only · forgets after 24 hours</span>';
  const actions = h('div', 'ak-actions');
  const btnNew = h('button', 'ak-btn', 'New chat'); btnNew.type = 'button';
  btnNew.title = 'Start again — forgets this conversation and its files now';
  const btnMin = h('button', 'ak-btn ak-icon', '–'); btnMin.type = 'button';
  btnMin.setAttribute('aria-label', 'Minimise'); btnMin.title = 'Minimise';
  actions.append(btnNew, btnMin);
  head.append(title, actions);
  const chips = h('div', 'ak-chips'); chips.hidden = true;
  const log = h('div', 'ak-log'); log.setAttribute('aria-live', 'polite');
  const form = h('form', 'ak-form');
  const box = h('textarea'); box.rows = 1; box.placeholder = 'Ask about trips, drivers, cars, cash, targets…';
  box.setAttribute('aria-label', 'Your question'); box.maxLength = 2000;
  const send = h('button', 'ak-send', 'Send'); send.type = 'submit';
  form.append(box, send);
  const foot = h('div', 'ak-foot', 'It reads only what your access already shows. Check “How I got this” under any answer.');
  panel.append(head, chips, log, form, foot);
  document.body.append(fab, panel);

  let context = {};
  let clear = new Set();
  let busy = false;
  let available = true;
  let working = null;

  /* The page the reader is on. */
  function page() {
    const raw = location.hash.slice(1);
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const sp = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    const view = decodeURIComponent((path.split('/')[0] || '')) || null;
    const titleEl = document.querySelector('#viewTitle, .m-title, #m h1');
    const p = { view, title: (titleEl?.textContent || view || '').trim().slice(0, 60) };
    if (sp.get('from') && sp.get('to')) { p.from = sp.get('from'); p.to = sp.get('to'); }
    else if (sp.get('period')) p.period = sp.get('period');
    else if (sp.get('days')) p.days = sp.get('days');
    else p.period = 'month';
    if (sp.get('fleet')) p.fleet = sp.get('fleet');
    if (sp.get('platform')) p.platform = sp.get('platform');
    return p;
  }

  function drawChips() {
    chips.replaceChildren();
    const items = [];
    if (context.period?.label) items.push(['period', 'Dates', context.period.label]);
    if (context.driver?.name) items.push(['driver', 'Driver', context.driver.name]);
    if (context.car) items.push(['car', 'Car', context.car]);
    if (context.fleet) items.push(['fleet', 'Fleet', context.fleet[0].toUpperCase() + context.fleet.slice(1)]);
    if (context.platform) items.push(['platform', 'Platform', context.platform[0].toUpperCase() + context.platform.slice(1)]);
    for (const [k, label, value] of items) {
      if (clear.has(k)) continue;
      const c = h('span', 'ak-chip');
      c.innerHTML = `<b>${esc(label)}</b><span>${esc(value)}</span>`;
      const x = h('button', null, '×'); x.type = 'button';
      x.setAttribute('aria-label', `Forget ${label.toLowerCase()} ${value}`);
      x.title = `Stop using ${value}`;
      x.onclick = () => { clear.add(k); drawChips(); };
      c.append(x); chips.append(c);
    }
    chips.hidden = !chips.children.length;
  }

  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  function emptyState() {
    const e = h('div', 'ak-empty');
    e.append(h('p', null, available
      ? 'Ask about the fleet in plain English — trips, drivers, cars, cash, targets. It checks every number against the dashboard, asks when a name or date is unclear, and can give you an Excel file.'
      : 'The assistant is not set up yet: it has no model key. An administrator can add one in Settings → Assistant.'));
    if (available) {
      const s = h('div', 'ak-suggest');
      for (const q of SUGGEST) {
        const b = h('button', 'ak-btn', q); b.type = 'button';
        b.onclick = () => ask(q);
        s.append(b);
      }
      e.append(s);
    }
    return e;
  }

  function addUser(text) {
    log.querySelector('.ak-empty')?.remove();
    log.append(h('div', 'ak-msg ak-user', text));
    scrollDown();
  }

  function addBot(m) {
    log.querySelector('.ak-empty')?.remove();
    const wrap = h('div', 'ak-msg ak-bot');
    if (m.type === 'ask') {
      wrap.append(renderText(m.question, {}));
      const opts = h('div', 'ak-options');
      for (const o of m.options || []) {
        const b = h('button', 'ak-btn', o); b.type = 'button';
        b.onclick = () => { opts.querySelectorAll('button').forEach((x) => { x.disabled = true; }); ask(o); };
        opts.append(b);
      }
      if ((m.options || []).length) wrap.append(opts);
    } else if (m.type === 'error') {
      const t = h('div', 'ak-text ak-error', m.text || 'Something went wrong.');
      wrap.append(t);
    } else {
      const blocks = {};
      for (const t of m.tables || []) blocks[`table:${t.id}`] = renderTable(t);
      for (const f of m.files || []) blocks[`file:${f.id}`] = renderFile(f);
      const text = renderText(m.text, blocks);
      if (m.plain) text.classList.add('ak-plain');
      wrap.append(text);
      /* A table or file the text did not place still belongs to the answer. */
      for (const b of Object.values(blocks)) if (!b.dataset.placed) wrap.append(b);
    }
    const src = (m.sources || []).filter((s) => s.definition);
    if (src.length) {
      const d = h('details', 'ak-how');
      d.append(h('summary', null, 'How I got this'));
      const ul = h('ul');
      for (const s of src) {
        const li = h('li');
        li.innerHTML = `${esc(s.definition)}${s.assumption ? ` <i>— ${esc(s.assumption)}</i>` : ''}`
          + `${s.withheld ? ` <i>— not shown: ${esc(s.withheld)}</i>` : ''}${s.error ? ` <i>— not available: ${esc(s.error)}</i>` : ''}`;
        ul.append(li);
      }
      d.append(ul); wrap.append(d);
    }
    if (m.fallback && m.model) wrap.append(h('div', 'ak-meta', `Answered by the lighter model (${m.model}) because the main one did not respond.`));
    log.append(wrap);
    scrollDown();
    if (panel.hidden) dot.hidden = false;
  }

  function setWorking(text) {
    if (!working) { working = h('div', 'ak-working'); log.append(working); }
    working.textContent = text;
    scrollDown();
  }
  function stopWorking() { working?.remove(); working = null; }

  async function ask(text) {
    const q = String(text || '').trim();
    if (!q || busy) return;
    busy = true; send.disabled = true;
    addUser(q);
    box.value = ''; grow();
    setWorking('Thinking…');
    const body = { message: q, page: page(), clear: [...clear] };
    clear = new Set();
    let last = null;
    try {
      const r = await fetch(API.chat, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok || !r.body) {
        let j = null; try { j = await r.json(); } catch { j = null; }
        throw Object.assign(new Error(j?.detail || `The server answered ${r.status}.`), { shown: true });
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === 'status') setWorking(e.text);
          else if (e.type === 'answer' || e.type === 'ask' || e.type === 'error') last = e;
        }
      }
      stopWorking();
      if (!last) throw Object.assign(new Error('The answer was cut off on the way. Try again.'), { shown: true });
      addBot(last);
      if (last.context) { context = last.context; drawChips(); }
    } catch (e) {
      stopWorking();
      const wrap = h('div', 'ak-msg ak-bot');
      wrap.append(h('div', 'ak-text ak-error', e.shown ? e.message : 'Could not reach the server — check the connection and try again.'));
      const retry = h('button', 'ak-btn', 'Try again'); retry.type = 'button';
      retry.onclick = () => { wrap.remove(); log.lastElementChild?.classList.contains('ak-user') && log.lastElementChild.remove(); ask(q); };
      wrap.append(retry);
      log.append(wrap); scrollDown();
    } finally {
      busy = false; send.disabled = false;
      if (!panel.hidden && !isPhone()) box.focus();
    }
  }

  async function load() {
    let s = null;
    try {
      const r = await fetch(API.state, { headers: { accept: 'application/json' } });
      /* Signed out where sign-in is required, a role without the action, or a
         server without the assistant at all: no button. */
      if (!r.ok) { fab.hidden = true; panel.hidden = true; return; }
      s = await r.json();
    } catch { s = null; }
    fab.hidden = false;
    available = s ? Boolean(s.available) : true;
    log.replaceChildren();
    const msgs = s?.conversation?.messages || [];
    if (!msgs.length) log.append(emptyState());
    for (const m of msgs) {
      if (m.role === 'user') addUser(m.text);
      else addBot(m);
    }
    context = s?.conversation?.context || {};
    drawChips();
    dot.hidden = true;
  }

  function open() {
    panel.hidden = false; fab.setAttribute('aria-expanded', 'true'); dot.hidden = true;
    if (isPhone()) fab.hidden = true;
    store.set(OPEN_KEY, '1');
    scrollDown();
    if (!isPhone()) box.focus();
  }
  function minimise() {
    panel.hidden = true; fab.hidden = false; fab.setAttribute('aria-expanded', 'false');
    store.set(OPEN_KEY, '0');
    fab.focus();
  }
  fab.onclick = () => (panel.hidden ? open() : minimise());
  btnMin.onclick = minimise;
  btnNew.onclick = async () => {
    if (busy) return;
    try { await fetch(API.fresh, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* the next load says */ }
    context = {}; clear = new Set();
    await load();
    if (!panel.hidden && !isPhone()) box.focus();
  };
  form.onsubmit = (e) => { e.preventDefault(); ask(box.value); };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(box.value); }
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') minimise(); });
  const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 140)}px`; };
  box.addEventListener('input', grow);

  /* The phone's keyboard: the panel follows the visible viewport, so the box
     stays above the keys instead of behind them. */
  if (window.visualViewport) {
    const fit = () => { document.documentElement.style.setProperty('--ak-vh', `${Math.round(window.visualViewport.height)}px`); };
    window.visualViewport.addEventListener('resize', fit);
    fit();
  }

  load().then(() => { if (store.get(OPEN_KEY) === '1' && !fab.hidden) open(); });
}
