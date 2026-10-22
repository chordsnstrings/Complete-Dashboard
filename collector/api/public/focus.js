/* FOCUS — the page leads with its figures; the explanation folds under ⓘ.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-22: "It feels the site is extremely verbose. People
   have to read through everything to understand what is being shown and what
   the action points are … the same information that they are getting should
   be the same however, the actual page looks daunting due to
   over-explanation. It's not a dashboard, it's a manuscript." Then, having
   gone through a demo of every page built from a production snapshot with
   the rules below applied: "change in production, go live".

   WHAT WAS MEASURED (docs/AUDIT.md, "Verbosity", 2026-10-22). 141 pages on
   production through bin/prod-mirror.mjs, every visible text node classed as
   prose, table, figure, label, heading, control or chart: the median page
   carried 620 words of visible prose against the redesign plan's budget of
   120, its first screen 110 words of prose against 5 figures, and 53% of the
   long blocks were explanation, 17% method, 3% anything a reader could act
   on. The demo's rules — these rules — took the median page of 106 to 194
   visible words and its longest visible block from 74 words to 15, and a
   script confirmed that every number on each page was still on it.

   WHAT THIS DOES, AND WHAT IT NEVER DOES.
   · It removes nothing and moves nothing. A long explanation is MARKED
     (data-fx="fold") and arkiv.css hides it until the reader opens its
     panel's "ⓘ notes", where it reappears in its own place. Every figure,
     table, chart and absence reason stays in the page, one click away.
   · The house principle stands: a figure that cannot be measured is shown
     absent with the true reason. The absence stays on the face of the page
     (its label is short, or it is a tile value, which this never touches);
     only the long reason folds, and it folds into the panel it explains.
   · What stays visible as it is: a block of 15 words or fewer; a block that
     is mostly figures (a figure cell that happens to be styled as prose); an
     error. What stays visible cut to ONE line: the first caption under a
     panel's heading — the line that says how to read the chart — and every
     warning, with a red dot (data-fx="lead" / "flag"). A tile's sub-line
     over 8 words is cut to one line too, and keeps the whole line as its
     title (data-fx="clamp"). Opening the panel's notes uncuts all of them.
   · A container that holds both prose and figures is left whole: hiding it
     would hide figures, and wrapping its text would rewrite a renderer's
     DOM under it.
   · Only under the Arkiv skin. The Classic skin is held byte-frozen
     (HANDOFF §6.5, arkiv_classic_frozen), so this never marks its DOM.
   · A reader who wants every word turns it off with the control bar's
     "ⓘ notes" button, remembered per browser (fleet.focus), and the
     pre-paint script in index.html stamps the choice before first paint.

   WHY MARKS AND NOT MOVES. Panels fill late (each fetches its own data) and
   some re-render on a clock (Target, every minute). A pass that moved nodes
   into a fold would fight those renderers: the moved node would keep being
   updated in the wrong place, and a re-render would leave the fold holding
   stale copies. A mark rides with its node, a re-render that drops the node
   drops the mark, and the observer below marks whatever arrives. */

