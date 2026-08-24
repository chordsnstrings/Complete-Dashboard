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

/* /api/kpis takes the newest reading per vehicle with DISTINCT ON (plate)
   ORDER BY plate, polled_at DESC. telemetry_snapshot was indexed on
   (plate, captured_at DESC) — the time the TRACKER recorded the fix, not the
   time we asked — so the sort could not be served and the headline figure on
   every page sorted the whole table. */
check('telemetry_snapshot is indexed on (plate, polled_at DESC)',
  /CREATE INDEX[^;]*ON telemetry_snapshot \(plate, polled_at DESC\)/i.test(sql));
const kpiSrc = readFileSync('api/server.js', 'utf8');
const kpi = kpiSrc.slice(kpiSrc.indexOf("app.get('/api/kpis'"));
const live = kpi.slice(0, kpi.indexOf('\napp.'));
check('and that is still the column the query orders by',
  !/DISTINCT ON \(plate\)/.test(live) || /ORDER BY plate, polled_at DESC/.test(live),
  'the query changed its sort column — the index no longer matches it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
