/* The vertical rhythm, measured rather than assumed.
   ─────────────────────────────────────────────────────────────────────────
   #view is a flex column with a gap, and for a page that appends its sections
   straight to it that is the whole story. Every tabbed page and every detail
   page does not: they render into a wrapper, so the tab bar stays put while
   the body swaps. The gap applies to the wrapper and never inside it, and what
   is left is whatever margin each section carries on its own — a .panel
   carries none.

   Measured on production before this test existed: twenty routes across twelve
   pages stacked sections at exactly 0px, Unit economics seven pairs of them.
   Nothing failed, nothing logged, and the page just looked wrong — which is
   the only way this class of defect ever announces itself. So it is measured
   in a browser, on every route, and a section that touches the one above it
   fails the suite.

   The first version of this test only looked at #view and the wrappers
   directly under it, which is why it passed clean while the same defect sat
   one level deeper: every panel body is a wrapper too, and a panel holding a
   note, a KPI row and a table stacked all three at 0px. So it walks the whole
   subtree now. What keeps that from drowning in false positives is a
   definition rather than a depth limit — two SECTIONS owe each other room;
   the parts inside one (a KPI's label and its number, a table's head and its
   body, a caption and what it captions) do not, and are not sections.

   Not part of `npm test`: it needs Chromium and a server. Run it the same way
   as the smoke test:

     node mockapi.mjs &
     node test/spacing.test.mjs
*/
import { launchChromium } from './browser.mjs';
import { ROUTES } from './routes_list.mjs';

const BASE = process.env.SPACING_BASE || process.env.SMOKE_BASE || 'http://localhost:8099';
/* Below this two sections are touching. Well under the 22px the stack sets, so
   a deliberate tighter pairing has room before it trips the test. */
const MIN_GAP = 10;

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* A SECTION is a block that holds content of its own — the things a page or a
   panel stacks. Everything else on screen is a part of one, and parts are
   spaced by their component, tightly and on purpose. The list is the
   product's own vocabulary; a new section class added to app.css and not
   added here is simply not measured, which is the safe direction to fail. */
const SECTION = ['panel', 'pbody', 'note', 'kpis', 'tblock', 'tscroll', 'cards',
  'cohort-cards', 'setgrid', 'hbars', 'idcard', 'vdct', 'chips', 'legend',
  'toolbar', 'stack', 'grid', 'g2', 'g3', 'g23', 'wave', 'cal', 'empty'];

const MEASURE = ([minGap, SECTION]) => {
  const view = document.querySelector('#view');
  if (!view) return { error: 'no #view' };
  const nm = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string'
    ? '.' + e.className.trim().split(/\s+/)[0] : ''}`;
  const visible = (e) => {
    const s = getComputedStyle(e);
    return !e.hidden && s.display !== 'none' && s.position !== 'absolute'
      && s.position !== 'fixed' && e.getBoundingClientRect().height > 4;
  };
  const isSection = (e) => [...e.classList].some((c) => SECTION.includes(c));
  const bad = [];
  const pairs = [];
  const walk = (el, depth) => {
    if (depth > 9) return;
    const kids = [...el.children].filter(visible);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1], b = kids[i];
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (rb.top < ra.bottom - 1) continue;                     // side by side
      const gap = Math.round(rb.top - ra.bottom);
      /* Two sections stacked: they owe each other room. */
      if (isSection(a) && isSection(b)) pairs.push([a, b, gap]);
      /* A panel's body against its own heading. Neither an h3 nor an h2 is a
         section, so the rule above cannot see the one pairing that made
         #settlement's chart sit flush under its title. */
      else if (b.classList.contains('pbody')) pairs.push([a, b, gap]);
    }
    for (const k of kids) walk(k, depth + 1);
  };
  walk(view, 0);
  for (const [a, b, gap] of pairs) {
    if (gap < minGap) bad.push(`${nm(a)} →${gap}px→ ${nm(b)}`);
  }
  return { bad, seen: pairs.length };
};

const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();

const only = process.env.SPACING_ONLY;
const routes = only ? ROUTES.filter((r) => r.includes(only)) : ROUTES;
const offenders = [];
let measured = 0;
for (const route of routes) {
  try {
    /* Not networkidle: #live and #map poll on a timer and never go idle, so
       the sweep sat on them until it was killed. A fixed settle is enough —
       this measures where boxes land, and a page that is still fetching has
       already laid out the sections it has. */
    await page.goto(`${BASE}/#${route}?days=30`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    const m = await page.evaluate(MEASURE, [MIN_GAP, SECTION]);
    if (m.error) continue;
    measured += 1;
    if (m.bad.length) offenders.push(`${route}: ${m.bad.slice(0, 3).join(' | ')}`);
  } catch { /* a route that will not load is the smoke test's job, not this one */ }
}
await browser.close();

check(`every section on every page is spaced from the one above it`, offenders.length === 0,
  offenders.length ? `\n      ${offenders.slice(0, 12).join('\n      ')}` : '');
check('and enough routes were actually measured to mean something', measured >= routes.length * 0.8,
  `${measured} of ${routes.length}`);

console.log(`\n  ${measured} routes measured against ${BASE}, minimum gap ${MIN_GAP}px`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
