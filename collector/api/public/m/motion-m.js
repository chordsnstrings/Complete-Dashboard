/* MOTION on the phone — the half a stylesheet cannot do.
   ─────────────────────────────────────────────────────────────────────────
   The desktop's motion layer (../motion.js, ../motion.css; the operator's
   ruling of 2026-10-27, docs/FIX-STATUS.md MOTION) was written for the desktop
   build, and index.html never stamped it on the phone (HANDOFF 0.11). The
   phone kept the old skin's movement under the new one instead: every screen
   — a refresh of the same screen included — slid in 14px from the right
   (m.css m-push), more than three times the 4px the skin allows anything to
   travel, and replayed on every pull-to-refresh, so a reader who pulled to see
   whether a number had moved watched every number move. m/motion-m.css says
   how each movement looks; this decides WHEN, for the moments a stylesheet
   cannot tell from their look-alikes — the desktop's three, on the phone's
   own markup:

   1. A SCREEN ARRIVING, versus the same screen drawn again. m/app.js render()
      empties and refills the SAME deck for both: a new address (a tab, a
      drill-down, a window or channel chosen in the sheet — the address is the
      screen, filters and all) is an arrival and gets the entrance; the same
      address (the refresh button, pull-to-refresh, coming back online) is a
      redraw and keeps still. The deck outlives every screen, so the entrance
      class is taken off by its own timer, cleared when the next screen starts
      — a timer left over from the last screen would take the class off this
      one halfway through.

   2. CONTENT AFTER A WAIT. A screen shows skeletons (m/ui.js skeleton()) until
      its answers land; what replaces a skeleton the reader actually watched
      comes up, and what replaced one within a frame or two — an answer from
      this browser's own copy (../swr.js) — just appears. The phone empties
      its deck and refills it in separate mutations, so "replaced" is a
      skeleton that LEFT a parent and content that arrived in the same parent
      a moment later, not one record holding both (the desktop's case).

   3. A FIGURE THAT MOVED. Each headline figure — a tile, a target cell — is
      compared with what the same slot (the section it stands in and its own
      label) said the last time this screen was drawn, and one that changed
      gets the skin's wash, laid on and lifted: Today's hour cards, redrawn
      every minute while the screen is open, and a redraw that brings new
      figures. An arrival forgets every slot, so a screen opened is never a
      screen whose figures "moved". The phone has no count-up (the desktop
      reads its tiles only once theirs has landed), no screen draws a figure
      twice on its way to the answer, and no segment switch (People's
      Trips/Money, Fleet's Status/Fares, Optimise's When/Where) redraws a tile
      with another value — measured on every screen, 2026-11-12 — so a figure
      is read the moment it lands. A screen that one day does either needs a
      guard here first.

   And the busy hairline: one element, for the stylesheet to draw along the top
   of the screen while data.js has the screen's requests out (data-busy on
   <html>, set only while data-motion is on).

   INERT unless index.html stamped data-motion="on" — the Arkiv skin, not
   under automation (navigator.webdriver) unless asked — and only on the
   redesigned phone (m/ui.js phoneContract()). Every class is checked against
   prefers-reduced-motion before it goes on. Nothing here changes a figure, a
   word, a link or the layout: it adds and removes its own fx-* classes and the
   one busy element, and each class comes off when its movement is over. It
   never redraws anything and never asks the server for anything. */
import { phoneContract } from './ui.js';

const on = () => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'on';
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* The headline figures. Rows are the phone's table and are left alone — a
   re-sorted list is not news (the desktop leaves its tables alone for the
   same reason). The hour sentence's bold figure is the desktop's, kept so a
   reader who opened the notes sees it marked too. */
export const FIGURES = '.m-stat .n, .tg-v, .hp-lede > b';
/* A skeleton that stood for less than this was never seen. */
const SEEN_MS = 120;
/* Content that lands in a parent this soon after a watched skeleton left it
   is what replaced it: the screen emptied the parent and filled it in the
   same task, or one await later. */
const AFTER_MS = 250;
const ENTER_MS = 1600;     // motion-m.css §3: 360ms of stagger + the pen
const ARRIVE_MS = 450;
const TICK_MS = 2500;

let started = false;
let deckEl = null;
let route = null;               // the address the deck's figures were read on
let enterTimer = 0;
let pending = 0;
const memory = new Map();       // slot → text; forgotten when the address changes
const raised = new WeakMap();   // skeleton → when it went up
const left = new WeakMap();     // parent → when a watched skeleton left it

