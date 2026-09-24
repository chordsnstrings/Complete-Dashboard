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
import { state, api, parseHash, href, q, qAll, hidesRange, hidesChannel,
  applyWindow, setFilter } from '../data.js';
import { rangePanel } from '../daterange.js';
/* timeStr, not a formatter of this file's own: it is the same function the
   desktop shell renders every clock through, and it names timeZone: TZ. */
import { el, esc, sourceLine, timeStr, pageFoot } from '../ui.js';
import { SCREENS, TABS, titleFor } from './screens.js';
import { phoneContract } from './ui.js';
/* The desktop shell's two sentences about the window, imported rather than
   re-worded: what the masthead calls the window and why a control does not
   apply on a page. A phone that described either differently from the
   desktop beside it would be another pair of pages disagreeing. shell.js
   builds nothing on import — its moves run only when the desktop calls
   buildShell() — so the phone takes the words and not the shell. */
import { windowWords, appliesSentence } from '../shell.js';

const root = document.getElementById('m');
/* ── which phone app ──────────────────────────────────────────────────────
   The operator's ruling of 2026-09-24 (docs/UI-REDESIGN-PLAN.md, "Phone PWA
   — redesign"). Read once, here: the shell is built once, and index.html has
   the PARSER write m/arkiv-m.css, so by the time this deferred module runs
   the sheet that declares --pg-phone:1 is in. Under the old skin every line
   below that is not behind AK draws exactly what it drew before
   (test/phone_classic.test.mjs). */
const AK = phoneContract();

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

/* ── the Arkiv shell: the same pieces, and a control bar ───────────────────
   Three changes, each only under the token:

     the wordmark  "Fleet", in Fraunces (the one serif left in the product),
                   stands where the back arrow would be at a tab's root, and
                   takes the reader to Today. Deeper, the arrow comes back.
     the ⋮         becomes the CONTROL BAR, a full-width row under the header
                   that NAMES the window, the channel and the fleet the
                   screen is read over — one tap to the same sheet. A reader
                   of the old phone had to open the sheet to learn what window
                   a figure was over; the desktop masthead now says it on
                   every page, and so does this.
     the rules     the header and the bar are ruled rather than blurred, and
                   every control is a 44px square (m/arkiv-m.css). */
let word = null, ctl = null, ctlParts = null;
if (AK) {
  word = el('a', 'ak-word', 'Fleet');
  word.setAttribute('aria-label', 'Fleet — go to Today');
  filterBtn.remove();
  head.insertBefore(word, titleWrap);
  /* One line of mono capitals — the window, the channel, the fleet — that
     wraps part by part rather than cutting one off: "All channels · Both
     flee…" was the first draft at 390px, a default that could not be read. */
  ctl = el('button', 'ak-ctl');
  ctl.type = 'button';
  ctl.title = 'Window, channel and fleet';
  ctl.setAttribute('aria-haspopup', 'dialog');
  ctlParts = el('span', 'ak-ctl-parts');
  ctl.append(ctlParts, el('span', 'ak-ctl-caret', '▾'));
  ctl.lastChild.setAttribute('aria-hidden', 'true');
  root.insertBefore(ctl, deck);
}

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
  /* Under the new shell the sheet says, before any choice, which of its
     choices this screen ignores and why — the desktop's .applies sentence.
     The old sheet offered every control on every screen in silence, so an
     Egari chosen on #live read as an Egari #live. */
  if (AK) {
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Window, channel and fleet');
    sheet.append(el('h2', 'ak-sheet-h', 'Window, channel and fleet'));
    const why = appliesSentence(state.view);
    if (why) sheet.append(el('p', 'ak-applies', esc(why)));
  }
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
      /* Through the ADDRESS, not straight into state. render() reads the hash
         now, so a pick written only to state would be overwritten by the very
         re-render it triggers — and a filter that changes what a page says has
         to be part of the page's address anyway, or the URL describes a screen
         nobody is looking at and the back button undoes nothing. */
      setFilter({
        period: pick.period || '',
        days: pick.days || state.days,
        from: pick.from || '',
        to: pick.to || '',
      });
    },
    close: () => { close(); render(); },
  }));
  group('Channel', PLATFORMS, state.platform, (v) => setFilter({ platform: v }));
  group('Fleet', FLEETS, state.fleet, (v) => setFilter({ fleet: v }));
  scrim.onclick = close;
  document.body.append(scrim, sheet);
  requestAnimationFrame(() => { scrim.classList.add('in'); sheet.classList.add('in'); });
}
filterBtn.onclick = openSheet;
if (ctl) ctl.onclick = openSheet;

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
    /* The fleet's clock, not the phone's. sw.js stamps x-sw-cached-at as an
       ISO instant, and `new Date(at).toLocaleTimeString()` rendered it wherever
       the reader happens to be: the cache written at 13:00:01Z on 2026-09-02
       (production /api/status, measured) read "17:00" in Dubai and "09:00" on a
       New York phone — the offline bar disagreeing with every hour label on the
       screen it sits above. */
    staleBar.textContent = at
      ? `Offline — showing what was last collected at ${timeStr(at)}`
      : 'Offline — showing the last numbers this phone saw';
    deck.prepend(staleBar);
  } catch { /* the screen's own error state already says it */ }
}

