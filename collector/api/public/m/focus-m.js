/* FOCUS on the phone — the explanations fold under ⓘ, as on the desktop.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-22, of the whole product: "It's not a dashboard, it's
   a manuscript" — and the FOCUS pass that answered it (../focus.js,
   docs/FIX-STATUS.md FOCUS) ran on the desktop build only. The front-end audit
   of 2026-11-12 confirmed the phone had none of it (HANDOFF 0.9: "Also open
   … the phone build"), so the screen with the least room carried every word:
   the footer's 50 words of sources and principle on every screen, 57 words
   under Today's livebar, 85 under one payout caption, 99 under one online-time
   reason.

   THE SAME RULES, NOT A SECOND SET. Every verdict is ../focus.js decide(), the
   function the operator approved after the 106-page demo: a block of 15
   words or fewer stays; a warning stays cut to one line; a statement that a
   figure is absent, refused or not compared stays cut to one line, so the
   house principle — absent WITH its reason — is never folded out of sight; a
   block that is mostly figures stays; a block that links somewhere stays cut
   to one line; the rest folds. Nothing is removed, moved or reworded: a block
   is MARKED (data-fx) and arkiv.css — which the phone loads under the skin —
   hides or cuts it until its section's "ⓘ notes" opens it in place. The
   switch is the desktop's key (fleet.focus), stamped before the first paint
   by index.html for both builds; on the phone it is on the More screen.

   WHAT IS THE PHONE'S OWN, and why:

   · WHERE PROSE IS: a list, not a climb. The desktop finds prose by walking
     from each text node to its nearest block, and where none is named it
     climbs to the nearest div — the climb that judged a driver's day ROW as a
     paragraph and cut it to one line on production, 2026-11-11 (docs/AUDIT.md
     "Rows cut to one line"; COVERAGE trap "a row is not a paragraph"). The
     phone's prose has six shapes, every one a class m/ui.js or a shared
     renderer writes — a caption (.m-cap), a statement's sentence, the hour
     sentence, a target cell's sub-line, an absence band's reason, the footer
     — and a tile's sub-line, cut by the desktop's tile rule. Nothing else is
     ever judged: not a row (.m-row — its name, its sub-line, its figure), not
     a tile's label or figure, not a control. A row cannot be cut because no
     row is ever a candidate; test/phone_focus_motion.test.mjs measures every
     row on every screen with the pass on and off and finds them equal.

   · A HOST IS A SECTION. The toggle that opens a fold goes at the end of the
     section the fold sits in: a numbered card, a statement band, the absence
     band, the tile band, the footer. A line that sits loose in the deck (a
     warning between two sections, a list's caption) is left whole: its
     toggle would land at the end of the deck, a screenful below the line it
     opens. The one loose line that does leave is the sentence naming the
     controls a screen ignores — the desktop folds it into its control bar's
     tooltip, and the phone's control bar opens a sheet that heads with it in
     full (m/arkiv-m.css §22, CSS alone, no mark).

   · THE STATEMENT. A screen's statement band is its answer, and when its
     sentence carries figures — To the bank's "Our own figure for the week it
     settles is AED 110,962.09, a difference of AED 217.57" — it stays whole;
     only a statement sentence that explains, with fewer than two figures,
     folds. A section's first caption and a warning statement's sentence are
     cut to their first line instead of folded, as the desktop cuts a panel's
     first caption.

   · TOUCH. There is no hover, so a cut tile line's title (the desktop's way
     to read the rest) can never be reached; the section's toggle uncuts it,
     and the toggle is a 44px target (m/arkiv-m.css §22). A tile line that is
     mostly figures ("1 already on · 1 not in yet · 1 not asked …") stays
     whole: at 180px a one-line cut would leave three of its six counts.

   · A FOLD PAYS FOR ITS TOGGLE. A 44px target with 12px above it is 56px of
     screen; a section whose marks hide fewer words than that holds (PAYS)
     was longer folded than whole — More grew 27px in the first sweep — so it
     is left whole, with no toggle.

   · NO LAYOUT SHIFT. The desktop marks 120ms after the page changes, so a
     long caption paints and then folds. Here the pass runs inside the
     MutationObserver callback, which the browser runs before it paints what
     a screen has just drawn: a fold is never seen unfolded. (The callback
     runs again for the toggles it adds itself, finds nothing new, and stops:
     it never loops.)

   · THE FALLBACK — a desktop tab (#driver/x/earnings) drawn inside the phone
     — is the desktop's own markup, so it is judged by the desktop's own pass
     (../focus.js focusIn), with a loose block left whole for the reason above.

   Only under the redesign (m/ui.js phoneContract()): the old skin's phone
   draws byte for byte what it drew (test/phone_classic.test.mjs). */