const KEY = 'fleet.focus';
const WORDS = /[A-Za-z0-9][A-Za-z0-9'’.,%+−\-/:]*/g;
const NUMS = /\d[\d,]*(?:\.\d+)?/g;
const words = (s) => (s.match(WORDS) || []).length;
const nums = (s) => (s.match(NUMS) || []).length;
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/* Where prose lives, nearest first, and what is never prose to this pass. */
const BLOCK = 'p, li, .note, .cap, dd, blockquote, .vdct-sub, .vdct-rec, .sp-ev, .sp-hint, .sub, .lede, .why';
const NOT_PROSE = 'svg, td, th, button, select, option, input, label, textarea, .kpi, h1, h2, h3, h4, summary, '
  + '.num, .hb, .hbars, .track, .sechd, .pill, .chip, .fx-more, details:not([open])';
const HOLDS_DATA = 'table, svg, canvas, .kpi, .kpis, .panel, .cband, .chartscroll, .hbars, button, select, input, details';
const HOST = '.panel, section.cband, section, form, fieldset';

const LEAD_WORDS = 15;     // a block this short is a line, not an explanation
const SUB_WORDS = 8;       // a tile's sub-line past this is cut to one line
const DENSE = 0.25;        // numbers per word above which a block is a figure cell

export const focusOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
const arkiv = () => document.documentElement.dataset.skin === 'arkiv';

/** The verdict for one prose block: keep, fold, lead (one line), or flag (one line, red dot). */
export function decide(b, view, foot) {
  const t = clean(b.textContent);
  const w = words(t);
  if (!w) return 'keep';
  if (foot && foot.contains(b)) return b.closest('.pf-basis, .pf-principle') ? 'fold' : 'keep';
  if (b.closest('.err, .error, .failbox, .closed-block, [role="alert"]')) return 'keep';
  const warn = b.matches('.note.warn, .note.err, .warn') || !!b.closest('.note.warn, .note.err');
  if (w <= LEAD_WORDS) return 'keep';
  if (warn) return 'flag';
  if (nums(t) / w > DENSE || b.querySelector('.n, .num, b.big, .tg-v')) return 'keep';
  if (b.matches('p.cap') && b.previousElementSibling?.matches('h3') && b.parentElement?.matches('.panel')) return 'lead';
  return 'fold';
}

/* Every prose block under root that this pass has not judged yet. */
function blocksIn(root, view) {
  const out = new Set();
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const el = n.parentElement;
      return !el || el.closest(NOT_PROSE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n; (n = w.nextNode());) {
    const el = n.parentElement;
    let b = el.closest(BLOCK);
    if (!b || !root.contains(b)) b = el.closest('div, section, span') || el;
    if (!root.contains(b) || b === root || b === view || b.dataset.fx) continue;
    if (b.querySelector(HOLDS_DATA)) continue;
    out.add(b);
  }
  return out;
}

const hostOf = (b, view, foot) => {
  if (foot && foot.contains(b)) return foot;
  const h = b.parentElement?.closest(HOST);
  return h && view.contains(h) && h !== view ? h : view;
};

function toggleFor(host, view) {
  let btn = [...host.children].find((c) => c.classList?.contains('fx-more'));
  const hidden = host.querySelectorAll('[data-fx="fold"]').length;
  const cut = host.querySelectorAll('[data-fx="lead"], [data-fx="flag"], [data-fx="clamp"]').length;
  if (!hidden && !cut) { btn?.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'fx-more';
    btn.addEventListener('click', () => { host.classList.toggle('fx-open'); label(btn, host); });
    host.append(btn);
  } else if (btn !== host.lastElementChild && host !== view) host.append(btn);
  btn.dataset.n = String(hidden);
  label(btn, host);
}
function label(btn, host) {
  const n = +btn.dataset.n || 0;
  const open = host.classList.contains('fx-open');
  const what = host.id === 'pageFoot' ? 'sources' : n ? `${n} note${n === 1 ? '' : 's'}` : 'more';
  btn.textContent = open ? `Hide ${host.id === 'pageFoot' ? 'sources' : 'notes'}` : `ⓘ ${what}`;
  btn.setAttribute('aria-expanded', String(open));
}

/** One pass over the page: judge what is new, then give each panel its toggle. Idempotent. */
export function focusView() {
  const view = document.getElementById('view');
  const foot = document.getElementById('pageFoot');
  if (!view || !arkiv()) return;
  const hosts = new Set();
  for (const root of [view, foot].filter(Boolean)) {
    for (const b of blocksIn(root, view)) {
      b.dataset.fx = decide(b, view, foot);
      if (b.dataset.fx !== 'keep') hosts.add(hostOf(b, view, foot));
    }
  }
  for (const s of view.querySelectorAll('.kpi .s, .kpi .t-sub, .kpi .sub')) {
    if (s.dataset.fx) continue;
    const t = clean(s.textContent);
    if (words(t) > SUB_WORDS) {
      s.dataset.fx = 'clamp';
      if (!s.title) s.title = t;
      hosts.add(hostOf(s, view, null));
    } else s.dataset.fx = 'keep';
  }
  // Re-count every host that holds a mark, not only the new ones: a panel
  // whose body re-rendered may have lost marks and must say so.
  for (const m of view.querySelectorAll('[data-fx]:not([data-fx="keep"])')) hosts.add(hostOf(m, view, null));
  if (foot?.querySelector('[data-fx="fold"]')) hosts.add(foot);
  for (const h of hosts) toggleFor(h, view);
  // The control bar's sentence ("the date range does not apply here") is the
  // control's own business: it becomes the bar's tooltip, said where it applies.
  const a = document.getElementById('fApplies'), bar = document.getElementById('filters');
  if (a && bar) bar.title = clean(a.textContent);
}

function applyFocus(on) {
  const r = document.documentElement;
  r.dataset.focus = on ? 'on' : 'off';
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private window */ }
  const b = document.getElementById('focusBtn');
  if (b) {
    b.setAttribute('aria-pressed', String(!on));
    b.textContent = on ? 'ⓘ notes' : 'ⓘ all text';
    b.title = on ? 'Explanations are folded under each panel. Click to show every word on every page.'
      : 'Every word is shown. Click to fold the explanations under each panel again.';
  }
}

let started = false;
/** Once, at boot: the control-bar button, the mark on <html>, and an observer that
    marks whatever the renderers add later. `section` is read on every pass so the
    Today strip knows whether it is on a Today page. */
export function startFocus({ section = () => null } = {}) {
  if (started || !arkiv()) return;      // the Classic skin is held byte-frozen: no mark, no button
  started = true;
  applyFocus(focusOn());
  const theme = document.getElementById('themeBtn');
  if (theme && !document.getElementById('focusBtn')) {
    const b = document.createElement('button');
    b.id = 'focusBtn'; b.type = 'button';
    b.addEventListener('click', () => applyFocus(document.documentElement.dataset.focus !== 'on'));
    theme.before(b);
    applyFocus(focusOn());
  }
  let timer = 0;
  const run = () => {
    timer = 0;
    document.documentElement.dataset.fxSec = section() || '';
    focusView();
  };
  const host = document.querySelector('main') || document.body;
  new MutationObserver((list) => {
    if (timer) return;
    if (!list.some((m) => m.target.closest?.('#view, #pageFoot') || [...m.addedNodes].some((n) => n.id === 'view'))) return;
    timer = setTimeout(run, 120);
  }).observe(host, { childList: true, subtree: true });
  run();
}
