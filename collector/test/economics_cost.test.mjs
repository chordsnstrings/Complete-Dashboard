/* What the landing page is allowed to READ.
   ─────────────────────────────────────────────────────────────────────────
   /api/economics/assets and /api/economics/drivers shipped correct and
   ruinous. Their SQL had only ever run against fixtures of a few thousand
   rows, where everything is fast, and against production's 279,000 trips the
   assets endpoint took 5.5 seconds cold at a year and 5 MINUTES with a
   platform filter — past the gateway, so the default landing page 504'd.

   Every one of the four causes was invisible to the existing tests, because
   every one of them produced the RIGHT ANSWER:

     1. the person fold computed per row instead of read from the STORED
        generated column (sql/schema_v20.sql: 2,434ms against 129ms)
     2. a self-join of trip to itself, carrying no window predicate on its
        inner side, so a 7-day question read all 279,000 rows exactly as a
        365-day one did
     3. an alert scan whose window lived only in a join condition, so the
        whole 56,000-row table was read at every window
     4. a CTE joined back to an aggregate of itself, which the planner turns
        into a nested loop the moment a caller narrows the outer query,
        because a filter over a CTE scan estimates ONE row: 9.1 million
        comparisons to produce 7,507

   A timing test cannot catch any of that — a fixture small enough to run in
   CI is fast however badly it is written, and a threshold in milliseconds
   fails on a loaded machine and passes on a quiet one. So this measures the
   two things that do not depend on the size of the box:

     WORK — the sum of (actual rows x loops) over every node of every plan the
     endpoint executes. Quadratic joins show up here as an enormous number and
     nowhere else.

     WINDOW SENSITIVITY — the same total, asked for one day and for the whole
     record. A query that reads a table the window cannot narrow costs the
     same either way, which is the signature of causes 2 and 3.

   Both are exact integers from EXPLAIN (ANALYZE), reproducible on any
   machine. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll } from './mount.mjs';
import { readFileSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
/* The wide fleet: 240 plates and 240 people over 28 days, so "one day" and
   "everything" differ by a factor of 28 and a query that ignores the window
   is visible as a flat cost rather than as a slow one. */
await seedFleet(db, { wide: true });
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
await db.query('ANALYZE');

/* Every statement an endpoint issues, captured by standing between the routes
   and the database — the same trick the route smoke uses to mount the app.
   Explaining the SQL the endpoint actually ran is the only version of this
   test that cannot drift from the endpoint. */
const issued = [];
const proxy = { query: async (text, params) => { issued.push([text, params]); return db.query(text, params); } };
const { get, server } = await mountAll(proxy);

const NODES = (p) => [p, ...(p.Plans || []).flatMap(NODES)];
async function costOf(path) {
  issued.length = 0;
  const r = await get(path);
  if (r.status !== 200) return { work: Infinity, status: r.status, plans: [] };
  const seen = issued.slice();
  let work = 0; const plans = [];
  for (const [text, params] of seen) {
    /* A parameterised EXPLAIN needs the same parameters the endpoint bound,
       or the planner is asked a different question than the one that ran. */
    const e = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params || []);
    const root = e.rows[0]['QUERY PLAN'][0].Plan;
    const nodes = NODES(root);
    work += nodes.reduce((a, n) => a + (n['Actual Rows'] || 0) * (n['Actual Loops'] || 1), 0);
    plans.push({ text, nodes });
  }
  return { work, status: 200, plans, statements: seen.length };
}

const [{ trips }] = (await db.query(
  `SELECT count(*)::int trips FROM trip`)).rows;
const [{ oneDay }] = (await db.query(
  `SELECT count(*)::int "oneDay" FROM trip
    WHERE (requested_at AT TIME ZONE 'Asia/Dubai')::date = '2026-08-15'`)).rows;
console.log(`\nfixture: ${trips} trips, ${oneDay} of them on 2026-08-15`);

/* ── 1. the window has to matter ──────────────────────────────────────── */
console.log('\nthe cost of an answer follows the size of the question');

const WIDE = 'from=2026-08-01&to=2026-08-31';
const NARROW = 'from=2026-08-15&to=2026-08-15';

for (const ep of ['assets', 'drivers']) {
  const wide = await costOf(`/api/economics/${ep}?${WIDE}`);
  const narrow = await costOf(`/api/economics/${ep}?${NARROW}`);
  check(`${ep}: both windows answer`, wide.status === 200 && narrow.status === 200,
    `${wide.status}/${narrow.status}`);
  /* Not a ratio of 28, because a good deal of both endpoints is per-PLATE and
     per-PERSON work that a narrower window does not shrink — the plate
     register, the document join, the standing union. Half is the line: under
     the shipped code the drivers endpoint was 1.00, dead flat, because its
     self-join read the whole trip table either way. */
  check(`${ep}: one day costs less than half of a month`,
    narrow.work < wide.work * 0.5,
    `one day ${narrow.work} rows of work, a month ${wide.work} — the window is not narrowing the scan`);
}

/* ── 2. nothing quadratic, filtered or not ────────────────────────────── */
console.log('\nno plan does work out of proportion to the rows it reads');

/* The endpoint reads roughly `trips` rows and hands back a few hundred. Every
   sort, aggregate and join stage re-reports those rows, so a healthy total is
   a small multiple of the table. A nested loop over a mis-estimated CTE is
   three orders of magnitude past this bound: the shape that took 308 seconds
   on production hardware scored 9.1 million against 8,293 input rows. */
