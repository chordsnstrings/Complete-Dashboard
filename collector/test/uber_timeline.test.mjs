/* ── online and waiting, or just offline? ──────────────────────────────────
   "How the day was spent" reports 97.7 h on job against 426.9 h waiting over
   28 days — 81% of the working span in one band that cannot tell a driver
   sitting at a rank with the app on from one who logged out and went home. The
   first is supply the fleet is paying for and failing to sell. Same colour,
   opposite meaning, and the biggest thing on the page.

   The fixture is a REAL response from supplier.uber.com/chronicle/graphql for
   an Egari driver, captured 2026-08-27 — not a hand-written shape that agrees
   with the parser by construction. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
import { toRows, windows, MAX_WINDOW_DAYS } from '../src/sources/uber_timeline.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const events = JSON.parse(readFileSync('test/fixtures/uber_timeline.json', 'utf8'))
  .data.GetTimelineInfo.timelineInfo;
const o = { fleet: 'egari', orgUuid: 'b2004b53-8175-4706-ab0a-c8b60e586c7c' };
const DRV = '0a6eb545-aa3b-4441-882c-34204df3d451';
const rows = toRows(o, DRV, events);

check('the fixture is a real answer with both statuses in it',
  events.length === 17 && new Set(events.map((e) => e.status)).size === 2,
  `${events.length} events`);

/* ── one event becomes a status row and its job's sub-states ─────────────── */
const kinds = rows.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {});
check('every event yields a status row', kinds.status === events.length, JSON.stringify(kinds));
/* The part nobody asked for and the panel needs most: the same footnote that
   says "the ride cannot be separated from the approach on any booking channel"
   is answered by DJ_PICKUP. */
const states = rows.filter((r) => r.kind === 'job')
  .reduce((a, r) => ((a[r.state] = (a[r.state] || 0) + 1), a), {});
check('and a job carries the boundary between approach and ride',
  states.DJ_ASSIGNED === 4 && states.DJ_PICKUP === 4 && states.DJ_COMPLETED === 4,
  JSON.stringify(states));
check('every row is attributed to the fleet and driver asked about',
  rows.every((r) => r.fleet_id === 'egari' && r.driver_ext_id === DRV && r.platform === 'uber'));
check('a job row carries the trip id, so it joins to the booking',
  rows.filter((r) => r.kind === 'job').every((r) => r.job_ext_id));

/* ── the key has to survive a re-run ─────────────────────────────────────── */
/* The API repeats a job's sub-states on every event that carries the job, so
   one response can name the same (driver, instant, state) twice — and a single
   INSERT cannot touch one key twice ("ON CONFLICT DO UPDATE command cannot
   affect row a second time"). */
const keys = rows.map((r) => `${r.driver_ext_id}|${r.at}|${r.kind}|${r.status}|${r.state}`);
check('one response never carries the same key twice',
  new Set(keys).size === keys.length, `${keys.length - new Set(keys).size} duplicates`);
check('the absent discriminator is empty string, not null — a NULL never '
  + 'collides with itself, so a nullable key re-inserts on every run',
  rows.every((r) => r.status !== null && r.state !== null));

const db = new PGlite();
await applySchema(db);
const cols = Object.keys(rows[0]);
const insert = async () => {
  for (const r of rows) {
    await db.query(
      `INSERT INTO driver_timeline_event (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
       ON CONFLICT (platform, driver_ext_id, at, kind, status, state) DO NOTHING`,
      cols.map((c) => (c === 'raw' ? JSON.stringify(r[c]) : r[c])));
  }
};
await insert();
const count = async () => (await db.query('SELECT count(*)::int c FROM driver_timeline_event')).rows[0].c;
const first = await count();
check('the rows land in the real schema', first === rows.length, `${first} of ${rows.length}`);
await insert();
check('and a second collection of the same window changes nothing',
  (await count()) === first, `${await count()} after re-run, was ${first}`);

/* ── the question the panel asks ─────────────────────────────────────────── */
const { rows: spans } = await db.query(`
  WITH s AS (
    SELECT at, status, lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
      FROM driver_timeline_event WHERE kind = 'status' AND status <> '')
  SELECT status, round(sum(extract(epoch FROM (next_at - at)))/3600.0, 2)::float AS hours
    FROM s WHERE next_at IS NOT NULL GROUP BY status`);
const by = Object.fromEntries(spans.map((r) => [r.status, r.hours]));
check('online time is derivable as spans between the transitions',
  by.ONLINE > 10 && by.ONLINE < 24, JSON.stringify(by));
/* A dangling ONLINE at the end of the window has no closing event, and must
   not be counted as running to now — that is how a driver who logged off last
   Tuesday shows as 200 hours online. */
check('and an unclosed final span is left out rather than run to now',
  Object.values(by).every((h) => h < 24), JSON.stringify(by));

/* ── windows respect the provider's own limit ────────────────────────────── */
/* Measured, not assumed: 31 days is refused with "Time Range Exceeds 31 days
   maximum", so a backfill has to be cut before it. */
check('the window size stays under the 31-day server limit', MAX_WINDOW_DAYS <= 30,
  String(MAX_WINDOW_DAYS));
const w = windows(new Date('2026-01-01'), new Date('2026-04-01'));
// 1 Jan → 1 Apr is 90 days, which at 30 a window is exactly three.
check('a long backfill is cut into windows the server will accept',
  w.length === 3 && w.every(([s, e]) => (e - s) <= MAX_WINDOW_DAYS * 864e5),
  `${w.length} windows`);
check('and they tile the range without a gap or an overlap',
  w[0][0].toISOString().startsWith('2026-01-01')
  && +w.at(-1)[1] === +new Date('2026-04-01')
  && w.every(([s], i) => i === 0 || +s === +w[i - 1][1]),
  w.map(([s, e]) => `${s.toISOString().slice(0, 10)}..${e.toISOString().slice(0, 10)}`).join(' '));
const same = windows(new Date('2026-01-01'), new Date('2026-01-01'));
check('an empty range asks for nothing rather than one empty window',
  same.length === 0, String(same.length));

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
