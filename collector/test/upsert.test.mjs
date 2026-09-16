/* ── the write path, which every collector shares ──────────────────────────
   upsertMany sent one INSERT per row. A year backfill writes about 165,000
   trips, so it sent 165,000 statements to a managed database on another host,
   and that — not the writing — is why a backfill pinned a one-vCPU Postgres
   for hours while every dashboard page timed out behind it.

   Batching it is only safe if the batch behaves exactly as the sequence did,
   and there are three ways it would not: rows in one call can carry different
   columns, a conflict key repeated inside one statement makes Postgres refuse
   the whole thing, and a wide table can cross the bind-parameter limit. Each
   has its own test below, and each is a thing the row-at-a-time version got
   right for free. */
import { PGlite } from '@electric-sql/pglite';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await db.exec(`
  CREATE TABLE thing (
    k1 TEXT NOT NULL, k2 TEXT NOT NULL,
    a TEXT, b INT, c TEXT, wide1 TEXT, wide2 TEXT,
    PRIMARY KEY (k1, k2)
  );
  CREATE TABLE counter (n INT);
  INSERT INTO counter VALUES (0);
`);

/* upsertMany takes its pool from src/db.js, which wants a real DATABASE_URL.
   Rather than stand up Postgres, the module's pool is replaced with one backed
   by PGlite — the code under test is the SQL it builds, and PGlite runs real
   Postgres. Every query is counted, because the point of the change is how
   MANY there are. */
let statements = 0;
const fakePool = {
  async connect() {
    return {
      query: async (text, params) => { statements++; return db.query(text, params); },
      release() {},
    };
  },
  query: (t, p) => db.query(t, p),
};
/* src/db.js closes over its own pool, and importing it needs a real
   DATABASE_URL. The function is therefore re-created from the SHIPPED SOURCE
   with the fake pool injected — a copy of the logic in this file would drift
   from it and quietly stop testing anything. */
import { readFileSync } from 'node:fs';
const src = readFileSync('src/db.js', 'utf8');
const body = src.slice(src.indexOf('export async function upsertMany'))
  .replace('export async function upsertMany', 'async function upsertMany');
const end = body.indexOf('\n}\n', body.indexOf('return n;')) + 2;
// eslint-disable-next-line no-new-func
const makeUpsert = new Function('pool', `${body.slice(0, end)}; return upsertMany;`);
const upsert = makeUpsert(fakePool);

console.log('\nit writes what it was given');

statements = 0;
const rows = Array.from({ length: 250 }, (_, i) => ({
  k1: 'x', k2: `r${i}`, a: `a${i}`, b: i, c: null,
}));
const n = await upsert('thing', rows, ['k1', 'k2']);
check('every row lands', n === 250, String(n));
const [{ cnt }] = (await db.query('SELECT count(*)::int cnt FROM thing')).rows;
check('and the table holds them all', cnt === 250, String(cnt));
check('in a handful of statements, not one per row', statements < 20,
  `${statements} statements for 250 rows`);
const [{ b }] = (await db.query(`SELECT b FROM thing WHERE k2 = 'r7'`)).rows;
check('with their values intact', b === 7, String(b));

console.log('\nre-running replaces rather than duplicating');

const again = await upsert('thing', rows.map((r) => ({ ...r, a: `${r.a}!` })), ['k1', 'k2']);
check('the second run reports the same count', again === 250, String(again));
const [{ cnt2 }] = (await db.query('SELECT count(*)::int cnt2 FROM thing')).rows;
check('and the table has not grown', cnt2 === 250, String(cnt2));
const [{ a }] = (await db.query(`SELECT a FROM thing WHERE k2 = 'r7'`)).rows;
check('the newer value won', a === 'a7!', a);

console.log('\na conflict key repeated inside one batch');

/* Postgres refuses a statement that updates one row twice — the row-at-a-time
   version never met the rule, because each row was its own statement and the
   last simply overwrote the earlier. The batch has to reproduce that. */
const dupes = [
  { k1: 'd', k2: '1', a: 'first' },
  { k1: 'd', k2: '1', a: 'second' },
  { k1: 'd', k2: '1', a: 'third' },
  { k1: 'd', k2: '2', a: 'other' },
];
let threw = null;
try { await upsert('thing', dupes, ['k1', 'k2']); } catch (e) { threw = String(e); }
check('does not blow up the whole batch', threw === null, String(threw).slice(0, 90));
const [{ a: dupA }] = (await db.query(`SELECT a FROM thing WHERE k1='d' AND k2='1'`)).rows;
check('and the last one wins, as a sequence would have left it', dupA === 'third', dupA);

console.log('\nrows that do not share a column list');

/* The sources build their row objects field by field and omit what a provider
   did not send, so one call really does carry several shapes. */
statements = 0;
const mixed = [
  { k1: 'm', k2: '1', a: 'has-a' },
  { k1: 'm', k2: '2', b: 42 },
  { k1: 'm', k2: '3', a: 'both', b: 7 },
  { k1: 'm', k2: '4', a: 'has-a-too' },
];
const mn = await upsert('thing', mixed, ['k1', 'k2']);
check('all shapes are written', mn === 4, String(mn));
const got = (await db.query(`SELECT k2, a, b FROM thing WHERE k1='m' ORDER BY k2`)).rows;
check('each row keeps only what it carried',
  got[0].a === 'has-a' && got[0].b === null
  && got[1].a === null && got[1].b === 42
  && got[2].a === 'both' && got[2].b === 7,
  JSON.stringify(got));
check('grouped into one statement per shape, not one per row', statements <= 3 * 3,
  `${statements} statements for 3 shapes`);

console.log('\nthe bind-parameter ceiling');

