/* The week that has not closed, and the cliff it drew.
   ──────────────────────────────────────────────────────────────────────────
   Uber files this fleet WEEKLY. src/rollup.js:916 divides each statement by
   the days it covers and writes one row per day, so every Uber day on every
   page is a seventh of a week. For a CLOSED week that is right and honest.

   For a week still running it is neither, and the failure is severe. Measured
   on production 2026-09-10:

     31 Aug - 6 Sept (closed)   AED 25,768.69 a day
     7 - 13 Sept     (open)     AED  4,444.39 a day

   an 83% collapse on the panel whose subject is the money — while the fleet's
   bookings over those days were 675, 787 and 763 against 665-820 the week
   before. Nothing had happened. Two errors compound: the numerator is only
   what Uber has settled so far, and the denominator is all seven days, three
   of which are in the FUTURE — so the money that was earned is spread across
   days with no work in them at all.

   The fix asks a provider for nothing new. Uber's per-trip fare is already on
   trip.price at Dubai-day grain for 88-92% of bookings, and the statement's
   net is that gross less a commission this fleet can MEASURE: ten closed weeks
   give 0.7372-0.7526, and predicting each closed week's filed net from its own
   gross times the ratio of the weeks before it is accurate to 0.42% worst case
   over six out-of-sample weeks. So an open period's days are answered from
   their own trips, and a closed period keeps its statement untouched. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import {
  openPeriods, commissionOf, fillOpenDays, applyFillToPlatforms, fillNote, resolveOpenFill,
} from '../api/statement_fill_sql.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* The key fillOpenDays() files a correction under. Written out here rather
   than imported, so a change to the separator fails loudly in a test instead
   of silently matching nothing. */
const K = (p, d) => `${p}\u0000${d}`;

/* The shape production has, in miniature. Three weeks: two closed, one open.
   The commission is exactly 25% so every figure below is checkable by hand —
   gross 1,000 a day becomes net 750 a day. */
