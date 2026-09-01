/* A KPI value cut off at the edge of its own tile.
   ─────────────────────────────────────────────────────────────────────────
   The tile is overflow:hidden, so a value too wide for it is not merely ugly:
   it ends mid-number with nothing to say it was truncated. app.css already
   guards against that — a value longer than KPI_ONE_LINE gets `.long`, which
   turns nowrap off so the figure wraps instead.

   That rule cannot reach a value rendered as a PILL. A pill sets its own
   white-space:nowrap, which is right in a table cell and, in a tile, fixes the
   pill's shrink-to-fit width at the whole string: on #reconcile/2026-08 at
   1180px the Gap tile wanted 153px of pill inside a 128px box, and
   bin/render-audit.mjs reported the 8px the kpi row was pushed past its
   container.

   Measured through the real kpiRow() and the real stylesheet at the real
   column width, because this is a CSS fact and nothing else can assert it. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* Five tiles at 1180px is the layout #reconcile/2026-08 draws, and 164px is
   the column it gives each of them. */
const measure = async (value) => page.evaluate(async (v) => {
  const ui = await import('/ui.js');
  document.querySelector('#kpihost')?.remove();
  const host = document.createElement('div');
  host.id = 'kpihost';
  host.style.width = '873px';
  document.body.append(host);
  host.append(ui.kpiRow([
    { label: 'Trips', value: '13,390', sub: 'bookings over Aug 2026' },
    { label: 'Expected payout', value: 'AED 199,260', sub: 'on-trip net' },
    { label: 'Bank payout', value: 'AED 433,139', sub: 'what the platforms report' },
    { label: 'Compared over', value: '7,196', sub: 'driver-days both sides describe' },
    { label: 'Gap', html: ui.pill(v, 'bad'), sub: 'banked against expected' },
  ]));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tiles = [...host.querySelectorAll('.kpi')];
  const row = host.querySelector('.kpis');
  const gap = tiles[tiles.length - 1];
  return {
    rowOver: row.scrollWidth - row.clientWidth,
    tileOver: gap.scrollWidth - gap.clientWidth,
    worst: Math.max(...tiles.map((t) => t.scrollWidth - t.clientWidth)),
    lines: Math.round(gap.querySelector('.pill').getBoundingClientRect().height),
    text: gap.querySelector('.n').textContent.trim(),
    long: gap.querySelector('.n').classList.contains('long'),
  };
}, value);

console.log('\na pill as a KPI value stays inside its tile');
const wide = await measure('+AED 228,060 · 114.5%');
check('the value is judged long, so the wrapping rule applies at all',
  wide.long, JSON.stringify(wide));
check('the tile does not overflow', wide.tileOver <= 1, `+${wide.tileOver}px`);
check('and neither does the row it sits in', wide.rowOver <= 1, `+${wide.rowOver}px`);
check('the pill took a second line rather than being cut', wide.lines > 26,
  `${wide.lines}px tall — one line is about 20px`);
check('and the whole figure is still there, to the last digit',
  wide.text === '+AED 228,060 · 114.5%', JSON.stringify(wide.text));

/* A longer one still, because the gap on a month with one statement day can
   reach four figures of percentage. */
console.log('\nand so does a worse one');
const worse = await measure('−AED 1,284,905 · 1,449.2%');
check('no tile overflows', worse.worst <= 1, `+${worse.worst}px`);
check('the row does not either', worse.rowOver <= 1, `+${worse.rowOver}px`);
check('and nothing is lost from the value',
  worse.text === '−AED 1,284,905 · 1,449.2%', JSON.stringify(worse.text));

/* The other direction: an ordinary pill, in a table cell, must still refuse to
   wrap. That nowrap is why a status badge is one line wherever it appears, and
   the fix above is scoped to a tile precisely so it survives. */
console.log('\nbut a pill outside a tile keeps its one line');
const cell = await page.evaluate(async () => {
  const ui = await import('/ui.js');
  const host = document.createElement('div');
  host.style.width = '90px';
  host.innerHTML = ui.pill('+AED 228,060 · 114.5%', 'bad');
  document.body.append(host);
  await new Promise((r) => requestAnimationFrame(r));
  return getComputedStyle(host.querySelector('.pill')).whiteSpace;
});
check('it is still nowrap', cell === 'nowrap', cell);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
