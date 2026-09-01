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
check('…and the response says how many it cleared', d.cleared === 3, String(d.cleared));

/* The other direction, and the reason this is an inference rather than a
   cutoff: a rule that has not re-run has not cleared anything, however old its
   rows are. Dropping them would silently delete real findings whenever a rule
   started failing. */
check('a rule that has NOT re-run keeps every finding it wrote',
  ids.includes('L-OLD-A') && ids.includes('L-OLD-B'), ids.join(','));

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

/* A filter must narrow the current set rather than reopening the cleared one. */
const one = await body('/api/insights?code=idle_vehicle');
check('filtering by rule still hides what that rule has stopped finding',
  (one.insights || []).length === 2
  && !(one.insights || []).some((r) => String(r.entity_id).startsWith('L-GONE')),
  JSON.stringify((one.insights || []).map((r) => r.entity_id)));

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
