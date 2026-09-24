/* ══ THE ARKIV SHELL ═════════════════════════════════════════════════════════
   Reskin STEP 4 (docs/UI-REDESIGN-PLAN.md §3 "Shell: rail, header, control
   bar, credential banner, freshness"). The desktop shell in index.html is the
   old one: a 236px rail (sections, theme, settings, freshness), then the
   credential banner, a sticky topbar holding the title AND the six controls,
   the view row, the today strip and #view. The new one is a sheet, top to
   bottom:

       masthead       the wordmark, and the WINDOW the page is read over
       section row    the seven sections, Set up, and freshness on the right
       view row       the pages inside the section (#sectabs)
       #authBanner    the credential banner
       control bar    the six controls, sticky, and a sentence naming the
                      controls that do not apply here and why
       today strip    #todayNow, laid out as the livebar
       title block    #crumb, #viewTitle, #viewSub
       #view          the page
       #pageFoot      the principle line (STEP 3)

   NOTHING IS REBUILT: every node with an id is MOVED, never re-created, so
   the listeners app.js bound to #fRange, #fGrain, #fPlatform, #fFleet,
   #refreshBtn, #zenBtn and #themeBtn at boot, renderNav()'s #nav,
   renderSectionTabs()'s #sectabs, setHeader()'s title block and the three
   hosts filled on every render (#authBanner, #todayNow, #freshness) all keep
   working, and every id a test or the phone relies on is still in the
   document exactly once. Only three things are new: the masthead, the section
   row that holds #nav, #settingsLink and #freshness, and the .applies
   sentence inside the control bar.

   WHICH SHELL IS A TOKEN, NEVER THE ATTRIBUTE. The charts ask --mk-* for
   their form (STEP 2) and the pages ask --pg-contract for their order
   (STEP 3); the shell asks --pg-shell, which app.css declares 0 and arkiv.css
   declares 1. test/arkiv_skin.test.mjs holds every module to it. The old
   skin never reaches buildShell()'s moves, so production's DOM is the DOM
   index.html writes, byte for byte.

   AND THE TOKEN IS ONLY READ ONCE THE STYLESHEETS HAVE ARRIVED. index.html
   appends app.js as a module from a script, and a script-inserted module
   runs when its import graph has arrived — nothing orders it after the
   stylesheets the parser meets below that script. Measured with arkiv.css
   held back 1.5s (test/arkiv_shell.test.mjs, with the wait taken out): the
   first render read --pg-shell and --pg-contract as the old skin's 0, drew
   the old shell and STEP 3's classic #overview under the new stylesheet, and
   nothing re-rendered when the sheet landed. whenStyled() waits for every
   stylesheet <link> the document asked for; when they are already in, which
   is the common case, it costs a microtask. */
import { $, el } from './ui.js';
import { state, windowLabel, windowDates, hidesRange, hidesChannel, MONTH_SHORT } from './data.js';

export function shellContract() {
  try {
    return String(getComputedStyle(document.documentElement).getPropertyValue('--pg-shell')).trim() === '1';
  } catch { return false; }
}

/* Every stylesheet <link> in the document, loaded or failed. A link whose
   sheet is already there is done; one still in flight is waited for, on load
   OR error, and never for longer than `cap` — a stylesheet that neither loads
   nor fails must not hold the page for ever.

   `late` is for the sheet slower than the cap. The page renders without it,
   in whatever shell the tokens then name; when the sheet does land, and it
   turns out to ask for this shell, `late` runs (app.js passes render) so the
   shell is built then rather than on the reader's next click. It matters
   more than a late restyle would: arkiv.css keeps #app invisible until the
   shell is built, so a shell that is never built is a blank page. Called
   ONLY when the cap fired first — in the ordinary case the one render the
   caller makes after this promise is the render that builds it.

   SINCE THE BOOT-ORDER FIX THE BROWSER DOES THIS FIRST, and this is the
   second line. index.html now has the PARSER write app.js in, so it is a
   deferred module, and a deferred script does not run while a stylesheet the
   parser inserted is still loading — arkiv.css included, since
   document.write is the parser's. The measurement above was taken with
   app.js appended from script, as it was until then. What this still covers
   is any stylesheet a script appends (which never holds a script back), and
   a page served by an index.html that appends its module again; on today's
   index.html every sheet is in by the time it runs, and it costs a
   microtask. */
export function whenStyled(cap = 4000, late = null) {
  const pending = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => !l.sheet);
  if (!pending.length) return Promise.resolve();
  let capped = false;
  const all = Promise.all(pending.map((l) => new Promise((ok) => {
    l.addEventListener('load', ok, { once: true });
    l.addEventListener('error', ok, { once: true });
  })));
  all.then(() => { if (capped && late && !built && shellContract()) late(); });
  return Promise.race([all, new Promise((ok) => setTimeout(() => { capped = true; ok(); }, cap))]);
}

