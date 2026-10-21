/* MONTH BY MONTH under "Each wire against our own figure" — the operator,
   2026-10-21: "this should have monthly reconciliation at the bottom for a quick
   overview which will help us understand actual monthly income … live till date".

   What the route's `months` and `pending` must hold, against a real schema
   (PGlite), on a fixture shaped like production's record:
   - a month is the month the money ARRIVED, every transfer counted in it;
   - the difference counts only weeks our figure fully covers — production's
     first Uber weeks carry a figure from 3 of 7 days (per-driver rows begin on
     2026-02-06), and folding that in printed February as +AED 362k;
   - Bolt, which states no period, is counted as money and never compared;
   - `earned` sums only the platforms that wire (Yango files per-driver rows
     and no transfer);
   - a month far outside the usual ±1% is FLAGGED, with its weeks, not smoothed;
   - `pending` is what was earned after the last settled week — the live part. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { dubaiIso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b) => a != null && Math.abs(a - b) < 0.005;

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

const payout = (o) => q(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount,
                                currency, period_start, period_end, method, source)
   VALUES ($1,$2,$3,$4::date,$5,'AED',$6::date,$7::date,'bank','test')`,
  [o.platform, o.fleet, o.id, o.day, o.amount, o.from || null, o.to || null]);
const driverDay = (platform, fleet, day, driver, earnings) => q(
  `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
     period_start, period_end, period_days, earnings, currency)
   VALUES ($1,$2,$3,$3,$4::date,$4::date,$4::date,1,$5,'AED')`,
  [platform, fleet, driver, day, earnings]);
const days = (from, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

/* September: the measured week (7–13 Sep, ours 110,962.09 against a wire of
   111,179.66), a wire whose week we hold no figure for, and a Bolt transfer. */
const WEEK = [14324.61, 15770.41, 17192.37, 16612.39, 17532.04, 15726.00, 13804.27];
days('2026-09-07', 7).forEach((d, i) => driverDay('uber', 'ecosine', d, 'u-1', WEEK[i]));
await payout({ platform: 'uber', fleet: 'ecosine', id: 'e:09-14', day: '2026-09-14', amount: 111179.66,
  from: '2026-09-07', to: '2026-09-13' });
await payout({ platform: 'uber', fleet: 'ecosine', id: 'e:09-07', day: '2026-09-07', amount: 103567.54,
  from: '2026-08-31', to: '2026-09-06' });
await payout({ platform: 'bolt', fleet: 'ecosine', id: 'b:09-05', day: '2026-09-05', amount: 3184.22 });
/* August: a FULL week far off — the shape of production's 16 Feb 2026 wire. */
days('2026-08-10', 7).forEach((d) => driverDay('uber', 'ecosine', d, 'u-1', 1000));
await payout({ platform: 'uber', fleet: 'ecosine', id: 'e:08-17', day: '2026-08-17', amount: 57810.41,
  from: '2026-08-10', to: '2026-08-16' });
/* October: a wire whose week our figure covers on 3 days of 7. */
days('2026-09-28', 3).forEach((d) => driverDay('uber', 'ecosine', d, 'u-1', 5000));
await payout({ platform: 'uber', fleet: 'ecosine', id: 'e:10-05', day: '2026-10-05', amount: 99000,
  from: '2026-09-28', to: '2026-10-04' });
/* Earned after the last settled week (4 Oct), and Yango rows that must not count. */
await driverDay('uber', 'ecosine', '2026-10-05', 'u-1', 1234.5);
await driverDay('uber', 'ecosine', '2026-10-06', 'u-1', 765.5);
await driverDay('yango', 'ecosine', '2026-09-08', 'y-1', 999);

const m = await mountAll(db);
const r = (await m.get('/api/finance/payouts/reconcile')).body;
const M = Object.fromEntries((r.months || []).map((x) => [x.month, x]));

console.log('months by the date the money arrived');
check('months come back newest first', JSON.stringify((r.months || []).map((x) => x.month))
  === JSON.stringify(['2026-10', '2026-09', '2026-08']), JSON.stringify((r.months || []).map((x) => x.month)));
