/* Two dates uber_fleet.js writes, one measured wrong on production and one
   measured right for a reason worth pinning down.
   ──────────────────────────────────────────────────────────────────────────
   1. THE RUN WINDOW. Production /api/status on 2026-09-02 answered

        uber_fleet catchup ecosine | win 2026-08-02 -> 2026-09-01
                                   | finished 2026-09-01T21:06:54.462Z
        uber_fleet catchup egari   | win 2026-08-02 -> 2026-09-01
                                   | finished 2026-09-01T21:06:56.838Z

      21:06:54Z is 02 Sep 01:06 in Dubai. `to` is the `new Date()` made seconds
      earlier by src/run.js:293 (`catchUp = (d) => runWindow('catchup',
      daysAgo(d), new Date(), …)`), so the run covered up to 2 Sep in Dubai and
      the row said 1 Sep — a day short at BOTH ends, on every scheduled
      catch-up, because src/index.js:98 fires it at 21:00 UTC = 01:00 Dubai.
      iso() is the UTC day of an instant; dubaiIso() is the day the fleet was
      in when it happened.

   2. THE PROBE TIME. provider_probe.probed_at is TIMESTAMPTZ, node-postgres
      parses it to a Date, and uber_fleet.js interpolates it into an
      operator-facing failure reason. Latent, not live — the guard needs an
      empty run against a non-empty probe on Ecosine — but when it fires it
      writes 55 characters of JS toString into collection_run.error.

   3. THE FAILED-WINDOW DATES, which look like the same bug and are not. They
      are compared against this run's own finished_at, in the browser, on the
      UTC clock. Section 3 below states that comparison and what moving one
      side of it to Dubai costs, so nobody "finishes the job" and hides a hole.

   Run: node test/uber_fleet_window_tz.test.mjs */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';
import { iso, dubaiIso } from '../src/util.js';