/* A class for as long as its movement lasts — a timer, not animationend,
   which bubbles from a chart's own line and would take a block's class off
   halfway (the desktop's reason). */
function flash(el, cls, ms) {
  el.classList.add(cls);
  return setTimeout(() => el.classList.remove(cls), ms);
}

/** Once, when the phone's shell is built and before its first screen. Says
    whether the layer is on: false while data-motion is off, and m/app.js then
    goes on exactly as before. */
export function startMotionM(deck) {
  if (started || !deck || !on() || !phoneContract()) return false;
  started = true;
  deckEl = deck;
  const busy = document.createElement('div');
  busy.id = 'akBusy';
  busy.setAttribute('aria-hidden', 'true');
  document.body.append(busy);
  new MutationObserver(watch).observe(deck, { childList: true, subtree: true });
  /* Folded notes (m/focus-m.js) come up when the reader opens them: the host
     is marked just BEFORE the toggle opens it — this listener captures, the
     toggle's own bubbles — and not on every redraw of an open host. */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.fx-more');
    if (btn?.parentElement && !still()) flash(btn.parentElement, 'fx-unfold', 700);
  }, true);
  /* TOUCH, NOT HOVER. iOS Safari applies :active — the press colour every row,
     tile and button carries (m/arkiv-m.css) and the 1px press motion-m.css adds
     — only where a touch listener is registered on the element or above it.
     The deck has one (pull-to-refresh); the header, the control bar, the tab
     bar and the sheet did not, so a thumb on them changed nothing until the
     tap was over. A passive listener costs no scroll performance. */
  document.addEventListener('touchstart', () => {}, { passive: true });
  return true;
}

/** m/app.js render(), before it empties the deck for a screen. True for a
    screen arriving, false for a redraw of the same one; undefined while the
    layer is off. */
export function motionScreen() {
  if (!started) return undefined;
  clearTimeout(enterTimer);
  deckEl.classList.remove('fx-enter');
  const here = location.hash;
  if (here === route) return false;
  route = here;
  memory.clear();
  if (!still()) enterTimer = flash(deckEl, 'fx-enter', ENTER_MS);
  return true;
}

function watch(records) {
  const now = performance.now();
  let added = false;
  for (const r of records) {
    for (const n of r.removedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains('m-skel')) continue;
      const t = raised.get(n);
      if (t == null || now - t >= SEEN_MS) left.set(r.target, now);
    }
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      added = true;
      if (n.classList.contains('m-skel')) raised.set(n, now);
    }
  }
  if (!still()) {
    for (const r of records) {
      const t = left.get(r.target);
      if (t == null || now - t > AFTER_MS) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.classList.contains('m-skel') || n.classList.contains('fx-more')) continue;
        /* A block with an entrance of its own (settling in under fx-enter, a
           chart drawing its line) keeps it. */
        if (getComputedStyle(n).animationName === 'none') flash(n, 'fx-arrive', ARRIVE_MS);
      }
    }
  }
  if (added && !pending) pending = requestAnimationFrame(() => { pending = 0; readFigures(); });
}

const words = (x) => (x?.textContent || '').replace(/\s+/g, ' ').trim();

/* A slot: the section a figure stands in (its card's head, or the head of
   the tile band it is in) and its own label. */
function slotOf(el) {
  const card = el.closest('.m-card');
  let block = words(card?.querySelector(':scope > h2'));
  if (!block) {
    const band = el.closest('.m-stats');
    const head = band?.previousElementSibling;
    if (head?.classList.contains('sechd')) block = words(head.querySelector('.sechd-name')) || words(head);
  }
  const tile = el.closest('.m-stat');
  if (tile) return `${block}|tile|${words(tile.querySelector('.l'))}`;
  const cell = el.closest('.tg-cell');
  if (cell) return `${block}|tg|${cell.dataset.tg || words(cell.querySelector('.tg-l'))}`;
  return `${block}|${el.parentElement?.className || ''}`;
}

/* Each figure against what its slot said the last time it was drawn; a
   repeat inside one block is numbered. A skeleton's figure is not one. */
function readFigures() {
  if (!deckEl) return;
  const seen = new Map();
  for (const el of deckEl.querySelectorAll(FIGURES)) {
    if (el.closest('.m-skel')) continue;
    let key = slotOf(el);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `#${n}`;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const was = memory.get(key);
    memory.set(key, text);
    if (was != null && was !== text && !still()) flash(el.querySelector('.hl') || el, 'fx-tick', TICK_MS);
  }
}
