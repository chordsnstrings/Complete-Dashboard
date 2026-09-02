/* detectBreaks(), on the clock the fleet actually works.
   ─────────────────────────────────────────────────────────────────────────
   Two faults, both measured on production 2026-09-02.

   1. THE FOUR-HOUR LEAK. src/sources/events.js bucketed trips with
      `date_trunc('month', requested_at)`, and requested_at is TIMESTAMPTZ read
      in a session Postgres runs in UTC. Dubai is UTC+4 with no daylight
      saving, so every month boundary leaked its first four hours backwards: a
      booking taken at 01:00 Dubai on the 1st is 21:00 UTC on the last day of
      the month before.

      MEASURED over the real Uber year on disk (/tmp/yearpull, 160,915 trips
      2025-09..2026-08): 4.95% of all trips fall in Dubai hours 00:00-03:59 —
      the busiest hour of that block, 00:00, carries 3,434 trips, more than
      04:00, 05:00 and 06:00 combined — and 495 of them sit on the 1st of a
      month, where the old statement filed them under the wrong month. Month by
      month the two bucketings disagree by up to 209 trips (December 2025:
      19,020 trips in Dubai, 19,229 in UTC, 1.1%).

      On that particular year the misfiling moved the printed size of a break
      without flipping a verdict (Feb→Mar 2026 reads -75.8% either way). It
      moves value_from / value_to, which /api/breaks prints as the fleet's
      monthly trip counts, and there is no year in which it is right.

   2. THE BREAK AGAINST A MONTH THAT HAS NOT FINISHED. detectBreaks compared
      every month in the series against its predecessor, including the month
      still running. MEASURED, https://fleet-dashboard-wpeqb.ondigitalocean.app
      /api/breaks on 2026-09-02 — the four most recent rows it serves, one per
      platform, all with period_to 2026-09-01 and detected_at 2026-09-01:

        uber   2026-08-01 -> 2026-09-01   12427 ->  1011   -91.9%  demand
        fms    2026-08-01 -> 2026-09-01   11214 ->   889   -92.1%  unattributable
        hotel  2026-08-01 -> 2026-09-01     920 ->    54   -94.1%  mixed
        yango  2026-08-01 -> 2026-09-01      29 ->     7   -75.9%  mixed

      September is one and a half days old. Not one of those four is a break;
      all four are the calendar. And they do not heal: the row is only rewritten
      while the pair still qualifies, so when September finishes and Aug→Sep
      turns out to be an ordinary month-over-month move, breakBetween returns
      null, nothing is upserted, and the -91.9% stays on #causes for ever. That
      is why the fix both stops writing them and deletes the ones already there.

   Everything below is anchored to the CURRENT Dubai month, so it exercises the
   same rule whenever it is run rather than on one lucky date. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* The collector writes through pool.query only (upsert() builds one INSERT …
   ON CONFLICT and sends it there), so pointing that at the throwaway database
   is enough. rowCount is restored because detectBreaks logs on it. */
pool.query = async (t, p) => {
  const r = await db.query(t, p);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
};
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* Months relative to the current DUBAI month. M(0) is the month still running.
   Built from Date.UTC on integers, never from String(date) or a local clock. */
const DUBAI = 4 * 3600e3;
const nowD = new Date(Date.now() + DUBAI);
const M = (back) => new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 1))
  .toISOString().slice(0, 7);
const [M0, M1, M2] = [M(0), M(1), M(2)];
console.log(`\nDubai months: running=${M0}  last complete=${M1}  before that=${M2}`);

let n = 0;
const trips = [];
const seed = (platform, month, day, hhmm, count, driver = 'd1') => {
  for (let i = 0; i < count; i++) {
    trips.push([platform, `t${++n}`, driver,
      `${month}-${String(day).padStart(2, '0')}T${hhmm}:00+04:00`]);
  }
};

/* ── platform 'tzleak': the leak alone decides whether a break exists ─────
   In Dubai months this is 100 → 125, a +25% move and no break at all. In UTC
   months the sixty 01:00-on-the-1st bookings fall into the month before, which
   makes it 160 → 65 — a -59% "collapse" that never happened. */
seed('tzleak', M2, 10, '12:00', 100);
seed('tzleak', M1, 1, '01:00', 60);          // 21:00 UTC on the last of M2
seed('tzleak', M1, 10, '12:00', 65);

