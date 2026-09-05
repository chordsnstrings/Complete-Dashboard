/* ── money_event is rebuilt where no reader can see it half-built ──────────
   money_event is the provenance record: every figure any provider sent, with
   the API call that sent it still attached. It is rebuilt whole on every
   rollup, and it used to be rebuilt whole in the open — a DELETE and five
   INSERTs as six separate autocommitted statements, with every reader in the
   gap served from whatever fraction of the table happened to exist.

   Measured on production, polling GET /api/money/sources across the
   quarter-hourly pass that fires at 10:00 UTC: seventy-five consecutive
   seconds answering rows=0, amount=0, rows_seen=0, then thirty-five more
   climbing back through 16%, 49% and 92% of the money before the window read
   AED 4,614,074.57 again. 112 seconds of every 900. During the blank phase
   api/public/provenance.js printed "No provider sent a figure for this
   window" — a specific, confident, false sentence, at a moment 21 channels
   had sent 30,764 figures.

   So what these tests pin is not a row count. It is that the rebuild is one
   transaction on one client, that a failed rebuild leaves the previous
   complete table standing, and that one provider's broken table still costs
   only its own rows.

   WHY THE CONCURRENCY IS ASSERTED STRUCTURALLY. The honest test is a second
   connection reading money_event while the rebuild runs. PGlite is a single
   embedded session — there is no second connection to read from, and a read
   issued on the rebuild's own session sees its own uncommitted writes, so it
   would report the empty table that no outside reader can actually observe.
   No Postgres server is available to the suite either. What makes an outside
   reader's snapshot whole under READ COMMITTED is exactly one property — that
   the DELETE and every INSERT are issued on ONE connection between a BEGIN
   and a COMMIT, and never on the pool, which hands out a different backend
   per call — and that property is directly observable from the statement
   sequence. So the sequence is what is asserted, statement by statement,
   against a handle shaped like a pg Pool. The rollback test below is the
   behavioural half: it checks the table itself, not the statements. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshMoneyEvents } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p) => (p === undefined ? db.query(t) : db.query(t, p)).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* Enough of a fixture that all five MONEY_SOURCES have something to insert —
   a priced trip, a payout, a component, a park-ledger line and an imported
   statement day. The amounts do not matter to anything here; that they are
   all present, and stay all present, does. */
let n = 0;
const trip = (plat, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price, currency, raw)
   VALUES ($1,$2,'ecosine','L1','d1','Ann Ahmed',$3::timestamptz,$3::timestamptz+interval '15 min',
           9,'completed',$4,'AED','{}'::jsonb)`,
  [plat, `t${++n}`, `${day}T09:00:00+04`, price]);
for (let d = 1; d <= 4; d++) { await trip('hotel', `2026-08-0${d}`, 150); await trip('yango', `2026-08-0${d}`, 42); }
await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end, earnings, currency)
         VALUES ('uber','ecosine','d1','Ann Ahmed','2026-08-03','2026-08-09', 1400, 'AED')`);
await q(`INSERT INTO driver_earnings_component (platform, driver_ext_id, period_start, period_end, category, parent, amount, currency, driver_name, fleet_id)
         VALUES ('uber','d1','2026-08-03','2026-08-09','your_earnings','earnings',1200,'AED','Ann Ahmed','ecosine')`);