const TODAY = '2026-09-10';
const RATE = 0.75;
let tn = 0;
const trip = (day, price, platform = 'uber') => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, distance_km, status, price)
   VALUES ($1,$2,'ecosine','L1','d1','Rida', $3::timestamptz, 10, 'completed', $4)`,
  [platform, `t${tn++}`, `${day}T09:00:00+04:00`, price]);
const stmt = (day, net, periodDays) => q(
  `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
     net, period_days, source, pseudo)
   VALUES ('uber','ecosine','Rida','d1',$1::date,$2,$3,'uber_rest',false)`,
  [day, net, periodDays]);
const days = (from, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

/* Two CLOSED weeks: 1,000 gross a day against a statement filed at 750 a day. */
for (const d of [...days('2026-08-24', 7), ...days('2026-08-31', 7)]) {
  await trip(d, 1000);
  await stmt(d, 750, 7);
}
/* The OPEN week. Three days have run and carry real trips; four have not
   happened. Uber has filed a fraction of the week so far — 1,400 — and
   rollup.js has spread it flat at 200 across all seven days, which is exactly
   what the chart was drawing. */
for (const d of days('2026-09-07', 3)) await trip(d, 1000);
for (const d of days('2026-09-07', 7)) await stmt(d, 200, 7);

console.log('\nthe open period is found, and only the open one');
const openRows = await q(`SELECT platform, max(day)::date AS last_day, max(period_days)::int AS period_days
                            FROM driver_statement_day GROUP BY 1`);
const periods = openPeriods(openRows, TODAY);
check('a period whose last day is still ahead of today is open',
  periods.size === 1 && periods.get('uber').open_end === '2026-09-13', JSON.stringify([...periods]));
check('…and it starts where the week starts, not where the trips stop',
  periods.get('uber').open_start === '2026-09-07', periods.get('uber')?.open_start);
check('a period that ended before today opens nothing',
  openPeriods(openRows, '2026-09-20').size === 0);
check('a one-day statement is a measurement, not a smear, so it is never open',
  openPeriods([{ platform: 'x', last_day: '2026-09-30', period_days: 1 }], TODAY).size === 0,
  'period_days = 1 means Uber measured that day; there is nothing to improve on');

console.log('\nthe commission is measured, never assumed');
const comm = await q(`
  WITH s AS (SELECT platform, day, sum(net) AS net FROM driver_statement_day
              WHERE day BETWEEN '2026-08-24' AND '2026-09-06' GROUP BY 1,2),
       g AS (SELECT platform, local_day AS day, sum(price) AS gross FROM trip_norm
              WHERE has_fare AND is_booking AND local_day BETWEEN '2026-08-24' AND '2026-09-06'
              GROUP BY 1,2)
  SELECT s.platform, sum(s.net) AS net, sum(g.gross) AS gross, count(*)::int AS days
    FROM s JOIN g ON g.platform=s.platform AND g.day=s.day GROUP BY 1`);
const c = commissionOf(comm, 'uber');
check('it comes out of the closed weeks at exactly what was filed',
  Math.abs(c.rate - RATE) < 1e-9, String(c.rate));
check('…over the fourteen closed days that carry both halves', c.days === 14, String(c.days));
check('a channel with no closed period gets NO rate, and a reason',
  commissionOf(comm, 'bolt').rate === null
  && /never been measured/.test(commissionOf(comm, 'bolt').why), commissionOf(comm, 'bolt').why);
check('…and neither does one with less than a whole week behind it',
  commissionOf([{ platform: 'uber', net: 100, gross: 200, days: 3 }], 'uber').rate === null,
  'a part-week ratio is the same partial-period error this module exists to remove');

console.log('\nan open day is answered from its own trips');
const fill = fillOpenDays({
  openDays: [
    { platform: 'uber', d: '2026-09-07', statement_net: 200, gross: 1000 },
    { platform: 'uber', d: '2026-09-08', statement_net: 200, gross: 1000 },
    { platform: 'uber', d: '2026-09-09', statement_net: 200, gross: 1000 },
    { platform: 'uber', d: '2026-09-10', statement_net: 200, gross: null },
    { platform: 'uber', d: '2026-09-11', statement_net: 200, gross: null },
  ],
  periods, rates: new Map([['uber', RATE]]),
});
check('a day that ran is its own gross at the measured commission',
  fill.byDay.get(K('uber', '2026-09-07')).now === 750,
  String(fill.byDay.get(K('uber', '2026-09-07'))?.now));
check('a day with no trip yet is ABSENT, never an average and never a zero',
  fill.byDay.get(K('uber', '2026-09-11')).now === null,
  'the open period runs to the end of its week, so it covers days nobody has lived; '
  + '0 there is a measurement of one, and the house rule forbids exactly that');
check('…and its smear is still removed, so nothing is left claiming to be a statement',
  fill.byDay.get(K('uber', '2026-09-11')).was === 200,
  'was is subtracted from the delta whether or not anything replaces it');
check('the window delta is the sum of what moved',
  fill.delta === (750 * 3) - (200 * 5), String(fill.delta));
check('…and it is carried per platform, because the basis is chosen per channel',
  fill.byPlatform.get('uber') === fill.delta, JSON.stringify([...fill.byPlatform]));
check('a closed day is never touched',
  !fill.byDay.has(K('uber', '2026-09-06')) && !fill.byDay.has(K('uber', '2026-08-31')));
check('with no measurable rate the statement stands exactly as filed',
  fillOpenDays({ openDays: [{ platform: 'uber', d: '2026-09-07', statement_net: 200, gross: 1000 }],
    periods, rates: new Map() }).applied === 0);

console.log('\nthe tile moves with the bars, or the panel accuses itself');
{
  const byPlat = new Map([['uber', { platform: 'uber', statement_net: 1400 }]]);
  const moved = applyFillToPlatforms(byPlat, fill);
  check('the platform row moves by the same delta the days did',
    byPlat.get('uber').statement_net === +(1400 + fill.delta).toFixed(2),
    String(byPlat.get('uber').statement_net));
  check('…and it reports what it moved', moved === fill.delta, String(moved));
  const untouched = new Map([['bolt', { platform: 'bolt', statement_net: 99 }]]);
  applyFillToPlatforms(untouched, fill);
  check('a channel with no open period is left alone',
    untouched.get('bolt').statement_net === 99);
}

console.log('\nend to end, against the database');
{
  const r = await resolveOpenFill({ q, from: '2026-08-24', to: '2026-09-13',
    platform: null, fleet: null, today: TODAY });
  const at = (d) => r.fill.byDay.get(K('uber', d));
  check('every day of the open period is corrected', r.fill.applied === 7, String(r.fill.applied));
  check('each running day lands on its own gross times the measured rate',
    ['2026-09-07', '2026-09-08', '2026-09-09'].every((d) => at(d).now === 750),
    JSON.stringify(['2026-09-07', '2026-09-08', '2026-09-09'].map((d) => at(d)?.now)));
  check('…and the days with no trips contribute nothing at all, as null not zero',
    ['2026-09-11', '2026-09-12', '2026-09-13'].every((d) => at(d).now === null));
  check('the note names the week, the rate, and what it is built from',
    /week to 2026-09-13 has not closed/.test(r.notes[0].why)
    && /75\.0%/.test(r.notes[0].why) && /not a forecast/.test(r.notes[0].why), r.notes[0]?.why);
  check('the corrected day matches the closed weeks, which is the whole defect',
    at('2026-09-07').now === 750 && at('2026-09-07').was === 200,
    'the smear showed 200 on a day whose own trips earned 750');
}

console.log('\na window that never reaches the open period is not touched');
{
  const r = await resolveOpenFill({ q, from: '2026-08-24', to: '2026-09-06',
    platform: null, fleet: null, today: TODAY });
  check('nothing is corrected and no note is raised',
    r.fill.applied === 0 && r.fill.delta === 0, String(r.fill.delta));
}

console.log('\nthe sentence says which of the two bases a day is on');
check('it names the rate to a tenth of a percent',
  /74\.7%/.test(fillNote({ open_end: '2026-09-13' }, 0.7468, 56)),
  fillNote({ open_end: '2026-09-13' }, 0.7468, 56));

console.log('\nthe derived half is never reported as a statement');
{
  const r = await resolveOpenFill({ q, from: '2026-08-24', to: '2026-09-13',
    platform: null, fleet: null, today: TODAY });
  check('the fill carries its own total, not only the delta it moved by',
    r.fill.total === 750 * 3, String(r.fill.total));
  check('…which is what lets a caption say how much of the money Uber did NOT file',
    r.fill.total !== r.fill.delta,
    'delta is the change; total is the derived money itself, and a sentence about '
    + 'what Uber reported needs the second one subtracted, not the first');
  const src = (await import('node:fs')).readFileSync(
    new URL('../api/server.js', import.meta.url), 'utf8');
  check('/api/kpis moves the derived money out of accounted_statements',
    /income\.accounted_statements - fillKpi\.fill\.total/.test(src),
    'otherwise money the fleet derived from its own trips is reported under a '
    + 'figure whose caption says Uber filed it');
  check('…and names it in its own right',
    /income\.accounted_derived = fillKpi\.fill\.total;/.test(src));
  const app = (await import('node:fs')).readFileSync(
    new URL('../api/public/app.js', import.meta.url), 'utf8');
  check('the panel subtracts it before saying "reported earning on its own statements"',
    /t\.money_statement_part - \(t\.money_derived_part \|\| 0\)/.test(app));
  check('…and gives the open week its own clause',
    /is the open week, worked out from those/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
