/* /api/forecast NOW ANSWERS THE YEAR-ON-YEAR QUESTION, AND REFUSES IT WHERE
   THE RECORD CANNOT SUPPORT IT.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT, measured on production 2026-09-22. The endpoint fitted one
   straight line to the months since the March 2026 break and published:

     {"m":"2026-09","point":14700,"low":11100,"high":18300}
     in_progress {days_so_far:22, trips_so_far:16166, projected:22045,
                  within_interval:false}

   The month it was predicting was already outside the interval it published
   for it. The line has no seasonal term and the regime it is fitted to has
   never contained an October, so it cannot have one.

   A SECOND DEFECT IN THE SAME OBJECT, found while fixing the first.
   `days_so_far` came from `spanTo`, the latest day carrying ANY booking. On
   2026-09-22 that was the 22nd, which held 71 bookings because the collector
   had run once that morning against a trailing norm near 766. So the run rate
   divided a numerator three quarters of a day short by a denominator a day too
   long: production published 734.8/day where the whole days alone give 766.4.
   That figure is the page's only out-of-sample score of its own forecast, so
   understating it makes a forecast that is too low look better than it is.

   What this file holds down, on the mounted route rather than on the model:

   1. THE NEW FIELDS ARE ACTUALLY SERVED, and carry both sides of bookings,
      active vehicles and bookings per active vehicle.
   2. A PAIR THAT IS NOT A COMPARISON IS REFUSED, BY THE ROUTE, with the
      channel named — the mix comes from a second rollup grain, so the model
      being right is not evidence the route fetched it.
   3. THE RUN RATE EXCLUDES THE DAY STILL BEING COLLECTED and says so.
   4. THE MONTH IN PROGRESS IS SCORED AGAINST THE SAME DAYS A YEAR EARLIER.
   5. A MONTH WITH NO HONEST BASE RENDERS ABSENT WITH A REASON.
   6. THE TOURISM REGRESSOR CARRIES ITS FIT AND ITS GAPS.
   7. THE OLD FIELDS STILL ANSWER — this is additive, and #forecast's existing
      refusal to fit across the break is untouched.

   PROVED BY REVERT — the guards were removed one at a time and the failures
   below are the ones that CAME BACK, transcribed from the output rather than
   from the intention. Baseline 38 passed, 0 failed.

   a. The route stops fetching the per-platform grain (`byPlatform` forced to
      null), so the mix that decides comparability is not there:
        ✗ the route refuses a pair whose year-ago month is a different business
            unchecked
        ✗ and names the channel that differs
        ✗ the refusal is the ROUTE's, from a second rollup grain it fetched
        ✗ the months it refused are listed on the seasonal model too
        ✗ a channel that did not exist a year ago is carried as its own term
        ✗ every method is scored one step ahead on the months that can be
            scored — {"seasonal":858.4,"line":5.3,"flat":236.5}
      32 passed, 6 FAILED.

      Two things worth keeping out of that. The verdict degrades to 'unchecked'
      with a reason saying the check could not be performed, which is the right
      answer for a grain that is genuinely missing and the wrong one for a
      grain that exists — so only an assertion on the VERDICT can tell those
      apart, not one on the wording. And the seasonal model's backtest error
      goes to 858%, because without the mix it happily fits January against a
      January that was a different business.

   b. The run rate goes back to `spanTo`, the last day carrying any booking
      (`haveWhole` forced false):
        ✗ the run rate is built from whole days only
            22 / null (today 2026-09-22)
        ✗ and says which basis it used
        ✗ the whole month including today is kept beside it, not thrown away
            1270 vs 1270
        ✗ and completing on that shape gives more than the flat run rate does
            1654 vs flat 1732
      34 passed, 4 FAILED. The last one is the one that matters: with the
      part-day counted, the shaped projection falls BELOW the flat run rate,
      inverting the relationship the panel exists to show.

   c. The same-days-a-year-ago query is dropped (`sameDays` left null):
        ✗ the month in progress is scored against the same days a year earlier
            null
        ✗ and the year-ago month is named — undefined vs 2025-09
        ✗ the share of the month elapsed is measured from last year, not
            assumed — undefined vs 0.7000
        ✗ and completing on that shape gives more than the flat run rate does
            undefined vs flat 1410
      34 passed, 4 FAILED.

      The FIRST run of this revert did not report four failures. It reported
      one and then died on `TypeError: Cannot read properties of null`, which
      ends the file on a stack trace and reaches `test/run-all.mjs` as a file
      with no "N passed, M failed" line — counted as broken, with nothing
      naming the cause. The assertions below that point are null-safe for that
      reason. A guard that cannot report its own failure legibly is half a
      guard. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { dubaiIso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);

/* ── the fixture ─────────────────────────────────────────────────────────
   Built relative to today in Dubai rather than on fixed dates, because the
   behaviour under test is "the day still being collected is today" and a
   fixture pinned to 2026-09 would stop exercising it the moment the clock
   moved past it. */
