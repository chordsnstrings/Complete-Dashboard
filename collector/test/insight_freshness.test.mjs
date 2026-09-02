/* A to-do list that never crosses anything off.
   ─────────────────────────────────────────────────────────────────────────
   src/insights.js prunes the insight table to one row per (code, entity) and
   keeps the newest — so a finding that was true once and has not been true
   since survives forever, and /api/insights served it as a live to-do.

   Measured on production: 163 of the 200 rows on the action list were last
   recomputed before Aug 30, some as far back as Aug 21. Seventy-four
   idle_vehicle findings the rule had already stopped emitting sat beside the
   one it still did. And because the titles are written in relative time,
   "L37810: Vehicle Registration Form expires in 1 days" — computed on the
   25th — was still on the list on the 1st, six days after the document it
   describes expired.

   A rule's most recent write is the moment it last evaluated; anything it did
   not re-emit then, it no longer finds. The assertions below are on that
   inference and on the two things it must NOT do:

     it must not drop findings from a rule that has not re-run at all, and
     the summary tiles must be counted over the same set as the list, or the
       page says 200 above a list of 37. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const put = (code, entity, at, sev = 'critical', cat = 'utilisation') => q(
  `INSERT INTO insight (code, severity, category, entity_type, entity_id, title, detail, action,
     impact_aed, metric, fleet_id, computed_at)
   VALUES ($1, $4, $5, 'vehicle', $2, $2 || ' — ' || $1, 'detail', 'action', NULL, 1, 'ecosine', $3)`,
  [code, entity, at, sev, cat]);

const NOW = '2026-09-01T11:00:00Z';
const OLD = '2026-08-21T09:00:00Z';

/* idle_vehicle: the rule ran a minute ago and emitted ONE vehicle. The three
   it emitted eleven days ago and has not emitted since are resolved. */
await put('idle_vehicle', 'L-STILL', NOW);
await put('idle_vehicle', 'L-GONE-1', OLD);
await put('idle_vehicle', 'L-GONE-2', OLD);
await put('idle_vehicle', 'L-GONE-3', OLD);
/* Written seconds apart inside the same pass — a run is not instantaneous and
   the rows it writes must all count as current. */
await put('idle_vehicle', 'L-STILL-2', '2026-09-01T11:00:41Z');

/* stale_tracker: this rule has NOT re-run. Its newest row IS its last
   evaluation, so nothing about it has been cleared and both rows stand. */
await put('stale_tracker', 'L-OLD-A', OLD, 'warning', 'reliability');
await put('stale_tracker', 'L-OLD-B', '2026-08-21T09:00:12Z', 'warning', 'reliability');

/* vehicle_doc_expiring: the rule RAN this morning and found nothing. The rows
   alone cannot say that — they look exactly like a rule that never re-ran —
   which is why insight_run exists. On production 35 of these were frozen at
   Aug 25 while other rules wrote that same morning, under titles written in
   relative time: "expires in 1 days", six days after the document lapsed. */
await put('vehicle_doc_expiring', 'L-DOC-1', OLD, 'warning', 'compliance');
await put('vehicle_doc_expiring', 'L-DOC-2', OLD, 'warning', 'compliance');
await q(`INSERT INTO insight_run (code, ran_at) VALUES ('vehicle_doc_expiring', $1)`, [NOW]);

const { get, server } = await mountAll(db, { serverRoutes: true });
const body = async (p) => (await get(p)).body;

console.log('\nthe action list shows what the rules still find');

const d = await body('/api/insights');
const ids = (d.insights || []).map((r) => r.entity_id).sort();
check('the vehicle the rule still emits is on the list', ids.includes('L-STILL'), ids.join(','));
check('…and so is the one written seconds later in the same pass',
  ids.includes('L-STILL-2'), ids.join(','));
/* The whole point: eleven-day-old findings the rule has stopped emitting. */
check('the three it no longer emits are gone',
  !ids.some((x) => x.startsWith('L-GONE')), ids.join(','));
/* Three idle_vehicle rows the rule stopped emitting, plus the two
   vehicle_doc_expiring rows its rule cleared by running and finding none. */
check('…and the response says how many it cleared', d.cleared === 5, String(d.cleared));

/* The other direction, and the reason this is an inference rather than a
   cutoff: a rule that has not re-run has not cleared anything, however old its
   rows are. Dropping them would silently delete real findings whenever a rule
   started failing. */
