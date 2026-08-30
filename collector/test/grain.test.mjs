/* Day, week, month — and the driver-day that all three are summed from.
   ─────────────────────────────────────────────────────────────────────────
   Two features that only work if they are one: a grain control is a promise
   that switching it does not change the total, and that promise is only
   keepable if every grain is built from the same rows.

   The traps this file exists to pin, each of which was live at some point
   while it was being written:

     a ROW is not a day    at week grain a 90-day window is five rows, and the
                           page divided trips by five to get a "daily" rate.
     a bucket is not whole at the edges of a window it is three days of seven,
                           drawn beside whole ones as a collapse.
     drivers do not sum    a five-day driver counted five times turns 118
                           people into six hundred.
     null is not zero      a week with no fare reported is not a week that
                           earned nothing.
     money is per platform statement net and per-trip fares are complementary
                           on Uber (which files one and not the other) and the
                           SAME money on Yango (which files both).
*/
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups, refreshDriverDays } from '../src/rollup.js';
import { periodWindow, previousWindow, grainOf, bucketSql, foldGrain, PERIODS, GRAINS }
  from '../api/window.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* ── periods, on Dubai's calendar ───────────────────────────────────────── */
/* 2026-08-29 is a Saturday. 14:00 Dubai, so a UTC-based implementation would
   still agree — which is why the awkward hour is tested separately below. */
const SAT = Date.parse('2026-08-29T10:00:00Z');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('today is one day', eq(periodWindow('today', SAT), ['2026-08-29', '2026-08-29']));
check('yesterday is the day before it', eq(periodWindow('yesterday', SAT), ['2026-08-28', '2026-08-28']));
/* ISO: Monday starts the week. Saturday the 29th belongs to the week that
   opened on Monday the 24th — not to the one starting Sunday the 23rd, which
   is what a Sunday-first implementation would answer. */
check('this week runs from ITS Monday to today', eq(periodWindow('week', SAT), ['2026-08-24', '2026-08-29']));
check('this month is the 1st to today', eq(periodWindow('month', SAT), ['2026-08-01', '2026-08-29']));
check('this quarter starts in July', eq(periodWindow('quarter', SAT), ['2026-07-01', '2026-08-29']));
check('this year starts in January', eq(periodWindow('year', SAT), ['2026-01-01', '2026-08-29']));
/* A finished period is WHOLE. Truncating last month to the 29th because today
   is the 29th would silently drop two days of July. */
check('last month is the whole of it', eq(periodWindow('last_month', SAT), ['2026-07-01', '2026-07-31']));
check('last week is seven days', eq(periodWindow('last_week', SAT), ['2026-08-17', '2026-08-23']));
check('an unknown period is refused rather than guessed', periodWindow('fortnight', SAT) === null);
check('every offered period resolves', PERIODS.every((p) => Array.isArray(periodWindow(p, SAT))));

/* The hour that separates a Dubai calendar from a UTC one. At 01:00 Dubai on
   the 1st of a month it is still the previous month in UTC, and a month-to-date
   computed on the server's clock would be the whole of the month before. */
const EARLY = Date.parse('2026-08-31T21:30:00Z');   // 01:30 Dubai on 1 Sep
check('a period is computed on Dubai’s calendar, not the server’s',
  eq(periodWindow('month', EARLY), ['2026-09-01', '2026-09-01']),
  JSON.stringify(periodWindow('month', EARLY)));

/* ── the comparison span ────────────────────────────────────────────────── */
/* The mistake this prevents: comparing 1–12 August against the WHOLE of July
   and reporting a 60% collapse that is entirely the calendar. */
check('the previous span is the same NUMBER of days, immediately before',
  eq(previousWindow(['2026-08-01', '2026-08-12']), ['2026-07-20', '2026-07-31']));
check('a single day compares against the day before it',
  eq(previousWindow(['2026-08-29', '2026-08-29']), ['2026-08-28', '2026-08-28']));

/* ── choosing a grain ───────────────────────────────────────────────────── */
const g = (query) => grainOf({ query }, SAT);
check('an explicit grain wins', g({ days: '7', grain: 'month' }) === 'month');
/* An ABSENT grain is `day`, whatever the span. Choosing from the window for a
   caller who did not ask would reshape a response that every pre-existing
   consumer — the product's own pages, a spreadsheet, a monitoring check —
   already parses one row per day. */
check('an absent grain is days, however wide the window',
  g({ days: '7' }) === 'day' && g({ days: '365' }) === 'day');
