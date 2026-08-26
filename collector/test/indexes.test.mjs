/* ── the filter this whole product is built on ─────────────────────────────
   Every window in the dashboard is a range of Asia/Dubai dates, and the
   queries say so directly:

     WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1 AND $2

   That is a function of the COLUMN. A plain index on the timestamp cannot
   answer it: Postgres reads every row and computes the expression to find out
   which ones match. So the predicate needs an index on the same expression —
   and for four of the five tables it is used against, there wasn't one. Fifty
   thousand alerts and forty thousand telemetry rows were read to answer "what
   happened in the last thirty days", on a database sharing a single vCPU with
   a backfill, which is the difference between a page and a gateway timeout.

   This is a static check because the failure is silent: the query returns the
   right answer, slowly, and slowness only becomes an outage under load that a
   test suite cannot reproduce. Grep is the right tool — it cannot be fooled by
   a small fixture where a scan is fast. */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const sql = readdirSync('sql').filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(`sql/${f}`, 'utf8')).join('\n');

/* The tables the Dubai-day predicate is applied to, and the column each one
   uses. Kept explicit rather than parsed out of the API: the parse has to
   guess which FROM a predicate belongs to, and a guess that drifts silently
   is worse than a list somebody has to update. Adding a table here without
   its index fails this test, which is the point. */
const DUBAI_DAY = [
  ['trip', 'requested_at'],
  ['alert', 'occurred_at'],
  ['telemetry_snapshot', 'captured_at'],
  /* The same table's OTHER clock. captured_at is when the tracker saw the
     vehicle; polled_at is when we asked. /api/coverage groups by the second
     because a dormant tracker's last fix is not evidence about what we
     collected — see sql/schema_v36.sql. */
  ['telemetry_snapshot', 'polled_at'],
  ['occupancy_segment', 'started_at'],
  ['ledger_entry', 'event_at'],
];

console.log('\nevery Dubai-day filter has an index that can serve it');

for (const [table, col] of DUBAI_DAY) {
  /* The index expression must match the predicate EXACTLY — an index on a
     different expression over the same column is no index at all. */
  const wanted = new RegExp(
    `CREATE INDEX[^;]*ON ${table} \\(\\(\\(${col} AT TIME ZONE 'Asia/Dubai'\\)::date\\)\\)`, 'i');
  check(`${table}.${col}`, wanted.test(sql),
    'no index on ((… AT TIME ZONE \'Asia/Dubai\')::date) — this filter scans the table');
}

/* And the reverse: a table filtered this way in the API but missing from the
   list above would never be checked. This catches the list going stale. */
const api = readdirSync('api').filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(`api/${f}`, 'utf8')).join('\n');
/* The alias is optional and must be matched as a UNIT: written `\w*\.?(\w+)`
   the greedy prefix eats all but the last character of an unqualified column,
   so `captured_at` was read as the column `t` — a check that reports a column
   nobody wrote is a check nobody will believe. */
const used = new Set([...api.matchAll(/\(\s*(?:\w+\.)?(\w+)\s+AT TIME ZONE 'Asia\/Dubai'\)::date/g)]
  .map((m) => m[1]));
const known = new Set(DUBAI_DAY.map(([, c]) => c));
/* Columns that belong to views (which cannot be indexed) or to derived CTEs
   are not tables and have no index of their own; they are named here so the
   check below stays about real base tables. */
const DERIVED = new Set(['local_day', 'day']);
const unlisted = [...used].filter((c) => !known.has(c) && !DERIVED.has(c));
check('no column is filtered this way without being on the list',
  unlisted.length === 0, `${unlisted.join(', ')} — add it above with its table, or its filter scans`);

console.log('\nthe live-fleet count can use an index for its sort');

/* Two different questions are asked of telemetry_snapshot, one per timestamp,
   and each needs its own index:

     captured_at — when the TRACKER saw the vehicle. /api/kpis takes the newest
       fix per plate to count what is reporting.
     polled_at   — when WE asked. /api/live takes the newest row per plate so it
       can report the two ages separately, because "our collector is down" and
       "this tracker stopped" are different states.

   Both sorts must be servable. This check exists because the first version of
   it pinned only the polled_at index, and when /api/kpis was moved onto the
   fix — a dormant tracker satisfies a poll-age test forever — the guard fired
   and said so, which is the whole point of writing it against the SOURCE. */
check('telemetry_snapshot is indexed on (plate, polled_at DESC)',
  /CREATE INDEX[^;]*ON telemetry_snapshot \(plate, polled_at DESC\)/i.test(sql));
check('and on (plate, captured_at DESC)',
  /CREATE INDEX[^;]*ON telemetry_snapshot \(plate, captured_at DESC\)/i.test(sql));

const kpiSrc = readFileSync('api/server.js', 'utf8');
const kpi = kpiSrc.slice(kpiSrc.indexOf("app.get('/api/kpis'"));
const live = kpi.slice(0, kpi.indexOf('\napp.'));
/* Whichever column it sorts by, an index has to cover it. */
const sortCol = (live.match(/DISTINCT ON \(plate\)[\s\S]*?ORDER BY plate, (\w+) DESC/) || [])[1];
check('the live-vehicle count sorts on a column an index covers',
  !/DISTINCT ON \(plate\)/.test(live)
  || (sortCol && new RegExp(`ON telemetry_snapshot \\(plate, ${sortCol} DESC\\)`, 'i').test(sql)),
  `sorts on ${sortCol || '(unparsed)'} — no matching index`);
/* And it must measure the FIX, not the poll: the provider lists dormant
   trackers on every cycle, so a poll-age test counts a vehicle silent since
   April 2024 as live for ever. */
check('and it measures the fix age, not the poll age',
  /now\(\) - captured_at < \$\{FIX_FRESH\}/.test(live) && !/polled_at < interval/.test(live),
  'liveness measured on when we asked rather than when the tracker answered');

/* The threshold has to clear the cadence the trackers actually report at.
   Set from the poll interval instead — eleven minutes, two missed cycles — it
   counted 13 of 130 vehicles as live while 58 had fixes inside a quarter of an
   hour: the fleet answers eleven to fifteen minutes behind, so a tight bound
   calls working vehicles dead. Anything under twenty is arguing from the poll
   again. */
const fresh = Number((kpiSrc.match(/const FIX_FRESH = "interval '(\d+) minutes'"/) || [])[1]);
check('the freshness bound clears the observed reporting lag',
  fresh >= 20 && fresh <= 120, `${fresh} minutes`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
