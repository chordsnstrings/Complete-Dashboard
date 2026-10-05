/* SPD (2026-10-05): trip_norm carries person_key, and JOIN_TRIP no longer
   joins the base table.

   EXPLAIN on production showed one shape under the slowest statements left:
   a nested loop of trip_pkey lookups, one per row in the window, because
   trip_norm's `t.*` froze at sql/schema_v18.sql — before v20 added
   person_key — and every query counting PEOPLE joined trip back to read it.
   /api/kpis at 90 days spent 19.2 s there.

   sql/schema_v100.sql rebuilds trip_norm and its two dependants so the star
   re-expands; JOIN_TRIP and the six inline copies become a projection of the
   row in hand. What this pins:
     1. v100's three view bodies are verbatim copies of the files that own
        them (v18, v62, v80), so the rebuild changes the column list and
        nothing else.
     2. On a migrated database the views carry person_key, and trip_ext and
        trip_cash survive the CASCADE.
     3. On data, the lateral answers exactly what the primary-key join did:
        same rows, same people, same person_key per row.
     4. No inline self-join is left in api/ or src/. */
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { JOIN_TRIP, peopleCountStored } from '../api/custody_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const file = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const lines = (f, a, b) => { const L = file(f).split('\n'); return L.slice(a - 1, b || L.length).join('\n').trimEnd(); };

console.log('1. verbatim bodies');
const v100 = file('sql/schema_v100.sql');
check('trip_norm is v18\'s', v100.includes(lines('sql/schema_v18.sql', 44, 116)));
check('trip_ext is v62\'s', v100.includes(lines('sql/schema_v62.sql', 26)));
check('trip_cash is v80\'s', v100.includes(lines('sql/schema_v80.sql', 77)));
check('…and the anchors are where this test thinks they are',
  lines('sql/schema_v18.sql', 44, 44) === 'CREATE VIEW trip_norm AS'
  && lines('sql/schema_v62.sql', 26, 26) === 'CREATE VIEW trip_ext AS'
  && lines('sql/schema_v80.sql', 77, 77) === 'CREATE OR REPLACE VIEW trip_cash AS');
check('registered after v99', /'schema_v99\.sql',[\s\S]*'schema_v100\.sql',\s*\n\];/.test(file('src/schema_files.js')));

console.log('2. the migrated views');
const db = new PGlite();
await applySchema(db);
const cols = async (v) => (await db.query(
  `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [v]))
  .rows.map((r) => r.attname);
for (const v of ['trip_norm', 'trip_ext', 'trip_cash']) {
  let c = []; try { c = await cols(v); } catch { /* missing view */ }
  check(`${v} exists`, c.length > 0);
  if (v !== 'trip_cash') check(`${v} carries person_key`, c.includes('person_key'));
}

console.log('3. the lateral answers what the join did');
const ins = (id, plat, ext, name, plate) => db.query(
  `INSERT INTO trip (external_id, platform, fleet_id, driver_ext_id, driver_name, requested_at, plate, status, price)
   VALUES ($1, $2, 'ecosine', $3, $4, '2026-09-01T10:00:00Z', $5, 'completed', 50)`, [id, plat, ext, name, plate]);
await ins('a1', 'uber', 'u-amina', 'Amina Rashid', 'P1');
await ins('a2', 'bolt', 'b-amina', 'Amina Rashid', 'P1');
await ins('b1', 'uber', 'u-bilal', 'Bilal Haq', 'P2');
await ins('c1', 'uber', 'u-anon', null, 'P3');
await ins('d1', 'uber', 'u-amina', 'Amina Rashid', 'P2');
const OLD = 'JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id';
const shape = (j) => `SELECT n.platform, n.external_id, t.person_key, t.driver_ext_id FROM trip_norm n ${j} ORDER BY 1, 2`;
const a = (await db.query(shape(OLD))).rows, b = (await db.query(shape(JOIN_TRIP))).rows;
check('same rows, same person_key on each', JSON.stringify(a) === JSON.stringify(b) && a.length === 5, JSON.stringify(b));
const people = (j) => `SELECT ${peopleCountStored()} AS n FROM trip_norm n ${j}`;
const pa = (await db.query(people(OLD))).rows[0].n, pb = (await db.query(people(JOIN_TRIP))).rows[0].n;
check('same number of people (Amina once across two accounts)', Number(pa) === Number(pb) && Number(pb) === 3, `${pa} vs ${pb}`);
const plan = (await db.query(`EXPLAIN ${people(JOIN_TRIP)}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
check('…and the plan reads trip once, with no primary-key lookup', (plan.match(/on trip\b/g) || []).length === 1 && !/trip_pkey/.test(plan), plan);

console.log('4. no self-join left');
const srcs = [...readdirSync(new URL('../api/', import.meta.url)).map((f) => `api/${f}`),
  ...readdirSync(new URL('../src/', import.meta.url)).map((f) => `src/${f}`)].filter((f) => f.endsWith('.js'));
const left = srcs.filter((f) => /JOIN trip [a-z0-9_]+ ON [a-z0-9_]+\.platform = n\.platform AND [a-z0-9_]+\.external_id = n\.external_id/
  .test(file(f).replace(/\/\*[\s\S]*?\*\//g, '')));
check('no trip_norm → trip primary-key join in api/ or src/', left.length === 0, left.join(', '));
check('JOIN_TRIP is the projection', JOIN_TRIP === 'CROSS JOIN LATERAL (SELECT n.*) t');

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
