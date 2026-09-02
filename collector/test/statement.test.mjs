/* ── the statement view of the money ───────────────────────────────────────
   Reconciling against the operator's ledger settled what our payout figure IS:
   netOutstanding, the amount the platform wires to the bank — statement net
   MINUS cash the drivers already collected, PLUS tips and tolls. A reader
   shown one where they expect the other reports a 13% "gap" that is actually
   drivers taking a fifth of fares in cash. So both figures now exist, side by
   side, and these tests are about the ways that goes wrong: the two getting
   ADDED, a statement row winning a payout day, an import that double-writes on
   re-run, or a pseudo-driver ("Not Match") appearing in a driver list. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const { server } = await mountAll(db);
const port = server.address().port;
const req = async (path, opts) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (path, body) => req(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

console.log('\nimporting the ledger');

const rows = [
  { date: '2026-08-03', driver: 'Amina Rashid', company: 'Ecosine', platform: 'Uber',
    gross: 500, fees: 130, net: 370, tips: 10, salik: 12, cash: 80, bank: 312, trips: 14 },
  { date: '2026-08-04', driver: 'AMINA  RASHID', company: 'Ecosine', platform: 'Uber',
    gross: 400, fees: 104, net: 296, tips: 0, salik: 8, cash: 60, bank: 244, trips: 11 },
  { date: '2026-08-03', driver: 'Bilal Noor', company: 'Egari', platform: 'Bolt',
    gross: 200, fees: 50, net: 150, tips: 0, salik: 0, cash: 150, bank: 0, trips: '' },
  { date: '2026-08-03', driver: 'Not Match', company: 'Ecosine', platform: 'Uber',
    gross: 90, fees: 20, net: 70, cash: 70, bank: 0, pseudo: true },
  { date: 'garbage', driver: 'X', company: 'Ecosine', platform: 'Uber', net: 1 },
];
const imp = await post('/api/import/statement-days', { rows, source: 'ledger', done: true });
check('the import answers with what it did', imp.status === 200 && imp.body?.written === 4,
  JSON.stringify(imp.body));
check('and names what it refused', imp.body?.rejected === 1);

const imp2 = await post('/api/import/statement-days', { rows: rows.slice(0, 3), source: 'ledger' });
check('a re-run replaces rather than duplicates', imp2.status === 200);
const [{ n }] = (await db.query(`SELECT count(*)::int n FROM driver_statement_day`)).rows;
check('four rows stored after two imports of overlapping batches', n === 4, String(n));
check('name case and double spaces fold to one driver',
  (await db.query(`SELECT count(DISTINCT name_key)::int n FROM driver_statement_day
                   WHERE NOT pseudo AND platform='uber'`)).rows[0].n === 1);
/* ── the run row the import writes about itself ────────────────────────────
   It used to be
     INSERT INTO collection_run (...)
     SELECT $1,'ecosine','import','ok', count(*), now()
       FROM driver_statement_day WHERE source = $1
   — a count of the WHOLE table under a hard-coded fleet. On production that
   read 39,797 rows against Ecosine nine days running, whatever the workbook
   held and whichever companies it named; a number that can only grow cannot
   say "this import landed nothing", which is the one failure a reader needs
   to hear about. See src/sources/ledger.js. */
{
  const runs = (await db.query(
    `SELECT fleet_id, mode, status, rows_written,
            to_char(window_start,'YYYY-MM-DD') s, to_char(window_end,'YYYY-MM-DD') e
       FROM collection_run WHERE source='ledger' ORDER BY fleet_id`)).rows;
  check('the import moved the data version (a collection run exists for it)',
    runs.length > 0);
  check('one run per fleet the workbook actually named, not a hard-coded ecosine',
    runs.map((r) => r.fleet_id).join(',') === 'ecosine,egari',
    runs.map((r) => r.fleet_id).join(','));
  check('carrying the rows THIS import wrote, not the size of the table',
    runs[0].rows_written === 3 && runs[1].rows_written === 1,
    runs.map((r) => `${r.fleet_id}:${r.rows_written}`).join(' '));
  check('and the days it covered, so a reader can see which months it was for',
    runs.every((r) => r.s === '2026-08-03' && r.e === '2026-08-04'),
    runs.map((r) => `${r.s}..${r.e}`).join(' '));
  check('the answer says the same thing the run row does',
    imp.body?.fleets?.ecosine === 3 && imp.body?.fleets?.egari === 1,
    JSON.stringify(imp.body?.fleets));
}

