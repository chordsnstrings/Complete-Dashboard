/* ── one definition of "the same person", in three places ──────────────────
   A human is several records — a UUID from Uber, another from Yango, a third
   from Bolt — and the only thing they share is a name entered inconsistently.
   So a fold turns "Najeeb Ullah Khan Khan" and "najeeb  ullah khan" into one
   key, and every question about a PERSON groups on it.

   The fold now exists three times: as CANON in api/server.js, as personFold in
   api/custody_sql.js, and as a stored generated column in sql/schema_v20.sql.
   The stored one is why /api/roster went from 21 seconds to under one — the
   fold was being evaluated over all 175,000 trips on every request — but three
   copies of a definition is exactly how two people quietly become one, or one
   becomes two, on a page nobody was looking at.

   So they are checked against each other, on the inputs that made the fold
   necessary in the first place. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { personFold, personKey, personKeyStored } from '../api/custody_sql.js';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','E') ON CONFLICT DO NOTHING`);

/* Extracting CANON from api/server.js by reading the source text was the first
   attempt, and it produced a fold that did nothing: in JS source '\\s+' is a
   backslash followed by s, and only becomes the whitespace class once the
   string literal is parsed. The lifted text went into SQL with the escaping
   still doubled, matched nothing, and reported the PRODUCT as broken.

   The fix was not a better extractor. server.js now imports personFold instead
   of keeping its own copy, so there is one JS definition to import here — which
   is what the test was trying to prove in the first place. */
const CANON = personFold;

const NAMES = [
  'Najeeb Ullah Khan Khan',        // the duplicated final word that started this
  'najeeb  ullah   khan',          // whitespace and case
  '  Muhammad Asif Zada  ',        // leading and trailing space
  'Gul Gul Rahman',                // a duplicate that is not the final pair
  'Ali Ali Ali Rahman',            // three in a row
  'SARA IQBAL',
  'Sara Iqbal',
  'Jean-Pierre Dupont',            // punctuation the fold must not touch
  "O'Brien Patrick",
  'Ahmed',                         // single word
  'أحمد الفلاني',                   // non-latin: the fold must not mangle it
];
let n = 0;
for (const name of NAMES) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status)
           VALUES ('uber', $1, 'ecosine', $2, $3, now(), 'completed')`, [`t${n}`, `d${n}`, name]);
  await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state)
           VALUES ('uber', $1, 'ecosine', $2, 'active')`, [`d${n}`, name]);
  n++;
}

console.log('\nperson_key: the stored column equals the expression it replaced');

const rows = await q(
  `SELECT driver_name, person_key,
          ${CANON('driver_name')} AS canon_server,
          ${personFold('driver_name')} AS canon_custody
   FROM trip ORDER BY external_id`);

check('every trip row stores exactly what CANON in api/server.js computes',
  rows.every((r) => r.person_key === r.canon_server),
  rows.filter((r) => r.person_key !== r.canon_server)
    .map((r) => `${JSON.stringify(r.driver_name)}: stored=${JSON.stringify(r.person_key)} canon=${JSON.stringify(r.canon_server)}`).join('; '));
check('and exactly what personFold in api/custody_sql.js computes',
  rows.every((r) => r.person_key === r.canon_custody),
  rows.filter((r) => r.person_key !== r.canon_custody)
    .map((r) => `${JSON.stringify(r.driver_name)}: stored=${JSON.stringify(r.person_key)} fold=${JSON.stringify(r.canon_custody)}`).join('; '));

const dps = await q(`SELECT full_name, person_key, ${CANON('full_name')} AS canon FROM driver_platform_state`);
check('the roster table folds identically, so a roster row and a trip row agree',
  dps.every((r) => r.person_key === r.canon));
/* And the JS copy does not come back. api/server.js kept its own character-for
   -character duplicate of this expression; the moment two copies exist, one of
   them is eventually edited alone. */
check('api/server.js imports the fold rather than defining its own',
  /const CANON = personFold;/.test(readFileSync('api/server.js', 'utf8'))
  && !/const CANON = \(col\) =>/.test(readFileSync('api/server.js', 'utf8')));

console.log('\nperson_key: the folds it was built to make');

