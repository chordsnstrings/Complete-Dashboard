/* The report nobody had asked for, and the columns that were never missing.
   ─────────────────────────────────────────────────────────────────────────
   driver_performance has carried acceptance_rate, cancellation_rate and
   completion_rate since the first schema, and grep says no collector has ever
   written one. So the ACCEPTANCE tile on every driver's Quality tab has been
   an em-dash for the life of this product — not for want of a column, but
   because REPORT_TYPE_DRIVER_QUALITY was never requested.

   Probed live on 2026-08-31: it returns 57 driver rows for one week with
   seventeen columns, keyed by Driver UUID. REPORT_TYPE_DRIVER_ACTIVITY, also
   keyed by uuid, adds the platform's own hours. A third — DRIVER_PERFORMANCE —
   identifies drivers by name, email and phone with NO uuid, and is deliberately
   not collected: folding names already merges seventeen of this fleet's
   hundred and nineteen drivers into people who are the same person twice.

   What is pinned here is the parsing, because every one of these fields has a
   way of being silently wrong:

     a rate stored sometimes as 0.87 and sometimes as 87 is worse than no rate
     a rolling "as seen in driver app" figure written into a dated row lies
     two reports merged by overwriting lose the more careful count
     a duration is "1 : 06 : 30", not a number
*/
import { readFileSync } from 'node:fs';
import { rate, spanHours, qualityRow, mergeQuality, num } from '../src/sources/uber.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\na rate is a fraction, whatever the report called it');

check('a percentage is stored as a fraction', rate('87%') === 0.87 && rate('87 %') === 0.87);
check('a bare number above one is a percentage too', rate('87') === 0.87,
  'the same column arrives both ways depending on the locale the report was generated under');
check('and a fraction is left alone', rate('0.87') === 0.87 && rate(0.93) === 0.93);
check('a perfect score survives the guess', rate('100%') === 1 && rate('1') === 1);
check('empty is unknown, never zero', rate('') === null && rate(null) === null && rate('n/a') === null,
  'a driver who accepted nothing and a driver nobody measured are different people');

console.log('\na duration is days, hours and minutes');

check('"1 : 06 : 30" is thirty and a half hours', spanHours('1 : 06 : 30') === 30.5);
check('and "0 : 07 : 45" is seven and three quarters', spanHours('0 : 07 : 45') === 7.75);
check('nothing is null, not zero hours', spanHours('') === null && spanHours(null) === null);
check('and a malformed span does not become NaN in the database', spanHours('later') === null);
check('a thousands separator is not a decimal point', num('1,204') === 1204);

console.log('\none driver-week, from the report that names them');

const Q = {
  'Driver UUID': 'u1', 'Driver first name': 'Ali', 'Driver surname': 'Khan',
  'Trips completed': '132', 'Confirmation rate': '91%', 'Cancellation rate': '4%',
  'Completion rate': '96%', 'Driver ratings (last 4 weeks)': '4.87',
  'Driver ratings (previous 500 trips)': '4.95',
  "Driver's current acceptance rate as seen in driver app": '88%',
  "Driver's current cancellation rate as seen in driver app": '6%',
  'Trips accepted (excluding Trip Radar or similar)': '140', 'Trips rejected': '12',
  'Trips cancelled': '6', 'Trips cancelled – Driver at fault': '2', 'Trips failed': '1',
  'Total trips assignments': '152',
};
const q = qualityRow(Q, '2026-08-24', '2026-08-30');

check('the row is keyed on Uber’s uuid, not on a name',
  q.driver_ext_id === 'u1' && q.driver_name === 'Ali Khan');
check('the column that has been empty since the first schema is filled',
  q.acceptance_rate === 0.91, String(q.acceptance_rate));
check('acceptance takes the PERIOD measure, not the rolling one',
  q.acceptance_rate === 0.91 && q.acceptance_rate_app === 0.88,
  'a current figure written into a dated row states something true about today as though it were true about the week');
check('and the same separation holds for cancellation',
  q.cancellation_rate === 0.04 && q.cancellation_rate_app === 0.06);
check('both ratings are kept, because they answer different questions',
  q.rating === 4.87 && q.rating_500 === 4.95,
  'four weeks moves with the period; five hundred trips is the number a driver thinks of as theirs — '
  + 'the gap between them is a trend available today');
check('every dispatch is counted, not only rated',
  q.trips_accepted === 140 && q.trips_rejected === 12 && q.trips_cancelled === 6
  && q.trips_cancelled_driver === 2 && q.trips_failed === 1 && q.trip_assignments === 152,
  'a rate over four trips and a rate over four hundred look identical and mean nothing alike');
check('an en-dash in Uber’s own header is not a hyphen, and both are read',
  qualityRow({ 'Driver UUID': 'u1', 'Trips cancelled - Driver at fault': '3' }, 'a', 'b')
    .trips_cancelled_driver === 3);
check('a row with no uuid is dropped rather than folded by name',
  qualityRow({ 'Driver first name': 'Ali' }, 'a', 'b') === null,
  'name folding already merges 17 of this fleet’s 119 drivers into the same person twice');

console.log('\ntwo reports, one row');

