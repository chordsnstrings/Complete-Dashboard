/* ══ THE ANSWER LINE AND THE ACT-ON STRIP — the component ═════════════════════
   FOCUS, the second half (HANDOFF 0.9; FIX-STATUS FOCUS and ANS; docs/AUDIT.md
   "Verbosity"). The operator, 2026-10-22: "People have to read through
   everything to understand what is being shown and what the action points
   are … It's not a dashboard, it's a manuscript." The audit that followed
   measured what the long blocks on 141 pages were FOR: explanation 53%, method
   17%, why a figure is absent 13%, scope 13% — and WHAT TO DO 3%. The generic
   half (focus.js) folded the explanations under ⓘ; what was still missing is
   the thing a reader opens a page for: its answer, and what to do about it.

   So each page now opens with two things, drawn here and decided in
   answers.js:

     · ONE ANSWER LINE — a sentence answering the page's own question, from the
       data the page has just fetched, with its basis under it in small type;
     · AN ACT-ON STRIP — up to three concrete next actions, each a link to where
       the action happens (another page, a cohort list, or a panel further down
       this one).

   WHERE IT SITS, AND WHY NOT INSIDE #view. Between the title block and #view,
   in a host of its own (#pageAnswer) — exactly where the demo the operator
   reviewed put it (the 106-page Now/Proposed demo of 2026-10-22). Not inside
   #view, for a reason the tests make concrete: the page contract says "00
   leads the page" (test/page_contract.test.mjs §7, test/arkiv_pages.mjs and
   test/arkiv_money.test.mjs all read #view's first child), and focus.js and
   motion.js both walk #view. A host OUTSIDE the page is the same arrangement
   as the shell footer (ui.js pageFoot): the shell owns the box, the page fills
   it, render() empties it on every navigation (clearAnswer below), and a
   render the reader has already left can never write into it — the `view`
   handed in must still be the #view on the page, which an abandoned render's
   replaced node is not (app.js freshView).

   ARKIV ONLY, AND DESKTOP ONLY. The Classic skin is held byte-frozen
   (test/arkiv_classic_frozen; FOCUS5), so the component is never built there:
   which skin is in force is a TOKEN (ui.js contract(), --pg-contract), never
   the attribute (test/arkiv_skin §4). The phone build (/m/) is a separate
   application with its own screens; it never reaches this file, and a page
   drawn inside the phone's fallback host is not inside #view, so nothing is
   drawn there either.

   NOTHING HERE DECIDES A WORD. The sentence, its basis and the actions are
   answers.js's; this file only draws them, absent or present:
     result = { page, text, basis, acts: [{ text, href, to }], none }
            | { page, absent, basis, acts }
   An ABSENT answer is drawn as what it is — "Not answered", then the true
   reason — never as an empty line, never as a zero (the house principle,
   ui.js PRINCIPLE). It carries data-absent, so ui.js highlight() can never
   emphasise it. */
import { el, esc, contract } from './ui.js';
import { parseHash } from './data.js';
import { gated, canOpenView } from './access.js';

export const ACTS_MAX = 3;
const HOST_ID = 'pageAnswer';

/* The panel an in-page action points at: its KEY ("payout-diff" — ui.js
   panel()'s third argument, stamped as data-panel; a band built by hand
   carries it as a class), or its heading, by the words it starts with
   ("Flagged segments"). Headings are fixed strings in each page's code, and
   most panels carry no key, so the heading is the one name every panel has.
   (The first version read a key as a class selector, ".payout-diff", and
   found nothing on any panel — answers.test §4 caught it: the action left
   the reader where they were.) */
export function findTarget(view, to) {
  if (!view || !to) return null;
  if (/^[a-z0-9-]+$/.test(to)) {
    return view.querySelector(`[data-panel="${to}"]`) || view.querySelector(`.${to}`);
  }
  const want = String(to).trim().toLowerCase();
  const h = [...view.querySelectorAll('.panel > h3, .sechd-name, h2, h3')]
    .find((x) => x.textContent.trim().toLowerCase().startsWith(want));
  return h ? (h.closest('.panel, section, .cband') || h) : null;
}

/* Scroll to the panel and say so with a ring that fades, without moving focus
   off a page that may hold a form: focus goes to the panel itself (tabindex
   -1), which a screen reader announces and a keyboard can continue from. */
function goTo(target) {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch { /* an element that will not take focus */ }
  target.classList.add('ans-target');
  setTimeout(() => target.classList.remove('ans-target'), 1800);
}

/* The section, built from a result. Exported for the tests; the page reaches
   it only through mountAnswer. */
