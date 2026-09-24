/* /api/insights/summary counts by RULE, and counts what carries a cost.
   ─────────────────────────────────────────────────────────────────────────
   The Arkiv #insights (plan §4, "What is open, by kind" and "What it costs to
   ignore") draws the open findings per rule and the unpriced ones as the
   absence outline. The list endpoint is capped at 200 rows and production
   held 202 open, so a count taken from the rows the page holds is a partial
   figure dressed as the fleet. The summary now answers both over the whole
   deduplicated, still-current set: `by_code` (n, priced, the summed cost, the
   channels its findings name) and `total.priced_n`.

   Same fixture shape as insight_freshness: PGlite, the real route. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const NOW = '2026-09-01T11:00:00Z';
const OLD = '2026-08-21T09:00:00Z';
const put = (code, type, entity, at, { sev = 'warning', cat = 'data', aed = null } = {}) => q(
  `INSERT INTO insight (code, severity, category, entity_type, entity_id, title, detail, action,
     impact_aed, metric, fleet_id, computed_at)
   VALUES ($1, $5, $6, $2, $3, $3 || ' — ' || $1, 'detail', 'action', $7, 1, 'ecosine', $4)`,
  [code, type, entity, at, sev, cat, aed]);

// idle_vehicle: two current (modelled cost), one the rule has stopped emitting.
await put('idle_vehicle', 'vehicle', 'L-1', NOW, { sev: 'critical', cat: 'utilisation', aed: 1680 });
await put('idle_vehicle', 'vehicle', 'L-2', NOW, { sev: 'critical', cat: 'utilisation', aed: 1680 });
await put('idle_vehicle', 'vehicle', 'L-GONE', OLD, { sev: 'critical', cat: 'utilisation', aed: 1680 });
// cancellation_rate: one priced (uber), one unpriced (bolt: no fare per trip).
await put('cancellation_rate', 'platform', 'uber', NOW, { cat: 'revenue', aed: 412.35 });
await put('cancellation_rate', 'platform', 'bolt', NOW, { cat: 'revenue' });
// tracker_feed_dark: a SOURCE id carries its fleet after a colon.
await put('tracker_feed_dark', 'source', 'cabman:ecosine', NOW, { sev: 'critical' });
await put('tracker_feed_dark', 'source', 'cabman:egari', NOW, { sev: 'critical' });
// stale_tracker: vehicles, no channel named.
await put('stale_tracker', 'vehicle', 'L-9', NOW);

const { get, server } = await mountAll(db, { serverRoutes: true });
const sum = (await get('/api/insights/summary')).body;
const by = Object.fromEntries((sum.by_code || []).map((r) => [r.code, r]));

console.log('\nby rule, over every current finding');
check('the summary carries by_code', Array.isArray(sum.by_code), JSON.stringify(Object.keys(sum)));
check('one row per rule, counted over the CURRENT set (the cleared idle_vehicle is not in it)',
  by.idle_vehicle?.n === 2 && by.cancellation_rate?.n === 2 && by.tracker_feed_dark?.n === 2
  && by.stale_tracker?.n === 1, JSON.stringify(sum.by_code));
check('…and the per-rule counts add up to the total', (sum.by_code || []).reduce((a, r) => a + r.n, 0) === sum.total.n,
  `${(sum.by_code || []).reduce((a, r) => a + r.n, 0)} vs ${sum.total.n}`);
check('priced counts the findings with a cost, per rule', by.cancellation_rate?.priced === 1 && by.idle_vehicle?.priced === 2
  && by.stale_tracker?.priced === 0, JSON.stringify(by));
check('…and the cost is summed to the fils', Number(by.cancellation_rate?.impact) === 412.35
  && Number(by.idle_vehicle?.impact) === 3360, `${by.cancellation_rate?.impact} ${by.idle_vehicle?.impact}`);
check('a rule nothing priced sums to null, never 0', by.stale_tracker?.impact == null, String(by.stale_tracker?.impact));
check('the channels a platform finding names', JSON.stringify([...(by.cancellation_rate?.channels || [])].sort()) === '["bolt","uber"]',
  JSON.stringify(by.cancellation_rate?.channels));
check('a source id is read up to its colon, once per channel', JSON.stringify(by.tracker_feed_dark?.channels) === '["cabman"]',
  JSON.stringify(by.tracker_feed_dark?.channels));
check('a rule about vehicles names no channel', (by.stale_tracker?.channels || []).length === 0,
  JSON.stringify(by.stale_tracker?.channels));
check('largest rule first', sum.by_code[0].n >= sum.by_code[sum.by_code.length - 1].n);
check('total.priced_n counts every current finding with a cost', sum.total.priced_n === 3, String(sum.total.priced_n));

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
