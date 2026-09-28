/* The page's side of sign-in and access.
   ─────────────────────────────────────────────────────────────────────────
   The server decides everything (api/access/*). This module only draws what
   it decided: who is signed in, which pages will open for them, the "not shown
   to your role" blocks with the true reason, and the one place a change is
   sent with its CSRF header and re-confirmed when the server asks.

   While sign-in is not yet required ('open' mode) and nobody is signed in, the
   product behaves exactly as it always has: every page opens, nothing is
   withheld. Signed in, the page follows the person's role. */
import { CLASS, ROLE, ROLES, LEVEL_NAME, rank, withheldSentence, holdersOf } from './access_model.js';

export const who = {
  loaded: false, signedIn: false, kind: 'anonymous', mode: 'open',
  user: null, access: null, roles: [], owner: false, preview: null, fleets: [], restricted: null,
};

export async function loadWho() {
  let answered = false;
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) { Object.assign(who, await r.json(), { loaded: true }); answered = true; } else who.loaded = true;
  } catch { who.loaded = true; }
  /* Only on an ANSWER. A 503 or no connection says nothing about who is
     here, and treating it as "anonymous" threw away a signed-in person's
     kept figures exactly when they were offline and needed them.
     …but not for ever: what was kept for a signed-in person is kept only as
     long as their session could still be alive (12 hours idle). A shared
     browser whose last reader's session simply ran out, opened while the
     server does not answer (every deploy's migrations, or no signal), used to
     paint that reader's figures (security review, 2026-09-28). */
  if (answered) partitionStorage();
  else forgetIfExpired();
  return who;
}
const KEPT_UNTIL = 'fleet.swr.until';
const IDLE_MS = 12 * 3600_000;
function forgetKept() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fleet.swr') || k === 'adminToken') localStorage.removeItem(k);
  } catch { /* storage blocked */ }
  try {
    if (typeof caches !== 'undefined') {
      caches.keys().then((ks) => ks.filter((k) => /-data(-\d+)?$/.test(k)).forEach((k) => caches.delete(k))).catch(() => {});
    }
  } catch { /* no Cache Storage */ }
}
function forgetIfExpired() {
  try {
    const until = Number(localStorage.getItem(KEPT_UNTIL) || 0);
    if (until && Date.now() > until) forgetKept();
  } catch { /* storage blocked */ }
}

/* The browser keeps recent answers (swr.js) for a fast first paint. Those are
   shaped for the person who read them, so when a different person — or the
   same person with different access — uses this browser, what is kept is
   thrown away before anything is painted from it. */
function partitionStorage() {
  const tag = who.signedIn
    ? `${who.kind}:${who.user?.id ?? who.device?.id ?? ''}:${JSON.stringify(who.access?.byFleet || {})}:${who.preview || ''}`
    : 'anonymous';
  try {
    if (localStorage.getItem('fleet.swr.who') !== tag) {
      for (const k of Object.keys(localStorage)) if (k.startsWith('fleet.swr.v')) localStorage.removeItem(k);
      /* The shared admin token the old Settings page kept here goes too: it is
         a write key, and the next person at this browser is not the one who
         typed it (security review, 2026-09-28). */
      localStorage.removeItem('adminToken');
      localStorage.setItem('fleet.swr.who', tag);
    }
    if (who.signedIn) localStorage.setItem(KEPT_UNTIL, String(Date.now() + IDLE_MS));
    else localStorage.removeItem(KEPT_UNTIL);
  } catch { /* storage blocked: nothing is kept anyway */ }
}

/* Every change this page sends carries the CSRF header, including the forms
   written before sign-in existed that call fetch() directly. Same-origin only,
   and only where the caller did not set one. */
let guarded = false;
export function installFetchGuard() {
  if (guarded || typeof window === 'undefined' || !window.fetch) return;
  guarded = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    try {
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      /* Every same-origin API call, GETs included: a few GETs act (a probe
         spends provider quota, the Tesla link writes OAuth state), and the
         server asks those for the header too. A custom header on a same-origin
         request costs nothing and triggers no preflight. */
      const apiCall = url.origin === location.origin && url.pathname.startsWith('/api/');
      if (apiCall && csrf()) {
        const h = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        if (!h.has('x-fm-csrf')) h.set('x-fm-csrf', csrf());
        init = { ...init, headers: h, credentials: init.credentials || 'same-origin' };
      }
    } catch { /* leave the request exactly as it was */ }
    return orig(input, init);
  };
}

