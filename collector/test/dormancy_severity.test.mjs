/* A severity that never moves is not a severity.
   ─────────────────────────────────────────────────────────────────────────
   vehicle_dormant filed every finding as 'warning' while its metric ran from
   36 days to 869 — a car quiet since Ramadan and a car quiet since two summers
   ago, on one list, sorted by nothing an operator could act on.

   The threshold is not chosen, it is read out of the data. Production
   2026-09-02 held twenty of these:

     36  36  37  44  45  51  71  75  103  116
     319  437  439  668  672  707  783  801  869  869

   Nothing between 116 and 319. One population is a repair, a lay-up or a gap
   between contracts; the other has left the fleet and is still counted in
   every per-vehicle average. The cut sits inside that empty range, so where
   exactly it is placed changes nothing — which is the point of putting it
   there rather than picking a round number and defending it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
const { computeInsights } = await import('../src/insights.js');

const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const seed = (plate, daysAgo) => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ('cabman','ecosine',$1,$2::timestamptz,$2::timestamptz,25.2,55.3,0,'Stopped')`,
  [plate, at(daysAgo)]);

/* One from each side of the gap, and one from each edge of it — 179 and 180
   are the cut itself, and a rule whose boundary is untested is a rule whose
   boundary moves the next time somebody edits it. */
await seed('L-REPAIR', 45);
await seed('L-EDGE-UNDER', 179);
await seed('L-EDGE-OVER', 181);
await seed('L-GONE', 800);
/* And one reporting normally, which must not be dormant at all. */
await seed('L-LIVE', 0.2);
await computeInsights({});

const got = await q(
  `SELECT entity_id, severity, metric, detail, action FROM insight
    WHERE code = 'vehicle_dormant' ORDER BY entity_id`);
const of = (p) => got.find((r) => r.entity_id === p);

console.log('\ndormancy has two populations and says which');
check('a car reporting now is not dormant at all',
  !of('L-LIVE'), JSON.stringify(got.map((r) => r.entity_id)));
check('all four silent cars are reported', got.length === 4,
  JSON.stringify(got.map((r) => [r.entity_id, r.metric, r.severity])));
check('a car silent for two years is critical, not a warning',
  of('L-GONE')?.severity === 'critical',
  JSON.stringify(of('L-GONE') && [of('L-GONE').metric, of('L-GONE').severity]));
check('…and one silent for six weeks is still only a warning',
  of('L-REPAIR')?.severity === 'warning',
  JSON.stringify(of('L-REPAIR') && [of('L-REPAIR').metric, of('L-REPAIR').severity]));

console.log('\nand the cut is where the data has no cars');
check('a day under it is a warning', of('L-EDGE-UNDER')?.severity === 'warning',
  JSON.stringify(of('L-EDGE-UNDER') && [of('L-EDGE-UNDER').metric, of('L-EDGE-UNDER').severity]));
check('a day over it is critical', of('L-EDGE-OVER')?.severity === 'critical',
  JSON.stringify(of('L-EDGE-OVER') && [of('L-EDGE-OVER').metric, of('L-EDGE-OVER').severity]));

/* The sentence has to move with the severity. A red pill over a paragraph
   hedging that the car might yet come back is two claims about one car. */
console.log('\nand the sentence moves with it');
check('the hedge is dropped where it is no longer honest',
  /has left the fleet/.test(of('L-GONE')?.detail || '')
  && !/usually means/.test(of('L-GONE')?.detail || ''),
  of('L-GONE')?.detail?.slice(0, 110));
check('…and kept where it is still true',
  /usually means/.test(of('L-REPAIR')?.detail || '')
  && /repair or a lay-up/.test(of('L-REPAIR')?.detail || ''),
  of('L-REPAIR')?.detail?.slice(0, 110));
check('…and the action stops asking a question whose answer is known',
  /stop counting as a vehicle in service/.test(of('L-GONE')?.action || ''),
  of('L-GONE')?.action?.slice(0, 100));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
