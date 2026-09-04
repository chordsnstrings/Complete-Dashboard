/* One business, two ledgers, and they must not disagree by 83%.
   ─────────────────────────────────────────────────────────────────────────
   /api/economics/assets and /api/economics/drivers are the same money seen
   from the car and from the person. The vehicle ledger has always run the
   income rule per channel — fleetIncome picks ONE figure per platform,
   because a payout is what is left of the same fares after the platform's
   commission and adding them counts the ride twice. The people ledger did
   `payouts + fares`, on a premise its own comment stated:

     "within one channel they are never both present: no platform this fleet
      works reports both"

   True until Uber's payments report landed. Uber now reports both — a gross
   per-trip fare AND the net payout that is what remains of those fares — and
   the addition double-counted every priced Uber ride.

   Measured on production, days=30, before the fix:

     /api/economics/drivers   money 1,038,493.42  = fares 586,052.56
                                                  + payouts 452,440.86
     /api/economics/assets    money   567,163.76

   Same fleet, same window, 83% apart — and `money` is the people ledger's
   sort key, so the ranking favoured whoever had the largest double count.

   The fixture below is the shape that produces it: one driver on one channel
   that reports a fare AND a payout for the same rides. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups, refreshPayouts } from '../src/rollup.js';
import { rebuildCustody } from '../src/custody.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, e = 0.5) => Math.abs(Number(a || 0) - Number(b || 0)) < e;

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const FROM = '2026-09-01', TO = '2026-09-07';
const RIDE = 'u-rania', HOTEL = 'h-hana';

let n = 0;
const trip = (platform, drv, name, plate, day, hour, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, product,
     payment_type, price, currency, pickup_addr, dropoff_addr)
   VALUES ($1, $2, 'ecosine', $3, $4, $5, $6::timestamptz,
           $6::timestamptz + interval '20 min', 10, 1200, 'completed',
           'UberX', 'card', $7, 'AED', 'Marina Walk', 'DXB T3')`,
  [platform, `t${++n}`, plate, drv, name, `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`, price]);

/* THE SHAPE. Rania drives Uber, whose payments report now prices every ride
   AND whose weekly statement pays her the net of those same fares. Four days,
   five rides a day, AED 100 gross each: 2,000 of fare, and a payout of 1,475
   which is that less the 25% fee and the 5% VAT on the fee. */
for (const day of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
  for (let i = 0; i < 5; i++) await trip('uber', RIDE, 'Rania Deeb', 'L500', day, 8 + i, 100);
  await q(
    `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name,
       period_start, period_end, earnings, trips, ingested_at)
     VALUES ('uber','ecosine',$1,'Rania Deeb',$2,$2,368.75,5,now())
     ON CONFLICT (platform, driver_ext_id, period_start, period_end) DO NOTHING`, [RIDE, day]);
  /* Hana's channel invoices its bookings and pays no statement — the branch
     that must keep being counted on its fares. */
  for (let i = 0; i < 2; i++) await trip('hotel', HOTEL, 'Hana Malouf', 'L501', day, 9 + i, 120);
}

await refreshRollups({ db });
await refreshPayouts(db);
await rebuildCustody({ from: FROM, to: TO, db });

const { get, server } = await mountAll(db, { serverRoutes: true });
const W = `from=${FROM}&to=${TO}`;

const people = (await get(`/api/economics/drivers?${W}`)).body;
const assets = (await get(`/api/economics/assets?${W}`)).body;

console.log('\nthe fixture reproduces the shape: one channel reporting both');

const rania = (people.rows || []).find((r) => /Rania/.test(r.driver_name || ''));
check('the Uber driver has both a fare and a payout on the same rides',
  rania && Number(rania.reported_fares) === 2000 && near(rania.attributed_payouts, 1475),
  JSON.stringify(rania && [rania.reported_fares, rania.attributed_payouts]));

console.log('\nthe income rule runs per channel, so nothing is counted twice');

/* THE assertion. 1,475 + 2,000 = 3,475 is what the addition produced. */
check('her money is the payout, not the payout plus the fares it came out of',
  near(rania?.money, 1475), `${rania?.money} — 3475 is the sum that double-counts`);
check('…and the row says which figure it took',
  /uber: payout/.test(rania?.money_basis || ''), String(rania?.money_basis));
check('…while the raw sums stay beside it under their own names',
  Number(rania?.reported_fares) === 2000 && near(rania?.attributed_payouts, 1475),
  JSON.stringify([rania?.reported_fares, rania?.attributed_payouts]));

const hana = (people.rows || []).find((r) => /Hana/.test(r.driver_name || ''));
check('a channel that invoices and pays no statement is still counted on its fares',
  near(hana?.money, 960) && /hotel: fares/.test(hana?.money_basis || ''),
  `${hana?.money} / ${hana?.money_basis}`);

console.log('\nand the two ledgers of one business agree');

check('the people ledger and the vehicle ledger report the same money',
  near(people.totals.money, assets.totals.money, 1),
  `people ${people.totals.money} vs assets ${assets.totals.money}`);
/* The halves have to add up to the whole, which they could not while a
   channel contributed to both. */
check('…and its two halves add to its own total',
  near(Number(people.totals.payouts || 0) + Number(people.totals.fares || 0),
    people.totals.money, 1),
  `${people.totals.payouts} + ${people.totals.fares} vs ${people.totals.money}`);
check('…with the fare half being the invoicing channel alone',
  near(people.totals.fares, 960), String(people.totals.fares));

/* And the ordering, because money is the sort key and the double count moved
   people up it. */
const order = (people.rows || []).map((r) => r.driver_name);
check('the ranking is by the chosen money, so the bigger earner leads',
  order[0] && /Rania/.test(order[0]), JSON.stringify(order));

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