import { decide, toggleFor, focusIn, applyFocus } from '../focus.js';
import { el, phoneContract } from './ui.js';

const WORDS = /[A-Za-z0-9][A-Za-z0-9'’.,%+−\-/:]*/g;
const NUMS = /\d[\d,]*(?:\.\d+)?/g;
const words = (s) => (s.match(WORDS) || []).length;
const nums = (s) => (s.match(NUMS) || []).length;
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/* The phone's prose, by the classes that write it. */
export const PROSE = 'p.m-cap, .m-lede p, p.hp-lede, .tg-sub, p.absb-why, .pf-inline p';
const TILE_SUB = '.m-stat .s';
/* Never judged, whatever they say. Rows and lists are the phone's table; an
   empty state, an error, a stale warning and an absence statement are the
   house principle on the face of the screen; the deposit form's notes and
   its server sentence are what someone with cash in hand reads before saving;
   the sheet is a control. */
export const NEVER = '.m-row, .m-rows, .m-empty, .m-err, .m-stale, .tg-absent, .ak-applies, '
  + '.m-sentence, .m-fieldnote, .m-picked, .m-sheet, form';
/* A section, nearest first. A statement band or a tile band inside a card
   belongs to the card, so one card has one toggle. */
export const HOSTS = '.m-card, .m-lede:not(.m-card .m-lede), section.absence, .pf-inline, '
  + '.m-stats:not(.m-card .m-stats)';
const FIGURES = 'svg, table, canvas, .m-stat, .tg-v, .m-rows, .ak-bars';
const SUB_WORDS = 8;     // the desktop's tile rule: a sub-line past this is cut to one line
const DENSE = 0.25;      // the desktop's figure-cell rule, applied to the tile line too
/* What a phone line holds at the reading size (358px of the deck at t5–t6:
   about nine words), what a half-width tile's line holds, and so how many
   words a section's marks must hide before its 56px toggle saves anything. */
const LINE_WORDS = 8;
const TILE_LINE_WORDS = 4;
const PAYS = 25;
/* Words a mark takes off the face: all of a fold; all but the first line of
   a cut (a lead, a flag, an absence, a clamped tile line). */
const hides = (m) => {
  const w = words(clean(m.textContent));
  if (m.dataset.fx === 'fold') return w;
  return Math.max(0, w - (m.matches('.m-stat:not(.hero) .s') ? TILE_LINE_WORDS : LINE_WORDS));
};

export const hostOf = (b) => b.parentElement?.closest(HOSTS) || null;

/** One pass over the deck. Idempotent: a block judged once keeps its mark. */
export function markDeck(deck) {
  if (!deck) return;
  const hosts = new Set();
  const foot = deck.querySelector(':scope > .pf-inline');
  for (const b of deck.querySelectorAll(PROSE)) {
    if (b.dataset.fx || b.closest('.m-fallback')) continue;
    const host = hostOf(b);
    if (!host || !deck.contains(host) || b.closest(NEVER)) { b.dataset.fx = 'keep'; continue; }
    let v = decide(b, deck, foot);
    /* THE STATEMENT'S SENTENCE IS PART OF THE ANSWER when it carries figures.
       The phone's statement band is "one sentence and the number it is about"
       (m/ui.js lede()), and on To the bank that sentence is the comparison
       the screen exists for — "Our own figure for the week it settles is
       AED 110,962.09, a difference of AED 217.57". The desktop's density rule
       (a figure cell styled as prose) passes it at 5 figures in 33 words, and
       the first cut folded it behind a tap; test/payout_mobile.test.mjs, which
       reads the lede for exactly those fils, caught it. A statement sentence
       with two figures or more stays whole; one that only explains folds as
       before, when it pays for its toggle (below). */
    if (v === 'fold' && host.matches('.m-lede') && nums(clean(b.textContent)) >= 2) v = 'keep';
    /* The first caption under a section's head says how to read the section
       — the desktop's rule for a panel's first caption, on the phone's card
       — and a warning statement's sentence is part of the warning: both stay
       on the face, cut to their first line, where the desktop would fold. */
    if (v === 'fold' && (b.matches('.m-card > h2 + p.m-cap') || host.matches('.m-lede.warn, .m-lede.bad'))) v = 'lead';
    b.dataset.fx = v;
    if (v !== 'keep') hosts.add(host);
  }
  for (const s of deck.querySelectorAll(TILE_SUB)) {
    if (s.dataset.fx || s.closest('.m-fallback')) continue;
    const t = clean(s.textContent);
    const w = words(t);
    const host = hostOf(s);
    if (host && w > SUB_WORDS && nums(t) / w <= DENSE) {
      s.dataset.fx = 'clamp';
      if (!s.title) s.title = t;
      hosts.add(host);
    } else s.dataset.fx = 'keep';
  }
  /* A section that holds no figure (More's "This app", a form's explanation)
     keeps its first line: folding all of it would leave a head over nothing.
     The desktop's rule, as it is. A statement band is not such a section: its
     claim is what it says, in display type above the sentence that folds. */
  for (const h of hosts) {
    if (h === foot || h.matches('.m-lede') || h.querySelector(FIGURES)) continue;
    const said = [...h.querySelectorAll('[data-fx]')].some((m) => m.dataset.fx !== 'fold' && words(clean(m.textContent)) >= 4);
    const first = h.querySelector('[data-fx="fold"]');
    if (!said && first) first.dataset.fx = 'lead';
  }
  /* A FOLD MUST PAY FOR ITS TOGGLE. The desktop's toggle is a 20px line; the
     phone's is a 44px target with 12px above it, and a section whose marks
     hide less than that is LONGER folded than whole. Measured by the sweep of
     2026-11-12 (bin/focus-rows-audit.mjs PHONE=1): More grew 1838 → 1865px
     (a 27-word caption cut to its first line, under a 56px "ⓘ more"), and the
     tile band on Corporate took a toggle row to hide six words of two tile
     lines. So a section is folded only when its marks hide at least PAYS
     words — what the toggle's 56px holds at the phone's reading size — and is
     otherwise left whole, every word on its face and no toggle under it. */
  for (const h of hosts) {
    const marks = [...h.querySelectorAll('[data-fx]:not([data-fx="keep"])')].filter((m) => hostOf(m) === h);
    if (marks.reduce((n, m) => n + hides(m), 0) < PAYS) for (const m of marks) m.dataset.fx = 'keep';
  }
  /* Every section that holds a mark is counted again, not only the new ones:
     Today's hour cards are redrawn every minute, and a section whose body was
     redrawn has new marks to count (or none, and loses its toggle). */
  for (const m of deck.querySelectorAll('[data-fx]:not([data-fx="keep"])')) {
    if (m.closest('.m-fallback')) continue;
    const h = hostOf(m);
    if (h) hosts.add(h);
  }
  for (const h of hosts) toggleFor(h, deck);
  const fb = deck.querySelector('.m-fallback');
  if (fb) focusIn(fb, fb.querySelector('.pf-inline'), { looseHost: false });
}

let started = false;
/** Once, when the phone's shell is built and before its first screen: the
    observer marks whatever every screen draws, before the browser paints it. */
export function startFocusM(deck) {
  if (started || !deck || !phoneContract()) return false;
  started = true;
  /* A pass runs INSIDE the callback, before the paint, so a pass that wrote
     something on every run would never let the page paint at all. Two guards:
     ../focus.js writes a toggle's label only when it changes, and a record
     that only touched a toggle — its own button added, moved or relabelled —
     is not news to judge. */
  const own = (n) => n.nodeType !== 1 ? !!n.parentElement?.closest('.fx-more') : n.matches('.fx-more') || !!n.closest('.fx-more');
  new MutationObserver((list) => {
    if (list.some((m) => !own(m.target) && ([...m.addedNodes].some((n) => !own(n)) || [...m.removedNodes].some((n) => n.nodeType === 1 && !n.matches('.fx-more'))))) markDeck(deck);
  }).observe(deck, { childList: true, subtree: true });
  markDeck(deck);
  return true;
}

/** The switch, for More → This app: the desktop's "ⓘ notes" button, said as
    what it does. The same key and the same mark on <html> (../focus.js
    applyFocus), so turning it off on the phone is turning it off. */
export function focusSwitch() {
  const b = el('button', 'm-btn ak-focus');
  b.type = 'button';
  const paint = () => {
    const on = document.documentElement.dataset.focus === 'on';
    b.textContent = on ? 'Show every word' : 'Fold the explanations again';
    b.setAttribute('aria-pressed', String(!on));
    b.title = on ? 'Explanations are folded under each section’s ⓘ. Tap to show every word on every screen.'
      : 'Every word is shown. Tap to fold the explanations under each section again.';
  };
  b.addEventListener('click', () => { applyFocus(document.documentElement.dataset.focus !== 'on'); paint(); });
  paint();
  return b;
}