/* `auto` is the opt-in, and it is what the dashboard's "Auto grouping" sends. */
check('auto over a short window is days', g({ days: '7', grain: 'auto' }) === 'day');
check('auto over a quarter is weeks', g({ days: '90', grain: 'auto' }) === 'week');
check('auto over a year is months', g({ days: '365', grain: 'auto' }) === 'month');
check('an unknown grain is not guessed at — it is days',
  g({ days: '365', grain: 'fortnight' }) === 'day');
check('every offered grain is accepted', GRAINS.every((x) => g({ grain: x }) === x));
check('the bucket SQL truncates, and to ISO weeks',
  /date_trunc\('week'/.test(bucketSql('week')) && /date_trunc\('month'/.test(bucketSql('month')));

/* ── folding a day series ───────────────────────────────────────────────── */
/* Twenty-one days from Monday 3 August: three whole weeks. */
const series = [];
for (let i = 0; i < 21; i++) {
  const d = new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10);
  series.push({ d, trips: 10, completed: 9, cancelled: 1, telematics_journeys: 3,
    km: 100, revenue: i === 0 ? null : 50, priced_trips: 2, drivers: 5,
    uncollected: i === 4, sources_silent: i === 4 ? 3 : 0 });
}
const byDay = foldGrain(series, 'day');
const byWeek = foldGrain(series, 'week');
const byMonth = foldGrain(series, 'month');
const sum = (rows, k) => rows.reduce((a, r) => a + (+r[k] || 0), 0);

check('the day grain is the series itself', byDay === series);
check('three whole weeks fold to three buckets', byWeek.length === 3, String(byWeek.length));
check('…keyed on their Mondays',
  eq(byWeek.map((b) => b.d), ['2026-08-03', '2026-08-10', '2026-08-17']));
/* The promise the control makes. */
check('the total is identical at every grain',
  sum(byDay, 'trips') === 210 && sum(byWeek, 'trips') === 210 && sum(byMonth, 'trips') === 210,
  `${sum(byDay, 'trips')} / ${sum(byWeek, 'trips')} / ${sum(byMonth, 'trips')}`);
check('…for distance too', sum(byWeek, 'km') === 2100);

/* A count-distinct cannot be added. Seven days of five drivers is five people
   working a week, not thirty-five people. */
check('drivers are NOT summed across the days in a bucket', byWeek[0].drivers === 5, String(byWeek[0].drivers));
check('…and the bucket says what its driver figure actually is',
  /floor/.test(byWeek[0].drivers_basis || ''), byWeek[0].drivers_basis);

/* null is a different fact from zero, and survives the fold. */
check('a bucket whose days all report null stays null',
  foldGrain([{ d: '2026-08-03', revenue: null, trips: 1, drivers: 0 }], 'week')[0].revenue === null);
check('…but one number in the bucket makes it a number',
  byWeek[0].revenue === 300, String(byWeek[0].revenue));

/* The edges. */
check('a whole week is not marked partial', byWeek.every((b) => b.partial === false && b.days === 7));
check('a month clipped by the window IS marked partial',
  byMonth[0].partial === true && byMonth[0].days === 21 && byMonth[0].of_days === 31,
  JSON.stringify({ p: byMonth[0].partial, d: byMonth[0].days, o: byMonth[0].of_days }));
const clipped = foldGrain(series.slice(0, 3), 'week')[0];
check('…and so is a three-day week', clipped.partial === true && clipped.days === 3 && clipped.of_days === 7);

/* A gap inside a bucket is counted in DAYS, so a week holding one dead day is
   not reported as a dead week. */
check('a bucket counts the collection holes inside it', byWeek[0].uncollected_days === 1);
check('…and is only "uncollected" when every day in it was',
  byWeek[0].uncollected === false);
check('…which a whole dead bucket is',
  foldGrain([{ d: '2026-08-03', uncollected: true, trips: 0, drivers: 0 }], 'week')[0].uncollected === true);

/* ── the complete driver-day ────────────────────────────────────────────── */
/* One driver, one day, two channels: Uber files a statement and no per-trip
   fare; the hotel channel files a fare and no statement. The day earned both.
   A ledger row is present and must be ignored — it is the operator's own
   workbook, and folding it in would have the record quoting itself. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
  requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
 VALUES ('uber','u1','ecosine','L1','d1','Ann','2026-08-06T06:00:00Z','2026-08-06T06:20:00Z','a','b',10,'completed',NULL,'{}'),
        ('uber','u2','ecosine','L1','d1','Ann','2026-08-06T07:00:00Z','2026-08-06T07:20:00Z','a','b',10,'completed',NULL,'{}'),
        ('hotel','h1','ecosine','L1','d1','Ann','2026-08-06T09:00:00Z','2026-08-06T09:30:00Z','a','b',20,'completed',150,'{}')`);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_ext_id, driver_name, day,
  gross, fees, net, tips, salik, cash, trips, currency, source)
 VALUES ('uber','ecosine','d1','Ann','2026-08-06', 300, 60, 240, 12, 5, 30, 2,'AED','report'),
        ('uber','ecosine','d1','Ann','2026-08-07', 100, 20,  80,  0, 0,  0, 1,'AED','report'),
        ('uber','ecosine','d1','Ann Ledger','2026-08-06', 999, 0, 999, 0, 0, 0, 9,'AED','ledger')`);
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
  period_start, period_end, period_days, period_earnings, earnings, cash_earnings, currency)
 VALUES ('uber','ecosine','d1','Ann','2026-08-06','2026-08-06','2026-08-06',1,222,222,30,'AED')`);
await refreshDriverDays(db);
const dd = await q(`SELECT day, trips, fares, stmt_net, stmt_tips, payout, money, money_source
                      FROM driver_day WHERE driver_ext_id='d1' ORDER BY day`);

check('the day row carries the money beside the work', dd.length === 2, String(dd.length));
check('the platform statement lands on it', Number(dd[0].stmt_net) === 240, String(dd[0].stmt_net));
check('…and the bank payout beside it, not instead of it', Number(dd[0].payout) === 222);
/* The central arithmetic: Uber's statement and the hotel's fare are DIFFERENT
   money on the same day, so they add. */
check('money is the statement plus the fares of channels with no statement',
  Number(dd[0].money) === 390, String(dd[0].money));
check('…and says it came from both', dd[0].money_source === 'mixed', dd[0].money_source);
check('the operator’s own ledger is not counted as the platform reporting',
  Number(dd[0].stmt_net) === 240 && Number(dd[0].money) === 390);
/* A day the money reached and the trip feed did not is still a day. */
check('a day with money and no trips still gets a row',
  dd[1].trips === 0 && Number(dd[1].money) === 80, JSON.stringify(dd[1]));
check('…named as statement-only', dd[1].money_source === 'statement');
/* `fares` is left exactly as it was, because it is still the honest answer to
   a different question — and is now impossible to mistake for this one. */
check('fares still reports only what the trip rows priced', Number(dd[0].fares) === 150);

/* ── the statement that carries no id ───────────────────────────────────────
   The failure that reached production. The first version of this join matched
   the statement to the day on driver_ext_id, which found nothing at all: 2,375
   driver-days, zero with money, against AED 330,343 of statements in the same
   window. The statements are not keyed the way the trips are — one human holds
   several platform account ids, which is why this codebase folds on the NAME
   and falls back to the id, and why every other money surface here already
   resolves them that way.

   Ann below files her statement with no driver_ext_id at all, and it still has
   to land on her day. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
  requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
 VALUES ('uber','n1','ecosine','L2','d9','Nora  Said','2026-08-11T06:00:00Z','2026-08-11T06:20:00Z','a','b',10,'completed',NULL,'{}')`);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_ext_id, driver_name, day,
  gross, fees, net, tips, salik, cash, trips, currency, source)
 VALUES ('uber','ecosine', NULL, 'Nora Said','2026-08-11', 500, 100, 400, 0, 0, 0, 1,'AED','report')`);
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
  period_start, period_end, period_days, period_earnings, earnings, cash_earnings, currency)
 VALUES ('uber','ecosine', 'uber-acct-77', 'Nora Said','2026-08-11','2026-08-11','2026-08-11',1,390,390,0,'AED')`);
await refreshDriverDays(db);
const nora = (await q(`SELECT driver_ext_id, stmt_net, payout, money, money_source
                         FROM driver_day WHERE day = '2026-08-11' AND driver_ext_id = 'd9'`))[0];
check('a statement with no driver id still lands on the right person’s day',
  nora && Number(nora.stmt_net) === 400, JSON.stringify(nora));
/* The payout DOES carry an id — the column is NOT NULL — but it is the
   platform account's, not the one the trips are filed under. Same person, two
   ids, and the fold is what joins them. */
check('…and the payout with it, filed under a different account id',
  nora && Number(nora.payout) === 390, JSON.stringify(nora));
check('…matched on the folded name, spacing and all',
  nora && Number(nora.money) === 400 && nora.money_source === 'statement', JSON.stringify(nora));

/* And it must land ONCE. A person working two platform accounts in a day has
   two driver_day rows; attributing the statement to both would double the
   fleet's revenue at every grain above the day, which is worse than the bug it
   would be fixing. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
  requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
 VALUES ('uber','n2','ecosine','L2','d9b','Nora Said','2026-08-11T09:00:00Z','2026-08-11T09:20:00Z','a','b',10,'completed',NULL,'{}')`);
await refreshDriverDays(db);
const both = await q(`SELECT driver_ext_id, stmt_net FROM driver_day
                       WHERE day = '2026-08-11' AND driver_ext_id IN ('d9','d9b') ORDER BY driver_ext_id`);
const paid = both.filter((r) => r.stmt_net != null);
check('one person’s statement lands on exactly one of their two day rows',
  both.length === 2 && paid.length === 1, JSON.stringify(both));
check('…and is not split or duplicated between them',
  paid.length === 1 && Number(paid[0].stmt_net) === 400, JSON.stringify(paid));

/* ── the three grains over the real routes ──────────────────────────────── */
let n = 0;
for (let i = 0; i < 21; i++) {
  const day = new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10);
  for (const drv of ['x1', 'x2']) {
    await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
      requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
     VALUES ('uber',$1,'ecosine','L9',$3,$4,$2::timestamptz,$2::timestamptz+interval '20 min','a','b',10,'completed',NULL,'{}')`,
     [`g${++n}`, `${day}T08:00:00+04`, drv, drv === 'x1' ? 'Bee' : 'Cee']);
  }
}
await refreshRollups({ db });
const { get } = await mountAll(db, { serverRoutes: true });
const WIN = 'from=2026-08-03&to=2026-08-23';
const at = async (grain) => (await get(`/api/trips/daily?${WIN}&grain=${grain}`)).body;
const [rD, rW, rM] = await Promise.all([at('day'), at('week'), at('month')]);
const tot = (r) => r.reduce((a, x) => a + (+x.trips || 0), 0);

check('the route answers 21 daily buckets', rD.length === 21, String(rD.length));
check('…3 weekly', rW.length === 3, String(rW.length));
check('…1 monthly', rM.length === 1, String(rM.length));
check('and the fleet total is the same at all three',
  tot(rD) === tot(rW) && tot(rW) === tot(rM) && tot(rD) > 0,
  `${tot(rD)} / ${tot(rW)} / ${tot(rM)}`);
check('the clipped month says how much of itself it holds',
  rM[0].partial === true && rM[0].days === 21, JSON.stringify({ p: rM[0].partial, d: rM[0].days }));

/* ── the period comparison ──────────────────────────────────────────────── */
const cmp = (await get(`/api/compare/period?${WIN}`)).body;
check('the comparison names the span it compared against',
  cmp.previous.from === '2026-07-13' && cmp.previous.to === '2026-08-02',
  JSON.stringify(cmp.previous));
check('…and reports the window it was asked for', cmp.window.from === '2026-08-03');
/* Ann, Bee, Cee and Nora. Nora holds TWO platform accounts and worked one day
   under both, so a count of driver_ext_id answers five — which is why the day
   row stores the folded person and this counts that instead. The two figures
   are returned side by side, because "five accounts, four people" is a fact
   about the fleet and not a discrepancy to hide. */
check('it counts people once, however many accounts they hold',
  cmp.now.drivers === 4, String(cmp.now.drivers));
check('…and reports the account count beside it, unfolded',
  cmp.now.driver_accounts === 5, String(cmp.now.driver_accounts));
/* A payout period reaches back before the window, so driver_day holds rows for
   people who were PAID in it and did not drive in it. Counting those as
   drivers answered 258 for a production month in which 119 people drove — a
   fleet twice its real size. They are counted, separately, because they are
   not nothing. */
check('someone paid in the window but not driving in it is not a driver',
  typeof cmp.now.paid_not_driving === 'number', String(cmp.now.paid_not_driving));
check('…and Ann, paid on a day her trips did not reach us, is one of them',
  cmp.now.paid_not_driving >= 1, String(cmp.now.paid_not_driving));
/* No prior data at all. "+100%" against nothing is not growth, it is a
   division that should not have happened. */
check('a change against an empty span is null, not infinity',
  cmp.change_pct.trips === null, String(cmp.change_pct.trips));
/* driver_day has no platform column by design — a day is one row per person,
   and a person works several channels inside it. */
const refused = await get(`/api/compare/period?${WIN}&platform=uber`);
check('a platform filter is refused rather than silently ignored',
  refused.status === 400 && /driver-day/.test(refused.body.error || ''),
  JSON.stringify(refused.body).slice(0, 120));

/* ── the window, echoed back ────────────────────────────────────────────── */
const kp = (await get(`/api/kpis?period=month&grain=week`)).body;
check('kpis says which period it answered', kp.window?.period === 'month', JSON.stringify(kp.window));
check('…that a running period is partial', kp.window?.partial === true);
check('…and which grain the caller asked for', kp.window?.grain === 'week');
const kd = (await get(`/api/kpis?${WIN}`)).body;
check('a plain window carries no period and is not partial',
  kd.window?.period === null && kd.window?.partial === false, JSON.stringify(kd.window));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