/* ── platform 'tzreal': a real break, whose SIZE the leak still corrupts ── */
seed('tzreal', M2, 10, '12:00', 200);
seed('tzreal', M1, 1, '02:30', 10);          // 22:30 UTC on the last of M2
seed('tzreal', M1, 10, '12:00', 40);

/* ── platform 'tzopen': the month still running ──────────────────────────
   05:00 Dubai on the 1st is 01:00 UTC, so this sits inside M0 under either
   bucketing: what is being tested is the completeness rule, not the grain. */
seed('tzopen', M1, 10, '12:00', 200);
seed('tzopen', M0, 1, '05:00', 5);

for (let i = 0; i < trips.length; i += 200) {
  const batch = trips.slice(i, i + 200);
  const vals = batch.map((_, k) => `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4},'completed')`);
  await q(`INSERT INTO trip (platform, external_id, driver_ext_id, requested_at, status)
           VALUES ${vals.join(',')}`, batch.flat());
}
console.log(`seeded ${trips.length} trips across three platforms`);

/* An event inside the SECOND half of the later month. The candidate lookup
   asked for events overlapping [first of month A, first of month B], so
   anything that happened after the 1st of the month the break landed in — the
   month whose numbers moved — could not be a candidate for it. */
await q(`INSERT INTO world_event (source, code, title, category, scope, starts_on, ends_on,
           expected_effect, confidence, summary)
         VALUES ('manual','testquake','Something happened mid-month','local','dubai',$1,$2,
                 'demand_down',0.9,'seeded by test/break_month_grain.test.mjs')`,
  [`${M1}-20`, `${M1}-22`]);

/* ── pre-existing stale row: a break written against a partial month ─────
   Exactly the shape production serves today, and the shape recomputation can
   never overwrite, because a pair that stops qualifying is simply not written
   again. */
await q(`INSERT INTO metric_break (metric, grain, platform, period_from, period_to,
           value_from, value_to, change_pct, attribution)
         VALUES ('trips','month','tzstale',$1,$2,900,40,-0.9555,'demand')`,
  [`${M1}-01`, `${M0}-01`]);

const { detectBreaks } = await import('../src/sources/events.js');
const written = await detectBreaks();
const breaks = await q(`SELECT platform, period_from::text pf, period_to::text pt,
                               value_from, value_to, change_pct, candidate_events
                        FROM metric_break ORDER BY platform, period_from`);
console.log(`\ndetectBreaks() wrote ${written}; metric_break now holds:`);
for (const b of breaks) {
  console.log(`  ${b.platform.padEnd(8)} ${b.pf} -> ${b.pt}  ${b.value_from} -> ${b.value_to}`
    + `  ${(b.change_pct * 100).toFixed(1)}%`);
}

console.log('\nmonths are Dubai months');

const leak = breaks.filter((b) => b.platform === 'tzleak');
check('a +25% Dubai month is not a -59% collapse because four hours moved',
  leak.length === 0,
  leak.map((b) => `${b.pf}->${b.pt} ${b.value_from}->${b.value_to} `
    + `${(b.change_pct * 100).toFixed(1)}%`).join(', ') || 'none');

const real = breaks.filter((b) => b.platform === 'tzreal');
check('a real break is still reported', real.length === 1, String(real.length));
check('and its two values are the Dubai month counts, not the UTC ones',
  real[0] && real[0].value_from === 200 && real[0].value_to === 50,
  real[0] ? `${real[0].value_from} -> ${real[0].value_to} (UTC bucketing gives 210 -> 40)` : 'no break');

console.log('\nboth months compared are months that finished');

const open = breaks.filter((b) => b.platform === 'tzopen');
check('the month still running is not compared against the one before it',
  open.length === 0,
  open.map((b) => `${b.pf}->${b.pt} ${(b.change_pct * 100).toFixed(1)}%`).join(', ') || 'none');
check('nothing at all is written for a period ending in the running month',
  breaks.every((b) => b.pt < `${M0}-01`),
  breaks.filter((b) => b.pt >= `${M0}-01`).map((b) => `${b.platform} ${b.pf}->${b.pt}`).join(', '));
check('and a stale one already stored against a partial month is cleared',
  !breaks.some((b) => b.platform === 'tzstale'),
  'the four rows /api/breaks serves today can never be overwritten, only deleted');