/* Is the page following a role right now? Not for an anonymous visitor while
   sign-in is optional — they get the product as it always was. */
export const gated = () => who.signedIn === true;

export const csrf = () => {
  const m = document.cookie.match(/(?:^|;\s*)fm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};
export const csrfHeaders = () => (csrf() ? { 'x-fm-csrf': csrf() } : {});

/* ── where a signed-out reader goes ───────────────────────────────────── */
export function toSignIn(reason = '') {
  /* From the sign-in page itself, keep where the reader was going. */
  const back = location.pathname === '/signin'
    ? (new URLSearchParams(location.search).get('back') || '/')
    : `${location.pathname}${location.hash}`;
  const q = new URLSearchParams({ back });
  if (reason) q.set('why', reason);
  location.assign(`/signin?${q}`);
}

/* ── withheld answers ─────────────────────────────────────────────────── */
/* A panel whose answer is not shown to this role, on a page that is: the
   page draws the rest, and the withheld banner at its top (from the refusal's
   x-fm-withheld) says what was left out and why. Any other failure still
   fails. */
export const unlessWithheld = (p, fallback) => Promise.resolve(p).catch((e) => {
  if (e instanceof WithheldError || e?.name === 'WithheldError') return typeof fallback === 'function' ? fallback(e) : fallback;
  throw e;
});
export class WithheldError extends Error {
  constructor(body, status) {
    super(body?.detail || 'Not shown to your role.');
    this.name = 'WithheldError';
    this.withheld = body || {};
    this.status = status;
  }
}
/* What this render's answers left out, gathered by api() from the
   x-fm-withheld header, and shown once at the top of the page. */
const seen = new Map();
export function noteWithheld(header) {
  for (const c of String(header || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (c === 'FLEET') continue;
    if (!seen.has(c)) seen.set(c, levelOf(c));
  }
}
export const resetWithheld = () => seen.clear();
export const withheldNow = () => [...seen.entries()];

/* ── levels and pages ─────────────────────────────────────────────────── */
export function levelOf(cls, { any = true } = {}) {
  if (!gated()) return 'F';
  const a = who.access || {};
  return (any ? a.levelsAny?.[cls] : a.levels?.[cls]) || '';
}
export const canDo = (cap) => !gated() || (who.access?.capsAny || []).includes(cap);

/* The class each page is ABOUT (collector/docs/ULM-DESIGN.md §7.1, Appendix
   B). A page opens when the reader holds its subject at any level on at least
   one of their fleets; everything else on it follows their levels. */
export const VIEW_SUBJECT = Object.freeze({
  action: 'ID', advances: 'CASH', analyst: 'REV', 'analyst/rules': 'ID', cancellations: 'ID', capacity: 'BK',
  causes: 'BK', charging: 'CASH', cohort: 'ID', 'cohort/settlement-cash': 'CASH', compare: 'BK', compliance: 'ID',
  corporate: 'REV', 'corporate/approach': 'LOC', 'corporate/guests': 'PAX', corridors: 'LOC', coverage: 'SYS',
  day: 'BK', demand: 'BK', deposits: 'CASH', driver: 'ID', 'driver/earnings': 'EARN', 'driver/money': 'CASH',
  /* A driver's and a vehicle's tabs are each about what their own routes are
     about (api/access/manifest.json): Quality is conduct, Territory is
     places, Trips is bookings, Unexplained trips names a likely culprit. */
  'driver/territory': 'LOC', 'driver/quality': 'COND', 'driver/trips': 'BK', 'driver/unauthorized': 'ACCUSE',
  'vehicle/compliance': 'VEH', drivers: 'ID', feeds: 'VEH', finance: 'REV', forecast: 'BK', 'hr-roster': 'HR', identity: 'MRG',
  'import-sheet': 'CASH', insights: 'ID', live: 'LOC', 'low-performers': 'ID', map: 'LOC', notfound: 'SYS',
  'online-time': 'ID', opening: 'CASH', optimise: 'BK', overview: 'BK', payouts: 'PAY', performance: 'ID',
  performer: 'ID', platforms: 'BK', 'platforms/funnel': 'COND', 'platforms/tiers': 'BK', playbook: 'REV',
  policy: 'CASH', property: 'REV', 'property/drivers': 'ID', 'property/guests': 'PAX', provenance: 'REV',
  providers: 'SYS', receipts: 'PAY', reconcile: 'PAY', retention: 'BK', revenue: 'REV', roster: 'ID',
  'roster/states': 'SYS', safety: 'COND', 'safety/events': 'VEH', 'safety/vehicles': 'VEH', salary: 'CASH',
  'same-person': 'MRG', segment: 'COND', segments: 'COND', settings: 'CRED', settlement: 'REV',
  'settlement/cash': 'CASH', 'settlement/receivables': 'PAY', slot: 'BK', sources: 'SYS', supply: 'BK',
  'top-performers': 'ID', trip: 'BK', trips: 'BK', unauthorized: 'COND', unit: 'REV', 'unit/assets': 'VEH',
  'unit/drivers': 'ID', vehicle: 'VEH', 'vehicle/drivers': 'ID', 'vehicle/earnings': 'REV',
  'vehicle/movement': 'LOC', 'vehicle/safety': 'COND', 'vehicle/trips': 'BK', vehicles: 'VEH',
  /* The account and access pages decide for themselves. */
  account: null, access: null, approvals: null, 'fleet-names': null,
});
export const PHONE_SUBJECT = Object.freeze({
  today: 'REV', overview: 'REV', money: 'REV', finance: 'REV', unit: 'REV', settlement: 'REV', revenue: 'REV',
  people: 'ID', drivers: 'ID', 'online-time': 'ID', fleet: 'VEH', vehicles: 'VEH', vehicle: 'VEH', driver: 'ID',
  live: 'LOC', safety: 'VEH', unauthorized: 'COND', sources: 'SYS', trips: 'BK', more: null, payouts: 'PAY',
  corporate: 'REV', analyst: 'REV', optimise: 'LOC', credentials: 'CRED', deposits: 'CASH', account: null,
});
const VEHICLE_COHORT = /^(vehicles|safety|unit-(idle-documented|moved-unpaid|still))/;
export function subjectOf(view, sub = '', param = '', { phone = false } = {}) {
  const map = phone ? PHONE_SUBJECT : VIEW_SUBJECT;
  if (view === 'cohort') {
    const p = String(param || '');
    if (/^settlement-cash/.test(p)) return 'CASH';
    /* safety-drivers ranks PEOPLE by harsh events: conduct, not vehicles.
       retention-* is read from /api/retention: bookings per person. */
    if (/^safety-drivers/.test(p)) return 'COND';
    if (/^retention/.test(p)) return 'BK';
    return VEHICLE_COHORT.test(p) ? 'VEH' : 'ID';
  }
  /* `#driver/<id>/money` puts the tab in `sub`; `#platforms/tiers` and
     `#settlement/cash` put it in `param`. Either may name the page. */
  if (sub && `${view}/${sub}` in map) return map[`${view}/${sub}`];
  if (param && `${view}/${param}` in map) return map[`${view}/${param}`];
  if (view in map) return map[view];
  /* A desktop page opened on the phone (the fallback) is about what it is
     about on the desktop. */
  if (phone) return subjectOf(view, sub, param);
  return 'SYS';
}
/* Pages that are an ACTION rather than a class of data: open to whoever
   holds the action. #access manages people, so it opens for the Owner and an
   Access admin; everyone else is told so, and it is not in their menu. */
export const VIEW_CAP = Object.freeze({ access: 'access.manage' });
export const VIEW_CAP_WHY = Object.freeze({
  access: 'Deciding who can see what is for the Owner and Access admins. Ask one of them if you need a change.',
});
/* PAGES BUILT FROM TOTALS. A role may hold a class only as totals (level A:
   the Dispatcher's conduct and passengers, the Technician's bookings, a wall
   screen's places and vehicles). A page opens on A only when every route
   behind its subject answers an aggregate — measured from the routes each
   page calls (bin/access-sweep.mjs report) against their grain in
   api/access/manifest.json, 2026-09-28. Every other page is a list or a
   record, which the server refuses at A; offering it in the menu and then
   refusing it is the defect this closes. */
export const VIEW_AGGREGATE = Object.freeze(new Set(['capacity', 'causes', 'demand', 'forecast', 'optimise',
  'overview', 'platforms', 'platforms/tiers', 'supply', 'corridors', 'corporate/approach', 'analyst', 'corporate', 'finance',
  'provenance', 'revenue', 'settlement', 'receipts', 'reconcile']));
export const PHONE_AGGREGATE = Object.freeze(new Set(['today', 'overview', 'money', 'finance', 'settlement',
  'revenue', 'corporate', 'analyst', 'optimise']));
function viewKey(view, sub, param, phone) {
  const map = phone ? PHONE_SUBJECT : VIEW_SUBJECT;
  if (sub && `${view}/${sub}` in map) return `${view}/${sub}`;
  if (param && `${view}/${param}` in map) return `${view}/${param}`;
  return view;
}
export function canOpenView(view, sub = '', param = '', opts = {}) {
  if (!gated()) return true;
  if (VIEW_CAP[view]) return (who.access?.capsAny || []).includes(VIEW_CAP[view]);
  const s = subjectOf(view, sub, param, opts);
  if (s === null) return true;
  const key = viewKey(view, sub, param, opts.phone);
  const totals = (opts.phone ? PHONE_AGGREGATE : VIEW_AGGREGATE).has(key);
  return rank(levelOf(s)) >= (totals ? rank('A') : rank('M'));
}

/* ── the closed page, and asking for access ───────────────────────────── */
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function closedBlock({ cls, view = '', title = 'This page is not open to your role', detail = null } = {}) {
  const box = document.createElement('section');
  box.className = 'access-closed';
  const c = CLASS[cls];
  const holders = cls ? holdersOf(cls).filter((n) => n !== 'Owner') : [];
  box.innerHTML = `
    <p class="ac-eyebrow">Not shown to your role</p>
    <h2>${esc(title)}</h2>
    <p class="ac-why">${esc(detail || (cls ? withheldSentence(cls, { level: levelOf(cls) === 'A' ? 'A' : '' }) : 'Your role does not include this.'))}</p>
    ${c ? `<p class="ac-who">This page is about <b>${esc(c.plain)}</b>. ${holders.length ? `${esc(holders.join(', '))} and the Owner` : 'The Owner'} can open it.</p>` : ''}
    ${who.preview ? `<p class="ac-who">You are previewing the <b>${esc(ROLE[who.preview]?.name || who.preview)}</b> role.</p>` : ''}
    ${who.signedIn && who.kind === 'user' && !who.preview ? `
    <form class="ac-ask">
      <label for="ac-reason">Ask for access — say briefly why you need it</label>
      <textarea id="ac-reason" rows="3" maxlength="600" required></textarea>
      <div class="ac-row"><button type="submit">Send request</button><span class="ac-msg" role="status"></span></div>
    </form>` : ''}`;
  const form = box.querySelector('.ac-ask');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = form.querySelector('.ac-msg');
      const reason = form.querySelector('textarea').value.trim();
      try {
        await post('/api/auth/request', { view, class: cls, reason });
        msg.textContent = 'Sent. The Owner or an Access admin will decide; you will see it on your account page.';
        form.querySelector('button').disabled = true;
      } catch (err) { msg.textContent = err.message; }
    });
  }
  return box;
}

