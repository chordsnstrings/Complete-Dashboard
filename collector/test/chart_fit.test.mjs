/* Two layout rules that are about COUNTING, which a stylesheet cannot do.
   ═══════════════════════════════════════════════════════════════════════════
   Both defects were on the day page and both looked like carelessness rather
   than a bug, which is the kind that survives longest.

   ── eight tiles in a six-column grid ────────────────────────────────────
   `.kpis` was `repeat(auto-fit, minmax(172px, 1fr))`. Auto-fit packs as many
   as fit and stops, so on a 1,132px page it is six columns whatever the tile
   count — and the day page has eight, so it drew six and then two, with four
   cells of nothing beside them. The count is known in JavaScript and nowhere
   else, so kpiCols() decides it and the grid follows.

   ── five share bars starting in five places ─────────────────────────────
   The donut's key gained a bar per row, and each row was its own grid
   container, so the columns were sized per row: "FMS telematics" pushed its
   bar 55px further right than "Bolt" did. A column of bars that cannot be
   compared down its own length is the one thing a column of bars is for. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* ── the arithmetic, on its own ─────────────────────────────────────────── */
const cols = await page.evaluate(async () => {
  const ui = await import('/ui.js');
  return Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    .map((n) => [n, ui.kpiCols(n)]));
});
const orphans = (n) => (cols[n] - (n % cols[n])) % cols[n];
check('eight tiles are four and four, not six and two', cols[8] === 4, String(cols[8]));
check('…and no count between five and twelve leaves more than one empty cell',
  [5, 6, 7, 8, 9, 10, 11, 12].every((n) => orphans(n) <= 1),
  JSON.stringify(Object.fromEntries([5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, orphans(n)]))));
/* The floor matters as much as the raggedness: three columns of 370px tiles
   is not an improvement on a ragged row. */
check('…and never fewer than four columns once there are five tiles',
  [5, 6, 7, 8, 9, 10, 11, 12].every((n) => cols[n] >= 4 && cols[n] <= 6),
  JSON.stringify(cols));
check('a short row is simply itself', cols[1] === 1 && cols[3] === 3 && cols[4] === 4,
  JSON.stringify([cols[1], cols[3], cols[4]]));

/* ── and the grid actually lands on it ──────────────────────────────────── */
const laid = await page.evaluate(async () => {
  const ui = await import('/ui.js');
  const out = {};
  for (const n of [5, 7, 8]) {
    const host = document.createElement('div');
    host.style.width = '1100px';
    document.body.append(host);
    host.append(ui.kpiRow(Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: String(i) }))));
    const grid = host.querySelector('.kpis');
    /* Rows counted from geometry, because that is what the reader sees. */
    const tops = [...grid.children].map((c) => Math.round(c.getBoundingClientRect().top));
    out[n] = { tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      rows: new Set(tops).size, n: grid.children.length };
  }
  /* The innerHTML path — the one #insights uses, which kpiRow never sees. */
  const raw = document.createElement('div');
  raw.className = 'kpis';
  raw.style.width = '1100px';
  raw.innerHTML = ui.kpiTiles(Array.from({ length: 5 }, (_, i) => ({ label: `R${i}`, value: String(i) })));
  document.body.append(raw);
  const before = getComputedStyle(raw).gridTemplateColumns.split(' ').length;
  ui.fitKpis(document.body);
  return { ...out, raw: { before, after: getComputedStyle(raw).gridTemplateColumns.split(' ').length } };
});
check('eight tiles are laid out four wide, in two rows',
  laid[8].tracks === 4 && laid[8].rows === 2, JSON.stringify(laid[8]));
check('seven are four wide, so the tail is one cell rather than four',
  laid[7].tracks === 4 && laid[7].rows === 2, JSON.stringify(laid[7]));
check('five are five wide, in one row', laid[5].tracks === 5 && laid[5].rows === 1,
  JSON.stringify(laid[5]));
/* THE #insights CASE. A row built with innerHTML never passes through
   kpiRow, and it had five tiles in six columns until the sweep existed. */