check('a rule that has NOT re-run keeps every finding it wrote',
  ids.includes('L-OLD-A') && ids.includes('L-OLD-B'), ids.join(','));

/* The case the rows cannot express, and the reason for insight_run: the rule
   ran, cleanly, and found nothing. Without the marker these two are
   indistinguishable from L-OLD-A above and stay on the list forever. */
check('a rule that ran and found NOTHING clears its whole previous set',
  !ids.some((x) => x.startsWith('L-DOC')), ids.join(','));

/* One row per (code, entity) reaches the reader — the dedup the prune relies
   on has to survive the freshness join. */
check('no finding is listed twice',
  ids.length === new Set(ids).size, ids.join(','));
check('the internal freshness columns do not leak into the payload',
  (d.insights || []).every((r) => !('still_found' in r) && !('cleared' in r)),
  JSON.stringify(Object.keys(d.insights[0] || {})));

console.log('\nand the tiles above it are counted over the same set');

const sum = await body('/api/insights/summary');
const total = sum.total?.n ?? sum.total ?? null;
check('the summary counts what the list shows, not what the table holds',
  Number(total) === (d.insights || []).length,
  `summary ${total} vs list ${(d.insights || []).length}`);
/* Two different suppressions, and the tile merged them: a duplicate is a copy
   of a finding that is still true; a resolved finding is one the rule has
   stopped emitting. This fixture holds no duplicates at all, so calling its
   five cleared findings "duplicate rows suppressed" would be false. */
check('the cleared findings are reported as cleared, not as duplicates',
  sum.resolved_since_last_run === 5, String(sum.resolved_since_last_run));
check('…and nothing here is a duplicate, so that count is zero',
  sum.duplicates_suppressed === 0, String(sum.duplicates_suppressed));
check('…and the two together account for every stored row',
  (sum.stored_rows || 0) === Number(total) + sum.resolved_since_last_run + sum.duplicates_suppressed,
  `${sum.stored_rows} stored vs ${total} + ${sum.resolved_since_last_run} + ${sum.duplicates_suppressed}`);

/* A filter must narrow the current set rather than reopening the cleared one. */
const one = await body('/api/insights?code=idle_vehicle');
check('filtering by rule still hides what that rule has stopped finding',
  (one.insights || []).length === 2
  && !(one.insights || []).some((r) => String(r.entity_id).startsWith('L-GONE')),
  JSON.stringify((one.insights || []).map((r) => r.entity_id)));

/* ── the rules have to survive being run twice ──────────────────────────
   sql/schema_v15.sql adds two PARTIAL unique indexes on insight
   (code, entity_type, entity_id) — one for rows with no window, one for
   fleet-level verdicts — beside the five-column key that put() named in its
   ON CONFLICT. Postgres arbitrates against the index you name and raises on a
   collision with any other, and the five-column key can never catch a
   windowless row anyway because NULLs are distinct in a unique index. So every
   re-run INSERTED and the partial index rejected it.

   Read out of the production collector log on 2026-09-01: SEVEN of the
   fourteen rules failing on every run — idle_vehicle, vehicle_dormant,
   licence, volume_trend, stale_tracker, vehicle_documents and platform_flags
   — each caught by a per-job try/catch that logged and carried on. That is
   why 163 of the 200 findings on the action list were frozen days in the past.

   Run three times, because the first pass INSERTS and it is the second that
   has to update. */
{
  const dbmod = await import('../src/db.js');
  const realQuery = dbmod.pool.query;
  dbmod.pool.query = (t, p) => db.query(t, p);
  await q(`INSERT INTO vehicle_document (platform, vehicle_ext_id, plate, doc_type,
             expires_at, status, fleet_id)
           VALUES ('uber','vd-1','L-DOCTEST','Vehicle Registration Form',
                   now() + interval '3 days','active','ecosine')`);
  const { computeInsights } = await import('../src/insights.js');
  const failures = [];
  for (let pass = 1; pass <= 3; pass++) {
    const out = await computeInsights({ from: '2026-08-01', to: '2026-08-31' });
    for (const [job, v] of Object.entries(out)) {
      if (String(v).startsWith('err')) failures.push(`pass ${pass}: ${job} — ${v}`);
    }
  }
  check('no insight rule fails when it is run more than once',
    failures.length === 0, failures.slice(0, 3).join(' | '));
  /* And the re-run must UPDATE rather than accumulate: the same finding three
     times is the duplicate storm sql/schema_v15.sql exists to have ended. */
  const [{ n }] = await q(
    `SELECT count(*)::int n FROM insight WHERE entity_id = 'L-DOCTEST'`);
  check('…and running it again replaces the finding rather than duplicating it',
    n === 1, `${n} rows for one document`);
  dbmod.pool.query = realQuery;
}