console.log('\nthe candidate window covers both months, not the first day of the second');

const ev = real[0] ? (typeof real[0].candidate_events === 'string'
  ? JSON.parse(real[0].candidate_events) : real[0].candidate_events) || [] : [];
check('an event in the second half of the later month is a candidate for it',
  ev.some((e) => e.title === 'Something happened mid-month'),
  JSON.stringify(ev.map((e) => e.title)));

console.log('\nthe statement itself, not just its result');

const src = readFileSync('src/sources/events.js', 'utf8');
check("the monthly series converts before it truncates",
  /date_trunc\('month',\s*requested_at AT TIME ZONE 'Asia\/Dubai'\)/.test(src),
  'test/timezone.test.mjs names this line');
check('no bare date_trunc on a timestamp is left in the file',
  !/date_trunc\(\s*'(?:day|week|month)'\s*,\s*requested_at\s*\)/.test(src));
check('the calendar year the seasonal events are generated for is a Dubai year',
  !/new Date\(\)\.getUTCFullYear\(\)/.test(src),
  'at 21:00 UTC on 31 December it is already next year in Dubai');

/* ── src/util.js: which chunkers are anchored where ──────────────────────
   Stated, and pinned, because moving one of these moves a STORED PRIMARY KEY.
   weekChunks decides period_start/period_end on driver_performance and
   driver_earnings_component; a week that starts on a different day is a
   different row, and the same money is then held twice. */
console.log('\nthe chunkers: Dubai-anchored where the boundary is a business day');

const { weekChunks, dubaiDayChunks, dateChunks, iso, dubaiIso, dubaiMonth } =
  await import('../src/util.js');
const D = (s) => new Date(s);

check('dubaiDayChunks starts its day at 20:00Z, which is midnight in Dubai',
  [...dubaiDayChunks(D('2026-08-19T09:00:00Z'), D('2026-08-19T10:00:00Z'))][0]
    .start.toISOString() === '2026-08-18T20:00:00.000Z');
check('…and stamps the Dubai date the window covers',
  [...dubaiDayChunks(D('2026-08-19T09:00:00Z'), D('2026-08-19T10:00:00Z'))][0].day === '2026-08-19');

/* PINNED, not endorsed. weekChunks is UTC-anchored: its Monday starts at
   00:00Z, which is 04:00 in Dubai, so Monday's small hours are asked for and
   stored under the week before. The seam is real — the daily grid beside it in
   src/sources/uber.js IS Dubai-anchored — but iso(w.start) is the stored key,
   and a Dubai-anchored Monday instant is 20:00Z on the SUNDAY, whose iso() is
   the day before. Moving the anchor without moving the stamp renames every
   week ever stored. This asserts what today depends on. */
const wk = [...weekChunks(D('2026-08-19T09:00:00Z'), D('2026-08-19T10:00:00Z'))][0];
check('weekChunks is UTC-anchored, and the key it stores is the Monday date',
  wk.start.toISOString() === '2026-08-17T00:00:00.000Z' && iso(wk.start) === '2026-08-17',
  `${wk.start.toISOString()} / ${iso(wk.start)}`);
check('dateChunks is run-anchored: it keeps the time of day it was given',
  [...dateChunks(D('2026-08-19T09:00:00Z'), D('2026-09-02T09:00:00Z'), 7)][0][0]
    .toISOString() === '2026-08-19T09:00:00.000Z');

check('iso() is the UTC date — safe on a midnight-UTC instant, not on a clock',
  iso(D('2026-08-05T21:05:00Z')) === '2026-08-05',
  'a 01:00 Dubai booking on the 6th; iso() says the 5th');
check('dubaiIso() is the Dubai date of the same instant',
  dubaiIso(D('2026-08-05T21:05:00Z')) === '2026-08-06',
  dubaiIso(D('2026-08-05T21:05:00Z')));
check('dubaiMonth() is the Dubai month of the same instant',
  dubaiMonth(D('2026-08-31T21:05:00Z')) === '2026-09',
  dubaiMonth(D('2026-08-31T21:05:00Z')));
check('…and neither reads the process clock to do it',
  dubaiIso(D('2025-12-31T20:00:00Z')) === '2026-01-01'
  && dubaiMonth(D('2025-12-31T20:00:00Z')) === '2026-01');

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
