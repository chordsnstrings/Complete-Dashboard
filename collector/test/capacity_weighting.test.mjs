/* The rota arithmetic in /api/capacity, cell by cell.
   ──────────────────────────────────────────────────────────────────────────
   Two faults, both measured on production at 13:15 UTC on 2026-09-02
   (https://fleet-dashboard-wpeqb.ondigitalocean.app/api/capacity, target month
   2026-10, 15,500 bookings projected, 168 cells):

     1. THE REDISTRIBUTION NEVER HAPPENED. capacity_routes.js computed
        dowCount[] — how many times each weekday falls in the target month —
        and then never used it: `weightOf = (c) => (c.bookings / totalBookings)
        * 1`. So each cell kept its share of an 84-day window, in which every
        weekday occurs exactly 12 times, and that fixed share was then divided
        by the TARGET month's occurrence count. October 2026 has 4 Sun–Wed and
        5 Thu–Sat, so an hour on a 4-occurrence weekday was handed 5/4 of the
        per-occurrence demand of an identical hour on a 5-occurrence one.

        Production, hour 18:00, measured bookings per occurrence against the
        expected-per-occurrence it produced:

            Sun 17.67 → 26.3   (×1.49)     Thu 28.50 → 33.9   (×1.19)
            Mon 23.25 → 34.6   (×1.49)     Fri 27.25 → 32.4   (×1.19)
            Tue 25.83 → 38.4   (×1.49)     Sat 22.33 → 26.6   (×1.19)
            Wed 26.36 → 35.9   (×1.36)

        Across all 168 cells the multiplier ran from 1.0997 to 1.4986 — a 36%
        swing driven by nothing but which weekday a cell sits on. The visible
        cost: every one of the ten largest gaps on "Add people here" was a
        Monday, Tuesday or Wednesday, while Thu 19:00 and Fri 19:00 — the two
        busiest hours the fleet actually has, at 29.0 and 28.5 bookings per
        occurrence — were pushed down the list.

     2. "EACH DOING" WAS AN AVERAGE OF RATIOS. bookings_per_driver was
        avg(bookings/drivers) while the two columns printed either side of it
        are means of their own numerator and denominator, so the row did not
        reconcile with itself. Production Sun 03:00: 7.67 bookings, 5.75
        drivers, "each doing" 1.4 — and 5.75 × 1.4 = 8.05, not 7.67. 26 of the
        168 rows were out by more than 2%. drivers_needed divides by this
        figure, so it is not cosmetic.

   Driven against a seeded database rather than a hand-built body, because both
   faults are in the SQL and the JavaScript that consumes it.

     node test/capacity_weighting.test.mjs */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { capacityRoutes } from '../api/capacity_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* ── the fixture ────────────────────────────────────────────────────────────
   April 1st to September 30th 2026, every day, so six whole months feed the
   forecast and the trailing 84-day window (2026-07-09 → 2026-09-30) holds
   exactly twelve occurrences of every weekday. Nothing about a day's WEEKDAY
   changes what is on it, which is the entire point: any difference the
   endpoint then reports between two weekdays is manufactured by the endpoint.

     09:00 — two bookings, two drivers, on every single day. Identical across
             all seven weekdays, so expected_per_occurrence must come out
             identical too.
     18:00 — alternating by week: one booking by one driver, then nine
             bookings by three drivers. Each cell therefore sees six of each,
             which makes avg(bookings/drivers) = 2.00 while
             sum(bookings)/sum(drivers) = 60/24 = 2.50. The row's own
             bookings_per_occurrence (5.00) over drivers_per_occurrence (2.00)
             is 2.50, so only one of the two definitions reconciles with the
             columns beside it. */
const iso = (d) => d.toISOString().slice(0, 10);   // String(aDate) is "Thu Aug 07 2026"
const FROM = Date.UTC(2026, 3, 1);                 // 2026-04-01
const TO = Date.UTC(2026, 8, 30);                  // 2026-09-30
const WINDOW_START = Date.UTC(2026, 6, 9);         // 2026-07-09, first day in the 84
const DAY = 86400000;

