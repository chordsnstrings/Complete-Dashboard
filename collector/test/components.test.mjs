/* ── a confident fleet total over an arbitrary truncated subset ────────────
   /api/earnings/components returned one row per (driver, category) and kept
   the four hundred largest by absolute value. Production returned exactly 400
   rows, which is what a cap looks like when it is cutting.

   Three things compounded there. The cut was by |amount| across every driver
   at once, so a top-level component for one driver could survive while its own
   children were cut, and a child of another could survive without its parent.
   componentTree() in api/public/app.js then sums the roots and prints "the N
   top-level components above net to AED …" — a fleet total, stated plainly,
   over whatever happened to fit.

   And the per-driver granularity was never used: componentTree folds on
   (parent, category) the moment the rows arrive and throws the driver away.
   Grouping in SQL instead makes the answer exact, removes the need for a cap,
   and turns four hundred rows into about twenty. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const P = ['2026-08-01', '2026-08-07'];
const comp = (drv, category, parent, amount) => q(
  `INSERT INTO driver_earnings_component
     (platform, driver_ext_id, fleet_id, period_start, period_end, category, parent, amount, currency)
   VALUES ('uber', $1, 'ecosine', $2::date, $3::date, $4, $5, $6, 'AED')`,
  [drv, P[0], P[1], category, parent, amount]);

/* Five hundred drivers, each with one root and one child, so the old 400-row
   cap would have cut the set in half and split parents from their children. */
for (let i = 0; i < 500; i++) {
  await comp(`d${i}`, 'earnings', null, 100 + i);
  await comp(`d${i}`, 'net_fare', 'earnings', 90 + i);
}
await comp('d0', 'cash_collected', 'payouts', -400);
await comp('d0', 'payouts', null, -400);

const { server, get } = await mountAll(db, { serverRoutes: true });
const res = await get(`/api/earnings/components?from=${P[0]}&to=${P[1]}`);
check('the endpoint answers', res.status === 200, JSON.stringify(res.body).slice(0, 120));
const rows = res.body.rows;

console.log('\ncomponents: one row per component, not per driver per component');

check('a thousand driver-rows fold to the four components that exist',
  rows.length === 4, JSON.stringify(rows.map((r) => r.category)));
check('and nothing is capped at 400 any more — the cap was binding in production',
  rows.length < 400);

console.log('\ncomponents: the totals are exact, not the largest four hundred');

const by = Object.fromEntries(rows.map((r) => [r.category, r]));
/* 500 roots of 100..599 = 174,750; children 90..589 = 169,750. */
check('a root sums every driver, not the ones that fitted',
  Number(by.earnings.amount) === 174750, String(by.earnings?.amount));
check('and so does its child', Number(by.net_fare.amount) === 169750, String(by.net_fare?.amount));
check('a negative component keeps its sign — a deduction is not an earning',
  Number(by.payouts.amount) === -400 && Number(by.cash_collected.amount) === -400);

console.log('\ncomponents: the tree can still be built');

check('every root is present', rows.filter((r) => !r.parent).length === 2,
  JSON.stringify(rows.filter((r) => !r.parent).map((r) => r.category)));
check('and every child names a parent that is in the set',
  rows.filter((r) => r.parent).every((c) => rows.some((p) => !p.parent && p.category === c.parent)),
  JSON.stringify(rows.map((r) => [r.category, r.parent])));
/* The whole point of the nesting: roots net to the payout, children are inside
   them and must not be added again. */
const net = rows.filter((r) => !r.parent).reduce((a, r) => a + Number(r.amount), 0);
check('the roots net to the payout — 174,750 earned less 400 deducted',
  net === 174350, String(net));

console.log('\ncomponents: how many people each part covers');

check('each component says how many drivers it covers, which a fleet total '
  + 'otherwise hides', Number(by.earnings.drivers) === 500, String(by.earnings?.drivers));
check('and a component only one driver has says so',
  Number(by.payouts.drivers) === 1, String(by.payouts?.drivers));

const src = (await import('node:fs')).readFileSync('api/server.js', 'utf8');
const slice = src.slice(src.indexOf("app.get('/api/earnings/components'"), src.indexOf("app.get('/api/earnings/components'") + 700);
check('no LIMIT survives on this endpoint', !/LIMIT/.test(slice), slice.slice(0, 200));

/* ── an empty answer, and which of the two empties it is ──────────────────
   These amounts are reported per PAYOUT PERIOD — a week at a time — and only a
   period the window holds ENTIRELY is counted, because counting one that
   straddles the edge reports part of a week as the whole of it. On a seven-day
   range that empties the panel while the database is full, and the page said
   "no payout breakdown collected yet": the reader was sent to the collector for
   data it had already collected. bin/page-audit.mjs found it empty at 7 days
   and full at 30.

   The two empties lead to opposite actions — widen the range, or go and fix a
   collector — so the endpoint has to tell them apart. */
{
  /* A three-day window inside the fixture's week: it overlaps every period and
     contains none of them. */
  const inside = await get(`/api/earnings/components?from=2026-08-03&to=2026-08-05`);
  check('a window that splits every period returns nothing',
    inside.body.rows.length === 0, JSON.stringify(inside.body.rows).slice(0, 80));
  check('…and says the components are there, overlapping it',
    inside.body.overlapping > 0, String(inside.body.overlapping));
  check('…and names the span the record actually covers, so the range can be widened to it',
    inside.body.first_period === P[0] && inside.body.last_period === P[1],
    JSON.stringify([inside.body.first_period, inside.body.last_period]));

  /* And a window nowhere near the data: nothing contained, nothing
     overlapping. That is the collector's problem, and the only case where
     saying so is right. */
  const far = await get(`/api/earnings/components?from=2025-01-01&to=2025-01-31`);
  check('a window the record does not reach reports no overlap either',
    far.body.rows.length === 0 && far.body.overlapping === 0,
    JSON.stringify([far.body.rows.length, far.body.overlapping]));

  /* And the answer that IS full carries no count of overlaps to misread. */
  check('a window that contains the periods reports no overlap to explain',
    res.body.overlapping === 0, String(res.body.overlapping));
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