{
  const m = new Map();
  mergeQuality(m, qualityRow(Q, '2026-08-24', '2026-08-30'));
  mergeQuality(m, qualityRow({
    'Driver UUID': 'u1', 'Trips completed': '999',
    'Time online (days : hours: minutes)': '2 : 04 : 00',
    'Time on trip (days : hours : minutes)': '1 : 02 : 30',
  }, '2026-08-24', '2026-08-30'));
  const r = m.get('u1');
  check('the activity report adds the hours nothing else collects for Uber',
    r.hours_online === 52 && r.hours_on_trip === 26.5, `${r.hours_online} ${r.hours_on_trip}`);
  check('and it FILLS rather than overwrites, so the careful count survives',
    r.trips === 132, `${r.trips} — the two reports count slightly different things`);
  check('the quality it already had is untouched', r.acceptance_rate === 0.91 && r.rating === 4.87);
  check('and one row is written per driver-week, not two',
    m.size === 1, 'two rows would make every average in the product double-count');
}

console.log('\nthe judgements in the collector');

const src = readFileSync('src/sources/uber.js', 'utf8');
const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const body = bare.slice(bare.indexOf('async function pullDriverQuality'));

check('only the two reports that carry a uuid are collected',
  /QUALITY_REPORTS = \['REPORT_TYPE_DRIVER_QUALITY', 'REPORT_TYPE_DRIVER_ACTIVITY'\]/.test(bare)
  && !/REPORT_TYPE_DRIVER_PERFORMANCE/.test(bare),
  'DRIVER_PERFORMANCE identifies drivers by name, email and phone with no uuid');
check('it walks whole provider weeks, because the window IS the grain',
/* closedWeeks wraps weekChunks and drops only the week that has not finished:
   an open week ends on the coming Sunday, and Uber refuses that outright with
   "endDate is too late" — measured on production, every mid-week run. The
   calendar grid, which is what these assertions are about, is unchanged. */
  /closedWeeks\(from, to\)/.test(body),
  'driver_performance is keyed on (period_start, period_end); seven arbitrary days would key a second '
  + 'row against the same week’s work');
check('newest first, so a run that dies part-way has collected the useful end',
  /\.reverse\(\)/.test(body));
check('it checkpoints per window',
  /checkpoint\?\.has\(`quality \$\{ps\}\.\.\$\{pe\}`\)/.test(body)
  && /checkpoint\?\.mark\(`quality \$\{ps\}\.\.\$\{pe\}`/.test(body));
check('a window past Uber’s retention is expected, not an error',
  /const expected = \/invalid date range\|retention\|out of range\/i\.test\(msg\)/.test(body));
/* Read off collect()'s phase names rather than off the call spelling. The
   pulls used to be `await pullX(from, to, onStep, ck)` written out one after
   another; interleaving the two fleets turned them into phases, and a check
   pinned to the old spelling failed a change that does not touch the ordering
   it is about. The ordering is what matters and it still reads plainly. */
const collectSrc = bare.slice(bare.indexOf('export async function collect'));
const phaseAt = (n) => collectSrc.indexOf(`phase(s, '${n}'`);
check('and it runs after trips and earnings, which are the ones worth keeping',
  phaseAt('trips') > 0 && phaseAt('perf') > phaseAt('trips') && phaseAt('qual') > phaseAt('perf'),
  'a run that runs out of report slots should end having collected the money');
check('the report type is a parameter now, and its old value is still the default',
  /generateReport\(start, end, attempt = 0, reportType = 'REPORT_TYPE_TRIP_ACTIVITY'\)/.test(bare),
  'every existing caller must keep asking for exactly what it asked for before');
check('a retry after a busy report slot keeps asking for the same report',
  /return generateReport\(start, end, attempt \+ 1, reportType\)/.test(bare),
  'dropping it would silently re-ask for trips and upsert them as quality');

const sql = readFileSync('sql/schema_v48.sql', 'utf8');
check('the new columns are added, never assumed',
  (sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length >= 11);
check('and the rolling driver-app figures are stored apart from the period ones',
  /acceptance_rate_app/.test(sql) && /cancellation_rate_app/.test(sql));

/* The guard is now a block around the phase rather than a ternary on its
   result, because the phase is a loop over both fleets. Same rule: the
   nearest thing standing between the incremental and this walk must be the
   mode test. */
{
  const at = collectSrc.indexOf("phase(s, 'qual'");
  const guard = collectSrc.lastIndexOf("mode !== 'incremental'", at);
  check('the half-hourly incremental never spends a report on it',
    at > 0 && guard > 0 && at - guard < 400,
    'two reports per week per fleet, every thirty minutes, out of a cap of three in flight — '
    + 'taken from the slots the trip and earnings pulls need');
  /* And the same for the fare walk, which is the other report this mode must
     not spend: it was a ternary too, and is now a block. */
  const fareAt = collectSrc.indexOf('pullTripFaresAcross(');
  const fareGuard = collectSrc.lastIndexOf("mode !== 'incremental'", fareAt);
  check('…nor one on the payments report',
    fareAt > 0 && fareGuard > 0 && fareAt - fareGuard < 900,
    'the payments report has a generation cap of its own and the week has not closed yet');
}
check('and the walk is bounded, so a backfill still finishes',
  /const QUALITY_WEEK_HORIZON = 26/.test(bare)
  && /\.slice\(0, QUALITY_WEEK_HORIZON\)/.test(body),
  'a year is 208 reports and the better part of a day, mostly re-fetching weeks that have not changed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