/* ── the moves ───────────────────────────────────────────────────────────── */
let built = false;

export function buildShell() {
  if (built) return true;
  if (!shellContract()) return false;
  const app = $('#app');
  const main = app?.querySelector('.main');
  const filters = $('#filters');
  const topbar = main?.querySelector('.topbar');
  if (!main || !filters || !topbar) return false;

  /* The masthead. "Fleet" is the wordmark — the only serif left on the page
     (plan §3 Typography) — and the right-hand side names the window, which
     until now lived only in #tzNote's title, where a reader has to hover to
     find it and a screenshot never shows it. */
  const mast = el('header', 'mast');
  mast.id = 'mast';
  mast.innerHTML = '<div class="mast-l"><span class="mast-word"><span class="logo" aria-hidden="true"></span>FleetMirror</span>'
    + '<span class="mast-org">Ecosine &amp; Egari · Dubai</span></div>'
    + '<div class="mast-r"><div id="mastWin" class="mast-win"></div>'
    + '<div id="mastWinSub" class="mast-win-sub"></div></div>';

  /* The rail becomes the section row: the same #nav renderNav() fills, then
     Set up (the same #settingsLink, href="#settings" untouched, relabelled),
     then freshness in the right-hand slot — the mockup's static channel list
     there was an unmeasured claim, and this is a measured one. #nav and Set up
     share one scroller, so a narrow window scrolls them as one row. */
  const sec = el('div', 'secrow');
  sec.id = 'secRow';
  const links = el('div', 'secrow-links');
  const setup = $('#settingsLink');
  links.append($('#nav'), setup);
  sec.append(links, $('#freshness'));
  if (setup) setup.textContent = 'Set up';

  /* The six controls leave the topbar and become the sticky control bar,
     with the theme cycle joining them (plan §3 CONTROL BAR). #filters keeps
     its id and its class; .ctl is added for the new form. The sentence goes
     before #tzNote so "Dubai time" stays the last thing on the row. */
  filters.classList.add('ctl');
  const applies = el('span', 'applies');
  applies.id = 'fApplies';
  const tz = $('#tzNote');
  const theme = $('#themeBtn');
  if (theme) filters.insertBefore(theme, tz || null);
  filters.insertBefore(applies, tz || null);

  /* The order, top to bottom. prepend() MOVES nodes that are already in the
     document, so #view and #pageFoot, which are not named here, stay where
     they are: after all of these. */
  main.prepend(mast, sec, $('#sectabs'), $('#authBanner'), filters, $('#todayNow'), topbar);

  /* Last, because arkiv.css keeps #app invisible until this class is on it:
     the stylesheet can arrive a frame before this module does, and the old
     rail restyled for one frame and then torn down is a flash, not a page. */
  app.classList.add('ak-shell');
  built = true;
  return true;
}

