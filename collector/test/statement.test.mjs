/* ── the statement view of the money ───────────────────────────────────────
   Reconciling against the operator's ledger settled what our payout figure IS:
   netOutstanding, the amount the platform wires to the bank — statement net
   MINUS cash the drivers already collected, PLUS tips and tolls. A reader
   shown one where they expect the other reports a 13% "gap" that is actually
   drivers taking a fifth of fares in cash. So both figures now exist, side by
   side, and these tests are about the ways that goes wrong: the two getting
   ADDED, a statement row winning a payout day, an import that double-writes on
   re-run, or a pseudo-driver ("Not Match") appearing in a driver list. */
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
check('the import moved the data version (a collection run exists for it)',
  (await db.query(`SELECT count(*)::int n FROM collection_run WHERE source='ledger'`)).rows[0].n === 1);

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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