check('a row built with innerHTML is corrected by the sweep',
  laid.raw.before === 6 && laid.raw.after === 5, JSON.stringify(laid.raw));

/* ── a bar's share of its step must not depend on the window width ─────── */
/* The cap was `Math.min(step * (1 - pad), 44)`, chosen when these charts were
   drawn in a fixed 720-unit viewBox where 44 units painted at about 66px after
   CSS stretched the picture. Once the viewBox became the host's measured width
   one unit is one CSS pixel, so 44 turned into a hard 44px ceiling while the
   gap between bars kept growing with the container. Measured on the day page,
   the same nine bars: 44.0px bar against a 72.2px gap at a 1440px viewport,
   41.9px against 16.3px at 900px. The same series read as a dense chart on a
   laptop and as thin stripes on a monitor. */
const bars = await page.evaluate(async () => {
  const c = await import('/charts.js');
  const shape = (n, w) => {
    const step = (w - 54) / n;
    const pad = n <= 12 ? 0.28 : n <= 40 ? 0.18 : 0.10;
    return { step, bw: c.barWidth(step, pad), fill: c.barWidth(step, pad) / step };
  };
  return {
    nine: [515, 1090, 1440].map((w) => shape(9, w)),
    day: [515, 1090].map((w) => shape(24, w)),
    two: shape(2, 1090),
    many: shape(90, 515),
  };
});
/* The invariant is that the shape holds across the widths a PANEL actually
   takes — 515px in a two-up grid, 1090px full width — not that it holds
   forever. A ceiling has to exist or a two-bar chart draws two slabs, and
   where the ceiling bites the fill necessarily falls. What must not happen is
   the fill falling at ordinary panel widths, which is what a 44px cap did. */
const fills = bars.nine.slice(0, 2).map((s) => s.fill);
check('nine bars fill the same share of their step at both panel widths',
  Math.abs(fills[0] - fills[1]) < 0.001, JSON.stringify(fills.map((f) => f.toFixed(3))));
check('…and where the ceiling does bite, it still leaves a bar over half its step',
  bars.nine[2].fill > 0.5, String(bars.nine[2].fill.toFixed(3)));
check('…and so do twenty-four', Math.abs(bars.day[0].fill - bars.day[1].fill) < 0.001,
  JSON.stringify(bars.day.map((s) => s.fill.toFixed(3))));
/* THE REGRESSION, named. At 1090px the old ceiling gave 44px against a 71px
   gap — 38% fill where the pad asked for 72%. */
check('…and a wide chart is no longer capped at the old 44 pixels',
  bars.nine[1].bw > 60, String(bars.nine[1].bw));
/* The ceiling still exists, and still catches the case it was written for. */
check('a two-bar chart is still stopped from drawing two slabs',
  bars.two.bw <= 96.001, String(bars.two.bw));
/* And pad still decides the density, which capping at a fraction of the step
   would have taken away — 0.62 is below every value 1 - pad takes, so it would
   have made a ninety-bar chart and a nine-bar chart the same shape. */
check('a dense chart is still denser than a sparse one',
  bars.many.fill > bars.nine[0].fill,
  JSON.stringify([bars.many.fill.toFixed(2), bars.nine[0].fill.toFixed(2)]));
check('…and no bar is thinner than its own corner radius',
  bars.many.bw >= 1.5, String(bars.many.bw));

