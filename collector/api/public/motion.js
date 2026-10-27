/* MOTION — the Arkiv skin's motion layer: the half a stylesheet cannot do.
   ─────────────────────────────────────────────────────────────────────────
   motion.css says how every movement looks. This decides WHEN, for the three
   moments a stylesheet cannot tell apart from their look-alikes (the
   operator's ruling of 2026-10-27, docs/FIX-STATUS.md MOTION):

   1. A PAGE ARRIVING, versus the same page drawn again. app.js redraws the
      page it is on whenever a background refresh finds the data moved
      (data:refreshed → render()), and every render builds a fresh #view
      (freshView). An entrance keyed on the element would replay on each of
      those, and the page would seem to reload under the reader. So the
      entrance class goes on only when the ADDRESS changed — the address is
      the page, filters and all (app.js applyRoute).

   2. CONTENT AFTER A WAIT. A panel's body is a skeleton (ui.js loading())
      until its request answers. Content that replaces a skeleton the reader
      actually watched comes up; content that replaced one within a frame or
      two — an answer from the browser's own copy (swr.js) — just appears.
      Fading in what was never late is motion for its own sake.

   3. A FIGURE THAT MOVED. On a redraw of the same page, each headline figure
      is compared with what the same slot said the last time; one that
      changed gets the skin's wash, laid on and lifted. Today the redraw is
      silent by design (app.js: nothing redraws unless something moved), so
      a reader who glanced away cannot tell WHICH number moved. The today
      strip, which outlives every page, is compared across pages too.

   And the busy hairline: one element, for the stylesheet to draw while
   data.js has the page's requests in flight (data-busy on <html>).

   INERT unless index.html stamped data-motion="on" — the Arkiv skin, the
   desktop build, not under automation — and every class is checked against
   prefers-reduced-motion before it goes on. Nothing here changes a figure,
   a word or a link: it adds and removes its own fx-* classes and nothing
   else, and removes each one when its movement is over. */

const on = () => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'on';
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* The headline figures: a glance tile's value, a Target cell, a today-strip
   figure, and the bold figures in the hour-by-hour sentence. Tables are left
   alone — a re-sorted column is not news. */
const FIGURES = '.kpi .n, .tg-v, .tn-f b, .hp-lede > b';
/* A skeleton that stood for less than this was never seen: the answer came
   from this browser's copy in the same task or the next. */
const SEEN_MS = 120;
const ENTER_MS = 1600;     // covers motion.css §3: 360ms of stagger + the pen
const ARRIVE_MS = 450;
const TICK_MS = 2500;
/* A tile drawn on a page's ARRIVAL is read only once its count-up has
   landed: app.js countUp() runs it up from zero over 620ms, and for that
   long it holds numbers that are not its value. Read inside that window,
   every tile looked as if it had moved (it had: through 0, 18,714, 39,779…
   on its way to 280,622; measured on #overview, 2026-10-27).

   Timed from when the count-up STARTS — app.js calls motionEntered() as it
   runs animateView(), at the very end of a page's render — and not from when
   the tile appeared. On production the tiles come in first and the rest of
   the page seconds later, so a window timed from the tile had closed before
   the count-up began, and its way up was marked as five figures moving
   (281,567 km on the way to 281,573 km; found on production the day the
   layer went live). A tile on a page whose entrance never ran (a render that
   failed) is not read at all.

   A REDRAW runs no count-up under this layer (app.js, `arriving`), so its
   figures are final the moment they are drawn and are compared at once —
   the mark lands on the same frame as the new number. */
const SETTLE_MS = 800;
const STRIPS = new Set(['todayNow', 'authBanner']);

let started = false;
let route = null;               // the address #view's figures were read on
let calm = false;               // this render is a redraw: nothing counts up
let counted = null;             // the #view whose entrance (and count-up) has run…
let countedAt = 0;              // …and when it started
const page = new Map();         // slot → text on this page; forgotten when the address changes
const strip = new Map();        // slot → text in the today strip; never forgotten
const raised = new WeakMap();   // skeleton → when it went up
let pending = 0;
let settling = 0;

/* A class for as long as its movement lasts. A timer rather than
   animationend: that event bubbles, and a chart's own line finishing inside
   a block would take the block's class off halfway. */
function flash(el, cls, ms) {
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

export function startMotion() {
  if (started || !on()) return;
  started = true;
  const busy = document.createElement('div');
  busy.id = 'akBusy';
  busy.setAttribute('aria-hidden', 'true');
  document.body.append(busy);
  /* .main holds #view and the today strip; #view is replaced on every
     render, so the watch is on its parent and survives each one. */
  new MutationObserver(watch).observe(document.querySelector('#app .main') || document.body,
    { childList: true, subtree: true });
  /* Folded notes (focus.js): mark the host just BEFORE focus.js opens it —
     this listener captures, focus.js's bubbles — so the notes come up when
     the reader asks for them, and not on every redraw of an open host. */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.fx-more');
    if (btn?.parentElement && !still()) flash(btn.parentElement, 'fx-unfold', 700);
  }, true);
}