const rows = [];
let n = 0;
const trip = (day, hour, driver) => {
  rows.push(['bolt', `t${n++}`, 'ecosine', 'L1', `drv-${driver}`, `Driver ${driver}`,
    `${day}T${String(hour).padStart(2, '0')}:30:00+04:00`]);
};
for (let t = FROM; t <= TO; t += DAY) {
  const day = iso(new Date(t));
  // 09:00 — flat, every day, two drivers taking one booking each.
  trip(day, 9, 'a'); trip(day, 9, 'b');
  // 18:00 — alternating weeks, anchored on the first day of the trailing
  // window so the split inside it is exactly six and six per cell.
  const week = Math.floor((t - WINDOW_START) / (7 * DAY));
  if (week % 2 === 0) trip(day, 18, 'a');
  else for (const drv of ['a', 'b', 'c']) for (let i = 0; i < 3; i++) trip(day, 18, drv);
}
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, distance_km, status, price)
           VALUES ${chunk.map((_, j) => `($${j * 7 + 1},$${j * 7 + 2},$${j * 7 + 3},$${j * 7 + 4},`
             + `$${j * 7 + 5},$${j * 7 + 6},$${j * 7 + 7},9,'completed',30)`).join(',')}`,
    chunk.flat());
}

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
capacityRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const d = await (await fetch(`http://127.0.0.1:${port}/api/capacity`)).json();

check('the endpoint answers', d.ok === true, JSON.stringify(d.reason || d.error || '').slice(0, 200));
check('…about October 2026, which has 4 Sun–Wed and 5 Thu–Sat',
  d.target_month === '2026-10', String(d.target_month));

const at = (dow, hour) => d.cells.find((c) => c.dow === dow && c.hour === hour);
const nine = [0, 1, 2, 3, 4, 5, 6].map((dow) => at(dow, 9));
check('every weekday has an 09:00 cell', nine.every(Boolean), JSON.stringify(nine.map((c) => !!c)));
check('…each seen twelve times in the trailing window',
  nine.every((c) => c && c.occurrences_observed === 12), JSON.stringify(nine.map((c) => c?.occurrences_observed)));
check('…each carrying the same measured bookings per occurrence',
  new Set(nine.map((c) => c?.bookings_per_occurrence)).size === 1,
  JSON.stringify(nine.map((c) => c?.bookings_per_occurrence)));
check('…on the two occurrence counts the month actually has',
  JSON.stringify(nine.map((c) => c?.occurrences_next)) === JSON.stringify([4, 4, 4, 4, 5, 5, 5]),
  JSON.stringify(nine.map((c) => c?.occurrences_next)));

/* ── 1. identical hours, redistributed onto the target month ─────────────── */
/* Seven hours that were identical in the window must stay identical per
   occurrence next month. Under the unfinished multiplication they do not: the
   four-occurrence weekdays come out 5/4 of the five-occurrence ones. */
const epo = nine.map((c) => c?.expected_per_occurrence);
const spread = Math.max(...epo) / Math.min(...epo);
check('identical hours get identical demand per occurrence, whatever weekday they fall on',
  spread <= 1.01, `Sun–Sat ${JSON.stringify(epo)} — a ${((spread - 1) * 100).toFixed(1)}% spread`);
check('…and it is not the 4-vs-5 occurrence ratio leaking through',
  Math.abs(spread - 1.25) > 0.01, `spread ${spread.toFixed(4)} is 5/4`);

/* The redistribution has to MOVE demand between weekdays, not invent it: a
   five-Friday month gives each Friday hour a smaller slice than a four-Monday
   month gives each Monday hour, and the month still adds up. */
const monthSum = d.cells.reduce((a, c) => a + c.expected_month, 0);
check('the month total is conserved by the reweighting',
  Math.abs(monthSum - d.target_bookings) <= d.cells.length / 2,
  `${monthSum} vs ${d.target_bookings}`);
check('…and so is the whole month reached by multiplying each cell back out',
  Math.abs(nine.reduce((a, c) => a + c.expected_per_occurrence * c.occurrences_next, 0)
    - nine.reduce((a, c) => a + c.expected_month, 0)) <= 7,
  'per-occurrence × occurrences ≠ expected_month');