/* One line at the top of a page that opened with parts left out. */
export function withheldBanner() {
  const rows = withheldNow();
  if (!gated() || !rows.length) return null;
  const hidden = rows.filter(([, l]) => l === '').map(([c]) => CLASS[c]?.plain).filter(Boolean);
  const masked = rows.filter(([, l]) => l === 'M').map(([c]) => CLASS[c]?.plain).filter(Boolean);
  const totals = rows.filter(([, l]) => l === 'A').map(([c]) => CLASS[c]?.plain).filter(Boolean);
  if (!hidden.length && !masked.length && !totals.length) return null;
  const el = document.createElement('div');
  el.className = 'access-withheld';
  const parts = [];
  if (hidden.length) parts.push(`<b>Not shown to your role:</b> ${esc(hidden.join(', '))}`);
  if (masked.length) parts.push(`<b>Masked:</b> ${esc(masked.join(', '))} (last characters only)`);
  if (totals.length) parts.push(`<b>Totals only:</b> ${esc(totals.join(', '))}`);
  el.innerHTML = `${parts.join(' · ')}. Where a value is left out on this page, this is why. <a href="#account">Ask for access</a>`;
  /* Masked values can be shown in full for ten minutes, with a reason — the
     server records who, what and why (ULM-DESIGN §6.2). */
  const maskedCodes = rows.filter(([, l]) => l === 'M').map(([c]) => c);
  if (maskedCodes.length && who.kind === 'user' && !who.preview) {
    const form = document.createElement('form');
    form.className = 'ac-reveal';
    form.innerHTML = `<label for="ac-reveal-why">Show the masked values in full for ten minutes — why?</label>
      <input id="ac-reveal-why" maxlength="200" required> <button type="submit">Show in full</button> <span class="ac-msg" role="status"></span>`;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const why = form.querySelector('input').value.trim();
      try {
        for (const c of maskedCodes) await post('/api/auth/reveal', { class: c, reason: why, view: location.hash.slice(1) });
        location.reload();
      } catch (err) { form.querySelector('.ac-msg').textContent = err.message; }
    });
    el.append(form);
  }
  return el;
}

