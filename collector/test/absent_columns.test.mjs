/* ── three hundred and sixty em-dashes under a heading that says "Rating" ──
   Measured on the live fleet: `rating` is null for all 360 people in the
   drivers directory. Nothing in the collector writes it — Uber's roster
   endpoint returns onboarding status and a vehicle, its earnings breakdown
   returns trips, distance and money, and no other channel this fleet is
   connected to reports a score at all. The column was rendered anyway, so it
   took a real column's width and showed a dash in every one of 360 rows.

   A dash is ambiguous in the worst possible way. It could mean this driver has
   no rating, or the fleet has none, or the collector is broken, or the page
   is. A reader cannot tell which, and a column that is empty in EVERY row
   cannot tell them: there is nothing to compare against.

   So a column may declare `absent` — the sentence to print if it turns out to
   be empty everywhere. The column is dropped, its width goes to the columns
   that carry numbers, and the sentence appears under the table.

   The rule that keeps this honest is that it is OPT-IN. Dropping any column
   that happened to be empty would hide a collection failure the day a source
   stops reporting; a column with no `absent` keeps its dashes, because the
   caller has not said what an absence there would mean.

   Run in a real browser rather than against a DOM shim: tableFrom builds
   elements, sets innerHTML and re-binds handlers on every paint, and a
   hand-rolled stub of document would be testing the stub. Chromium is already
   how this repo checks rendering. No server data is involved — the rows below
   are the test's own, which is what a unit test is. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* Everything below runs IN the page, against the real module. */
const run = (fn, arg) => page.evaluate(async ({ src, a }) => {
  const ui = await import('/ui.js');
  // eslint-disable-next-line no-new-func
  return new Function('ui', 'a', `return (${src})(ui, a);`)(ui, a);
}, { src: fn.toString(), a: arg });

const COLS = [
  { label: 'Driver', key: 'name' },
  { label: 'Trips', key: 'trips', num: true },
  { label: 'Rating', key: 'rating', num: true, absent: 'no channel reports a driver rating' },
  { label: 'Fares', key: 'fares', num: true },
];
/* The column definitions cross into the page as JSON, so `render` functions
   cannot come with them. A column that needs one carries it as `renderSrc` —
   the same source-string trick `run` above uses — and it is rebuilt on the
   other side. The sparse-column count depends on what a column RENDERS, so a
   test of that count cannot avoid sending one. */
const build = (ui, a) => {
  const cols = a.cols.map((c) => (c.renderSrc
    // eslint-disable-next-line no-new-func
    ? { ...c, render: new Function(`return (${c.renderSrc});`)() }
    : c));
  const t = ui.tableFrom(a.rows, cols);
  const html = t.innerHTML;
  const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
  return {
    html,
    /* Read off the HEADER ROW, not off the raw HTML. The absence note itself
       contains `<b>Rating</b>`, so a regex over innerHTML reports the column
       as present precisely because it was dropped and explained. */
    hasRating: heads.includes('Rating'),
    heads,
    bodyRows: t.querySelectorAll('tbody tr').length,
    note: (t.querySelector('.tabsent') || {}).textContent || '',
  };
};
const rows = (rating) => [
  { name: 'A', trips: 10, rating, fares: 100 },
  { name: 'B', trips: 8, rating, fares: null },
  { name: 'C', trips: 6, rating, fares: 40 },
];

console.log('\nabsent columns: empty everywhere means gone, with a reason');

const dead = await run(build, { rows: rows(null), cols: COLS });
check('a column empty in every row is not rendered', !dead.hasRating, dead.heads.join(','));
check('and the reason is printed under the table instead',
  /no channel reports a driver rating/.test(dead.note), dead.note);
check('the reason names the column, so a reader knows which one went',
  /Rating/.test(dead.note), dead.note);
check('the columns that DO carry numbers are all still there',
  ['Driver', 'Trips', 'Fares'].every((h) => dead.heads.includes(h)), dead.heads.join(','));
check('and every row still renders', dead.bodyRows === 3, String(dead.bodyRows));

console.log('\nabsent columns: one value anywhere keeps the column');

const alive = await run(build, { cols: COLS,
  rows: [{ name: 'A', trips: 1, rating: 4.9, fares: 1 }, { name: 'B', trips: 1, rating: null, fares: 1 }] });
check('a single non-empty value keeps the whole column', alive.hasRating);
check('and the absence note does not appear', !alive.note);
check('the row that IS empty still shows a dash, which now means "this one"',
  /—/.test(alive.html));

console.log('\nabsent columns: what counts as empty');

for (const [what, v] of [['null', null], ['an empty string', ''],
  ['an em-dash', '—'], ['an empty array', []]]) {
  const t = await run(build, { rows: rows(v), cols: COLS });
  check(`${what} counts as empty`, !t.hasRating, t.heads.join(','));
}
const zero = await run(build, { rows: rows(0), cols: COLS });
check('but ZERO does not — a rating of zero is a rating, and a count of zero is a finding',
  zero.hasRating, zero.heads.join(','));

