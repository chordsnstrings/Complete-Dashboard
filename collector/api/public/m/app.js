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
import { state, api, parseHash, href } from '../data.js';
import { el, esc } from '../ui.js';
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
const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months']];
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
  group('Window', RANGES, state.days, (v) => { state.days = Number(v); });
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

  const screen = SCREENS[id];
  const t = titleFor(id, param, sub);
  titleEl.textContent = t.title;
  subEl.textContent = t.sub || '';
  backBtn.style.display = depth > 1 || !currentTab() ? '' : 'none';
  document.title = `${t.title} · Fleet`;
  [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.tab === currentTab()));

  deck.scrollTop = 0;
  deck.innerHTML = '';
  try {
    await (screen || SCREENS.fallback)(deck, { view: id, param, sub, alive: () => g === gen });
  } catch (e) {
    if (g !== gen) return;
    deck.innerHTML = '';
    const d = el('div', 'm-card m-err');
    d.innerHTML = `<div class="m-empty"><b>Could not load this screen</b>${esc(e.message || String(e))}</div>`;
    deck.append(d);
  }
  if (g === gen) freshness();
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