/* A batched import: only the last POST carries done:true, and the run must
   still describe the whole workbook. The handler that records it sees 400 rows
   of a 39,797-row import, which is exactly why the count(*) form was reached
   for — so the tally is what makes the honest number available at all. */
{
  await db.query(`DELETE FROM collection_run WHERE source='batched'`);
  const b1 = [
    { date: '2026-07-01', driver: 'Batch One', company: 'Ecosine', platform: 'Uber', net: 10 },
    { date: '2026-07-02', driver: 'Batch Two', company: 'Egari', platform: 'Bolt', net: 20 },
  ];
  const b2 = [
    { date: '2026-07-09', driver: 'Batch Three', company: 'Ecosine', platform: 'Uber', net: 30 },
  ];
  await post('/api/import/statement-days', { rows: b1, source: 'batched', done: false });
  const last = await post('/api/import/statement-days', { rows: b2, source: 'batched', done: true });
  const runs = (await db.query(
    `SELECT fleet_id, rows_written, to_char(window_start,'YYYY-MM-DD') s,
            to_char(window_end,'YYYY-MM-DD') e
       FROM collection_run WHERE source='batched' ORDER BY fleet_id`)).rows;
  check('a batched import records every batch, not only the last one',
    runs.length === 2 && runs[0].rows_written === 2 && runs[1].rows_written === 1,
    runs.map((r) => `${r.fleet_id}:${r.rows_written}`).join(' '));
  check('and its window spans the whole workbook, not the final batch',
    runs.every((r) => r.s === '2026-07-01' && r.e === '2026-07-09'),
    runs.map((r) => `${r.s}..${r.e}`).join(' '));
  check('the tally is cleared once the run is recorded, so the next import '
    + 'does not inherit this one\u2019s count',
    (await db.query(`SELECT count(*)::int n FROM source_state
                     WHERE source='batched' AND key='import_tally'`)).rows[0].n === 0);
  check('the last batch answers with what the whole import landed',
    last.body?.fleets?.ecosine === 2 && last.body?.fleets?.egari === 1,
    JSON.stringify(last.body?.fleets));
  /* Scaffolding out of the money table. These rows exist to prove the run row,
     not to be revenue, and everything below this line counts what the ledger
     and the API-derived statements hold. */
  await db.query(`DELETE FROM driver_statement_day WHERE source='batched'`);
}

/* The case the count(*) form could never report: an import that RAN and landed
   nothing. The table still holds everything the last import left, so the old
   row said 39,797 and 'ok'. */
{
  const junk = await post('/api/import/statement-days', {
    rows: [{ date: '2026-07-01', driver: 'Nobody', company: 'Ecosine', platform: 'yay', net: 5 }],
    source: 'blankimport', done: true });
  check('an import whose every row was rejected still records a run', junk.status === 200);
  const r = (await db.query(
    `SELECT fleet_id, status, rows_written, error FROM collection_run
      WHERE source='blankimport'`)).rows;
  check('...and that run says it wrote nothing, as an error rather than an ok',
    r.length === 1 && r[0].rows_written === 0 && r[0].status === 'error',
    JSON.stringify(r));
  check('with no fleet attributed to it, because the workbook named none',
    r[0].fleet_id === null, String(r[0].fleet_id));
  check('and a reason a person can act on', /rejected|held none/.test(String(r[0].error)),
    String(r[0].error));
}