const db = new PGlite();
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
const { logRun } = await import('../src/db.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const SRC = readFileSync(new URL('../src/sources/uber_fleet.js', import.meta.url), 'utf8');

/* The production catch-up, to the millisecond, and the `from` src/util.js:81
   would have built for it (daysAgo offsets `new Date()`, so it is a clock too
   and carries the same 21:06 time of day). */
const TO = new Date('2026-09-01T21:06:54.462Z');
const FROM = new Date(TO); FROM.setUTCDate(FROM.getUTCDate() - 30);

console.log('\n1. the run window is the days the fleet lived, not the days UTC did');

check('the instant this is all about really is the next day in Dubai',
  iso(TO) === '2026-09-01' && dubaiIso(TO) === '2026-09-02',
  `iso ${iso(TO)} / dubaiIso ${dubaiIso(TO)}`);
check('…and the far end of the window shifts too, so it was short at both ends',
  iso(FROM) === '2026-08-02' && dubaiIso(FROM) === '2026-08-03',
  `iso ${iso(FROM)} / dubaiIso ${dubaiIso(FROM)}`);

/* Through the real logRun into the real DATE columns, because the point is
   what the row HOLDS, not what the expression returned. Read back with
   to_char: reading a DATE into JS is the other half of this bug class and a
   test must not depend on it. */
const windowOf = async (window_start, window_end) => {
  const id = await logRun({ source: 'uber_fleet', fleet_id: 'ecosine', mode: 'catchup',
    window_start, window_end, status: 'partial', rows_written: 392 });
  const { rows: [r] } = await db.query(
    `SELECT to_char(window_start, 'YYYY-MM-DD') AS s, to_char(window_end, 'YYYY-MM-DD') AS e
       FROM collection_run WHERE id = $1`, [id]);
  return `${r.s} -> ${r.e}`;
};

const before = await windowOf(iso(new Date(FROM)), iso(new Date(TO)));
const after = await windowOf(dubaiIso(FROM), dubaiIso(TO));
console.log(`     before: ${before}   (production’s row, verbatim)`);
console.log(`     after:  ${after}`);
check('before: the shipped expression stores the window production printed',
  before === '2026-08-02 -> 2026-09-01', before);
check('after: dubaiIso stores the days the run actually covered',
  after === '2026-08-03 -> 2026-09-02', after);
check('and the collector now writes the second of those',
  /window_start: dubaiIso\(from\), window_end: dubaiIso\(to\)/.test(SRC),
  'window_start/window_end must not go through iso() — `to` is a clock, not a midnight anchor');

console.log('\n2. the probe time is a string before it leaves Postgres');

await db.query(
  `INSERT INTO provider_probe (provider, surface, ok, record_count, probed_at)
   VALUES ('uber', 'earner-payments', true, 412, '2026-09-02 12:00:01.603+00')`);

/* The query the file actually ships, lifted out of it rather than retyped, so
   a revert of the SELECT fails this test instead of quietly passing it. */
const sql = (() => {
  const at = SRC.indexOf('FROM provider_probe');
  const open = SRC.lastIndexOf('`', at);
  const close = SRC.indexOf('`', at);
  if (at < 0 || open < 0 || close < 0) throw new Error('could not find the provider_probe query in src/sources/uber_fleet.js');
  return SRC.slice(open + 1, close);
})();

/* Two spellings because the fix changed the sentence as well as the query: the
   zone is now named, which an operator-facing time in a UTC container and a
   Dubai fleet has to be. `was` is the text that shipped, so the 204-character
   measurement below is of the real thing and not of this test's wording. */
const was = (probe) => `earner payments returned no earners in any of 4 week(s), but the `
  + `probe of the same surface saw ${probe.record_count} at ${probe.probed_at}. `
  + 'The request, not the window, is wrong.';
const sentence = (probe) => `earner payments returned no earners in any of 4 week(s), but the `
  + `probe of the same surface saw ${probe.record_count} at ${probe.probed_at} Dubai. `
  + 'The request, not the window, is wrong.';
const WEEKDAY = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;

// The control: what the bare column did, on this same real table.
const { rows: [bare] } = await db.query(
  `SELECT record_count, probed_at FROM provider_probe
    WHERE provider = 'uber' AND surface = 'earner-payments' AND ok`);
const wasMsg = was(bare);
console.log(`     before: ${wasMsg.slice(60, 165)}`);
check('before: a bare TIMESTAMPTZ comes back as a Date',
  bare.probed_at instanceof Date, typeof bare.probed_at);
check('…and the operator’s failure reason named a weekday, not a time',
  WEEKDAY.test(wasMsg) && /Coordinated Universal Time/.test(wasMsg), wasMsg.slice(90, 160));
check('…and it was short enough to survive the 300-char slice whole',
  wasMsg.length === 204 && wasMsg.length < 300, String(wasMsg.length));

const { rows: [probe] } = await db.query(sql);
const nowMsg = sentence(probe);
console.log(`     after:  ${nowMsg.slice(60, 165)}`);
check('after: the shipped query hands JS a string, so no String() can undo it',
  typeof probe.probed_at === 'string', typeof probe.probed_at);
check('…on Dubai’s clock — 12:00 UTC is 16:00 in Dubai, not 12:00',
  probe.probed_at === '2026-09-02 16:00', String(probe.probed_at));
check('…and the sentence now names a time an operator can act on',
  !WEEKDAY.test(nowMsg) && /at 2026-09-02 16:00 Dubai\./.test(nowMsg), nowMsg.slice(60, 160));
check('the record_count guard the invariants test pins is untouched',
  /record_count > 0/.test(SRC) && /provider_probe/.test(SRC));

console.log('\n3. the failed-window dates stay on the run’s own UTC clock, on purpose');

/* api/public/app.js:4098 and :4370, verbatim:
     dayKey(h.to) > dayKey(h.finished_at)   → "not yet due", dropped from the debt
   with dayKey = String(v ?? '').slice(0, 10) — the UTC day of an ISO instant.
   Measured by replaying production's 42 /api/status rows through the real
   collectionDebt(): moving the chunk `to` to the Dubai day lifted `invented`
   from 8 to 10, cut the debt from 1478 owed days to 1416, and removed both
   uber_fleet rows from "Windows that did not land" — hiding 62 days of a dead
   Uber web session behind a label that means "nothing to do here". */
const dayKey = (v) => String(v ?? '').slice(0, 10);
const notYetDue = (to) => dayKey(to) > dayKey(TO.toISOString());
check('a UTC-clocked chunk end does not outrun its own run',
  notYetDue(iso(new Date(TO))) === false, 'this is the hole staying visible');
check('…while a Dubai-clocked one would, and the hole would vanish',
  notYetDue(dubaiIso(TO)) === true,
  'if this ever goes false, api/public/app.js changed and the chunk dates can move to Dubai');
check('so the chunk dates are still iso() and the comment says why',
  /failed\.push\(\{ from: iso\(new Date\(from\)\), to: iso\(new Date\(to\)\)/.test(SRC)
  && /NOT an oversight/.test(SRC));

console.log('\n4. the week grid under the earnings rows did not move');

/* period_start/period_end are part of driver_earnings_component's primary key
   and schema_v26 prunes on period_end - period_start > 6. weekChunks hands
   pullEarningsWeek Date.UTC anchors, which is the one argument iso() is built
   for, so this pair must NOT have been swept up in the fix. */
check('the component keys are still stamped with iso()',
  /const ps = iso\(new Date\(from\)\), pe = iso\(new Date\(to\)\);/.test(SRC));
{
  const monday = new Date(Date.UTC(2026, 7, 17));
  check('…and for a UTC-midnight anchor the two helpers agree anyway',
    iso(monday) === '2026-08-17' && dubaiIso(monday) === '2026-08-17',
    `${iso(monday)} / ${dubaiIso(monday)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
