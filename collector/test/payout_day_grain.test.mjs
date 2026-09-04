/* ── a day measured beats a week divided ───────────────────────────────────
   driver_payout_day_finest expands every report window across its days and
   divides the period's money by the number of them. That is the right answer
   when a week is all the provider will tell you, and it is why #reconcile
   showed AED 3,256.43 on three consecutive days: one weekly row, spread flat.

   Uber's earner breakdown answers per day as well. Measured against the live
   endpoint before this was written — seven daily calls and one weekly call
   over the identical Dubai span agreed to the cent on trips and on net
   outstanding, 842 trips / AED 30,280.53 for Egari and 1,862 / AED 71,006.78
   for Ecosine — so a day row here is a measurement, not a finer-looking guess.

   The view already orders by `(period_end - period_start) ASC`, finest first,
   so a day row supersedes the week containing it with no schema change. These
   tests hold that behaviour down: the flat spread must give way, the days that
   have no day row must keep the week's, and the money must not double. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshPayouts } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const perf = (drv, from, to, earnings, trips = null) => q(
  `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name,
     period_start, period_end, earnings, trips, ingested_at)
   VALUES ('uber','ecosine',$1,$2,$3,$4,$5,$6, now())`,
  [drv, `Name ${drv}`, from, to, earnings, trips]);

/* One Mon–Sun week, AED 700 — the shape the collector stored before. */
await perf('d1', '2026-08-17', '2026-08-23', 700, 70);
await refreshPayouts(db);

let rows = await q(`SELECT day::text, earnings, trips, period_days FROM driver_payout_day
                     WHERE driver_ext_id='d1' ORDER BY day`);
check('a week with no finer measurement is spread across its seven days',
  rows.length === 7 && rows.every((r) => near(r.earnings, 100)),
  JSON.stringify(rows.map((r) => r.earnings)));
check('and each of those days is marked as covering seven',
  rows.every((r) => Number(r.period_days) === 7));
check('the spread conserves the week total',
  near(rows.reduce((a, r) => a + Number(r.earnings), 0), 700));

/* Now the daily grid lands for three of those days, and it does NOT agree with
   the flat 100 — which is the entire point of asking per day. */
await perf('d1', '2026-08-19', '2026-08-19', 250, 25);
await perf('d1', '2026-08-20', '2026-08-20', 40, 4);
await perf('d1', '2026-08-21', '2026-08-21', 310, 31);
await refreshPayouts(db);

rows = await q(`SELECT day::text AS day, earnings, trips, period_days FROM driver_payout_day
                 WHERE driver_ext_id='d1' ORDER BY day`);
const by = Object.fromEntries(rows.map((r) => [r.day, r]));
check('still one row per day, not one per report', rows.length === 7, `${rows.length} rows`);
check('a day that was measured shows what was measured, not the week average',
  near(by['2026-08-19'].earnings, 250) && near(by['2026-08-20'].earnings, 40)
  && near(by['2026-08-21'].earnings, 310),
  JSON.stringify([by['2026-08-19'].earnings, by['2026-08-20'].earnings, by['2026-08-21'].earnings]));
check('and is marked as covering one day, so a reader can tell the two apart',
  [19, 20, 21].every((d) => Number(by[`2026-08-${d}`].period_days) === 1));
check('a day the daily grid did not reach keeps the week it belongs to',
  [17, 18, 22, 23].every((d) => near(by[`2026-08-${d}`].earnings, 100)
    && Number(by[`2026-08-${d}`].period_days) === 7),
  JSON.stringify([17, 18, 22, 23].map((d) => by[`2026-08-${d}`].earnings)));
check('trips follow the same rule, undivided on a measured day',
  near(by['2026-08-19'].trips, 25) && near(by['2026-08-17'].trips, 10));

/* The failure this guards against: counting the week AND the days inside it. */
check('the money is not double counted — the week is replaced, not added to',
  near(rows.reduce((a, r) => a + Number(r.earnings), 0), 250 + 40 + 310 + 4 * 100),
  String(rows.reduce((a, r) => a + Number(r.earnings), 0)));

/* A re-run of the same day must replace it, not stack a second row: the table
   is keyed on (platform, driver, period_start, period_end) and a daily window
   is asked for again on every incremental run. */
await q(`UPDATE driver_performance SET earnings=999, trips=99, ingested_at=now()
          WHERE driver_ext_id='d1' AND period_start='2026-08-19' AND period_end='2026-08-19'`);
await refreshPayouts(db);
rows = await q(`SELECT day::text AS day, earnings FROM driver_payout_day
                 WHERE driver_ext_id='d1' AND day='2026-08-19'`);
check('re-collecting a day updates it rather than adding a second row',
  rows.length === 1 && near(rows[0].earnings, 999), JSON.stringify(rows));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