/* ── reading about people and access ──────────────────────────────────
   Never through data.js's api(): that keeps a copy in localStorage for
   stale-while-revalidate, and these answers are about people and must not
   outlive the session that read them. */
export async function getJson(path) {
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (r.status === 401 && j?.error === 'signin') { toSignIn('expired'); throw new Error('Signed out.'); }
  if (!r.ok) {
    const e = r.status === 403 && j?.error === 'withheld' ? new WithheldError(j, r.status) : new Error(j?.detail || `${r.status}`);
    e.status = r.status; e.body = j;
    throw e;
  }
  return j;
}

/* ── sending a change ─────────────────────────────────────────────────── */
export async function post(path, body = {}, { method = 'POST', retry = true } = {}) {
  const r = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (r.status === 403 && j?.error === 'stepup' && retry) {
    await confirmIdentity();
    return post(path, body, { method, retry: false });
  }
  if (r.status === 401 && j?.error === 'signin') { toSignIn('expired'); throw new Error('Signed out.'); }
  if (!r.ok) {
    const e = new Error(j?.detail || j?.error || `${r.status}`);
    e.status = r.status; e.body = j;
    throw e;
  }
  return j;
}

/* Re-confirming who you are before a sensitive change: the password, or the
   two-step code when it is on. A dialog because it interrupts a change in
   progress and returns to it — the change itself is on its page. */
