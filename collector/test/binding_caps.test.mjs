/* ── a cap the reader cannot see is a wrong total ──────────────────────────
   Forty-one endpoints in this API carry a LIMIT. A LIMIT is fine; a LIMIT that
   is CUTTING and says nothing is not, because the reader takes the last row as
   the last one there is — and worse, a page that aggregates the capped list
   prints a fleet figure over whatever happened to fit.

   Probed against production, five endpoints returned exactly their LIMIT.
   Three of them already disclosed it (shown / truncated / total_guests /
   driver_count) and were false positives of the probe, which looked for a key
   literally named `total`. Two did not:

     /api/product/by-vehicle   600 of 600 — a bare array
     /api/map/days             400 of 400 — disclosed by the API, ignored by
                                            the page that renders it

   product/by-vehicle was the same defect as /api/earnings/components: the
   front end pivots the rows into one per plate and computes the fleet's
   concentration sentence — "the top N vehicles take X% of the work" — over
   EVERY plate rather than the thirty it lists. Cutting the input made that
   sentence wrong in the direction that flatters the fleet.

   This test pins the rule rather than the five instances: every capped list
   either has room to spare or says it was cut. */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const files = ['server.js', ...readdirSync('api').filter((f) => f.endsWith('_routes.js'))];
const src = Object.fromEntries(files.map((f) => [f, readFileSync(`api/${f}`, 'utf8')]));

/* One handler's body: from its app.get to the next one. */
const handlers = [];
for (const [f, s] of Object.entries(src)) {
  const marks = [...s.matchAll(/app\.get\('(\/api\/[^']*)'/g)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : s.length;
    handlers.push({ file: f, route: m[1], body: s.slice(m.index, end) });
  });
}

console.log('\nbinding caps: every capped list says so, or has no cap');

const capped = handlers.filter((h) => /LIMIT \d+/.test(h.body));
check(`${capped.length} handlers carry a LIMIT`, capped.length > 20, String(capped.length));

/* WHICH of them are cutting cannot be answered here, and the first draft of
   this test tried: it flagged twenty handlers, seventeen of them LIMIT 1
   lookups, which is exactly how a harness teaches people to ignore it.
   `LIMIT 600` looks identical whether the table holds four hundred rows or
   four thousand — only asking the real database tells you which.

   So that question belongs to bin/cap-audit.mjs, which calls every capped
   endpoint against production and compares the row count to the limit. What
   is testable HERE is that the tool exists, that it distinguishes a cap that
   is cutting from one that is cutting silently, and that it ignores the
   lookups. Measured on 25 Aug 2026: 45 handlers carry a LIMIT above 1, seven
   are at their cap, and none of the seven is silent. */
const cap = readFileSync('bin/cap-audit.mjs', 'utf8');
check('the question "which caps are actually cutting" is asked of the database, '
  + 'not of the source', /await fetch\(`\$\{BASE\}\$\{h\.route\}/.test(cap));
check('and a LIMIT 1 is excluded, because a lookup cannot cut a list',
  /filter\(\(n\) => n > 1\)/.test(cap));
check('a cap that is cutting AND says so is reported separately from one that '
  + 'is silent — the first is a design, the second is a wrong total',
  /biting/.test(cap) && /quiet/.test(cap));
check('and it exits non-zero only for the silent ones',
  /process\.exit\(biting\.length \? 1 : 0\)/.test(cap));

console.log('\nbinding caps: the two that were cutting');

const prod = handlers.find((h) => h.route === '/api/product/by-vehicle');
check('/api/product/by-vehicle has no LIMIT at all now — (plate, product) pairs '
  + 'on a 140-vehicle fleet cannot exceed a few hundred, so the cap saved '
  + 'nothing and cost the tail',
  prod && !/LIMIT \d+/.test(prod.body.split('held AS')[0]),
  prod ? prod.body.slice(0, 200) : 'route missing');

const days = handlers.find((h) => h.route === '/api/map/days');
check('/api/map/days still reports total, shown and truncated on every row',
  days && /total: t\?\.n/.test(days.body) && /truncated:/.test(days.body));

const app = readFileSync('api/public/app.js', 'utf8');
check('and the day picker now READS them — the API disclosed this all along '
  + 'and the page that renders it did not',
  /rows\[0\]\?\.truncated/.test(app),
  'fillDays ignores the truncation the endpoint reports');
check('the note it prints names both numbers, so "no day for this vehicle" and '
  + '"this vehicle was never tracked" stay different sentences',
  /No day for this vehicle is in the picker/.test(app));

console.log('\nbinding caps: the aggregating consumers');

check('componentTree sums roots only, and says the children are inside them',
  /is not added again/.test(app));
check('the concentration sentence is computed over every plate, not the visible '
  + 'slice — which is why its input must not be capped',
  /computed over ALL vehicles/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