console.log('\nabsent columns: mostly-empty says so too');

/* Between "every row" and "most rows" there is no difference to the reader:
   330 dashes out of 361 looks exactly as broken as 361 would. But the column
   has to stay, because the rows that DO carry a value are the finding. */
const mostly = await run(build, { cols: COLS,
  rows: [...Array(19)].map((_, i) => ({ name: `d${i}`, trips: 1, rating: null, fares: 1 }))
    .concat([{ name: 'x', trips: 1, rating: 4.9, fares: 1 }]) });
check('a column filled in 1 of 20 rows is KEPT — the one row is the finding',
  mostly.hasRating, mostly.heads.join(','));
check('and the table says how many carry a value',
  /1 of 20 rows carry one/.test(mostly.note), mostly.note);
check('followed by the same reason the empty case would have given',
  /no channel reports a driver rating/.test(mostly.note), mostly.note);

/* ── and it counts what the reader SEES, not what the row carries ─────── */
/* A money column renders 0 as a dash, and `0` is a value — so on production
   this sentence said "72 of 361 rows carry one" above a table showing 31:
   forty-one drivers have a fare total of exactly zero. The note and the column
   it describes disagreed about the column. */
const DASHED = [{ label: 'Driver', key: 'name' }, { label: 'Trips', key: 'trips', num: true },
  { label: 'Fares', key: 'fares', num: true, absent: 'no channel here reports a fare',
    renderSrc: '(r) => (r.fares ? `AED ${r.fares}` : "\u2014")' }];
const zeroes = await run(build, { cols: DASHED,
  rows: [...Array(17)].map((_, i) => ({ name: `d${i}`, trips: 1, fares: 0 }))
    .concat([...Array(3)].map((_, i) => ({ name: `p${i}`, trips: 1, fares: 40 }))) });
check('a zero that renders as a dash is not counted as carrying a value',
  /3 of 20 rows carry one/.test(zeroes.note), zeroes.note);
/* The other half of the same claim: a zero that a column actually PRINTS is a
   value, and must still be counted. A count of zero trips is a finding. */
const printed = [{ label: 'Driver', key: 'name' }, { label: 'Trips', key: 'trips', num: true },
  { label: 'Alerts', key: 'alerts', num: true, absent: 'no alert reached this fleet',
    renderSrc: '(r) => String(r.alerts)' }];
const printedZero = await run(build, { cols: printed,
  rows: [...Array(20)].map((_, i) => ({ name: `d${i}`, trips: 1, alerts: 0 })) });
check('a zero the column prints IS counted, so no sparse note fires',
  !/rows carry one/.test(printedZero.note), printedZero.note);

const half = await run(build, { cols: COLS,
  rows: [...Array(20)].map((_, i) => ({ name: `d${i}`, trips: 1, rating: i % 2 ? 4.9 : null, fares: 1 })) });
check('a column filled in half its rows says nothing — gaps are ordinary there',
  !half.note, half.note);

const tiny = await run(build, { cols: COLS,
  rows: [{ name: 'a', trips: 1, rating: 4.9, fares: 1 }, { name: 'b', trips: 1, rating: null, fares: 1 },
    { name: 'c', trips: 1, rating: null, fares: 1 }, { name: 'd', trips: 1, rating: null, fares: 1 },
    { name: 'e', trips: 1, rating: null, fares: 1 }] });
check('and a five-row table says nothing either — one of five is not a pattern',
  !tiny.note, tiny.note);

console.log('\nabsent columns: it is opt-in, deliberately');

const noReason = await run(build, { rows: rows(null),
  cols: [{ label: 'Driver', key: 'name' }, { label: 'Rating', key: 'rating', num: true }] });
check('a column with no `absent` keeps its dashes — silently dropping it would '
  + 'hide the day a source stops reporting', noReason.hasRating, noReason.heads.join(','));

console.log('\nabsent columns: sorting still works around a dropped column');

const sorted = await run((ui, a) => {
  const t = ui.tableFrom(a.rows, a.cols, { sortable: true, sortId: 'absent-test',
    defaultSort: { key: 'trips', dir: 'asc' } });
  return { first: t.querySelector('tbody tr td').textContent.trim(),
    hasRating: [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim()).includes('Rating') };
}, { rows: rows(null), cols: COLS });
check('a default sort on a surviving column is applied', sorted.first === 'C', sorted.first);
check('and the dropped column is still dropped', !sorted.hasRating);

console.log('\nabsent columns: the live directory declares one');

const { readFileSync } = await import('node:fs');
const drv = readFileSync('api/public/driver.js', 'utf8');
check('the drivers directory says why a rating is missing rather than showing '
  + '360 dashes', /label: 'Rating'[\s\S]{0,300}absent:/.test(drv));
check('and the reason names what was actually checked, not just "no data"',
  /roster returns onboarding status/.test(drv));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