/* ── the window, named ───────────────────────────────────────────────────── */
/* "1 – 23 Sep 2026", "25 Aug – 23 Sep 2026", "28 Dec 2025 – 3 Jan 2026". */
export function spanLabel(from, to) {
  const p = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    return m ? { y: m[1], m: MONTH_SHORT[Number(m[2]) - 1], d: Number(m[3]) } : null; };
  const a = p(from), b = p(to);
  if (!a || !b) return '';
  if (from === to) return `${b.d} ${b.m} ${b.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${b.m} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`;
  return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`;
}

/* What the masthead says. Three kinds of window, and each says only what the
   client can vouch for:
     · a rolling window ("Last 30 days") is computed HERE (windowDates), so
       its two Dubai days are printed under it;
     · two dates off the calendar are the label already;
     · a calendar period ("This month") is resolved by the SERVER's calendar
       (data.js windowParams), so only its name is printed — dates worked out
       here could disagree with the ones the page was actually built over.
   A page that takes no window says so rather than naming the one the
   controls happen to hold. */
export function windowWords(view = state.view) {
  if (view === 'notfound' || hidesRange(view)) return { main: 'No window applies here', sub: '' };
  if (state.from && state.to) return { main: windowLabel(), sub: '' };
  if (state.period) return { main: windowLabel(), sub: '' };
  const [from, to] = windowDates();
  return { main: windowLabel(), sub: spanLabel(from, to) };
}

/* ── which controls do not apply here, and why ─────────────────────────────
   Today a hidden control just vanishes, and a reader who had "Egari" set on
   the last page is left to guess whether this one is Egari's. The three
   lists in data.js say WHICH controls a page hides; this says why, in the
   words data.js's own comments give for putting each page on its list. A
   page with no reason of its own gets the reason every list shares, which is
   true of all of them by construction: none of those controls changes what
   the page shows. test/arkiv_shell.test.mjs holds every listed page to having
   a sentence, and every sentence to naming exactly the controls hidden. */
const EVERY = 'none of them changes what it shows';
/* A NO_FILTER page hides the platform and the fleet as well as the window, so
   its reason has to answer for all four. Where data.js (or the page) says why
   the channel controls come off too, the reason says it: #live's feed takes no
   parameter at all, /api/day takes a day and nothing else, #online-time's call
   list was asked for as every driver, a deposit is written against a person,
   and the pay book is /api/ledger/entries, which takes no platform or fleet
   (data.js's #charging comment). A reason that answered only for the window
   read as though the chips had simply been forgotten. */
export const APPLIES_WHY = {
  /* NO_FILTER: the window, the grouping, the platform and the fleet */
  settings: 'it sets credentials and the collection schedule, and counts nothing over a window',
  live: 'it shows every car where it is now',
  sources: 'it is the state of every collector now, whatever window a page is read over',
  day: 'the day it shows is in its address, and every source that saw that day is on it',
  providers: 'it is the inventory of what each provider sends',
  action: 'it is one finding and the evidence it was raised on',
  'online-time': 'it has its own day picker, only Uber reports time online, and the call list covers '
    + 'every driver we hold data for',
  'same-person': 'a pair is a pair whenever either record drove',
  deposits: 'a cash position is a position against a person, not a window or a channel',
  advances: 'an exposure is a position against a person, not a window',
  salary: 'the month is chosen on the page itself, and the pay book takes no platform or fleet',
  opening: 'the position is stated as of a date chosen on the page',
  'import-sheet': 'it is a file and a review queue',
  policy: 'each figure is in force from its own date, not over a window',
  forecast: 'it fits whole months since the last regime change',
  capacity: 'it fits a rota to demand from every channel, over its own trailing window, and names it',
  map: 'it has its own car-and-day picker',
  segment: 'it is one occupancy segment, addressed by plate and time',
  trip: 'it is one booking, addressed by the provider’s own id',
  feeds: 'it is every car Uber lists as active now, judged on the last day',
  /* NO_RANGE: the window and the grouping */
  reconcile: 'its rows are whole months',
  compare: 'it carries its own two days in its address',
  causes: 'it is the whole record’s monthly trend',
  'top-performers': 'it is a fixed Monday-to-Sunday week, chosen on the page',
  'low-performers': 'it is a fixed Monday-to-Sunday week, chosen on the page',
  performer: 'it is a fixed Monday-to-Sunday week, chosen on the page',
  payouts: 'it is the register of every transfer that ever reached the bank',
  /* NO_PLATFORM_FLEET: the platform and the fleet */
  driver: 'it answers for this person on every channel',
  vehicle: 'it answers for this car on every channel',
  property: 'it answers for this property on every channel',
  coverage: 'what it reads is not split by channel or fleet yet',
  charging: 'an advance is recorded against a person, not a channel',
};

export function appliesSentence(view = state.view) {
  if (view === 'notfound') return 'No control applies: this address names no page.';
  const range = hidesRange(view), chan = hidesChannel(view);
  if (!range && !chan) return '';
  const names = [...(range ? ['date range', 'grouping'] : []), ...(chan ? ['platform', 'fleet'] : [])];
  const list = names.length === 2 ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const lead = range ? `The ${list}` : `${list[0].toUpperCase()}${list.slice(1)}`;
  return `${lead} do not apply here — ${APPLIES_WHY[view] || EVERY}.`;
}

/* ── on every render ─────────────────────────────────────────────────────────
   Called from render() beside renderNav() and setHeader(). A no-op until the
   shell has been built, so the old skin pays one boolean. */
export function shellFrame() {
  if (!built) return;
  const w = windowWords();
  const win = $('#mastWin'), sub = $('#mastWinSub');
  if (win) win.textContent = `${w.main} · Dubai time`;
  if (sub) { sub.textContent = w.sub; sub.hidden = !w.sub; }
  const a = $('#fApplies');
  if (a) { a.textContent = appliesSentence(); a.hidden = !a.textContent; }
  /* Set up is lit on #settings, which is in no section, so nothing else in
     the row is. */
  $('#settingsLink')?.classList.toggle('on', state.view === 'settings');
  /* In a window too narrow for either row, the lit item can sit past the
     edge of its scroller — measured at 390px: Set up, lit on #settings, was
     off the right of the section row, so the row named no place at all.
     Each row is scrolled (sideways only; the page does not move) so its lit
     item is in view. */
  reveal($('#secRow .secrow-links'), $('#secRow .on'));
  reveal($('#sectabs .tabs'), $('#sectabs .tabs a.on'));
}

function reveal(scroller, item) {
  if (!scroller || !item || scroller.scrollWidth <= scroller.clientWidth) return;
  const s = scroller.getBoundingClientRect(), r = item.getBoundingClientRect();
  if (r.left >= s.left && r.right <= s.right - 22) return;     // 22px: the edge fade
  scroller.scrollLeft += (r.left - s.left) - (s.width - r.width) / 2;
}