/** Called by app.js with each fresh #view. A new address is a page arriving;
    the same address is a redraw, which keeps its figures for comparison.
    Says which: true for an arrival, false for a redraw — and nothing at all
    while the layer is off, so app.js goes on exactly as before. */
export function motionView(root) {
  if (!started || !root) return undefined;
  /* app.js freshView() CLONES the last #view, attributes and all, so a class
     put on it comes along: a redraw within the entrance's 1.6 s inherited
     fx-enter, and no timer would ever take it off the new element. Found on
     production, 2026-10-27. */
  root.classList.remove('fx-enter');
  const here = location.hash;
  calm = here === route;
  if (calm) return false;
  route = here;
  page.clear();
  if (!still()) flash(root, 'fx-enter', ENTER_MS);
  return true;
}

/** Called by app.js the moment a page's entrance runs (animateView), which is
    when its tiles start counting up. Their figures are read once that lands. */
export function motionEntered(root) {
  if (!started || !root) return;
  counted = root;
  countedAt = performance.now();
  setTimeout(readFigures, SETTLE_MS + 30);
}

function watch(records) {
  const now = performance.now();
  let figures = false;
  for (const r of records) {
    let waited = false;
    for (const n of r.removedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains('skel')) continue;
      const t = raised.get(n);
      if (t == null || now - t >= SEEN_MS) waited = true;
    }
    const added = [];
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList.contains('skel')) raised.set(n, now);
      else added.push(n);
    }
    if (r.addedNodes.length) figures = true;
    /* The shell's two strips that fill in AFTER the page — the today strip
       and the credential banner — push it down when they land; one that was
       empty and is now filled comes up instead. Only those two: the section
       links are rebuilt one append at a time on every render, and the first
       of them would fade on every page. */
    if (!waited && STRIPS.has(r.target.id) && !r.removedNodes.length && added.length
      && added.length === r.target.childElementCount && !still()) {
      for (const n of added) flash(n, 'fx-arrive', ARRIVE_MS);
      continue;
    }
    if (!waited || still()) continue;
    /* What replaced the skeleton comes up. A node with an entrance of its
       own (a chart's growing bar, a block already settling) keeps it. If
       only text came, the host itself does. */
    const targets = added.length ? added : [r.target];
    for (const n of targets) {
      if (getComputedStyle(n).animationName === 'none') flash(n, 'fx-arrive', ARRIVE_MS);
    }
  }
  if (figures && !pending) pending = requestAnimationFrame(() => { pending = 0; readFigures(); });
}

function readFigures() {
  const now = performance.now();
  const early = compare(document.querySelector('#view'), page, now)
    | compare(document.querySelector('#todayNow'), strip, now);
  /* Come back for whatever was too fresh to read. Pushed back by every new
     batch, so a count-up still running keeps it waiting until it lands. */
  if (early) { clearTimeout(settling); settling = setTimeout(readFigures, SETTLE_MS); }
}

/* Each figure against what its slot said before. A slot is the block it
   stands in (a panel's heading, a section's name) and its own label, so the
   same words in two panels are two slots; a repeat inside one block is
   numbered. Text is compared as the reader sees it. */
function compare(host, memory, now) {
  if (!host) return false;
  const seen = new Map();
  let early = false;
  for (const el of host.querySelectorAll(FIGURES)) {
    let key = slotOf(el);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `#${n}`;
    if (!calm && el.matches('.kpi .n') && !(counted === host && now - countedAt >= SETTLE_MS)) {
      early = true;
      continue;
    }
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const before = memory.get(key);
    memory.set(key, text);
    /* On the skin's highlighter when the figure wears one (ui.js highlight():
       a wash and a rule of its own), so the mark is drawn round what the
       reader sees as the figure. */
    if (before != null && before !== text && !still()) flash(el.querySelector('.hl') || el, 'fx-tick', TICK_MS);
  }
  return early;
}

function slotOf(el) {
  const words = (x) => (x?.textContent || '').replace(/\s+/g, ' ').trim();
  const block = words(el.closest('.panel')?.querySelector('h3'))
    || words(el.closest('.cband')?.querySelector('.sechd-name'));
  const kpi = el.closest('.kpi');
  if (kpi) return `${block}|kpi|${kpi.dataset.kpi || words(kpi.querySelector('.l'))}`;
  const cell = el.closest('.tg-cell');
  if (cell) return `${block}|tg|${cell.dataset.mt || words(cell.querySelector('.tg-l'))}`;
  const tn = el.closest('.tn-f');
  if (tn) return `strip|${words(tn.querySelector('.lb-l')) || words(el.nextSibling)}`;
  return `${block}|${el.parentElement?.className || ''}`;
}