const key = async (name) => (await q(
  `SELECT person_key FROM trip WHERE driver_name = $1`, [name]))[0]?.person_key;

check('a duplicated final word collapses', await key('Najeeb Ullah Khan Khan') === 'najeeb ullah khan');
check('case and repeated whitespace collapse to the same key',
  await key('najeeb  ullah   khan') === await key('Najeeb Ullah Khan Khan'));
check('leading and trailing space is trimmed', await key('  Muhammad Asif Zada  ') === 'muhammad asif zada');
check('a duplicate that is not the final pair collapses too',
  await key('Gul Gul Rahman') === 'gul rahman');
check('three of the same word in a row collapse to one',
  await key('Ali Ali Ali Rahman') === 'ali rahman');
check('case alone is not a different person',
  await key('SARA IQBAL') === await key('Sara Iqbal'));

console.log('\nperson_key: what it must NOT do');

/* Merging two real people is worse than showing one twice, so the fold has to
   be conservative about everything except the specific noise it targets. */
check('a hyphenated name is left intact', await key('Jean-Pierre Dupont') === 'jean-pierre dupont');
check('an apostrophe is left intact', await key("O'Brien Patrick") === "o'brien patrick");
check('a single-word name survives', await key('Ahmed') === 'ahmed');
check('a non-latin name is not mangled', await key('أحمد الفلاني') === 'أحمد الفلاني');