/* ── the importer writes into the money tables, so it checks what it writes ──
   platform and company were lowercased and inserted with no allow-list, though
   FLEETS is declared in the same file and validated elsewhere. Measured on
   production 2026-09-02: a platform called `yay` — 22 rows, AED 881.98,
   2026-02-14 to 2026-04-06, across both fleets — is in driver_statement_day
   now, and therefore in money_event, so "Where the money came from" was
   offering a misspelling as a revenue source. It did no further harm only
   because every money read filters source='ledger' out, which is a coincidence
   of this importer's other job rather than a defence. */
console.log('\nthe importer refuses a platform or a fleet it does not know');

{
  const before = (await db.query('SELECT count(*)::int n FROM driver_statement_day')).rows[0].n;
  const junk = await post('/api/import/statement-days', {
    rows: [
      { date: '2026-08-05', driver: 'Typo Person', company: 'Ecosine', platform: 'yay', net: 400 },
      { date: '2026-08-05', driver: 'Typo Person', company: 'Ecosien', platform: 'Uber', net: 400 },
    ],
    source: 'ledger',
  });
  check('a misspelled platform is refused', junk.status === 200 && junk.body?.written === 0,
    JSON.stringify(junk.body));
  check('…and so is a misspelled fleet', junk.body?.rejected === 2, JSON.stringify(junk.body));
  /* Refused, not silently dropped: an import that discards a row without
     saying so is how somebody spends an afternoon looking for money they
     believe they uploaded. */
  check('…and the refusal is reported rather than swallowed',
    Array.isArray(junk.body?.bad) ? junk.body.bad.length === 2 : junk.body?.rejected === 2,
    JSON.stringify(junk.body));
  const after = (await db.query('SELECT count(*)::int n FROM driver_statement_day').then((r) => r.rows))[0].n;
  check('nothing reached the money table', after === before, `${before} → ${after}`);
  check('and no invented platform is in it',
    (await db.query(`SELECT count(*)::int n FROM driver_statement_day WHERE platform = 'yay'`))
      .rows[0].n === 0);
  /* And the gate must not have swallowed the good case with the bad. */
  const good = await post('/api/import/statement-days', {
    rows: [{ date: '2026-08-06', driver: 'Real Person', company: 'Ecosine', platform: 'Uber', net: 50 }],
    source: 'ledger',
  });
  check('a platform and fleet it does know still import',
    good.status === 200 && good.body?.written === 1, JSON.stringify(good.body));
}

console.log('\nthe ledger is reference, not display');

/* The workbook was given to understand the calculation, not to be a source on
   the platform: displayed statement figures come from API sources only. The
   ledger rows stay stored — they verify the API numbers in tests and hold the
   only record of months no API serves — but no endpoint surfaces them. */
const kLedger = (await req('/api/kpis?from=2026-08-01&to=2026-08-31')).body;
check('ledger rows do not surface in kpis', kLedger.statement_net == null,
  String(kLedger.statement_net));
const revLedger = (await req('/api/revenue?from=2026-08-01&to=2026-08-31')).body;
check('nor on the revenue page',
  (revLedger.platforms || []).every((r) => r.statement_net == null));

/* An API-sourced statement — the uber statement report — IS displayed. */
await post('/api/import/statement-days', {
  rows: [
    { date: '2026-08-03', driver: 'Amina Rashid', company: 'Ecosine', platform: 'Uber',
      gross: 500, fees: 130, net: 370, tips: 10, salik: 12, cash: 80, bank: 312, trips: 14 },
    { date: '2026-08-04', driver: 'AMINA  RASHID', company: 'Ecosine', platform: 'Uber',
      gross: 400, fees: 104, net: 296, tips: 0, salik: 8, cash: 60, bank: 244, trips: 11 },
    { date: '2026-08-03', driver: 'Bilal Noor', company: 'Egari', platform: 'Bolt',
      gross: 200, fees: 50, net: 150, tips: 0, salik: 0, cash: 150, bank: 0, trips: '' },
    { date: '2026-08-03', driver: 'Not Match', company: 'Ecosine', platform: 'Uber',
      gross: 90, fees: 20, net: 70, cash: 70, bank: 0, pseudo: true },
  ],
  source: 'uber_report', done: true });