export function answerBlock(result, view = null) {
  const r = result || {};
  const box = el('section', `ans${r.absent ? ' ans-absent' : ''}`);
  box.id = HOST_ID;
  box.dataset.ans = String(r.page || '');
  box.setAttribute('aria-label', 'This page’s answer, and what to act on');
  /* data-fx="keep" on every block: focus.js judges each prose block once and
     never touches one already marked, so the answer is never folded or cut to
     one line — wherever a later change to focus.js might look. */
  if (r.absent) {
    const p = el('p', 'ans-line ans-na');
    p.dataset.fx = 'keep';
    p.dataset.absent = '1';
    p.innerHTML = `<span class="ans-na-l">Not answered</span> ${esc(r.absent)}`;
    box.append(p);
  } else {
    const p = el('p', 'ans-line', esc(r.text || ''));
    p.dataset.fx = 'keep';
    box.append(p);
  }
  if (r.basis) {
    const b = el('p', 'ans-basis', esc(r.basis));
    b.dataset.fx = 'keep';
    box.append(b);
  }
  const acts = (r.acts || []).filter((a) => a && a.text && a.href).slice(0, ACTS_MAX);
  if (acts.length || (!r.absent && r.none)) {
    const strip = el('nav', `ans-act${acts.length ? '' : ' ans-act-none'}`);
    strip.setAttribute('aria-label', 'Act on');
    strip.append(el('span', 'ans-act-t', 'Act on'));
    if (acts.length) {
      const ol = el('ol', 'ans-acts');
      for (const a of acts) {
        const li = el('li');
        li.dataset.fx = 'keep';
        const link = el('a', 'ans-act-i', `<span class="ans-act-x">${esc(a.text)}</span><span class="ans-act-go" aria-hidden="true">→</span>`);
        link.href = a.href;
        if (a.to) {
          link.dataset.to = a.to;
          /* A panel further down THIS page: the address is the page itself,
             so a middle-click still opens something true, and a plain click
             scrolls instead of asking the router for the page it is on. */
          link.addEventListener('click', (e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const v = view && view.isConnected ? view : document.getElementById('view');
            const t = findTarget(v, a.to);
            if (!t) return;                 // the panel is gone: let the link do its work
            e.preventDefault();
            goTo(t);
          });
        }
        li.append(link);
        ol.append(li);
      }
      strip.append(ol);
    } else {
      const n = el('p', 'ans-act-n', esc(r.none));
      n.dataset.fx = 'keep';
      strip.append(n);
    }
    box.append(strip);
  }
  return box;
}

/* An action leading to a page this reader's role does not open is drawn as
   plain text — still readable, not a door (ULM-DESIGN §7 rule 6) — exactly
   as app.js markShutLinks() treats every link inside #view. That pass reads
   #view only, and this box sits above it, so the box does its own. */
function markShut(box) {
  if (!gated()) return;
  for (const a of box.querySelectorAll('a[href^="#"]')) {
    const r = parseHash(a.getAttribute('href').slice(1));
    if (!r.view || canOpenView(r.view, r.sub || '', r.param || '')) continue;
    a.classList.add('access-shut');
    a.setAttribute('aria-disabled', 'true');
    a.title = 'Not shown to your role';
  }
}

/* Draw `result` above `view`, replacing whatever answer is there. Returns the
   section, or null when nothing may be drawn: the old skin, a detached or
   replaced view (a render the reader has left), or a host that is not the
   page's #view (the phone's fallback). */
export function mountAnswer(view, result) {
  if (typeof document === 'undefined' || !result) return null;
  if (!contract()) return null;
  if (!view || !view.isConnected || view.id !== 'view') return null;
  /* The same answer again — #target and #month-target redraw every minute —
     leaves the box alone, so a reader tabbing through the actions keeps
     their place instead of losing focus to a rebuilt copy of the same words. */
  const sig = JSON.stringify(result);
  const old = document.getElementById(HOST_ID);
  if (old && old.dataset.sig === sig && old.nextElementSibling === view) return old;
  const box = answerBlock(result, view);
  box.dataset.sig = sig;
  markShut(box);
  if (old) old.remove();
  view.parentElement.insertBefore(box, view);
  return box;
}

/* Every navigation starts without an answer (app.js render(), beside
   clearPageFoot): the page that is arriving draws its own, and a page with no
   rule — or one that fails to load — shows none rather than the last page's. */
export function clearAnswer() {
  if (typeof document === 'undefined') return;
  document.getElementById(HOST_ID)?.remove();
}