export function confirmIdentity() {
  return new Promise((resolve, reject) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'access-dialog';
    const code = Boolean(who.user?.totp);
    dlg.innerHTML = `
      <form method="dialog">
        <h3>Confirm it is you</h3>
        <p>This change needs you to re-confirm${code ? ' with the code from your authenticator app' : ' your password'}.</p>
        <label for="ac-stepup">${code ? 'Six-digit code' : 'Password'}</label>
        <input id="ac-stepup" ${code ? 'inputmode="numeric" autocomplete="one-time-code" maxlength="11"' : 'type="password" autocomplete="current-password"'} required>
        <p class="ac-msg" role="status"></p>
        <div class="ac-row"><button type="submit" value="ok">Confirm</button><button type="button" class="ghost" value="cancel">Cancel</button></div>
      </form>`;
    document.body.append(dlg);
    const input = dlg.querySelector('input');
    const msg = dlg.querySelector('.ac-msg');
    dlg.querySelector('button.ghost').addEventListener('click', () => { dlg.close(); dlg.remove(); reject(new Error('Not confirmed.')); });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await post('/api/auth/stepup', code ? { code: input.value } : { password: input.value }, { retry: false });
        dlg.close(); dlg.remove(); resolve();
      } catch (err) { msg.textContent = err.message; input.select(); }
    });
    dlg.showModal?.() ?? dlg.setAttribute('open', '');
    input.focus();
  });
}

