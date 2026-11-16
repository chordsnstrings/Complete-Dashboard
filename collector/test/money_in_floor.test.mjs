/* "at least" on Money in, only where money is genuinely missing.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16: "fix the Money in 'at least' bug".

   moneyInTile (api/public/ui.js) printed "at least … this is a floor rather
   than the total" whenever trips > priced_trips. That counts two kinds of
   booking whose money is NOT missing:
     · a ride nobody took — no fare, and never will be one;
     · an Uber booking on a day Uber's statement covers — no fare on the trip
       row because Uber's export has no fare column, its money already INSIDE
       the statement's net, which is what driver_day.money takes that day.
   Measured on production for October on the driver ERN sampled: 30 unpriced of
   502, 43 never completed, the statement on 31 of 31 days, nothing missing —
   and the Overview said "at least" with a reason that was not true.

   /api/driver/kpis now returns `unpriced_unstated` (completed, no fare, and —
   for Uber — on a day no statement reaches) and `unpriced_unstated_uber`, and
   both tiles that print this figure (Money in on the Overview and phone,
   Actual earnings on Earnings) gate "at least" on it. Held here:

     1. the route, on PGlite: an Uber booking inside a statement day is not
        counted; one on a day no statement reaches is; a cancelled one is not;
        an unpriced Bolt booking is, statement or not; a priced one is not;
     2. the tiles: no floor when the count is 0 however many bookings are
        unpriced; a floor with the parts named when it is not; a response from
        before the field falls back to dark_bookings, never to the old rule;
     3. Money in and Actual earnings agree on whether it is a floor.

   REVERSIONS (each run, each failing as named):
     · the route's EXISTS clause removed (every unpriced Uber booking counted)
       → §1 "inside a statement day" fails
     · the COMPLETED filter removed → §1 "a cancelled booking" fails
     · moneyInTile back on trips - priced_trips → §2 "no floor" and "old
       response" fail
     · actualEarningsTile back on dark_bookings alone → §3 fails

   Synthetic people only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { moneyInTile } from '../api/public/ui.js';
import { actualEarningsTile } from '../api/public/actualearnings.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

const DRV = 'u-floor';
let n = 0;
const trip = (platform, day, hour, status, price = null) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price)
   VALUES ($1,$2,'ecosine','L700',$3,'Floor Tester',$4,$5,9,$6,$7)`,
  [platform, `fl${n++}`, DRV, `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`,
    status === 'completed' || status === 'finished' ? `${day}T${String(hour).padStart(2, '0')}:30:00+04:00` : null, status, price]);

const D1 = '2026-10-05', D2 = '2026-10-06';
/* D1 carries an Uber statement; D2 does not (its week has not landed). */
await q(`INSERT INTO driver_day (driver_ext_id, day, trips, completed, stmt_net, money) VALUES ($1, $2, 3, 3, 250.00, 250.00)`, [DRV, D1]);
await q(`INSERT INTO driver_day (driver_ext_id, day, trips, completed, fares, money) VALUES ($1, $2, 3, 2, 42.50, 42.50)`, [DRV, D2]);
await trip('uber', D1, 9, 'completed');                 // inside a statement day: NOT missing
await trip('uber', D1, 11, 'completed');                // inside a statement day: NOT missing
await trip('uber', D2, 9, 'completed');                 // no statement reaches D2: missing (uber)
await trip('uber', D2, 12, 'rider_cancelled');          // nobody rode: NOT missing
await trip('bolt', D1, 14, 'finished');                 // Bolt, no fare: missing (elsewhere), statement or not
await trip('bolt', D2, 15, 'finished', 42.5);           // priced: NOT missing

const { server, get } = await mountAll(db, { serverRoutes: false });
const r = await get(`/api/driver/kpis?id=${DRV}&from=2026-10-01&to=2026-10-31`);
const k = r.body || {};

console.log('\n1. the route counts the bookings whose money is genuinely missing');
check('the endpoint answers', r.status === 200, JSON.stringify(r.body).slice(0, 160));
check('two completed bookings carry no fare that any statement covers — the Uber one on D2 and the Bolt one',
  k.unpriced_unstated === 2, String(k.unpriced_unstated));
check('…one of them waits on Uber\'s weekly statement', k.unpriced_unstated_uber === 1, String(k.unpriced_unstated_uber));
check('the two Uber bookings inside a statement day are not counted (5 unpriced, 2 missing)',
  k.trips - k.priced_trips === 5 && k.unpriced_unstated === 2, JSON.stringify([k.trips, k.priced_trips, k.unpriced_unstated]));

console.log('\n2. the tiles gate "at least" on that count, never on unpriced trips');
const OCT = { trips: 502, priced_trips: 472, completed: 459, not_completed: 43, dark_bookings: 0,
  day_money: 21699.83, day_money_days: 31, day_money_period_days: 7, day_money_source: 'mixed',
  day_stmt_net: 20951.83, day_stmt_days: 31, window_days: 31 };
const none = moneyInTile({ ...OCT, unpriced_unstated: 0, unpriced_unstated_uber: 0 });
check('no floor when nothing is missing, however many bookings are unpriced (the October driver)',
  !/at least/.test(none.value) && !/floor/.test(none.sub), JSON.stringify([none.value, none.sub.slice(0, 120)]));
const wait = moneyInTile({ ...OCT, unpriced_unstated: 9, unpriced_unstated_uber: 9 });
check('nine Uber bookings before the week\'s statement: "at least", and why',
  /^at least /.test(wait.value) && /^9 completed bookings here carry no fare that any statement or booking reports, so this is a floor rather than the total — 9 on Uber, whose weekly payments report has not reached their days yet\./.test(wait.sub),
  JSON.stringify([wait.value, wait.sub.slice(0, 220)]));
const mix = moneyInTile(k);
check('the route\'s own answer: 1 on Uber, 1 on a channel that sent no fare',
  /^at least /.test(mix.value) && /1 on Uber, whose weekly payments report has not reached its day yet, 1 on a channel that sent no fare for it\./.test(mix.sub),
  JSON.stringify([mix.value, mix.sub.slice(0, 220)]));
const old = moneyInTile({ ...OCT });
check('a response from before the field falls back to dark_bookings (0 here) — never to trips minus priced',
  !/at least/.test(old.value) && !/floor/.test(old.sub), JSON.stringify([old.value, old.sub.slice(0, 120)]));

console.log('\n3. Money in and Actual earnings agree');
const W = { worked: true, bookingsN: 502 };
for (const [label, pay] of [['nothing missing', { ...OCT, unpriced_unstated: 0, dark_bookings: 3 }],
  ['two missing', { ...OCT, unpriced_unstated: 2, unpriced_unstated_uber: 1 }]]) {
  const a = moneyInTile(pay), b = actualEarningsTile(pay, W);
  check(`${label}: both say "at least", or neither does`, /^at least/.test(a.value) === /^at least/.test(b.value),
    JSON.stringify([a.value, b.value]));
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
