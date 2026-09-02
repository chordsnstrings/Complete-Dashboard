/* The #capacity headline, checked against the response it is drawn from.
   ─────────────────────────────────────────────────────────────────────────
   Three faults, all of them visible on production on 2026-09-02 and none of
   them reachable from an endpoint test, because the endpoint was right and the
   page was wrong:

     1. The figure SUBTRACTED DRIVERS FROM BOOKINGS. It summed
        `expected_per_occurrence - drivers_per_occurrence` — Tuesday 18:00
        contributed 38.7 bookings less 22.3 drivers — and printed the remainder
        as "301 DRIVER-SHIFTS SHORT". Bookings and drivers are not the same
        unit, so the number was neither; the real weekly gap, summing the
        per-cell `driver_gap` the same response already carries, is 763. It
        also summed over `shortfall`, which is the twenty largest gaps, under a
        claim counting all 166 short hours.

     2. The sub-line said "0 hours have people to spare, so some of this is a
        rota that can be moved rather than people who have to be hired" —
        drawing a conclusion about moving people from a count of zero, beside a
        panel reading "No hour is covered beyond its projection". Meanwhile the
        "most ever seen" column showed 149 of those 166 hours have carried at
        least as many drivers as the projection needs.

     3. The paragraph explaining WHY the week reads short keyed on
        `d.trailing_bookings`, a field /api/capacity has never sent (it is
        `observed_bookings`), so it never rendered and the coarser fallback
        beneath it did.

   The page is driven here against a hand-built /api/capacity body rather than
   a seeded database: the assertion is arithmetic on the join between response
   and screen, and a fixture that produced a 40%-lift forecast would be a test
   of forecastMonths instead.

     node test/capacity_headline.test.mjs */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Four hours, shaped so the two arithmetics cannot be confused for one
   another. Bookings-minus-drivers over the shortfall rows is (20−4)+(30−5) =
   41; the sum of the gaps over the same hours is 6+5 = 11. */
const cell = (dow, hour, { expected, have, rate, need, seen }) => ({
  dow, hour, observed_bookings: expected * 4, occurrences_observed: 12,
  bookings_per_occurrence: expected, share_pct: 1, expected_month: expected * 4,
  occurrences_next: 4, thin: false,
  expected_per_occurrence: expected,
  drivers_per_occurrence: have,
  bookings_per_driver: rate,
  most_drivers_seen: seen,
  drivers_needed: need,
  driver_gap: +(need - have).toFixed(1),
});
const SHORT_A = cell(1, 10, { expected: 20, have: 4, rate: 2, need: 10, seen: 6 });
const SHORT_B = cell(1, 9, { expected: 30, have: 5, rate: 3, need: 10, seen: 12 });
const LEVEL_A = cell(2, 9, { expected: 6, have: 6, rate: 1, need: 6, seen: 8 });
const LEVEL_B = cell(2, 10, { expected: 4, have: 4, rate: 1, need: 4, seen: 5 });
const SPARE = cell(3, 9, { expected: 4, have: 8, rate: 1, need: 4, seen: 9 });

const body = (cells, spare) => ({
  ok: true,
  target_month: '2026-10', target_is_next_month: true,
  platform: null, fleet: null,
  target_bookings: 4500, target_low: 3800, target_high: 5200,
  forecast_kind: 'forecast',
  /* 8,400 over 84 days is 3,000 a month against a 4,500 projection: a 50%
     lift, which is the shape production is in and the reason every hour reads
     short. Named `observed_bookings`, as the endpoint names it. */
  window_days: 84, observed_bookings: 8400,
  cells,
  shortfall: cells.filter((c) => c.driver_gap >= 0.5).sort((a, b) => b.driver_gap - a.driver_gap),
  surplus: spare,
  totals: {
    cells_short: cells.filter((c) => c.driver_gap >= 0.5).length,
    cells_spare: spare.length,
    cells_thin: 0,
    drivers_needed_peak: Math.max(...cells.map((c) => c.drivers_needed)).toFixed(1),
    /* drivers_needed is drivers_now × (projected ÷ measured), so when this is
       above 1 in every cell no cell CAN read spare and "0 hours have people to
       spare" is arithmetic rather than a finding. Reported by the endpoint so
       the page can tell the two apart. */
    min_need_ratio: +Math.min(...cells.filter((c) => c.drivers_per_occurrence > 0)
      .map((c) => c.drivers_needed / c.drivers_per_occurrence)).toFixed(3),
  },
  caveat: 'A driver’s throughput in an hour is a MEASUREMENT, not a capacity.',
});