const BUDGET = 60;
for (const ep of ['assets', 'drivers']) {
  for (const filter of ['', '&platform=uber', '&fleet=ecosine', '&platform=uber&fleet=ecosine']) {
    const c = await costOf(`/api/economics/${ep}?${WIDE}${filter}`);
    check(`${ep}${filter || ' (unfiltered)'}: ${c.work} rows of work for ${trips} trips`,
      c.work < trips * BUDGET,
      `over ${trips * BUDGET} — some node is doing quadratic work`);
  }
}

/* ── 3. the trip table is read once, through the window ───────────────── */
console.log('\nno scan of trip escapes the window');

{
  const c = await costOf(`/api/economics/drivers?${NARROW}`);
  /* Sum the actual rows of every node that touches `trip` by any name. Under
     JOIN_TRIP one of them reported the whole table at every window; that is
     the number this pins, and it is a count, not a clock. */
  const tripNodes = c.plans.flatMap((p) => p.nodes.filter((n) => n['Relation Name'] === 'trip')
    .map((n) => ({ n, text: p.text })));
  const tripRows = tripNodes.reduce((a, { n }) => a + (n['Actual Rows'] || 0) * (n['Actual Loops'] || 1), 0);
  check(`a one-day drivers request reads ${tripRows} trip rows, not ${trips}`,
    tripRows < trips, `it read ${tripRows} of ${trips} — the window is not reaching the scan`);

  /* And the count of SCANS, which a small fixture cannot hide. JOIN_TRIP put
     two scans of `trip` in the work query — one through trip_norm for the
     window, one bare to reach person_key — and only the first carried the
     window. At production scale that second scan was the whole table at every
     window; here it is cheap, so the shape is what has to be pinned. */
  const work = c.plans.find((p) => /GROUP BY 1/.test(p.text) && /driver_ext_id/.test(p.text)
    && /requested_at AT TIME ZONE/.test(p.text));
  check('the drivers ledger scans trip once, not twice',
    work && work.nodes.filter((n) => n['Relation Name'] === 'trip').length === 1,
    work ? `${work.nodes.filter((n) => n['Relation Name'] === 'trip').length} scans of trip in one query`
      : 'could not find the work query among the statements issued');
}
{
  const c = await costOf(`/api/economics/drivers?${NARROW}`);
  const alertRows = c.plans.flatMap((p) => p.nodes)
    .filter((n) => n['Relation Name'] === 'alert')
    .reduce((a, n) => a + (n['Actual Rows'] || 0) * (n['Actual Loops'] || 1), 0);
  const [{ total, onday }] = (await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date
              = '2026-08-15')::int onday
       FROM alert`)).rows;
  check(`a one-day drivers request reads ${alertRows} alerts, not all ${total}`,
    alertRows < total, `the alert window lives only in the join condition again (${onday} happened that day)`);
}

/* ── 4. the fold is read, never recomputed ────────────────────────────── */
console.log('\nthe person fold is the stored column, not a regex per row');

/* sql/schema_v20.sql stores the fold on `trip` precisely so no windowed query
   has to compute it, and measured the difference at 2,434ms against 129ms.
   trip_norm cannot expose the column — v18 froze the view's SELECT t.* two
   migrations earlier — so a query that reads the view has no choice but to
   fold again. This is a grep because that is what the failure is: correct
   SQL, reading the wrong relation. */
/* Comments stripped first: this file explains at length why it does NOT fold,
   and a grep over the prose would find the words it is looking for and fail
   on the explanation. */
const src = readFileSync('api/economics_routes.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('neither ledger folds the driver name per row',
  !/regexp_replace/.test(src) && !/personKey\s*\(/.test(src),
  'api/economics_routes.js computes the fold — read trip.person_key instead');
check('and neither self-joins trip to reach it',
  !/JOIN_TRIP/.test(src),
  'JOIN_TRIP puts an unwindowed scan of the whole trip table into the query');
check('both read the stored fold off the base table',
  (src.match(/person_key/g) || []).length >= 2 && /FROM trip t\b/.test(src),
  'the stored column is what makes the window scan cheap — see sql/schema_v20.sql');

/* The endpoints are also the only ones that read trip through the covering
   index, which is only useful if the migration that creates it runs. */
const dbSrc = readFileSync('src/db.js', 'utf8');
check('the covering index migration is in the list migrate() replays',
  /schema_v30\.sql/.test(dbSrc),
  'sql/schema_v30.sql exists but migrate() never runs it');
const idx = (await db.query(
  "SELECT indexdef FROM pg_indexes WHERE indexname = 'trip_econ_day_idx'")).rows;
check('and it exists after the schema is applied', idx.length === 1,
  'trip_econ_day_idx missing — the economics scan will fetch the heap for every row');
if (idx.length) {
  const def = idx[0].indexdef;
  for (const col of ['plate', 'platform', 'fleet_id', 'person_key', 'driver_ext_id',
    'driver_name', 'status', 'payment_type', 'price', 'distance_km', 'requested_at']) {
    check(`  it carries ${col}`, new RegExp(`\\b${col}\\b`).test(def.split('INCLUDE')[1] || ''),
      'a column the endpoints read is missing, so the scan cannot stay in the index');
  }
  check('  and it is keyed on the same Dubai-day expression the queries filter on',
    /\(\(\(requested_at AT TIME ZONE 'Asia\/Dubai'::text\)\)::date\)/.test(def), def);
}

/* ── 5. the landing page is warmed ────────────────────────────────────── */
console.log('\nthe first screen is warmed like every other list view');

const warmSrc = readFileSync('api/warm.js', 'utf8');
for (const p of ['/api/economics/assets', '/api/economics/drivers']) {
  check(`${p} is in the warmer`, warmSrc.includes(`'${p}'`),
    'the default landing page is the one page nothing warms');
}

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
