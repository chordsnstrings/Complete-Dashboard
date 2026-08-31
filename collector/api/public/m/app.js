/* The phone application: shell, router, and the plumbing a PWA needs.
   ─────────────────────────────────────────────────────────────────────────
   index.html decides whether this file or /app.js is loaded; they never run
   together. This one owns everything above and below the content — a header
   that always offers a way back, a deck that scrolls, a tab bar a thumb can
   reach — and hands the middle to a screen from ./screens.js.

   Three things here exist only because this is a phone:

     the sheet     a <select> on a phone is an OS picker with no room for the
                   sentence explaining what the choice does. The window,
                   channel and fleet controls are one sheet with real labels.
     pull-to-refresh   the desktop has a ⟳ in the corner and the room to put
                   it there. Here the gesture IS the control, and the header
                   button stays as well for anyone who does not know that.
     the worker    registered from here rather than from the desktop build,
                   because a service worker that caches the phone shell for a
                   desktop reader would be caching an app they never see.
*/
import { state, api, parseHash, href, q, qAll, hidesRange, hidesChannel } from '../data.js';
import { rangePanel } from '../daterange.js';
import { el, esc, sourceLine } from '../ui.js';
import { SCREENS, TABS, titleFor } from './screens.js';

const root = document.getElementById('m');

/* ── shell ──────────────────────────────────────────────────────────────── */
const head = el('div', 'm-head');
const backBtn = el('button', 'm-ico');
backBtn.type = 'button'; backBtn.innerHTML = '‹'; backBtn.title = 'Back';
backBtn.style.display = 'none';
backBtn.onclick = () => history.back();
const titleWrap = el('div');
titleWrap.style.cssText = 'flex:1 1 auto;min-width:0';
const titleEl = el('h1', null, 'Today');
const subEl = el('span', 'm-sub', '');
titleWrap.append(titleEl, subEl);
const filterBtn = el('button', 'm-ico');
filterBtn.type = 'button'; filterBtn.innerHTML = '⋮'; filterBtn.title = 'Window and channels';
const refreshBtn = el('button', 'm-ico');
refreshBtn.type = 'button'; refreshBtn.innerHTML = '⟳'; refreshBtn.title = 'Refresh';
head.append(backBtn, titleWrap, filterBtn, refreshBtn);

const deck = el('div', 'm-deck');
const tabs = el('nav', 'm-tabs');
root.append(head, deck, tabs);

TABS.forEach((t) => {
  const b = el('button', 'm-tab');
  b.type = 'button';
  b.append(el('i', null, t.ic), el('span', null, t.label));
  b.onclick = () => {
    /* Tapping the tab you are already on returns to its root and scrolls up —
       the behaviour every phone app has, and the only way back out of a
       drill-down without hunting for the header. */
    if (currentTab() === t.id && parseHash().view === t.route) deck.scrollTo({ top: 0 });
    location.hash = href(t.route);
  };
  b.dataset.tab = t.id;
  tabs.append(b);
});

const currentTab = () => {
  const v = parseHash().view || 'today';
  const t = TABS.find((x) => x.owns.includes(v));
  return t ? t.id : null;
};

/* ── the window / channel sheet ─────────────────────────────────────────── */
/* Calendar periods first, because the business thinks in them and because a
   rolling window moves under the reader: two screens opened four minutes apart
   answer about two different spans, and the operator has no way to tell that
   from the pages disagreeing. A period is stable — only its last day moves.

   Prefixed `p:` so a period and a day-count cannot be confused for one
   another, matching the desktop's control. */
const PLATFORMS = [['', 'All channels'], ['uber', 'Uber'], ['yango', 'Yango'],
  ['bolt', 'Bolt'], ['hotel', 'Hotel'], ['fms', 'FMS telematics']];
const FLEETS = [['', 'Both fleets'], ['ecosine', 'Ecosine'], ['egari', 'Egari']];

