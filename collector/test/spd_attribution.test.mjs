/* SPD (2026-10-05): what made /api/unauthorized/attributed 19 s at a month
   and 41 s at six, measured by EXPLAIN ANALYZE on production (31 s plan, 211
   journeys), and what each fix pins:

     hist aggregate, every trip on the car, per journey   18.0 s  gated on an
       empty last_ppl — it feeds only no_last_reason / WHY_NO_LAST
     candidate status, walk of dse_at_idx per candidate    7.6 s  per-account
       probe (test/status_join_arms.test.mjs)
     newest non-Uber trip in a window, plate-only index    3.2 s  schema v99
       (plate, coalesce(ended_at, requested_at))

   Behaviour is held by the attribution suites, which assert every absence
   sentence on fixture data; this pins the shapes so a later edit cannot
   quietly put the cost back. Plus the plan logger that made the next round
   measurable without a deploy per guess. */
import { readFileSync } from 'node:fs';
import { attributionJoin } from '../api/unauthorized_sql.js';

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const sql = attributionJoin('o').replace(/\/\*[\s\S]*?\*\//g, '');

const hist = sql.slice(sql.indexOf('hist AS ('), sql.indexOf('tally AS ('));
check('hist reads the car\'s trips only when the last-trip rule reached nobody',
  /WHERE t\.plate = o\.plate\s+AND coalesce\(btrim\(t\.driver_ext_id\), ''\) <> ''\s+AND NOT EXISTS \(SELECT 1 FROM last_ppl\)/.test(hist));
check('…and so does the other-channel probe',
  /WHERE t4\.plate = o\.plate\s+AND NOT EXISTS \(SELECT 1 FROM last_ppl\)/.test(sql));
check('no_last_reason is still decided from the same tally', /AS no_last_reason/.test(sql));

const v99 = readFileSync(new URL('../sql/schema_v99.sql', import.meta.url), 'utf8');
check('v99: (person_key, driver_ext_id)', /CREATE INDEX IF NOT EXISTS trip_person_ext_idx ON trip \(person_key, driver_ext_id\);/.test(v99));
check('v99: (plate, coalesce(ended_at, requested_at)) — the probe\'s own expression',
  /ON trip \(plate, \(coalesce\(ended_at, requested_at\)\)\);/.test(v99)
  && /coalesce\(t\.ended_at, t\.requested_at\) > \(SELECT at FROM last_at\)/.test(sql));
check('v99 is registered', readFileSync(new URL('../src/schema_files.js', import.meta.url), 'utf8').includes("'schema_v99.sql'"));

const srv = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
check('a statement over PLAN_QUERY_MS logs its plan, once per head, never re-run with ANALYZE',
  /if \(ms >= PLAN_MS\) logPlan\(text, params, ms\);/.test(srv)
  && /pool\.query\(`EXPLAIN \$\{text\}`, params\)/.test(srv) && /planned\.has\(head\)/.test(srv));
check('W() carries the raw requested_at range beside local_day, so fleet and platform windows can use their indexes',
  /\$\{c\}requested_at >= \(\$1::date::timestamp AT TIME ZONE 'Asia\/Dubai'\)`\s*\n\s*\+ ` AND \$\{c\}requested_at < \(\(\$2::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Dubai'\)`/.test(srv));
const ur = readFileSync(new URL('../api/unauthorized_routes.js', import.meta.url), 'utf8');
check('the driver tab runs its three independent reads together',
  /const \[rows, tally, held\] = await Promise\.all\(\[rowsP, tallyP, heldP\]\);/.test(ur)
  && !/const (rows|tally|held) = await q\(/.test(ur.slice(ur.indexOf("app.get('/api/driver/unauthorized'"))));
check('coverage starts its geo count before the nine counts, and marks it handled',
  /const geoP = q\(/.test(srv) && /geoP\.catch\(\(\) => \{\}\);/.test(srv) && /const geo = await geoP;/.test(srv)
  && srv.indexOf('const geoP = q(') < srv.indexOf("earnDays] = await Promise.all(["));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