const today = dubaiIso();
const curM = today.slice(0, 7);
const dayNo = Number(today.slice(8, 10));
const addM = (ym, k) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
// idx 0 is 23 months back; idx 23 is the month in progress.
const M = (i) => addM(curM, i - 23);

/* Per-month bookings by channel. The shape is the live one in miniature:
   a Bolt-only opening stretch before Uber was ever collected, a seasonal peak
   a year back, a collapse, a recovery, and a hotel channel that starts only in
   the last three complete months. Each of those is a different reason a
   year-on-year pair is or is not a comparison. */
const MIX = {};
const seed = (i, o) => { MIX[M(i)] = o; };
// 0-2: Bolt only. Nothing else was being collected yet.
seed(0, { bolt: 600 }); seed(1, { bolt: 640 }); seed(2, { bolt: 580 });
// 3-7: Uber arrives.
[2000, 2200, 2400, 2600, 2800].forEach((n, k) => seed(3 + k, { uber: n - 200, bolt: 200 }));
// 8-10: the months that will be the base for the last three complete months.
seed(8, { uber: 2800, bolt: 200 });
seed(9, { uber: 3000, bolt: 200 });
seed(10, { uber: 3200, bolt: 200 });
// 11-14: the seasonal peak — the base for the months being forecast.
seed(11, { uber: 8200, bolt: 300 });
seed(12, { uber: 8700, bolt: 300 });
seed(13, { uber: 7600, bolt: 300 });
seed(14, { uber: 6900, bolt: 300 });
// 15: the break.
seed(15, { uber: 620, bolt: 80 });
// 16-19: recovery.
[800, 1000, 1200, 1300].forEach((n, k) => seed(16 + k, { uber: n - 80, bolt: 80 }));
// 20-22: recovery continues, and the hotel channel starts.
seed(20, { uber: 1200, bolt: 100, hotel: 100 });
seed(21, { uber: 1280, bolt: 120, hotel: 100 });
seed(22, { uber: 1380, bolt: 120, hotel: 100 });
// 23: the month in progress.
seed(23, { uber: 1100, bolt: 90, hotel: 80 });

const VEH = [20, 20, 19, 40, 42, 44, 46, 48, 60, 62, 64, 70, 72, 68, 66, 30, 33, 36, 40, 42,
  45, 46, 48, 44];
const DRV = VEH.map((v) => v + 12);
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);

for (let i = 0; i <= 23; i++) {
  const m = M(i);
  const mix = MIX[m];
  await q(
    `INSERT INTO rollup_month (month, platform, fleet_id, bookings, trips, drivers, vehicles,
       earning_vehicles, revenue, priced_trips, booking_platforms)
     VALUES ($1::date,'*','*',$2,$2,$3,$4,$4,$5,$2,$6)`,
    [`${m}-01`, total(mix), DRV[i], VEH[i], total(mix) * 42, Object.keys(mix)]);
  for (const [p, n] of Object.entries(mix)) {
    await q(
      `INSERT INTO rollup_month (month, platform, fleet_id, bookings, trips, drivers, vehicles,
         earning_vehicles, revenue, priced_trips)
       VALUES ($1::date,$2,'*',$3,$3,$4,$5,$5,$6,$3)`,
      [`${m}-01`, p, n, Math.round(DRV[i] / 2), Math.round(VEH[i] / 2), n * 42]);
  }
}

