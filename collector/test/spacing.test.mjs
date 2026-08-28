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

const MEASURE = (minGap) => {
  const view = document.querySelector('#view');
  if (!view) return { error: 'no #view' };
  const nm = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string'
    ? '.' + e.className.trim().split(/\s+/)[0] : ''}`;
  const visible = (e) => {
    const s = getComputedStyle(e);
    return !e.hidden && s.display !== 'none' && e.getBoundingClientRect().height > 4;
  };
  /* Two things are attached to a neighbour by design and are not sections.
     A tab bar belongs to the subject above it and carries its own 4px/2px in
     app.css; a caption belongs to whatever it captions. Spacing either to 22px
     would break the thing this test exists to protect. Everything else is a
     section and owes its neighbour room. */
  const attached = (e) => e.classList.contains('tabs') || e.classList.contains('cap')
    || e.tagName === 'H2' || e.tagName === 'H3';
  const bad = [];
  /* Only the containers that STACK a page's sections: #view itself and any
     wrapper a page renders its body into. A panel's own internals are not
     sections — an h3 sits 2px above its caption on purpose. */
  const hosts = [view, ...[...view.children].filter((k) => k.tagName === 'DIV'
    && [...k.classList].every((c) => c === 'stack') && k.children.length >= 2)];
  for (const host of hosts) {
    const kids = [...host.children].filter(visible);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
      if (b.top < a.bottom - 1) continue;                       // side by side
      if (attached(kids[i]) || attached(kids[i - 1])) continue;
      const gap = Math.round(b.top - a.bottom);
      if (gap < minGap) bad.push(`${nm(kids[i - 1])} →${gap}px→ ${nm(kids[i])}`);
    }
  }
  return { bad };
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
    const m = await page.evaluate(MEASURE, MIN_GAP);
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