await q(`INSERT INTO ledger_entry (platform, external_id, fleet_id, driver_ext_id, driver_name, event_at, category, amount, currency)
         VALUES ('yango','L-1','ecosine','d1','Ann Ahmed','2026-08-05T10:00:00+04','commission',-33,'AED')`);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day, gross, fees, net, tips, cash, source)
         VALUES ('uber','ecosine','Ann Ahmed','d1','2026-08-02', 900, 100, 800, 20, 40, 'ledger')`);

/* A handle shaped like a pg Pool: it has .connect(), so src/rollup.js must
   take the transaction on a checked-out client rather than through the pool.
   Every statement is recorded with WHICH handle issued it, because that is
   the whole distinction — pg's Pool.query() picks a free connection per call,
   so a BEGIN, a DELETE and a COMMIT sent through it can land on three
   different backends and the DELETE is then simply committed on its own.
   `fail` optionally intercepts one statement and throws instead of running
   it, standing in for the statement_timeout cancellation that really does
   interrupt this rebuild under backfill load. */
function poolLike(target, { failOn = null } = {}) {
  const seen = [];
  let connects = 0, releases = 0;
  const run = (who, t, p) => {
    seen.push({ who, sql: String(t).trim().split('\n')[0].slice(0, 40) });
    if (failOn && String(t).trim().startsWith(failOn)) {
      const e = new Error('canceling statement due to statement timeout');
      e.code = '57014';
      throw e;
    }
    return p === undefined ? target.query(t) : target.query(t, p);
  };
  return {
    seen,
    stats: () => ({ connects, releases }),
    query: (t, p) => run('pool', t, p),
    connect: async () => {
      const id = ++connects;
      return { query: (t, p) => run(`client${id}`, t, p), release: () => { releases++; } };
    },
  };
}
const verb = (s) => s.sql.split(/[\s(]/)[0].toUpperCase();
/* `ROLLBACK TO SAVEPOINT` and `ROLLBACK` share a first word and mean opposite
   things — one discards a single source, the other discards the whole rebuild
   — so the tests below match the statement and not the verb. */
const isAbort = (s) => /^ROLLBACK\s*;?$/i.test(s.sql.trim());

console.log('\nthe rebuild is one transaction on one client');
const poolA = poolLike(db);
const rows = await refreshMoneyEvents(poolA);
const after = await q('SELECT count(*)::int n, round(sum(amount)::numeric,2) s FROM money_event');
check('it still rebuilds the table', rows > 0 && after[0].n === rows, `${rows} / ${after[0].n}`);
check('all five sources landed',
  (await q('SELECT count(DISTINCT source)::int n FROM money_event'))[0].n >= 5,
  JSON.stringify((await q('SELECT DISTINCT source FROM money_event')).map((r) => r.source)));

const who = [...new Set(poolA.seen.map((s) => s.who))];
check('exactly one connection was checked out', poolA.stats().connects === 1, JSON.stringify(poolA.stats()));
check('and it was handed back', poolA.stats().releases === 1, JSON.stringify(poolA.stats()));
/* The failure this replaces: BEGIN through the pool opens a transaction on a
   connection the DELETE never runs on, so the DELETE autocommits and the table
   really is empty to everyone. */
check('nothing at all went through the pool itself',
  who.length === 1 && who[0] === 'client1', JSON.stringify(who));

const verbs = poolA.seen.map(verb);
const begins = verbs.filter((v) => v === 'BEGIN').length;
const commits = verbs.filter((v) => v === 'COMMIT').length;
check('one BEGIN and one COMMIT, not one per source', begins === 1 && commits === 1, `${begins}/${commits}`);
const iBegin = verbs.indexOf('BEGIN'), iCommit = verbs.indexOf('COMMIT');
check('the transaction opens before anything is written and closes after',
  iBegin === 0 && iCommit === verbs.length - 1, JSON.stringify(verbs));
const iDelete = verbs.indexOf('DELETE');
check('the DELETE is inside it', iDelete > iBegin && iDelete < iCommit, `${iBegin}/${iDelete}/${iCommit}`);
const inserts = verbs.map((v, i) => (v === 'INSERT' ? i : -1)).filter((i) => i >= 0);
check('so is every one of the five INSERTs',
  inserts.length === 5 && inserts.every((i) => i > iDelete && i < iCommit),
  JSON.stringify(inserts));
/* The property, stated once as the readers experience it: between the moment
   money_event stops being the old answer and the moment it is the new one,
   there is no committed state at all — so no snapshot can hold a fraction of
   it. Anything that writes the table outside the BEGIN..COMMIT breaks that,
   whatever it is called. */
check('no reader can observe an empty or partial table, because no write to it is committed alone',
  poolA.seen.every((s, i) => !['DELETE', 'INSERT', 'TRUNCATE', 'UPDATE'].includes(verb(s))
    || (i > iBegin && i < iCommit)),
  JSON.stringify(poolA.seen.map((s, i) => `${i}:${verb(s)}`)));

console.log('\na PGlite handle has no pool, and is used directly');
/* Tests inject a PGlite instance, production injects a pg Pool. PGlite is one
   session with no .connect(), so BEGIN/COMMIT through its own query() already
   IS one transaction — the same test withDbLock uses to tell them apart. */
const plain = { seen: [], query(t, p) { this.seen.push(String(t).trim().split('\n')[0]); return p === undefined ? db.query(t) : db.query(t, p); } };
const rows2 = await refreshMoneyEvents(plain);
check('it rebuilds without a .connect() to call', rows2 === rows, `${rows2} vs ${rows}`);
const v2 = plain.seen.map((s) => s.split(/[\s(]/)[0].toUpperCase());
check('and still wraps the whole rebuild in one transaction',
  v2[0] === 'BEGIN' && v2[v2.length - 1] === 'COMMIT'
  && v2.filter((v) => v === 'BEGIN').length === 1, JSON.stringify(v2));

console.log('\na rebuild that fails leaves the previous complete table standing');
/* The reader-facing half of the property, checked against the table rather
   than the statement list. The rebuild is the one deliberately-heavy write in
   the system and it shares the database with the backfills that make it
   necessary; the pool cancels a statement at two minutes. Before this change
   the DELETE was already permanent when that happened, and money_event stayed
   empty until the next pass fifteen minutes later. */
const before = await q('SELECT count(*)::int n, round(sum(amount)::numeric,2) s FROM money_event');
const poolB = poolLike(db, { failOn: 'COMMIT' });
let threw = null;
try { await refreshMoneyEvents(poolB); } catch (e) { threw = e; }
check('the failure is reported and not swallowed', threw && /statement timeout/.test(String(threw)), String(threw));
const now = await q('SELECT count(*)::int n, round(sum(amount)::numeric,2) s FROM money_event');
check('every row a provider sent is still there', now[0].n === before[0].n, `${now[0].n} vs ${before[0].n}`);
check('and so is every figure', String(now[0].s) === String(before[0].s), `${now[0].s} vs ${before[0].s}`);
check('the whole transaction was rolled back', poolB.seen.some(isAbort),
  JSON.stringify(poolB.seen.map((s) => s.sql)));
/* A leaked client is permanent — the pool caps at eight, and eight leaks are
   an API that answers nothing at all. */
check('and the client was handed back on the error path too',
  poolB.stats().releases === 1 && poolB.stats().connects === 1, JSON.stringify(poolB.stats()));

console.log('\none provider’s broken table still costs only its own rows');
/* This is the guarantee that sharing a transaction most easily destroys, and
   the mechanism is worth stating exactly because an earlier version of this
   comment stated it wrongly. In Postgres the first error aborts the whole
   transaction and every later statement fails with "current transaction is
   aborted, commands ignored until end of transaction block" — and the COMMIT
   that follows neither throws nor commits: the server answers it with the
   command tag ROLLBACK and no error whatsoever. So five INSERTs in one
   transaction without savepoints do not empty the provenance record, they
   silently discard the whole rebuild, DELETE included, and leave money_event
   exactly as the last good pass left it while the function returns a
   plausible positive row count and nothing anywhere reports a failure. Stale,
   not blank — which is the harder of the two to notice. Asserted by genuinely
   breaking one source — the park ledger — rather than by simulating the error,
   because the thing being tested is the database's behaviour and not the
   code's bookkeeping.

   The fare below exists only from this point on, and the table standing
   before the broken pass is measured first, so that a rebuild that silently
   rolled itself back cannot be mistaken for one that committed: the two
   differ in their contents even where they might not differ in their size. */
await trip('hotel', '2026-08-09', 777);
const freshRef = `t${n}`;
const standing = await q('SELECT count(*)::int n FROM money_event');
await db.exec('ALTER TABLE ledger_entry RENAME TO ledger_entry_hidden');
const poolC = poolLike(db);
let rows3 = null, err3 = null;
try { rows3 = await refreshMoneyEvents(poolC); } catch (e) { err3 = e; }
check('the pass still completes', err3 === null, String(err3));
const srcs = (await q('SELECT DISTINCT source FROM money_event')).map((r) => r.source);
check('the four working sources committed anyway', srcs.length >= 4 && rows3 > 0,
  JSON.stringify(srcs));
check('the broken one is absent rather than fabricated', !srcs.includes('yango_park_ledger'),
  JSON.stringify(srcs));
/* THE OUTCOME, NOT THE STATEMENT. This check used to ask only whether a
   COMMIT had been issued and no bare ROLLBACK with it, which is not the same
   question as whether the transaction committed — Postgres answers a COMMIT
   sent inside an aborted transaction with the command tag ROLLBACK and no
   error, so a savepoint-less run issues its BEGIN, its DELETE, its five
   INSERTs and its COMMIT and no ROLLBACK — everything the old assertion
   looked at, exactly as it looks here — and passed it unchanged while
   committing nothing. What tells the two apart is the table afterwards. A real commit
   leaves exactly the rows this pass inserted and nothing else — so the count
   the function returned is the count in the table, and the fare added just
   above, which no earlier pass could have written, is in there. A silent
   rollback leaves the rows that were standing before, that fare missing and
   the park ledger it was supposed to have dropped still present. Measured
   with the savepoints stripped out of src/rollup.js: 11 rows returned against
   the 12 that were standing, and the new fare nowhere in the table. */
const kept = await q(
  `SELECT count(*)::int n, count(*) FILTER (WHERE external_ref = $1)::int fresh FROM money_event`,
  [freshRef]);
check('the transaction survived the error and committed — the rows are in the table afterwards',
  kept[0].n === rows3 && kept[0].fresh === 1
  && poolC.seen.some((s) => verb(s) === 'COMMIT') && !poolC.seen.some(isAbort),
  `${kept[0].n} in the table, ${rows3} returned, ${standing[0].n} standing before, fresh=${kept[0].fresh}`);
/* Rolled back only as far as the source that failed — which is what keeps the
   other four alive inside a transaction Postgres would otherwise have aborted
   entirely on the first error. */
check('and only the failing source was rolled back, to its savepoint',
  poolC.seen.filter((s) => /^ROLLBACK TO SAVEPOINT/i.test(s.sql)).length === 1,
  JSON.stringify(poolC.seen.map((s) => s.sql)));
await db.exec('ALTER TABLE ledger_entry_hidden RENAME TO ledger_entry');
await refreshMoneyEvents(db);
/* Repinned from `=== 1`. The 1 was the number of money_event rows this
   fixture's single ledger_entry line happens to produce — the fixture's
   shape, not the property being checked, and red the moment anyone adds a
   second ledger line. The park ledger source emits exactly one money_event
   per ledger_entry row that has an amount and an event_at, so that count IS
   the property — the source is back and back whole — and it holds for any
   fixture. The `want > 0` guard is there so an empty ledger_entry can never
   make this pass by making both sides zero. */
const led = await q(`SELECT
    (SELECT count(*) FROM money_event WHERE source = 'yango_park_ledger')::int got,
    (SELECT count(*) FROM ledger_entry WHERE amount IS NOT NULL AND event_at IS NOT NULL)::int want`);
check('and the source comes back whole the moment its table does',
  led[0].want > 0 && led[0].got === led[0].want, `${led[0].got} of ${led[0].want}`);

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
