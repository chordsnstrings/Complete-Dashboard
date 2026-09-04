/* A week the daily grid already stated must not be counted a second time.
   ─────────────────────────────────────────────────────────────────────────
   payout_day_grain.test.mjs holds down the per-DRIVER rule: a driver's own day
   row beats the week containing it. This holds down what that rule could not
   reach — the driver who appears in the WEEKLY report and not in the daily one.

   schema_v23 gave that driver-day the week's money divided by seven, on the
   reasoning that a day with no finer row of its own has nothing better. On
   Uber that is false, and the operator's bank statements are what proved it.
   Over 27 July to 30 August 2026, driver_payout_day held:

       1d rows   94 drivers   AED 440,726.21
       7d rows  216 drivers   AED  23,745.20   (plus 1,452.13 on 2/3/4-day rows)

   and the bank paid AED 440,445.31. The daily grid alone is +0.06%. If the 122
   drivers who appear only in the weekly report had earned that 23,745, the
   daily-only figure would be SHORT by it; it is over by 281. So the weekly row
   is a restatement of a week the daily grid already accounts for, and its
   money must not be added.

   schema_v58 withholds it — the MONEY only, on days the fleet's daily grid ran
   — and says so on the row. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshPayouts } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) < e;

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const perf = (drv, from, to, earnings, extra = {}) => q(
  `INSERT INTO driver_performance
     (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end,
      earnings, hours_online, rating, ingested_at)
   VALUES ('uber', $1, $2, $2, $3, $4, $5, $6, $7, now())
   ON CONFLICT (platform, driver_ext_id, period_start, period_end) DO UPDATE
     SET earnings = EXCLUDED.earnings`,
  [extra.fleet || 'ecosine', drv, from, to, earnings,
    extra.hours ?? null, extra.rating ?? null]);

/* THE SHAPE PRODUCTION HAS. One week. `earner` appears in both grids; `weekly`
   appears only in the weekly one, which is the 122-driver class. */
for (const d of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
  '2026-08-07', '2026-08-08', '2026-08-09']) {
  await perf('earner', d, d, 100);
}
await perf('earner', '2026-08-03', '2026-08-09', 700, { hours: 70, rating: 4.9 });
await perf('weekly', '2026-08-03', '2026-08-09', 210, { hours: 35, rating: 4.7 });

await refreshPayouts(db);

const rows = await q(
  `SELECT driver_ext_id, day, period_days, earnings, hours_online, rating, grain_reason
     FROM driver_payout_day WHERE platform='uber' ORDER BY driver_ext_id, day`);
const of = (d) => rows.filter((r) => r.driver_ext_id === d);
const sum = (d) => of(d).reduce((a, r) => a + Number(r.earnings || 0), 0);

console.log('\nthe driver the daily grid reached');
check('keeps a row for every day', of('earner').length === 7, String(of('earner').length));
check('and the day’s own measurement, not the week divided',
  of('earner').every((r) => near(r.earnings, 100)), JSON.stringify(of('earner').map((r) => r.earnings)));
check('so the week totals what the days measured', near(sum('earner'), 700), String(sum('earner')));

console.log('\nthe driver who appears only in the weekly report');
check('still has a row for every day of the week',
  of('weekly').length === 7, String(of('weekly').length));
/* The whole point. Seven days x 30 = 210 used to be added on top of a figure
   that already reconciled. */
check('but carries NO money on them', near(sum('weekly'), 0), String(sum('weekly')));
check('and says why, in the server’s own words',
  of('weekly').every((r) => /also filed a per-day report/.test(r.grain_reason || '')),
  JSON.stringify(of('weekly')[0]?.grain_reason));
check('the reason names the window it came from',
  /7-day report of 03 Aug to 09 Aug/.test(of('weekly')[0]?.grain_reason || ''),
  String(of('weekly')[0]?.grain_reason).slice(0, 90));

console.log('\nwhat must NOT be withheld');
/* hours_online and the rating come from a different report on a different
   grid — REPORT_TYPE_DRIVER_QUALITY — and the grain bug never touched them.
   Dropping the row would have taken them with the money. */
check('the hours survive', of('weekly').every((r) => Number(r.hours_online) > 0),
  JSON.stringify(of('weekly').map((r) => r.hours_online)));
check('and the rating survives', of('weekly').every((r) => Number(r.rating) === 4.7),
  JSON.stringify(of('weekly')[0]?.rating));
check('the measured driver’s money is untouched by any of it', near(sum('earner'), 700));

console.log('\nthe fleet total, which is the number the bank checks');
const total = rows.reduce((a, r) => a + Number(r.earnings || 0), 0);
check('is the daily grid alone', near(total, 700), String(total));
/* Before schema_v58 this was 700 + 210 = 910, a 30% overstatement on this
   fixture and 5.78% on the real August window. */
check('and not the daily grid plus the week restating it', !near(total, 910), String(total));

console.log('\noutside the daily grid’s horizon, nothing changes');
/* The daily grid reaches back about 192 days and the weekly further. A week
   with no daily rows anywhere in the fleet must keep its money, or every older
   month in the product empties. */
await perf('earner', '2025-01-06', '2025-01-12', 350);
await refreshPayouts(db);
const old = await q(
  `SELECT earnings, grain_reason FROM driver_payout_day
    WHERE driver_ext_id='earner' AND day BETWEEN '2025-01-06' AND '2025-01-12'`);
check('the old week is still spread across its days', old.length === 7, String(old.length));
check('and keeps every fils of it',
  near(old.reduce((a, r) => a + Number(r.earnings || 0), 0), 350),
  String(old.reduce((a, r) => a + Number(r.earnings || 0), 0)));
check('with no reason attached, because nothing superseded it',
  old.every((r) => r.grain_reason == null), JSON.stringify(old[0]));

console.log('\na second fleet is judged on its own grid');
/* daily_grid is keyed on (platform, fleet_id, day). Egari having no daily rows
   must not let Ecosine's grid suppress Egari's week. */
await perf('eg1', '2026-08-03', '2026-08-09', 140, { fleet: 'egari' });
await refreshPayouts(db);
const eg = await q(
  `SELECT earnings, grain_reason FROM driver_payout_day WHERE fleet_id='egari'`);
check('Egari’s week survives Ecosine’s daily grid', eg.length === 7, String(eg.length));
check('and keeps its money', near(eg.reduce((a, r) => a + Number(r.earnings || 0), 0), 140),
  String(eg.reduce((a, r) => a + Number(r.earnings || 0), 0)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