/* Postgres allows 65,535 parameters per statement. A wide table with a large
   chunk crosses it, and the failure is a hard error on a batch that looked
   fine in testing with narrow rows. */
statements = 0;
const wide = Array.from({ length: 400 }, (_, i) => ({
  k1: 'w', k2: `r${i}`, a: 'x', b: i, c: 'y', wide1: 'p', wide2: 'q',
}));
const wn = await upsert('thing', wide, ['k1', 'k2'], 40000);   // absurd chunk on purpose
check('a huge chunk is split rather than refused', wn === 400, String(wn));
const [{ cnt3 }] = (await db.query(`SELECT count(*)::int cnt3 FROM thing WHERE k1='w'`)).rows;
check('and every row still lands', cnt3 === 400, String(cnt3));

console.log('\nnothing to write is not an error');
check('an empty list writes nothing and says so', (await upsert('thing', [], ['k1', 'k2'])) === 0);

console.log('\nan update that changes nothing does not rewrite the row');

/* WHY THIS IS TESTED ON xmin AND NOT ON THE VALUES.
   ─────────────────────────────────────────────────────────────────────────
   The defect is invisible in the data: before the fix and after it, the table
   holds exactly the same rows with exactly the same values. What differed was
   the COST — Postgres has no in-place update, so an UPDATE that sets every
   column to the value already stored still writes a new row version and leaves
   the old one as a dead tuple for every sequential scan to read past.

   src/sources/uber.js:1919 re-upserts every status entry of every driver into
   driver_status_event on every live tick (default 120 s), and the call site
   calls that write "idempotent by construction". It was idempotent in its
   result and not in its cost: `SELECT min(at) FROM driver_status_event`, over
   a table two days old, took 67 to 109 seconds on production on 2026-09-16,
   which is what /api/unauthorized/attributed was waiting on even for a window
   holding zero segments.

   xmin is the transaction that wrote the live version of a row, so it is the
   one observable that distinguishes "not rewritten" from "rewritten with the
   same bytes". Revert the WHERE clause in src/db.js and these four checks go
   red while every value assertion in this file stays green — which is exactly
   the shape of defect that needs a test that is not about values. */
await db.exec(`INSERT INTO thing (k1, k2, a, b) VALUES ('x', '1', 'same', 5)`);
const xminOf = async () => (await db.query(
  `SELECT xmin::text AS x FROM thing WHERE k1='x' AND k2='1'`)).rows[0].x;
const before = await xminOf();

await upsert('thing', [{ k1: 'x', k2: '1', a: 'same', b: 5 }], ['k1', 'k2']);
check('an identical row is not rewritten', (await xminOf()) === before,
  `xmin ${before} -> ${await xminOf()}`);

await upsert('thing', [{ k1: 'x', k2: '1', a: 'different', b: 5 }], ['k1', 'k2']);
const afterReal = await xminOf();
const [realRow] = (await db.query(`SELECT a, b FROM thing WHERE k1='x' AND k2='1'`)).rows;
check('a row that really changed still is', afterReal !== before && realRow.a === 'different',
  `${afterReal} vs ${before}, a=${realRow.a}`);

/* NULL IS WHERE '<>' WOULD HAVE BEEN WRONG. `a <> EXCLUDED.a` is NULL — not
   true — whenever either side is NULL, so a guard written with <> would refuse
   to write a value over a NULL and refuse to clear a value back to NULL, and
   both are real corrections a provider can send. IS DISTINCT FROM is the form
   that treats NULL as a value, and these two checks are the reason it is. */
await upsert('thing', [{ k1: 'x', k2: '1', a: null, b: 5 }], ['k1', 'k2']);
const [cleared] = (await db.query(`SELECT a FROM thing WHERE k1='x' AND k2='1'`)).rows;
check('a value cleared to NULL is still written', cleared.a === null, JSON.stringify(cleared));

await upsert('thing', [{ k1: 'x', k2: '1', a: 'filled', b: 5 }], ['k1', 'k2']);
const [filled] = (await db.query(`SELECT a FROM thing WHERE k1='x' AND k2='1'`)).rows;
check('and a NULL filled in is written too', filled.a === 'filled', JSON.stringify(filled));

/* THE SINGLE-ROW WRITER CARRIES THE SAME GUARD, and is tested here rather
   than trusted: two writers with one rule between them is a rule a caller has
   to know which function it picked to rely on. Extracted from the shipped
   source for the same reason upsertMany is — a copy of the logic would drift
   from it and quietly stop testing anything. */
const oneBody = src.slice(src.indexOf('export async function upsert('))
  .replace('export async function upsert(', 'async function upsertOne(');
const oneEnd = oneBody.indexOf('\n}\n') + 2;
// eslint-disable-next-line no-new-func
const upsertOne = new Function('pool', `${oneBody.slice(0, oneEnd)}; return upsertOne;`)(fakePool);

await db.exec(`INSERT INTO thing (k1, k2, a, b) VALUES ('y', '1', 'same', 9)`);
const yminOf = async () => (await db.query(
  `SELECT xmin::text AS x FROM thing WHERE k1='y' AND k2='1'`)).rows[0].x;
const yBefore = await yminOf();
await upsertOne('thing', { k1: 'y', k2: '1', a: 'same', b: 9 }, ['k1', 'k2']);
check('upsert() does not rewrite an identical row either', (await yminOf()) === yBefore,
  `xmin ${yBefore} -> ${await yminOf()}`);
await upsertOne('thing', { k1: 'y', k2: '1', a: 'moved', b: 9 }, ['k1', 'k2']);
const [yRow] = (await db.query(`SELECT a FROM thing WHERE k1='y' AND k2='1'`)).rows;
check('and still writes one that changed', yRow.a === 'moved', JSON.stringify(yRow));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