/* ── render ─────────────────────────────────────────────────────────────── */
let gen = 0;
let lastDepth = 0;
async function render() {
  const g = ++gen;
  /* The window and the channel filters come out of the address too, not just
     the route. Without this the phone dropped every `?days=`, `?period=`,
     `?from=`, `?platform=` and `?fleet=` a link carried and rendered the
     defaults — so the same URL showed one window on a desktop and another on
     a phone. */
  const { view, param, sub } = applyWindow(parseHash());
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
  if (AK) akFrame(id, backBtn.style.display !== 'none');

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
    if (AK) akApplies(g, id);
    await (AK ? akFoot(g, id) : stampSource(g, id));
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

/* ── the Arkiv shell, on every render ─────────────────────────────────────
   The control bar names what the screen is read over, in the desktop
   masthead's words (shell.js windowWords): a rolling window's two Dubai
   days, a calendar period by its name alone (the server's calendar resolves
   it, so dates worked out here could disagree with the ones the screen was
   built over), and "No window applies here" where none does. A channel or
   fleet the screen ignores is said to be ignored — never claimed as covered:
   #online-time ignores the platform chip because only Uber reports time
   online, so "every channel" there would be false. */
const PLATFORM_WORD = Object.fromEntries(PLATFORMS);
const FLEET_WORD = Object.fromEntries(FLEETS);
/* Two phone screens the desktop has no page for, and which read no window
   and no channel: More is a list of places to go, and the credential paste
   is a form. data.js's lists do not name them (they are not desktop views),
   so the bar is told here rather than naming a window neither is read over. */
const PHONE_ONLY_UNWINDOWED = new Set(['more', 'credentials']);
/* One answer for the bar AND the footer's colophon. The first draft asked
   windowWords() in the footer, so More read "No window applies here" in the
   bar and "This month · Dubai time" at its foot — two claims about one
   screen. */
const windowOf = (id) => (PHONE_ONLY_UNWINDOWED.has(id)
  ? { main: 'No window applies here', sub: '' } : windowWords(id));
function akFrame(id, deep) {
  const none = PHONE_ONLY_UNWINDOWED.has(id);
  const w = windowOf(id);
  const part = (text, cls = '') => el('span', `ak-ctl-p${cls}`, esc(text));
  ctlParts.replaceChildren(
    part(w.sub ? `${w.main} · ${w.sub}` : w.main, ' ak-ctl-win'),
    ...(none || hidesChannel(id)
      ? [part('Channel and fleet not applied', ' ak-ctl-off')]
      : [part(PLATFORM_WORD[state.platform || ''] || state.platform),
        part(FLEET_WORD[state.fleet || ''] || state.fleet)]));
  word.style.display = deep ? 'none' : '';
  word.href = href('today');
}

/* The sentence naming the controls this screen ignores, and why — first in
   the deck, where a reader looking at an unchanged screen after moving a
   chip looks for the reason. Prepended once the screen has drawn, because
   most screens empty the deck after their fetch. */
function akApplies(g, id) {
  if (g !== gen) return;
  const why = appliesSentence(id);
  if (why && !deck.querySelector(':scope > .ak-applies')) deck.prepend(el('p', 'ak-applies', esc(why)));
}

/* THE FOOTER, on every screen: the basis (the same source line the old phone
   closed its deck with — sourceLine(), shared with the desktop), the house
   principle, and a colophon naming the window and the clock. ui.js
   pageFoot() builds it: given a host outside #view it appends its own inline
   footer, the one the desktop's fallback tabs already draw on the phone.
   The screens that describe no feed (More, Sources, the credential paste)
   still carry the principle; they have no basis line, as before. */
async function akFoot(g, id) {
  if (g !== gen) return;
  if (deck.querySelector('.pf-inline, .pagefoot')) return;
  const w = windowOf(id);
  const colophon = [`${w.main} · Dubai time`, 'Ecosine & Egari'];
  let line = null;
  if (!NO_SOURCE.has(id) && !deck.querySelector('.srcline')
    && deck.querySelector('.m-card, .m-stat, .m-row, .m-lede')) {
    try {
      const plats = hidesChannel(id) ? await qAll('/api/platforms') : await q('/api/platforms');
      if (g !== gen) return;
      line = sourceLine(plats, {
        whole: hidesRange(id),
        only: !hidesChannel(id) && state.platform ? [state.platform] : null,
        fleet: !hidesChannel(id) && state.fleet ? state.fleet : null,
      });
    } catch { /* provenance never breaks a screen */ }
  }
  if (g !== gen) return;
  pageFoot({ basis: line, colophon }, deck);
}

/* The browser's own chrome in the paper the screen is drawn on. The two
   theme-color metas in index.html carry production's linen and near-black,
   and on an installed Android app they colour the status bar — a linen
   strip over Arkiv's white. They are rewritten here, only under the token,
   from the resolved --paper (no colour is written down twice; SPEC L5.1),
   and again when the phone's theme follows the OS across a change. The
   manifest's colours are one static file for every reader, so they wait for
   the flip (plan STEP 5). */
function akChrome() {
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  if (!paper) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', paper));
}
if (AK) {
  akChrome();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', akChrome);
}

function refresh() {
  navigator.serviceWorker?.controller?.postMessage('skip-waiting');
  /* And ASK whether there is a new one, rather than only telling the current
     worker not to wait. skip-waiting is a message to the worker already
     installed; if the browser has not yet re-fetched /sw.js there is nothing
     waiting to skip, and a pull-to-refresh checks for new data while the code
     drawing it stays whatever this phone first downloaded. */
  navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => {});
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
  /* A NEW worker taking over means the shell in the cache is new too, and the
     modules this page is running are the old ones — a worker swap does not
     re-evaluate scripts that have already loaded. So the page reloads once.
     ─────────────────────────────────────────────────────────────────────
     Without this, a deploy reaches the cache and stops there: the reader keeps
     looking at the previous build until they happen to cold-start the app.
     Measured on a real phone on 2026-09-03, though the version string never
     changing (api/public/sw.js) meant nothing ever got this far.

     Guarded, because controllerchange fires again for the worker that the
     reload itself brings up, and an unguarded reload here is a boot loop on
     the one screen a reader cannot escape. */
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* http, or blocked */ });
  });
}