/* EVERY day from the first month of the fixture to today, not just the recent
   ones. `partial_month` is computed from the first and last day the record
   holds ANY booking, so a day grain that starts three months back marks every
   month before that as partial — and a partial month is refused as a
   year-ago base, which silently emptied the comparable window and left the
   seasonal model with nothing to fit. Generated in SQL rather than looped,
   because that is seven hundred rows. */
await q(
  `INSERT INTO rollup_day (day, platform, fleet_id, bookings, trips, drivers, vehicles,
     earning_vehicles, revenue, priced_trips)
   SELECT d::date, '*', '*', 47, 47, 20, 18, 18, 47 * 42, 47
   FROM generate_series($1::date, $2::date, interval '1 day') d
   ON CONFLICT (day, platform, fleet_id) DO NOTHING`,
  [`${M(0)}-01`, today]);

/* The same month a year earlier, ramping through the month, so that completing
   on its shape and completing on a flat rate are different numbers — which is
   the only way the assertion below can tell them apart. */
const lyM = addM(curM, -12);
for (let d = 1; d <= lastDay(lyM); d++) {
  await q('UPDATE rollup_day SET bookings = $2, trips = $2 WHERE day = $1::date AND platform = \'*\'',
    [`${lyM}-${String(d).padStart(2, '0')}`, 60 + d * 4]);
}
/* Today: the collector has run once and the day holds a fraction of a day's
   work. This single row is the whole of defect two. */
await q('UPDATE rollup_day SET bookings = 3, trips = 3 WHERE day = $1::date AND platform = \'*\'',
  [today]);

const r = await get('/api/forecast?horizon=12');
const b = r.body;

/* ── 7. the old contract still answers ──────────────────────────────── */
check('the endpoint still answers, and still fits a line', b.ok === true && b.n >= 3,
  JSON.stringify({ ok: b.ok, n: b.n }));
check('and still refuses to fit across the break, naming the months it dropped',
  Array.isArray(b.months_excluded) && b.months_excluded.length > 0
  && b.months_used.every((m) => !b.months_excluded.includes(m)),
  JSON.stringify(b.months_used));

/* ── 1. the new fields are served ───────────────────────────────────── */
const yo = (m) => (b.yoy || []).find((x) => x.m === m);
check('every observed month is paired with the same month a year earlier',
  Array.isArray(b.yoy) && b.yoy.length > 0 && b.yoy.every((x) => x.ly_m),
  String(b.yoy?.length));
{
  const row = yo(M(22));
  check('a comparable pair carries bookings on both sides',
    row.trips === total(MIX[M(22)]) && row.ly_trips === total(MIX[M(10)]),
    JSON.stringify([row.trips, row.ly_trips]));
  check('active vehicles then and now, both sides',
    row.vehicles === VEH[22] && row.ly_vehicles === VEH[10],
    JSON.stringify([row.vehicles, row.ly_vehicles]));
  check('and bookings per active vehicle, both sides',
    Math.abs(row.per_vehicle - total(MIX[M(22)]) / VEH[22]) < 0.01
    && Math.abs(row.ly_per_vehicle - total(MIX[M(10)]) / VEH[10]) < 0.01,
    JSON.stringify([row.per_vehicle, row.ly_per_vehicle]));
  /* The fleet shrank and each car got busier. A page showing only the total
     lets those read the same, which is the thing the operator asked for. */
  check('the fleet-size and per-vehicle halves are both reported, and differ',
    row.vehicle_ratio < 1 && row.split && row.split.led_by,
    JSON.stringify([row.vehicle_ratio, row.intensity_ratio, row.split?.led_by]));
}