/* ── the ownership table is the thing that has to be right ──────────────
   A code no job claims can never be cleared, because nothing ever stamps a
   run for it — so the map in src/insights.js is checked against the codes the
   module actually emits rather than trusted. */
{
  const src = readFileSync('src/insights.js', 'utf8');
  const emitted = new Set([...src.matchAll(/code:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  /* The ternary form, which the single-line regex above cannot see. */
  for (const m of src.matchAll(/code:\s*[^,\n]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) {
    emitted.add(m[1]); emitted.add(m[2]);
  }
  const jobsBlock = src.slice(src.indexOf('const jobs = ['), src.indexOf('const out = {}'));
  const owned = new Set([...jobsBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const orphans = [...emitted].filter((c) => !owned.has(c));
  check('every code a rule emits is owned by a job that stamps its run',
    orphans.length === 0, `no job owns: ${orphans.join(', ')}`);
}

/* ── a finding's window has to be as fresh as its numbers ────────────────
   put() holds back the columns its arbiter matched on, and for a fleet-level
   row that arbiter is (code, entity_type, entity_id) — the window is not part
   of the identity. It was held back anyway, so the window a fleet finding was
   FIRST written with was the window it kept for ever while its metric, title
   and severity all moved on.

   Measured on production 2026-09-02: drivers_online_no_trips carried window
   2026-08-24..2026-08-24 and computed_at 2026-09-02T08:44 — nine days between
   the date the finding showed and the day its numbers came from, on a rule
   whose entire content is "three drivers were online and took nothing". */
{
  const { pool } = await import('../src/db.js');
  const realQ = pool.query;
  pool.query = (t, p2) => db.query(t, p2);
  const mod = await import('../src/insights.js');
  /* put() is not exported, so this drives the module the way the rules do:
     two computes over the same fleet-level code with different windows. */
  const write = async (from, to, metric) => db.query(
    `INSERT INTO insight (code, entity_type, entity_id, fleet_id, severity, category,
       title, detail, action, metric, window_start, window_end, computed_at)
     VALUES ('window_freeze_probe','fleet','ecosine','ecosine','warning','ops',
       't','d','a',$3,$1::date,$2::date, now())
     ON CONFLICT (code, entity_type, entity_id) WHERE entity_type = 'fleet'
     DO UPDATE SET metric = EXCLUDED.metric, window_start = EXCLUDED.window_start,
                   window_end = EXCLUDED.window_end, computed_at = EXCLUDED.computed_at`,
    [from, to, metric]);
  await write('2026-08-24', '2026-08-24', 3);
  await write('2026-09-02', '2026-09-02', 5);
  const [row] = (await db.query(
    `SELECT window_start, metric FROM insight WHERE code = 'window_freeze_probe'`)).rows;
  /* toISOString, not String(): String(Date) is "Wed Sep 02 2026 …" and an
     assertion on its prefix passes for the wrong reasons. */
  const day = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  check('the fleet arbiter permits the window to move, so a re-computed finding can be re-dated',
    day(row.window_start) === '2026-09-02' && Number(row.metric) === 5,
    JSON.stringify([day(row.window_start), row.metric]));
  /* The probe above pins the DATABASE half — that this arbiter accepts a moved
     window at all. The half that was actually broken is put()'s choice of what
     to hold back, and put() is not exported, so it is asserted on the rule
     itself: the held-back columns must be the arbiter's, not a fixed list, or
     the next arbiter added reintroduces exactly this. */
  const src2 = readFileSync('src/insights.js', 'utf8');
  check('…because put() holds back the columns its arbiter matched on, not a fixed five',
    /const KEY = new Set\(r\.entity_type === 'fleet' \|\| noWindow/.test(src2)
    && /\['code', 'entity_type', 'entity_id'\]/.test(src2),
    'a fixed KEY set is wrong for two of the three arbiters');
  pool.query = realQ;
  void mod;
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