/* ── and the panel grid has columns ─────────────────────────────────────── */
/* `grid` alone sets display and gap; the columns live on `.g2`/`.g3`/`.g23`.
   The day page and #corridors were the only two analytical views in the
   product that passed no modifier, so seven chart panels sat in one 1,132px
   track: a nine-bar chart drawn 1,090px wide, a 234px donut with 416px of
   empty panel either side, and a page 1,173px taller than it needed to be. */
{
  const src = await (await fetch(`http://127.0.0.1:${port}/day.js`)).text();
  const cor = await (await fetch(`http://127.0.0.1:${port}/corridors.js`)).text();
  check('the day page’s panel grid declares its columns',
    /el\('div', 'grid g\d/.test(src), (src.match(/el\('div', 'grid[^']*'/) || ['none'])[0]);
  check('…and so does the corridors page',
    /el\('div', 'grid g\d/.test(cor), (cor.match(/el\('div', 'grid[^']*'/) || ['none'])[0]);
  const css = await (await fetch(`http://127.0.0.1:${port}/app.css`)).text();
  /* And the class they name collapses on a narrow screen, or the fix trades a
     stretched chart for a horizontal scrollbar. */
  check('…and that class collapses to one column on a narrow screen',
    /@media\(max-width:1080px\)\{[^{]*\.g2[^{]*\{grid-template-columns:1fr\}/
      .test(css.replace(/\s+/g, '')),
    'app.css must fold .g2 below 1080px, or the fix trades a stretched chart for a scrollbar');
}

/* ── the donut key ──────────────────────────────────────────────────────── */
const key = await page.evaluate(async () => {
  const charts = await import('/charts.js');
  const host = document.createElement('div');
  host.style.width = '900px';
  document.body.append(host);
  charts.donut(host, [
    { label: 'FMS telematics', n: 611 }, { label: 'Uber', n: 487 },
    { label: 'Bolt', n: 21 }, { label: 'Hotel', n: 21 }, { label: 'Yango', n: 1 },
  ]);
  const ring = host.querySelector('svg.donut').getBoundingClientRect();
  const keys = host.querySelector('.dnut-keys').getBoundingClientRect();
  return {
    lefts: [...host.querySelectorAll('.dk-t')].map((e) => Math.round(e.getBoundingClientRect().left)),
    widths: [...host.querySelectorAll('.dk-f')].map((e) => +e.style.width.replace('%', '')),
    pcts: [...host.querySelectorAll('.dk-p')].map((e) => e.textContent.trim()),
    counts: [...host.querySelectorAll('.dk-n')].map((e) => e.textContent.trim()),
    labels: [...host.querySelectorAll('.dk-l')].map((e) => e.textContent.trim()),
    /* Beside, not under: the ring's right edge is left of the key's left edge
       and their vertical centres are within a few pixels. */
    beside: ring.right <= keys.left + 1
      && Math.abs((ring.top + ring.bottom) / 2 - (keys.top + keys.bottom) / 2) < 8,
    hostRight: Math.round(host.getBoundingClientRect().right),
    keyRight: Math.round(keys.right),
  };
});
check('every share bar starts at the same x', new Set(key.lefts).size === 1,
  JSON.stringify(key.lefts));
check('…and the key sits beside the ring rather than under it, given the room',
  key.beside, JSON.stringify(key));
check('…without leaving the panel', key.keyRight <= key.hostRight + 1,
  `${key.keyRight} vs ${key.hostRight}`);
/* The share is the number the chart had and never printed: it was reachable
   only by hovering an arc, which a touch screen cannot do. */
check('every row carries its share as well as its count',
  key.pcts.length === 5 && key.counts.length === 5 && key.pcts.every((p) => /%$/.test(p)),
  JSON.stringify(key.pcts));
check('…rounded so it reads, and never rounded to a zero it is not',
  key.pcts[0] === '54%' && key.pcts[2] === '1.8%' && key.pcts[4] === '0.1%',
  JSON.stringify(key.pcts));
check('…and the bar lengths are those shares, not the sorted rank',
  key.widths[0] > key.widths[1] && key.widths[1] > key.widths[2]
  && Math.abs(key.widths[0] - 53.6) < 1, JSON.stringify(key.widths));
/* A slice too small to see must still be visible AS a row. */
check('a one-in-a-thousand slice still draws a bar rather than nothing',
  key.widths[4] > 0, String(key.widths[4]));
check('the ring and its key name the same things in the same order',
  key.labels.join() === 'FMS telematics,Uber,Bolt,Hotel,Yango', key.labels.join());

check('nothing threw', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