const NO_SPARE = body([SHORT_A, SHORT_B, LEVEL_A, LEVEL_B], []);
const WITH_SPARE = body([SHORT_A, SHORT_B, LEVEL_A, SPARE], [SPARE]);

/* A fourth body for the two tiles, shaped so the busiest hour and the
   hungriest hour are DIFFERENT hours — which is the whole fault. Thursday
   19:00 takes 40 bookings each time it comes round, more than any other hour
   here; Tuesday 18:00 takes 12, but its drivers manage half a booking each, so
   it needs 24 people against Thursday's 20. Production printed the Tuesday
   under the words "Busiest single hour". Every cell also needs more people
   than turn up (smallest ratio 1.11), so no cell can read spare. */
const BUSY = cell(4, 19, { expected: 40, have: 18, rate: 2, need: 20, seen: 25 });
const HUNGRY = cell(2, 18, { expected: 12, have: 6, rate: 0.5, need: 24, seen: 8 });
const MILD = cell(3, 9, { expected: 10, have: 8, rate: 1, need: 10, seen: 9 });
const PEAK = body([BUSY, HUNGRY, MILD], []);

/* The view, mounted on its own. The shell is not part of what is being
   checked and dragging it in would need every other endpoint stubbed too. */
const HARNESS = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/app.css"><div id="root"></div>
<script type="module">
  import { renderCapacity } from '/capacity.js';
  renderCapacity(document.getElementById('root'))
    .then(() => { document.title = 'rendered'; })
    .catch((e) => { document.title = 'threw: ' + e.message; });