console.log('\nthe statement rides beside the payout, never inside it');

const W = 'from=2026-08-01&to=2026-08-31';
const k = (await req(`/api/kpis?${W}`)).body;
check('kpis carries statement_net', k.statement_net === 370 + 296 + 150 + 70, String(k.statement_net));
/* The fixture is empty of payouts here, so accounted must NOT absorb the
   statement: a channel's basis stays fares/payout, and the statement is its
   own field. */
check('accounted does not swallow the statement',
  (k.accounted || 0) !== (k.accounted || 0) + k.statement_net, 'tautology guard');
check('and says which platforms the statement covers',
  Array.isArray(k.statement_platforms) && k.statement_platforms.includes('uber')
  && k.statement_platforms.includes('bolt'), JSON.stringify(k.statement_platforms));

const rev = (await req(`/api/revenue?${W}`)).body;
const uberRow = (rev.platforms || []).find((r) => r.platform === 'uber');
check('the revenue page shows the statement columns per platform',
  uberRow && uberRow.statement_net === 370 + 296 + 70 && uberRow.statement_cash === 80 + 60 + 70,
  JSON.stringify(uberRow && [uberRow.statement_net, uberRow.statement_cash]));
check('statement drivers exclude the pseudo rows the money includes',
  uberRow.statement_drivers === 1, String(uberRow.statement_drivers));
check('the totals carry both views without adding them',
  rev.totals.statement_net === 886 && rev.totals.statement_net !== rev.totals.accounted,
  JSON.stringify([rev.totals.statement_net, rev.totals.accounted]));

const tm = (await req('/api/trend/monthly')).body;
const aug = (tm.months || []).find((m) => m.m === '2026-08');
check('the monthly trend carries the statement series', aug && aug.statement_net === 886,
  String(aug && aug.statement_net));

console.log('\nand the payout resolution never sees it');
check('driver_payout_day is untouched by the import',
  (await db.query(`SELECT count(*)::int n FROM driver_payout_day`)).rows[0].n === 0);
check('both sources coexist in storage',
  (await db.query(`SELECT count(DISTINCT source)::int n FROM driver_statement_day`)).rows[0].n === 2);

console.log('\non-trip days derive from the components the API returns');

/* The REST payments surface is the API source for on-trip money. Its rows are
   per driver-week per category; refreshStatements turns them into statement
   days. The traps proven here: cash_collected arrives NEGATIVE and must flip,
   overlapping report grids must resolve finest-first rather than both
   spreading, and two accounts folding to one person-day must SUM. */
const { refreshStatements } = await import('../src/rollup.js');
const dec = (id, ps, pe, cat, amt, name) => db.query(
  `INSERT INTO driver_earnings_component (platform, driver_ext_id, period_start, period_end,
     category, amount, driver_name, fleet_id, parent)
   VALUES ('uber', $1, $2, $3, $4, $5, $6, 'ecosine', null)`, [id, ps, pe, cat, amt, name]);

await dec('u-1', '2026-08-03', '2026-08-09', 'net_fare', 700, 'Test Driver');
await dec('u-1', '2026-08-03', '2026-08-09', 'tip', 14, 'Test Driver');
await dec('u-1', '2026-08-03', '2026-08-09', 'toll', 7, 'Test Driver');
await dec('u-1', '2026-08-03', '2026-08-09', 'cash_collected', -140, 'Test Driver');
/* The two lines this fold never read. driver_statement_day has carried gross
   and fees since sql/schema_v25.sql and nothing wrote them, so /api/revenue
   reported both as null on every platform and window beside a statement_net of
   AED 1,038,040 drawn from this same tree. `fare` is the gross the rider was
   charged; `service_fee` is the channel's commission out of it, and arrives
   negative like cash_collected. */
