/* ── one statement, two vocabularies ───────────────────────────────────────
   Uber describes the same money twice. The OAuth REST payments surface roots
   its tree at `earnings` and calls the fare-net-of-commission `net_fare`; the
   supplier GraphQL breakdown roots at `your_earnings` and splits the same
   figure into `fare` and `service_fee`. Only the first surface answers for
   Ecosine, and only for the current payment period; only the second answers
   for Egari, and it answers for as far back as Uber retains.

   refreshStatements knew the first vocabulary alone, so Egari's components
   arrived and every one of them was dropped — a fleet paid AED 107,233 in
   August 2026 with a null expectation beside it on #reconcile.

   Measured on production, both trees carry the same identity:

     REST     earnings      = net_fare           + tip + taxes
     GraphQL  your_earnings = fare + service_fee + tip + taxes

   which is why the mapping SUBTRACTS from Uber's own root rather than adding
   the children up: the root already contains categories this code has never
   seen. Egari's residual against fare+service_fee was exactly its AED 3.00
   `promotion`, and the next unnamed category would vanish the same way.

   These tests hold that down, and hold down the two things it must not break:
   REST still wins where both surfaces covered a period, and the two readings
   of one day must never be added together. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshStatements } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

const comp = (fleet, drv, from, to, category, parent, amount) => q(
  `INSERT INTO driver_earnings_component
     (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end,
      category, parent, amount, currency)
   VALUES ('uber',$1,$2,$3,$4,$5,$6,$7,$8,'AED')`,
  [fleet, drv, `Name ${drv}`, from, to, category, parent, amount]);

const dayOf = (drv, day) => q(
  `SELECT net, tips, salik, cash FROM driver_statement_day
    WHERE driver_ext_id=$1 AND day=$2 AND source='uber_rest'`, [drv, day]);

/* ── the GraphQL tree alone, which is every Egari week ──────────────────── */
/* Driver 64686123's real week, to the fils: fare 3386.90, service_fee -846.78,
   taxes -42.38, tip 35.00 — and your_earnings 2532.74, which is their sum. */
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'your_earnings', null, 2532.74);
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'fare', 'your_earnings', 3386.90);
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'service_fee', 'your_earnings', -846.78);
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'taxes_earnings', 'your_earnings', -42.38);
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'tip', 'your_earnings', 35.00);
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'cash_collected', 'payouts', -210.44);
await comp('egari', 'g1', '2026-08-17', '2026-08-23', 'toll', 'refunds', 50.40);
await refreshStatements(db);

let rows = await q(`SELECT count(*)::int n FROM driver_statement_day WHERE fleet_id='egari'`);
check('a GraphQL-only week produces statement days at all', rows[0].n === 7, JSON.stringify(rows));

let d = await dayOf('g1', '2026-08-20');
/* your_earnings 2532.74 - tip 35.00 - taxes (-42.38) = 2540.12, over 7 days. */
check('net is the root less tip and tax, spread over the period',
  d.length === 1 && near(d[0].net, 2540.12 / 7), JSON.stringify(d));
check('tips come through unchanged', near(d[0].tips, 35.00 / 7), JSON.stringify(d));
check('toll becomes salik', near(d[0].salik, 50.40 / 7), JSON.stringify(d));
check('cash_collected arrives negative and is stored positive',
  near(d[0].cash, 210.44 / 7), JSON.stringify(d));

/* The identity the mapping rests on: subtracting from the root must equal
   adding the named children, whenever every child IS named. */
check('subtracting from the root equals fare + service_fee here',
  near(2532.74 - 35.00 - (-42.38), 3386.90 + (-846.78)));

/* ── a category nobody mapped ───────────────────────────────────────────── */
/* Egari's real fleet-wide residual was AED 3.00 of `promotion`. An additive
   reading drops it; subtracting from Uber's root keeps it. */
await comp('egari', 'g2', '2026-08-17', '2026-08-23', 'your_earnings', null, 103.00);
await comp('egari', 'g2', '2026-08-17', '2026-08-23', 'fare', 'your_earnings', 100.00);
await comp('egari', 'g2', '2026-08-17', '2026-08-23', 'promotion', 'your_earnings', 3.00);
await refreshStatements(db);
d = await dayOf('g2', '2026-08-20');
check('an unnamed sibling of fare is still counted, because the root carries it',
  d.length === 1 && near(d[0].net, 103.00 / 7), JSON.stringify(d));