export async function signOut() {
  try { await post('/api/auth/logout', {}, { retry: false }); } catch { /* signed out either way */ }
  forgetKept();
  location.assign('/signin?why=signedout');
}

/* The look a signed-in person chose, or the browser's own choice. */
export async function setLook(look) {
  try { localStorage.setItem(document.documentElement.dataset.ui === 'phone' ? 'fleet.skin.phone' : 'fleet.skin', look); } catch { /* blocked */ }
  if (who.signedIn && who.kind === 'user') { try { await post('/api/auth/prefs', { look }); } catch { /* the local choice stands */ } }
}

/* Is this page already in the look the signed-in person chose? If not, the
   choice is stored where the pre-paint script reads it and the answer is
   false — the caller reloads once, so the page paints in the chosen look. */
export function inChosenLook() {
  const look = who.user?.prefs?.look;
  if (look !== 'arkiv' && look !== 'classic') return true;
  /* An address that names a look (?skin=classic) wins for this load. Without
     this the page stored the account's look and reloaded, the pre-paint
     script read ?skin= again and stored it back, and the page reloaded for
     ever — measured at 21 reloads in 6 seconds (Access pages' test). */
  const asked = new URLSearchParams(location.search).get('skin');
  if (asked === 'arkiv' || asked === 'classic') return true;
  const now = document.documentElement.dataset.skin === 'arkiv' ? 'arkiv' : 'classic';
  if (look === now) return true;
  try { localStorage.setItem(document.documentElement.dataset.ui === 'phone' ? 'fleet.skin.phone' : 'fleet.skin', look); } catch { return true; }
  return false;
}

export const roleNames = () => (who.roles || []).map((r) => ROLE[r]?.name || r);

/* ── the fleets, by the names the platforms give them ─────────────────────
   The operator's ruling (2026-09-26): a fleet is called what the platforms
   call it — the brand, the common part of those names — never a name typed
   into the product. The server derives it (src/fleet_names.js) and keeps it
   in fleet.name; /api/auth/me hands every page the list. The pages used to
   print "Ecosine" and "Egari" from a dozen literals.

   Before /api/auth/me has answered (or where a test serves no such route),
   the fleets' own ids stand in, capitalised — the ids are the database's,
   never invented. */
const FALLBACK_FLEET_IDS = ['ecosine', 'egari'];
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
/* A fleet's name is text a platform account holder typed, and the pages
   write it into HTML in a few dozen places (sourceLabel alone reaches ~40,
   not all of them through esc()). The security review of 2026-09-28 found
   four such sinks unescaped; those now escape, and this is the second
   lock: the characters that open a tag or leave a double-quoted attribute
   are not part of any brand name, so they are dropped here, once, before
   any page sees the name. "&" stays: "Smith & Sons" is a real name, and a
   stray ampersand in innerHTML renders as itself. */
const plainName = (s) => String(s).replace(/[<>"`\u0000-\u001f\u007f]/g, '').trim();
export const fleetList = () => (who.fleets?.length
  ? who.fleets.map((f) => ({ id: f.id, name: (f.name && plainName(f.name)) || cap1(f.id) }))
  : FALLBACK_FLEET_IDS.map((id) => ({ id, name: cap1(id) })));
export const isFleetId = (id) => fleetList().some((f) => f.id === String(id || '').toLowerCase());
export const fleetLabel = (id) => fleetList().find((f) => f.id === String(id || '').toLowerCase())?.name || cap1(String(id || ''));
/* "Ecosine & Egari"; "Both fleets" while there are two, "Every fleet" after. */
export const fleetNames = (sep = ' & ') => fleetList().map((f) => f.name).join(sep);
export const allFleetsLabel = () => (fleetList().length === 2 ? 'Both fleets' : 'Every fleet');
export { CLASS, ROLE, ROLES, LEVEL_NAME, rank };
