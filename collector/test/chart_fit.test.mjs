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