const sep = M['2026-09'];
check('September counts every transfer that arrived in it', sep?.transfers === 3 && near(sep.wire, 111179.66 + 103567.54 + 3184.22),
  JSON.stringify(sep));
check('…split by platform', near(sep?.wire_by_platform?.uber, 214747.2) && near(sep?.wire_by_platform?.bolt, 3184.22),
  JSON.stringify(sep?.wire_by_platform));

console.log('\nthe difference counts only weeks our figure fully covers');
check('September compares the one fully covered week', sep?.compared?.rows === 1
  && near(sep.compared.calculated, 110962.09) && near(sep.compared.delta, 217.57) && near(sep.compared.wire, 111179.66),
  JSON.stringify(sep?.compared));
check('…as a share of the same wire', near(sep?.compared?.delta_pct, 0.2), String(sep?.compared?.delta_pct));
check('…and is not flagged', sep?.compared?.unusual === false);
check('a week with no figure and a Bolt transfer are listed apart, by kind',
  sep?.not_compared?.rows === 2 && sep.not_compared.why.no_driver_day_rows?.rows === 1
  && sep.not_compared.why.provider_states_no_period?.rows === 1, JSON.stringify(sep?.not_compared));
const oct = M['2026-10'];
check('a week covered on 3 days of 7 is not counted in the month', oct?.compared === null, JSON.stringify(oct?.compared));
check('…it is listed as a part week, with its money', oct?.not_compared?.why?.part_week?.rows === 1
  && near(oct.not_compared.why.part_week.wire, 99000), JSON.stringify(oct?.not_compared));
const row = r.rows.find((x) => x.paid_on === '2026-10-05');
check('…and its own row still shows the comparison, with its coverage', row?.calculated === 15000
  && row?.days_with_rows === 3 && row?.period_days === 7, JSON.stringify(row));

console.log('\na month far outside the usual ±1% is flagged, not smoothed');
const aug = M['2026-08'];
check('August is compared', aug?.compared?.rows === 1 && near(aug.compared.calculated, 7000), JSON.stringify(aug?.compared));
check('…and flagged unusual, with the week that carries it', aug?.compared?.unusual === true
  && aug.compared.unusual_weeks.length === 1 && aug.compared.unusual_weeks[0].paid_on === '2026-08-17',
  JSON.stringify(aug?.compared));

console.log('\nwhat the drivers earned on the month’s own days');
check('September earned is the platforms that wire only (Yango left out)',
  near(sep?.earned, 110962.09 + 15000) && sep?.earned_days === 10, `${sep?.earned} ${sep?.earned_days}`);
check('October earned runs to the last day held', near(oct?.earned, 2000) && oct?.earned_through === '2026-10-06',
  `${oct?.earned} ${oct?.earned_through}`);

console.log('\nlive to date');
const now = dubaiIso().slice(0, 7);
check('only the current month is marked to date', (r.months || []).every((x) => x.to_date === (x.month === now))
  && (r.months || []).filter((x) => x.to_date).every((x) => x.through === dubaiIso()));
const pe = (r.pending || []).find((x) => x.platform === 'uber' && x.fleet_id === 'ecosine');
check('earned after the last settled week is carried as pending', pe?.settled_through === '2026-10-04'
  && near(pe?.earned, 2000) && pe?.from === '2026-10-05' && pe?.through === '2026-10-06', JSON.stringify(pe));
check('…and only where wires state their week (no Bolt pending)', !(r.pending || []).some((x) => x.platform === 'bolt'));

console.log('\nthe filter travels');
const rb = (await m.get('/api/finance/payouts/reconcile?platform=bolt')).body;
check('a Bolt-only selection has Bolt money and no Uber, and earns nothing', (rb.months || []).length === 1
  && rb.months[0].month === '2026-09' && near(rb.months[0].wire, 3184.22) && rb.months[0].earned === null,
  JSON.stringify(rb.months));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