// A NULL name has no person, and must not become the empty-string person —
// that would fold every anonymous row into one very busy driver.
await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, requested_at, status)
         VALUES ('uber','tnull','ecosine','dnull', now(), 'completed')`);
const [nul] = await q(`SELECT person_key FROM trip WHERE external_id = 'tnull'`);
check('a row with no driver name has no person key, rather than an empty one',
  nul.person_key === null, JSON.stringify(nul.person_key));
check('and the index excludes it, so it cannot become a shared bucket',
  /WHERE person_key IS NOT NULL AND person_key <> ''/.test(readFileSync('sql/schema_v20.sql', 'utf8')));

console.log('\nperson_key: it is maintained, not merely populated once');

/* The reason this is a generated column and not a cached copy: a cache drifts
   the moment a row is updated and nobody remembers to refresh it. */
await q(`UPDATE trip SET driver_name = 'Renamed  Person Person' WHERE external_id = 't0'`);
const [renamed] = await q(`SELECT person_key FROM trip WHERE external_id = 't0'`);
check('an updated name updates the stored key with it',
  renamed.person_key === 'renamed person', JSON.stringify(renamed.person_key));

console.log('\nthe cross-platform table groups on the stored fold');

/* The fold is two nested regexes. schema_v20 stored it as a generated column
   with an index and recorded the measurement in its own header — the same
   aggregate costs 2,434ms computing the regex and 129ms reading the column —
   and /api/drivers/cross-platform was the last route still computing it, on
   the page whose other two panels were already fast.

   Two things have to hold, and both are easy to get wrong:
   the grouping key must be the stored column, and the WHERE must NOT be. */
{
  const src = readFileSync('api/server.js', 'utf8');
  const at = src.indexOf("app.get('/api/drivers/cross-platform'");
  const body = src.slice(at, src.indexOf('res.json({ platforms', at));
  check('it groups on the stored column', /GROUP BY t\.person_key/.test(body));
  check('and no longer recomputes the fold in the SQL',
    !/regexp_replace/.test(body) && !/\$\{CANON\(/.test(body),
    'the regex is back in the grouping key');
  /* Making the predicate match the partial index's definition is what took the
     driver directory from 4.3 seconds to 41: the planner chose that index and
     walked most of the table with it. person_key is the key, never the
     filter. */
  check('the filter still tests the name, not the indexed column',
    /coalesce\(btrim\(n\.driver_name\), ''\) <> ''/.test(body)
    && !/WHERE[^)]*person_key\s*(IS NOT NULL|<>)/.test(body),
    'a person_key predicate here makes the planner choose the partial index');
  /* The population used to come from a SECOND full aggregation at the same
     grain — the whole window grouped by person again, to count how many people
     there are and how many work more than one channel. It rides on the first
     aggregation now. The small DISTINCT-platform lookup above it is a
     different thing and is left alone: it decides which per-platform columns
     the response carries, and taking it from a rollup would add a column of
     zeros for a platform whose trips carry no driver name. */
  check('the population rides on the one aggregation, not a second of them',
    /count\(\*\) OVER \(\)/.test(body)
    && (body.match(/GROUP BY t\.person_key/g) || []).length === 1
    && !/GROUP BY 1\) s/.test(body),
    'the window is still grouped by person twice');
}

console.log('\nthe money tables fold people the same way');

/* sql/schema_v51.sql put the same generated column on driver_statement_day and
   driver_payout_day, because /api/reconcile folds BOTH of them per row and the
   slow-query log measured the pair at eight seconds. Four copies of one
   expression now exist in SQL; each one is a chance for a person's money and a
   person's work to end up under two different keys. */
let m = 0;
for (const name of NAMES) {
  m++;
  await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_ext_id, driver_name, day,
             net, tips, salik, cash, source, pseudo)
           VALUES ('uber', 'ecosine', $1, $2, date '2026-05-01' + $3::int, 100, 0, 0, 0, 'uber_rest', false)`,
    [`s${m}`, name, m]);
  await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
             period_start, period_end, earnings, cash_earnings)
           VALUES ('uber', 'ecosine', $1, $2, date '2026-05-01' + $3::int,
                   date '2026-05-01' + $3::int, date '2026-05-01' + $3::int, 100, 0)`,
    [`p${m}`, name, m]);
}
for (const [table, col] of [['driver_statement_day', 'driver_name'], ['driver_payout_day', 'driver_name']]) {
  const got = await q(`SELECT ${col} AS nm, person_key, ${CANON(col)} AS canon FROM ${table}`);
  check(`${table} stores exactly what the JS fold computes`,
    got.length === NAMES.length && got.every((r) => r.person_key === r.canon),
    got.filter((r) => r.person_key !== r.canon)
      .map((r) => `${JSON.stringify(r.nm)}: ${JSON.stringify(r.person_key)} vs ${JSON.stringify(r.canon)}`).join('; '));
}
/* And the two agree with each other, which is the property /api/reconcile
   depends on: it joins a statement row to a payout row ON this key, so a fold
   that differed by a space would compare a person against nobody and report
   the platform as having paid for work it never reported. */
const [{ joined }] = await q(
  `SELECT count(*)::int AS joined FROM driver_statement_day s
     JOIN driver_payout_day p ON p.person_key = s.person_key AND p.day = s.day`);
check('a statement row and a payout row for the same human join on the key',
  joined === NAMES.length,
  `${joined} of ${NAMES.length} — one pair per name, and a fold that differed `
  + 'on any of them by a space would leave that pair unjoined');

/* The anonymous row, on the tables where money lives: an empty key here would
   pool every unnamed payout under one person and hand them the fleet's cash. */
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, day,
           period_start, period_end, earnings, cash_earnings)
         VALUES ('uber', 'ecosine', 'p-anon', date '2026-06-01', date '2026-06-01', date '2026-06-01', 99, 0)`);
const [anon] = await q(`SELECT person_key FROM driver_payout_day WHERE driver_ext_id = 'p-anon'`);
check('a payout with no driver name has no person key', anon.person_key === null,
  JSON.stringify(anon.person_key));
/* personKeyStored is what the endpoint actually writes, and it has to answer
   the id for exactly that row rather than NULL — a NULL person groups every
   anonymous payout together again one level up. */
const [{ k }] = await q(
  `SELECT ${personKeyStored('p')} AS k FROM driver_payout_day p WHERE p.driver_ext_id = 'p-anon'`);
check('…and personKeyStored falls back to the id, as personKey always did',
  k === 'p-anon', JSON.stringify(k));
const [{ same }] = await q(
  `SELECT count(*)::int AS same FROM driver_payout_day p
    WHERE ${personKeyStored('p')} IS DISTINCT FROM ${personKey('p.driver_ext_id', 'p.driver_name')}`);
check('and answers identically to the expression it replaced, on every row',
  same === 0, `${same} row(s) differ`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