function openSheet() {
  const scrim = el('div', 'm-scrim');
  const sheet = el('div', 'm-sheet');
  sheet.append(el('div', 'm-grab'));
  const close = () => {
    scrim.classList.remove('in'); sheet.classList.remove('in');
    setTimeout(() => { scrim.remove(); sheet.remove(); }, 280);
  };
  const group = (title, options, current, set) => {
    sheet.append(el('h3', null, title));
    options.forEach(([v, label]) => {
      const b = el('button', `m-opt${String(current) === String(v) ? ' on' : ''}`);
      b.type = 'button';
      b.append(el('span', null, esc(label)));
      if (String(current) === String(v)) b.append(el('span', null, '✓'));
      b.onclick = () => { set(v); close(); render(); };
      sheet.append(b);
    });
  };
  /* The desktop's calendar, in the sheet.
     ─────────────────────────────────────────────────────────────────────
     The phone listed twelve fixed windows, which is the control the desktop
     used to have and has the same two holes: it cannot name a month with its
     year on it, and it cannot name two dates. The panel is the same module,
     because where a control appears is a placement decision and not a
     different control — and a phone that answers "how did August go"
     differently from the desktop is another pair of pages disagreeing. */
  sheet.append(el('h3', null, 'Window'));
  sheet.append(rangePanel({
    onPick: (pick) => {
      /* Exactly one kind survives a pick. A screen headed "August 2026" while
         showing a rolling thirty days is the class of bug this product spends
         its life removing. */
      state.period = pick.period || '';
      state.days = pick.days || state.days;
      state.from = pick.from || '';
      state.to = pick.to || '';
    },
    close: () => { close(); render(); },
  }));
  group('Channel', PLATFORMS, state.platform, (v) => { state.platform = v; });
  group('Fleet', FLEETS, state.fleet, (v) => { state.fleet = v; });
  scrim.onclick = close;
  document.body.append(scrim, sheet);
  requestAnimationFrame(() => { scrim.classList.add('in'); sheet.classList.add('in'); });
}
filterBtn.onclick = openSheet;

/* ── pull to refresh ────────────────────────────────────────────────────
   Only from a deck that is already at the top, and only downwards, so it never
   competes with a scroll the reader meant. */
let pullY = 0, pulling = false;
deck.addEventListener('touchstart', (e) => {
  pulling = deck.scrollTop <= 0 && e.touches.length === 1;
  pullY = pulling ? e.touches[0].clientY : 0;
}, { passive: true });
deck.addEventListener('touchmove', (e) => {
  if (!pulling) return;
  const dy = e.touches[0].clientY - pullY;
  if (dy > 0) deck.style.transform = `translateY(${Math.min(dy * 0.35, 54)}px)`;
}, { passive: true });
deck.addEventListener('touchend', (e) => {
  if (!pulling) return;
  const dy = (e.changedTouches[0]?.clientY || pullY) - pullY;
  deck.style.transition = 'transform .3s var(--ease-out)';
  deck.style.transform = '';
  setTimeout(() => { deck.style.transition = ''; }, 320);
  if (dy > 96) refresh();
  pulling = false;
}, { passive: true });

/* ── freshness: what the reader is looking at ───────────────────────────── */
let staleBar = null;
async function freshness() {
  try {
    const r = await fetch('/api/status');
    const cached = r.headers.get('x-sw-cache') === 'hit';
    const at = r.headers.get('x-sw-cached-at');
    if (staleBar) { staleBar.remove(); staleBar = null; }
    if (!cached) return;
    staleBar = el('div', 'm-stale');
    staleBar.textContent = at
      ? `Offline — showing what was last collected at ${new Date(at).toLocaleTimeString()}`
      : 'Offline — showing the last numbers this phone saw';
    deck.prepend(staleBar);
  } catch { /* the screen's own error state already says it */ }
}