await dec('u-1', '2026-08-03', '2026-08-09', 'fare', 1050, 'Test Driver');
await dec('u-1', '2026-08-03', '2026-08-09', 'service_fee', -280, 'Test Driver');
// an older, coarser run-stamped period overlapping the same days
await dec('u-1', '2026-08-01', '2026-08-28', 'net_fare', 9999, 'Test Driver');
// a second account of the same person, same week
await dec('u-1b', '2026-08-03', '2026-08-09', 'net_fare', 70, 'TEST  driver');
await refreshStatements(db);

const [d1] = (await db.query(`SELECT * FROM driver_statement_day
  WHERE source='uber_rest' AND day='2026-08-04'`)).rows;
check('a week of components becomes seven statement days', !!d1);
check('the finest period wins the day (700/7, never 9999/28)',
  d1 && Math.abs(Number(d1.net) - (100 + 10)) < 0.01, d1 && String(d1.net));
check('cash flips positive on the way in', d1 && Math.abs(Number(d1.cash) - 20) < 0.01,
  d1 && String(d1.cash));
check('tips and salik ride separately',
  d1 && Math.abs(Number(d1.tips) - 2) < 0.01 && Math.abs(Number(d1.salik) - 1) < 0.01);
check('the gross the rider was charged is written, spread over the same days',
  d1 && Math.abs(Number(d1.gross) - 150) < 0.01, d1 && String(d1.gross));
check('the commission is written, and flips positive like cash',
  d1 && Math.abs(Number(d1.fees) - 40) < 0.01, d1 && String(d1.fees));
/* The two new columns are READ, not derived from, and they do not disturb the
   one that was already right. net comes from net_fare — or from your_earnings
   less tips and taxes — and must be exactly what it was before a fare line and
   a service_fee line existed on the same week. Somebody later "reconciling"
   net to gross minus fees would break this: the tree carries taxes, surcharges
   and promotions this fold deliberately does not name, and on one production
   driver those two sides differ by AED 124.87. */
check('adding the gross and commission lines leaves net exactly as it was',
  d1 && Math.abs(Number(d1.net) - 110) < 0.01, d1 && String(d1.net));
/* A driver whose statement files no fare line must stay null rather than
   collapse to zero: nobody measured a gross for them. */
check('a component tree with no fare line reports no gross at all',
  (await db.query(`SELECT count(*)::int n FROM driver_statement_day
     WHERE source='uber_rest' AND gross IS NULL`)).rows[0].n > 0);
check('two accounts of one person sum rather than last-write-wins',
  d1 && Math.abs(Number(d1.net) - 110) < 0.01, 'expected 100 + 10');
/* The resolver honestly gives a day to the only period covering it — even a
   coarse one. That is correct AT THE RESOLVER: the defence against run-stamped
   smears is schema_v26 deleting them at the source, exactly as schema_v24 did
   for the payout rows. Here the seeded 28-day row stands in for that junk, so
   the expectations state the resolver's real arithmetic. */
const [d20] = (await db.query(`SELECT net FROM driver_statement_day
  WHERE source='uber_rest' AND day='2026-08-20'`)).rows;
check('a day only the coarse period covers takes its share of it',
  d20 && Math.abs(Number(d20.net) - 9999 / 28) < 0.01, d20 && String(d20.net));
check('while the migration kills over-week periods at the source',
  /period_end - period_start > 6/.test(readFileSync('sql/schema_v26.sql', 'utf8')));
check('a re-run replaces the slice rather than doubling it',
  (await refreshStatements(db), (await db.query(`SELECT count(*)::int n FROM driver_statement_day
     WHERE source='uber_rest'`)).rows[0].n === 28));
const kD = (await req('/api/kpis?from=2026-08-01&to=2026-08-31')).body;
check('and the derived days surface as on-trip revenue',
  kD.statement_net != null && Math.abs(kD.statement_net - (770 + 9999 * (21 / 28) + 886)) < 1,
  String(kD.statement_net));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
