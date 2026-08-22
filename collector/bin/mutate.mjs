#!/usr/bin/env node
/* Do the checks actually bite?
   ─────────────────────────────────────────────────────────────────────────
   Ten passes produced fourteen test files and about 1,150 assertions, and a
   green suite means nothing if the assertions cannot fail. Three times during
   this audit a check reported clean against the exact code it was written to
   catch: the odometer lint treated a FILTER clause as scoping the statement,
   the timezone lint read line by line and could not see a call whose options
   sit on the next line, and the browser smoke test waited a fixed 900ms and
   verified that skeleton loaders appear.

   So: reintroduce each bug and require the suite to notice. Every entry below
   is a single edit that puts back something a pass removed. A mutation nothing
   catches is a hole in the audit, not a harmless edit.

   Slow on purpose — it runs the whole suite once per mutation, about fifteen
   minutes — so it is not part of `npm test`. Run it after adding a check, and
   before trusting a green suite on anything that matters.

       node bin/mutate.mjs

   The working tree is restored after each mutation, including on failure. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MUTATIONS = [
  ['custody requires an id again (pass 3)', 'sql/schema_v19.sql',
    "AND (coalesce(btrim(t.driver_ext_id), '') <> '' OR coalesce(btrim(t.driver_name), '') <> '')",
    "AND coalesce(btrim(t.driver_ext_id), '') <> ''"],
  ['driver counts go back to counting accounts (pass 4)', 'api/custody_sql.js',
    'export const peopleCount = (idCol = \'driver_ext_id\', nameCol = \'driver_name\') =>\n  `count(DISTINCT ${personKey(idCol, nameCol)})`;',
    'export const peopleCount = (idCol = \'driver_ext_id\', nameCol = \'driver_name\') =>\n  `count(DISTINCT ${idCol})`;'],
  ['the ranking stops saying how many people there are (pass 5)', 'api/server.js',
    "res.json({ rows, people: t?.people ?? rows.length, shown: rows.length,",
    "res.json({ rows, shown: rows.length,"],
  ['a formatter goes back to the viewer clock (pass 6)', 'api/public/ui.js',
    "{ hour: '2-digit', minute: '2-digit', timeZone: TZ }",
    "{ hour: '2-digit', minute: '2-digit' }"],
  ['an unknown vehicle answers 200 again (pass 7)', 'api/vehicle_routes.js',
    "if (!seen) return res.status(404).json({ error: 'vehicle not found' });",
    "if (!seen) return fn(req, res, plate, [...win(req), plate]);"],
  ['average distance divides by every trip again (pass 8)', 'api/server.js',
    'round(avg(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,2) avg_km,',
    'round(avg(distance_km)::numeric,2) avg_km,'],
  ['complimentary rides count as revenue again (live)', 'sql/schema_v18.sql',
    "  (t.price IS NOT NULL\n   AND lower(coalesce(t.payment_type, '')) NOT IN ('foc-complimentary', 'foc', 'complimentary'))\n    AS has_fare,",
    '  (t.price IS NOT NULL) AS has_fare,'],
  ['the JS name fold drifts from the SQL one (live)', 'api/driver_routes.js',
    "  const out = [];\n  for (const w of parts) if (out[out.length - 1] !== w) out.push(w);\n  return out.join(' ');",
    "  while (parts.length > 2 && parts[parts.length - 1] === parts[parts.length - 2]) parts.pop();\n  return parts.join(' ');"],
  ['revenue per km mixes two populations again (live)', 'api/vehicle_routes.js',
    'revenue_per_km: t.priced_km > 0 && t.priced_measured_revenue\n        ? +(t.priced_measured_revenue / t.priced_km).toFixed(2) : null });',
    'revenue_per_km: t.km > 0 && t.revenue\n        ? +(t.revenue / t.km).toFixed(2) : null });'],
  ['a route module stops being mounted (pass 5)', 'test/mount.mjs',
    "for (const f of readdirSync('api').filter((x) => x.endsWith('_routes.js'))) {",
    "for (const f of readdirSync('api').filter((x) => x.endsWith('_routes.js') && !x.startsWith('capacity'))) {"],
];

let caught = 0, missed = [];
for (const [name, file, from, to] of MUTATIONS) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { missed.push(`${name}  — ANCHOR NOT FOUND in ${file}`); continue; }
  writeFileSync(file, original.replace(from, to));
  let out = '';
  try { out = execFileSync(process.execPath, ['test/run-all.mjs'], { encoding: 'utf8', timeout: 540000 }); }
  catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  writeFileSync(file, original);
  const failing = (out.match(/(\d+) file\(s\) failing/) || [])[1];
  const files = (out.match(/✗ (\S+)/g) || []).slice(0, 3).join(' ');
  if (failing && +failing > 0) { caught++; console.log(`  ✓ caught: ${name}   [${files}]`); }
  else { missed.push(`${name}  (${file})`); console.log(`  ✗ MISSED: ${name}`); }
}
console.log(`\n${caught}/${MUTATIONS.length} mutations caught`);
if (missed.length) { console.log('\nholes:'); missed.forEach((m) => console.log(`  ${m}`)); }
process.exit(missed.length ? 1 : 0);