/* ── 2. the route refuses a pair that is not a comparison ───────────── */
{
  /* M(12) is Uber + Bolt; M(0) twelve months before it is BOLT ONLY, because
     nothing else was being collected then. The ratio would be about 15x. */
  const row = yo(M(12));
  check('the route refuses a pair whose year-ago month is a different business',
    row.comparable === 'no', `${row.comparable}`);
  check('and names the channel that differs',
    /uber/.test(row.reason || ''), row.reason);
  check('the refusal is the ROUTE’s, from a second rollup grain it fetched',
    b.yoy.some((x) => x.like_platforms?.length), 'no like_platforms on any row');
  check('the months it refused are listed on the seasonal model too',
    (b.seasonal.months_rejected || []).some((x) => x.m === M(12)),
    JSON.stringify((b.seasonal.months_rejected || []).map((x) => x.m)));
}

/* ── the seasonal forecast ──────────────────────────────────────────── */
{
  const s = b.seasonal;
  check('the seasonal model is served and fitted to comparable months only',
    s.ok === true && s.months_used.length === 3
    && !s.months_used.includes(M(12)), JSON.stringify(s.months_used));
  check('its ratio carries a range built from the scatter of three months',
    s.ratio > 0 && s.ratio_low < s.ratio && s.ratio_high > s.ratio && s.t_multiplier === 4.30,
    JSON.stringify([s.ratio_low, s.ratio, s.ratio_high]));
  const first = s.forecast[0];
  check('the first forecast month is built on the same month a year earlier',
    first.m === addM(curM, 1) && first.base_m === addM(curM, -11),
    `${first.m} on ${first.base_m}`);
  /* The seasonal peak a year ago is 8,500 against a fleet now running 1,600 a
     month, so a model that knows about last year lands far above one that does
     not. That gap IS the deliverable. */
  check('and lands well clear of the straight line, because the base is a peak',
    first.point > (b.forecast[0].point * 1.5),
    `${first.point} vs line ${b.forecast[0].point}`);
  check('a channel that did not exist a year ago is carried as its own term',
    first.carry?.some((c) => c.platform === 'hotel'), JSON.stringify(first.carry));

  /* ── 5. a month with no honest base renders absent with a reason ──── */
  const orphan = s.forecast.find((x) => x.point === null);
  check('a month whose base is a partial month renders absent, not short',
    orphan && /partial month/.test(orphan.reason), JSON.stringify(orphan));
}

/* ── the scoreboard, published whichever way it falls ───────────────── */
check('every method is scored one step ahead on the months that can be scored',
  b.model_scores && b.model_scores.n >= 1
  && b.model_scores.rows.every((x) => x.actual > 0 && x.line != null),
  JSON.stringify(b.model_scores?.mean_abs_pct));
check('and the months that cannot be scored each say why',
  (b.model_scores.unscorable || []).every((u) => u.reason),
  JSON.stringify(b.model_scores.unscorable?.slice(-1)));

/* ── 3. the run rate excludes the day still being collected ─────────── */
{
  const ip = b.in_progress;
  check('the month in progress is reported', !!ip, JSON.stringify(ip));
  check('the run rate is built from whole days only',
    ip.days_so_far === dayNo - 1 && ip.last_whole_day < today,
    `${ip.days_so_far} / ${ip.last_whole_day} (today ${today})`);
  check('and says which basis it used',
    /whole days only/.test(ip.basis) && /still being collected/.test(ip.basis), ip.basis);
  /* Both figures served, so the difference is visible rather than the smaller
     one quietly replacing the larger. */
  check('the whole month including today is kept beside it, not thrown away',
    ip.trips_including_today > ip.trips_so_far,
    `${ip.trips_including_today} vs ${ip.trips_so_far}`);
  check('the per-day rate is the whole-day one, not the diluted one',
    Math.abs(ip.per_day - ip.trips_so_far / ip.days_so_far) < 0.11,
    `${ip.per_day} vs ${(ip.trips_so_far / ip.days_so_far).toFixed(1)}`);
}