/* An 09:00 cell on a five-Thursday weekday must carry MORE of the month in
   total than the identical Monday one, precisely because it comes round more
   often — the sanity check the old arithmetic inverted. */
check('a weekday that occurs five times carries more of the month than one that occurs four',
  at(4, 9).expected_month > at(1, 9).expected_month,
  `Thu ${at(4, 9).expected_month} vs Mon ${at(1, 9).expected_month}`);

/* ── 2. every row reconciles with the columns printed beside it ──────────── */
/* "Each doing" sits between "Drivers now" and the expected demand on the page,
   and drivers_needed is the projection divided by it. An average of ratios is
   not the ratio of the averages, and the fixture makes the two 2.00 and 2.50. */
const six = at(6, 18);
check('the 18:00 cells are the mixed-turnout ones the fixture built',
  six && six.bookings_per_occurrence === 5 && six.drivers_per_occurrence === 2,
  JSON.stringify({ b: six?.bookings_per_occurrence, d: six?.drivers_per_occurrence }));
check('"each doing" is total bookings over total drivers, not the mean of the per-occurrence ratios',
  six && Math.abs(six.bookings_per_driver - 2.5) < 0.011,
  `${six?.bookings_per_driver} — the mean of the ratios is 2.00, the pooled rate is 2.50`);
const off = d.cells.filter((c) => c.bookings_per_driver && c.drivers_per_occurrence
  && Math.abs(c.drivers_per_occurrence * c.bookings_per_driver - c.bookings_per_occurrence)
     > 0.02 * c.bookings_per_occurrence);
check('…so every row multiplies back out to the bookings printed beside it',
  off.length === 0, `${off.length} of ${d.cells.length} rows do not reconcile, e.g. `
    + JSON.stringify(off.slice(0, 2).map((c) => [c.dow, c.hour, c.bookings_per_occurrence,
      c.drivers_per_occurrence, c.bookings_per_driver])));

/* ── 3. the page can tell whether "spare" was reachable at all ───────────── */
/* drivers_needed is drivers_now × (projected demand ÷ measured demand), so
   when the projection sits above the measured rate in every cell, no cell can
   come out negative and "Hours with people to spare: 0" is arithmetic rather
   than a finding. Production on 2026-09-02 had a smallest ratio of 1.057 —
   above one in all 168 cells — beside a panel telling the reader to move
   people from hours that cannot exist. The endpoint now reports the ratio so
   the page can say which of the two it is. */
const ratios = d.cells.filter((c) => c.drivers_needed != null && c.drivers_per_occurrence > 0)
  .map((c) => c.drivers_needed / c.drivers_per_occurrence);
check('the response reports the smallest needed-to-present ratio',
  d.totals.min_need_ratio != null && Math.abs(d.totals.min_need_ratio - Math.min(...ratios)) < 0.005,
  `${d.totals.min_need_ratio} vs ${Math.min(...ratios).toFixed(4)}`);

/* ── 4. and the identity the two corrections together produce ───────────── */
/* Once "each doing" is Σbookings ÷ Σdrivers and the share is a share of the
   target month, drivers_needed = drivers_now × (target ÷ Σweights) in every
   cell — the demand divides straight back out, because each hour is sized
   against what its own drivers delivered against the very demand the
   projection rescales. Production's 2026-09-02 body re-derived through the
   fixed code gives 1.3231–1.3458 over all 168 cells, the spread being
   2-decimal rounding of bookings_per_driver alone.

   Pinned because the page's heatmap caption now says exactly this, and a
   future change that reintroduces per-hour variation into drivers_needed must
   come back here and rewrite that caption rather than silently contradict it. */
const spreadOfRatio = Math.max(...ratios) / Math.min(...ratios);
check('drivers_needed is drivers-now times one constant, in every cell',
  spreadOfRatio < 1.02, `ratios span ${Math.min(...ratios).toFixed(4)}–${Math.max(...ratios).toFixed(4)}`);
check('…which is the same constant min_need_ratio reports',
  Math.abs(d.totals.min_need_ratio - Math.min(...ratios)) < 0.005, String(d.totals.min_need_ratio));

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await db.close();
process.exit(fail ? 1 : 0);