/* ── both surfaces on one period: REST is the figure that was proven ────── */
await comp('ecosine', 'e1', '2026-08-17', '2026-08-23', 'earnings', null, 1379.19);
await comp('ecosine', 'e1', '2026-08-17', '2026-08-23', 'net_fare', 'earnings', 1372.22);
await comp('ecosine', 'e1', '2026-08-17', '2026-08-23', 'your_earnings', null, 2532.74);
await comp('ecosine', 'e1', '2026-08-17', '2026-08-23', 'fare', 'your_earnings', 3386.90);
await comp('ecosine', 'e1', '2026-08-17', '2026-08-23', 'service_fee', 'your_earnings', -846.78);
await refreshStatements(db);
d = await dayOf('e1', '2026-08-20');
check('where both vocabularies describe one period, net_fare wins',
  d.length === 1 && near(d[0].net, 1372.22 / 7), JSON.stringify(d));
check('and the two readings are never added together',
  d.length === 1 && !near(d[0].net, (1372.22 + 2540.12) / 7), JSON.stringify(d));

/* ── two surfaces, two grains, one day ──────────────────────────────────── */
/* The REST feed answers on short periods and GraphQL on weeks. The finest
   period covering a day already wins (the resolution this table has always
   used); what matters here is that the day takes ONE of them, not the sum. */
await comp('ecosine', 'e2', '2026-08-17', '2026-08-23', 'your_earnings', null, 700.00);
await comp('ecosine', 'e2', '2026-08-20', '2026-08-20', 'earnings', null, 90.00);
await comp('ecosine', 'e2', '2026-08-20', '2026-08-20', 'net_fare', 'earnings', 90.00);
await refreshStatements(db);
d = await dayOf('e2', '2026-08-20');
check('a measured day supersedes the week containing it',
  d.length === 1 && near(d[0].net, 90.00), JSON.stringify(d));
d = await dayOf('e2', '2026-08-21');
check('a day the finer period does not cover keeps the week',
  d.length === 1 && near(d[0].net, 700.00 / 7), JSON.stringify(d));

/* ── a period with neither root is still dropped ────────────────────────── */
/* The HAVING exists so that a period carrying only a toll refund does not
   become a statement day claiming the driver earned nothing. */
await comp('ecosine', 'e3', '2026-08-17', '2026-08-23', 'toll', 'refunds', 12.00);
await refreshStatements(db);
rows = await q(`SELECT count(*)::int n FROM driver_statement_day WHERE driver_ext_id='e3'`);
check('a period with no earnings root produces no statement day', rows[0].n === 0, JSON.stringify(rows));

/* ── taxes and tips hang under both roots ───────────────────────────────── */
/* If the subtraction did not name its parent it would take the REST tree's
   tax off the GraphQL root as well. */
await comp('ecosine', 'e4', '2026-08-17', '2026-08-23', 'your_earnings', null, 500.00);
await comp('ecosine', 'e4', '2026-08-17', '2026-08-23', 'taxes_earnings', 'your_earnings', -10.00);
await comp('ecosine', 'e4', '2026-08-24', '2026-08-30', 'earnings', null, 480.00);
await comp('ecosine', 'e4', '2026-08-24', '2026-08-30', 'net_fare', 'earnings', 470.00);
await comp('ecosine', 'e4', '2026-08-24', '2026-08-30', 'taxes_earnings', 'earnings', -10.00);
await refreshStatements(db);
d = await dayOf('e4', '2026-08-20');
check('the GraphQL subtraction takes only the tax under its own root',
  d.length === 1 && near(d[0].net, 510.00 / 7), JSON.stringify(d));
d = await dayOf('e4', '2026-08-26');
check("the REST period's own tax is left where it was",
  d.length === 1 && near(d[0].net, 470.00 / 7), JSON.stringify(d));

/* ── rebuilding is idempotent ───────────────────────────────────────────── */
const before = await q(`SELECT count(*)::int n, round(sum(net)::numeric,2) net
                          FROM driver_statement_day WHERE source='uber_rest'`);
await refreshStatements(db);
const after = await q(`SELECT count(*)::int n, round(sum(net)::numeric,2) net
                         FROM driver_statement_day WHERE source='uber_rest'`);
check('a second rebuild changes nothing',
  before[0].n === after[0].n && near(before[0].net, after[0].net),
  `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