</script>`;

let answer = NO_SPARE;
const shell = express();
shell.get('/api/capacity', (_req, res) => res.json(answer));
shell.get('/api/platforms', (_req, res) => res.json([]));
shell.get('/harness.html', (_req, res) => res.type('html').send(HARNESS));
shell.use(express.static('api/public'));
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
/* A CONTEXT per scenario, not a reload. swr.js keeps every response in
   localStorage under the whole URL and serves it on the next ask, so the
   second scenario reloaded into the first scenario's body and quietly tested
   nothing — the same stale-read this cache exists to make invisible. */
const read = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.title === 'rendered'
    || document.title.startsWith('threw'), null, { timeout: 20000 }).catch(() => {});
  const out = await page.evaluate(() => {
    const t = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      title: document.title,
      claim: t(document.querySelector('.vdct-claim')),
      figure: t(document.querySelector('.vdct-fig b')),
      unit: t(document.querySelector('.vdct-fig i')),
      sub: t(document.querySelector('.vdct-sub')),
      notes: [...document.querySelectorAll('.note')].map(t),
      kpis: [...document.querySelectorAll('.kpi')].map((k) => ({
        label: t(k.querySelector('.l')), value: t(k.querySelector('.n')), sub: t(k.querySelector('.s')) })),
      empties: [...document.querySelectorAll('.empty')].map(t),
    };
  });
  await ctx.close();
  return out;
};

/* ── 1. the headline is drivers minus drivers ───────────────────────────── */
answer = NO_SPARE;
const a = await read();
check('the view rendered', a.title === 'rendered', a.title);

const shortCells = NO_SPARE.cells.filter((c) => c.driver_gap >= 0.5);
const gapSum = shortCells.reduce((s, c) => s + c.driver_gap, 0);          // 11
const mixedUnits = NO_SPARE.shortfall.reduce(
  (s, c) => s + (c.expected_per_occurrence - c.drivers_per_occurrence), 0); // 41

check('the claim counts the short hours', a.claim.startsWith(`${shortCells.length} hours`), a.claim);
check('the figure is the sum of the per-hour driver gaps',
  Number(a.figure) === Math.ceil(gapSum), `${a.figure} vs ${gapSum}`);
check('…and is NOT bookings-expected minus drivers-present',
  Number(a.figure) !== Math.ceil(mixedUnits), `${a.figure} vs the mixed-unit ${mixedUnits}`);
/* Driver-hours: each cell is one hour of one weekday and its gap is drivers
   per occurrence, so the sum over the week's cells is what a week of the
   projected month is short by. "driver-shifts" named a period nothing here
   measures. */
check('…in a unit both operands are in, over the period it was summed across',
  /driver-hours/i.test(a.unit) && !/booking/i.test(a.unit), a.unit);

/* ── 2. the spare-hours sentence says what it measured ──────────────────── */
check('with no spare hour the sub does not claim any',
  !/\b0 hours have people to spare/.test(a.sub), a.sub);
check('…it says the shortfall is against average turnout',
  /average turnout/i.test(a.sub), a.sub);
/* SHORT_B has seen 12 drivers against the 10 it needs; SHORT_A has seen 6
   against 10. One of the two, named, because the column is already on screen. */
check('…and reports how many short hours have already carried the drivers they need',
  /\b1 of the 2 short hours has already carried/.test(a.sub), a.sub);
check('…and does not conclude that the rota can be moved',
  !/rota that can be moved/.test(a.sub), a.sub);

/* ── 3. the trailing-rate paragraph renders at all ──────────────────────── */
const lift = a.notes.find((n) => /projection is/.test(n)) || '';
check('the page names how far the projection sits above the measured rate',
  /50% above/.test(lift), lift.slice(0, 140) || '(no such note)');
check('…with the monthly rate it was measured against',
  /3,000 bookings a month/.test(lift), lift.slice(0, 160));

/* ── 4. and when there IS spare cover, it still says so ─────────────────── */
answer = WITH_SPARE;
const b = await read();
check('with one spare hour the sub names it',
  /1 hour has people to spare/.test(b.sub), b.sub);
check('…and the figure is still the gap sum over the short hours',
  Number(b.figure) === Math.ceil(WITH_SPARE.cells.filter((c) => c.driver_gap >= 0.5)
    .reduce((s, c) => s + c.driver_gap, 0)), `${b.figure}`);

/* ── 5. the tile labelled "busiest" names the busiest hour ──────────────── */
/* Production on 2026-09-02 printed "Busiest single hour — Tuesday 18:00, 33.7
   drivers needed". Tue 18:00 was 12th of 168 by bookings per occurrence
   (25.83) behind Thu 19:00 (29.0), Thu 18:00 (28.5) and Fri 19:00 (28.5): the
   tile sorted on drivers_needed and called the winner busy. Busy and
   understaffed are different questions and the page has a panel for the
   second one. */
answer = PEAK;
const c = await read();
const kpi = (label) => c.kpis.find((k) => k.label.toLowerCase().startsWith(label.toLowerCase())) || {};
check('the peak scenario rendered', c.title === 'rendered', c.title);
const busiest = kpi('Busiest single hour');
check('the busiest tile names the hour with the most bookings',
  /Thursday 19:00/.test(busiest.value), `${busiest.value} — Thu 19:00 takes 40 a time, Tue 18:00 takes 12`);
check('…not the hour that merely needs the most people',
  !/Tuesday 18:00/.test(busiest.value), busiest.value);
check('…and says how much work it is, in the unit the word "busiest" is about',
  /\b40(\.0)? bookings/.test(busiest.sub), busiest.sub);

/* ── 6. a zero that cannot be anything else says so ─────────────────────── */
/* drivers_needed is drivers_now × (projected ÷ measured). Every cell here
   needs at least 1.11× the people it gets, so no cell can be negative and the
   spare tile is pinned at zero by arithmetic. Production sat at a smallest
   ratio of 1.057 across all 168 cells, printing "Hours with people to spare 0
   — covered beyond what the projection needs" beside a panel telling the
   reader to move people out of hours that cannot exist. */
const spareTile = kpi('Hours with people to spare');
check('the spare tile is zero in this scenario', spareTile.value === '0', spareTile.value);
check('…and its sub says the zero is arithmetic, not a finding',
  /no hour can/i.test(spareTile.sub), spareTile.sub);
check('…naming the smallest ratio that makes it impossible',
  /1\.11/.test(spareTile.sub), spareTile.sub);
check('…and the spare panel stops telling the reader to move people who cannot exist',
  c.empties.some((e) => /no hour can/i.test(e)), JSON.stringify(c.empties));

/* When spare cover IS reachable, the ordinary wording comes back. */
const spareTileB = b.kpis.find((k) => k.label.startsWith('Hours with people to spare')) || {};
check('with a reachable spare hour the tile keeps its plain sub',
  !/no hour can/i.test(spareTileB.sub || ''), spareTileB.sub);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