/* ── render ─────────────────────────────────────────────────────────────── */
let gen = 0;
let lastDepth = 0;
async function render() {
  const g = ++gen;
  const { view, param, sub } = parseHash();
  const id = view || 'today';
  state.view = id; state.param = param; state.sub = sub;

  const depth = [view, param, sub].filter(Boolean).length;
  deck.classList.remove('push', 'pop');
  void deck.offsetWidth;                      // restart the animation
  deck.classList.add(depth < lastDepth ? 'pop' : 'push');
  lastDepth = depth;

  /* A detail page has a phone screen; its TABS do not. `#driver/x` is the
     person, and `#driver/x/earnings` is one of the desktop's tabs about them —
     which the fallback renders from the real module rather than this app
     reimplementing seven of them badly. */
  const screen = (sub && (id === 'driver' || id === 'vehicle'))
    ? SCREENS.fallback : SCREENS[id];
  const t = titleFor(id, param, sub);
  titleEl.textContent = t.title;
  subEl.textContent = t.sub || '';
  backBtn.style.display = depth > 1 || !currentTab() ? '' : 'none';
  document.title = `${t.title} · Fleet`;
  [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.tab === currentTab()));

  deck.scrollTop = 0;
  deck.innerHTML = '';
  try {
    /* A detail screen only learns whose page it is after it has fetched, so it
       is given a way to name the header. The desktop does the same thing with
       setHeader(detail); here it matters more, because the header IS the only
       place the name can go. */
    const setTitle = (title, sub2) => {
      if (g !== gen) return;
      if (title) { titleEl.textContent = title; document.title = `${title} · Fleet`; }
      if (sub2 != null) subEl.textContent = sub2;
    };
    await (screen || SCREENS.fallback)(deck,
      { view: id, param, sub, alive: () => g === gen, setTitle });
    await stampSource(g, id);
  } catch (e) {
    if (g !== gen) return;
    deck.innerHTML = '';
    const d = el('div', 'm-card m-err');
    d.innerHTML = `<div class="m-empty"><b>Could not load this screen</b>${esc(e.message || String(e))}</div>`;
    deck.append(d);
  }
  if (g === gen) freshness();
}

/* ── the phone says what it was built from too ────────────────────────────
   The desktop grew this first, and the phone is the surface an operator
   actually opens — the screenshots that started this audit were phone
   screenshots. Same rule, same helper, so the two applications cannot
   describe the fleet's sources differently.

   Set apart from the desktop only in where it sits: the phone has no page
   footer, so it goes at the end of the scrolling deck as its own quiet block. */
const NO_SOURCE = new Set(['more', 'sources', 'credentials', 'settings']);

async function stampSource(g, id) {
  if (g !== gen || NO_SOURCE.has(id)) return;
  if (deck.querySelector('.srcline')) return;
  if (!deck.querySelector('.m-card, .m-stat, .m-row, .m-lede')) return;
  try {
    const plats = hidesChannel(id) ? await qAll('/api/platforms') : await q('/api/platforms');
    if (g !== gen) return;
    const line = sourceLine(plats, {
      whole: hidesRange(id),
      only: !hidesChannel(id) && state.platform ? [state.platform] : null,
      fleet: !hidesChannel(id) && state.fleet ? state.fleet : null,
    });
    if (line) { line.classList.add('m-src'); deck.append(line); }
  } catch { /* provenance never breaks a screen */ }
}

function refresh() {
  navigator.serviceWorker?.controller?.postMessage('skip-waiting');
  render();
}
refreshBtn.onclick = () => { refreshBtn.classList.add('on'); refresh(); setTimeout(() => refreshBtn.classList.remove('on'), 600); };

addEventListener('hashchange', render);
addEventListener('online', render);
if (!location.hash) location.hash = href('today');
render();

/* ── the worker ─────────────────────────────────────────────────────────
   Registered after first paint: a phone on a bad connection should spend its
   first second on the screen the reader asked for, not on priming a cache. */
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* http, or blocked */ });
  });
}