/* ── 4. scored against the same days a year earlier ─────────────────── */
{
  const sdy = b.same_days_year_ago;
  check('the month in progress is scored against the same days a year earlier',
    !!sdy && sdy.through_day === dayNo - 1 && sdy.ly_same_days > 0,
    JSON.stringify(sdy));
  /* Null-safe from here down. When this block is the thing that broke, the
     next three assertions read off `sdy` and a bare dereference throws — which
     ends the file on a stack trace, loses every assertion after it, and
     reports to `test/run-all.mjs` as a file with no tally rather than as a
     failure with a name. A guard that cannot report its own failure legibly is
     half a guard. */
  check('and the year-ago month is named', sdy?.ly_m === lyM, `${sdy?.ly_m} vs ${lyM}`);
  /* The year-ago month ramps through, so the share elapsed by this day is less
     than the share of the calendar that has elapsed — which is exactly why a
     flat run rate understates a ramping month. */
  check('the share of the month elapsed is measured from last year, not assumed',
    sdy != null && sdy.share_of_month_by_now < (dayNo - 1) / lastDay(lyM),
    `${sdy?.share_of_month_by_now} vs ${((dayNo - 1) / lastDay(lyM)).toFixed(4)}`);
  check('and completing on that shape gives more than the flat run rate does',
    sdy != null && sdy.projected > b.in_progress.projected,
    `${sdy?.projected} vs flat ${b.in_progress.projected}`);
}

/* ── 6. tourism carries its fit and its gaps ────────────────────────── */
{
  const t = b.tourism;
  check('the tourism series is served against every observed month',
    Array.isArray(t.series) && t.series.length === b.observed.filter((m) => !m.no_data).length,
    String(t.series?.length));
  /* THE HOUSE PRINCIPLE, on the one field most likely to be faked. Dubai
     published a year-to-date total covering February to July 2026 and no
     monthly figure inside it; those months carry a reason, never a twelfth. */
  const gap = t.series.find((x) => x.m === '2026-04');
  if (gap) {
    check('a month Dubai did not publish carries null and a reason, never a number',
      gap.visitors === null && /not published monthly/.test(gap.reason), JSON.stringify(gap));
    check('and the reason says why dividing a total would be wrong',
      /invention/.test(gap.reason), gap.reason);
  } else {
    check('a month Dubai did not publish carries null and a reason, never a number',
      t.series.every((x) => x.visitors != null || x.reason),
      'no 2026-04 in this fixture; every gap still carries a reason');
    check('and the reason says why dividing a total would be wrong',
      (t.aggregates || []).some((a) => /says nothing about any one of them/.test(a.note)),
      JSON.stringify(t.aggregates));
  }
  check('the hand-transcribed series reconciles to what Dubai published separately',
    Array.isArray(t.reconciliation) && t.reconciliation.length === 3
    && t.reconciliation.every((c) => c.ok),
    JSON.stringify(t.reconciliation?.map((c) => [c.label, c.delta])));
  check('the aggregate months are kept as an aggregate, not spread over the months',
    (t.aggregates || []).length === 1 && t.aggregates[0].from === '2026-02'
    && t.aggregates[0].to === '2026-07', JSON.stringify(t.aggregates));
  check('the break has a cause on the record, and it is the city’s not the fleet’s',
    (t.context || []).some((c) => /hotel occupancy/.test(c.detail)),
    JSON.stringify((t.context || []).map((c) => c.headline)));
}

/* ── the calendar names events and moves no number ──────────────────── */
{
  const c = b.calendar;
  check('the demand calendar says which model wrote it',
    /GLM 5\.2/.test(c.model || ''), c.model);
  check('and carries the warning that no figure is adjusted by it',
    /No figure on this page is adjusted by it/.test(c.warning || ''), c.warning);
  check('no calendar month carries a multiplier a forecast could pick up',
    (c.months || []).every((m) => !Object.entries(m)
      .some(([k, v]) => k !== 'events' && typeof v === 'number')),
    JSON.stringify((c.months || [])[0]));
}

/* ── the refusal path still names the filter ────────────────────────── */
{
  const none = await get('/api/forecast?platform=careem');
  check('a channel with no bookings still refuses, about that channel only',
    none.body.ok === false && /careem/.test(none.body.reason) && none.body.filtered === true,
    JSON.stringify(none.body.reason));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
