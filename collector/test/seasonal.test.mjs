/* A YEAR-ON-YEAR COMPARISON OVER A RECORD THAT STARTS AT A DIFFERENT MONTH
   PER CHANNEL, and the several ways that is a confident lie.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT this module exists for, measured on production 2026-09-22 against
   the month in progress — the only out-of-sample evidence #forecast has:

     September 2026, forecast by the straight line   14,700 (11,100-18,300)
     September 2026, first 21 whole days             16,095
     the same 21 days of September 2025              19,867
     September 2026 completing on last year's shape  ~23,975

   The line is 39% low and the month is outside its own 95% interval —
   /api/forecast answers `within_interval: false`. Not scatter: August to
   September is the sharpest seasonal step in this city's year (14,234 in
   August 2025 against 29,594 in September 2025) and a line fitted to
   March..August has no term that can express it.

   THE SECOND DEFECT, which is what most of this file guards. The obvious fix —
   compare each month with the same month a year earlier — is wrong here,
   because this record does not start at one date. Uber's first month is
   2025-04, Yango's 2025-09, the hotel channel's 2026-07, and Bolt is a known
   collection gap being repaired separately. Measured on production:

     2026-01   37,100 bookings   uber + bolt + yango
     2025-01    6,384 bookings   BOLT ONLY

   A year-on-year table that prints +481% for January is reporting the month we
   started collecting Uber. Every check below that says "not comparable" exists
   because that number would otherwise be on the page in bold.

   PROVED BY REVERT — each guard was removed, this file re-run, and the
   failures BELOW ARE THE ONES THAT ACTUALLY CAME BACK, not the ones that were
   expected. Two of the five behaved differently from the prediction and both
   are recorded as they happened, because a revert note written from intention
   rather than from output is the same lie the tests exist to stop. Baseline is
   61 passed, 0 failed.

   1. `yearOnYear` stops testing the channel mix (`if (worst >= newChannelShare)`
      → `if (false)`), so a pair is never refused for describing a different
      business:
        ✗ a year-ago month carrying a different business is refused
            partly ratio=5.811
        ✗ February and March 2026 are refused for the same reason
        ✗ fewer than three comparable pairs refuses rather than guessing
        ✗ only the months that can be scored are scored
            ["2026-04","2026-05","2026-06","2026-07","2026-08"]
        ✗ every method is scored against the same actual
      56 passed, 5 FAILED.

      NOT as predicted, in two ways worth keeping. "the refusal names the
      channel and its share" still PASSES, because the softer 'partly' verdict
      names the same channel and the same 84.5% — so that assertion tests the
      wording and not the verdict, and only the verdict assertion above can
      catch this. And "the forecast window excludes a pair that is not a
      comparison" also still passes, because the three months that stop being
      refused are the OLDEST ones and the window takes the newest three either
      way. A guard whose failure mode is invisible to the assertion aimed at it
      is the reason this section is written from the output.

   2. `seasonalForecast` drops the `sqrt(1 + 1/n)` new-observation term
      (`t * s * Math.sqrt(1 + 1 / ratios.length)` → `t * s`):
        ✗ the interval is for a NEW ratio, not for the mean of the ones seen
            0.1637 vs 0.1638
        ✗ and it is wide enough to be honest about three points
      59 passed, 2 FAILED.

   3. `base_regime` back to the original wrong test
      (`window.some((p) => p.ly_m >= base.m)`):
        ✗ a base month inside the current regime is flagged as such
            before the break / false
      60 passed, 1 FAILED. The companion assertion about a PRE-break base still
      passes, because the broken test happens to answer that case correctly —
      which is exactly how the defect shipped.

   4. `tourismFit` stops excluding months whose channel mix differs from the
      fleet's current one (`if (Math.max(ownShare, theirShare) >= mixTolerance)`
      → `if (false)`):
        ✗ tourism is fitted only over months of the same business
            n=14 2025-01,2025-02
        ✗ the months left out each carry the true reason
        ✗ visitors explain most of the movement in work per vehicle
            0.135
      58 passed, 3 FAILED. The r² collapses from 0.668 to 0.135 — the fit is
      destroyed by plotting three months of a BOLT-ONLY fleet against a full
      year of Dubai's visitors, and without this guard the page would have
      reported "tourism explains 14% of the movement" and been wrong about the
      relationship as well as about the number.

   5. `sameDaysYearAgo` ignores `lastWholeDay` and counts the day still being
      collected:
        ✗ a day still being collected is not counted as a whole one
            22 / 16157
        ✗ the same days of the same month a year earlier are the comparison
            20947 ratio 0.771
        ✗ and the month is completed on last year's shape, above the flat run
            rate — 22827 vs flat 23081
        ✗ the share of the month that had elapsed is reported, not assumed to
            be 21/30 — 0.7078
      57 passed, 4 FAILED. Note the third one: with the part-day counted, the
      shaped projection falls BELOW the flat run rate, which inverts the very
      relationship the panel exists to show. */
import { yearOnYear, seasonalForecast, scoreModels, tourismFit, decompose,
  sameDaysYearAgo, lastYear } from '../src/seasonal.js';
import { VISITORS, NOT_PUBLISHED, reconcile, CALENDAR, CALENDAR_SOURCE } from '../src/dubai_tourism.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

/* ── the live series, as production answers it ───────────────────────────
   Real numbers, because a fixture with a tidy shape cannot falsify a model
   that fails on a messy one — the same lesson `docs/COVERAGE.md` records about
   a mock with narrow digits and a layout that overflows on wide ones. These
   are /api/forecast's own `observed` rows from 2026-09-22. */
const M = (m, trips, drivers, vehicles, extra = {}) =>
  ({ m, trips, drivers, vehicles, no_data: false, partial_month: false, ...extra });

const LIVE = [
  M('2024-10', 0, 0, 0, { no_data: true, partial_month: true }),
  M('2024-11', 0, 0, 0, { no_data: true, partial_month: true }),
  M('2024-12', 1013, 80, 71, { partial_month: true }),
  M('2025-01', 6384, 102, 94),
  M('2025-02', 4206, 105, 98),
  M('2025-03', 2148, 102, 97),
  M('2025-04', 24247, 161, 99),
  M('2025-05', 21579, 167, 106),
  M('2025-06', 12649, 141, 104),
  M('2025-07', 11816, 152, 107),
  M('2025-08', 14234, 161, 114),
  M('2025-09', 29594, 196, 120),
  M('2025-10', 35703, 215, 118),
  M('2025-11', 40452, 209, 123),
  M('2025-12', 30674, 179, 119),
  M('2026-01', 37100, 179, 113),
  M('2026-02', 30772, 172, 114),
  M('2026-03', 6987, 132, 95),
  M('2026-04', 7229, 117, 91),
  M('2026-05', 10416, 103, 81),
  M('2026-06', 10756, 90, 77),
  M('2026-07', 10883, 107, 83),
  M('2026-08', 14021, 115, 98),
  M('2026-09', 16166, 126, 100, { partial_month: true }),
];

/* The channel mix, also from production — one /api/forecast call per platform.
   This is the evidence the comparability test is made of, so a fixture that
   invented it would prove nothing. */
const MIX = new Map(Object.entries({
  '2024-12': { bolt: 1013 },
  '2025-01': { bolt: 6384 },
  '2025-02': { bolt: 4206 },
  '2025-03': { bolt: 2148 },
  '2025-04': { uber: 21372, bolt: 2875 },
  '2025-05': { uber: 19725, bolt: 1854 },
  '2025-06': { uber: 11863, bolt: 786 },
  '2025-07': { uber: 11065, bolt: 751 },
  '2025-08': { uber: 13568, bolt: 666 },
  '2025-09': { uber: 28210, bolt: 1198, yango: 186 },
  '2025-10': { uber: 32726, bolt: 2673, yango: 304 },
  '2025-11': { uber: 34734, bolt: 5414, yango: 304 },
  '2025-12': { uber: 26649, bolt: 3841, yango: 184 },
  '2026-01': { uber: 31120, bolt: 5755, yango: 225 },
  '2026-02': { uber: 25437, bolt: 5101, yango: 234 },
  '2026-03': { uber: 6065, bolt: 841, yango: 81 },
  '2026-04': { uber: 6711, bolt: 441, yango: 77 },
  '2026-05': { uber: 9707, bolt: 581, yango: 128 },
  '2026-06': { uber: 10047, bolt: 594, yango: 115 },
  '2026-07': { uber: 9655, bolt: 472, yango: 103, hotel: 653 },
  '2026-08': { uber: 12445, bolt: 560, yango: 100, hotel: 916 },
  '2026-09': { uber: 14784, bolt: 661, yango: 76, hotel: 645 },
}).map(([m, o]) => [m, new Map(Object.entries(o))]));

const rows = yearOnYear(LIVE, { byPlatform: MIX });
const at = (m) => rows.find((r) => r.m === m);

/* ── 1. A YEAR-AGO MONTH IS NOT AUTOMATICALLY COMPARABLE ─────────────── */
{
  const jan = at('2026-01');
  check('a year-ago month carrying a different business is refused',
    jan.comparable === 'no', `${jan.comparable} ratio=${jan.ratio?.toFixed(3)}`);
  check('and the refusal names the channel and its share',
    /uber/.test(jan.reason) && /84\.5%/.test(jan.reason), jan.reason);
  /* The number the page would otherwise have printed. Kept in the test as the
     thing being refused, not as a thing being asserted. */
  check('the raw ratio it refused to publish really is the absurd one',
    near(jan.ratio, 5.811, 0.001), String(jan.ratio));

  check('February and March 2026 are refused for the same reason',
    at('2026-02').comparable === 'no' && at('2026-03').comparable === 'no',
    `${at('2026-02').comparable} / ${at('2026-03').comparable}`);

  /* A different refusal with a different reason: the year-ago month is simply
     not in the record. That is not the same fact and must not read the same. */
  check('a month with no year-ago month at all says the record begins after it',
    at('2025-09').comparable === 'no' && /record begins after it/.test(at('2025-09').reason),
    at('2025-09').reason);
  check('a PARTIAL year-ago month is refused as short by construction',
    at('2025-12').comparable === 'no' && /short by construction/.test(at('2025-12').reason),
    at('2025-12').reason);

  check('and the months that ARE a comparison are allowed through',
    ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08']
      .every((m) => at(m).comparable !== 'no'),
    JSON.stringify(['2026-04', '2026-08'].map((m) => at(m).comparable)));
}

/* ── 2. THE FLEET AND THE WORK EACH CAR DOES MUST NOT READ THE SAME ──── */
{
  const aug = at('2026-08');
  check('bookings, active vehicles and per-vehicle are all carried, both sides',
    aug.trips === 14021 && aug.ly_trips === 14234
    && aug.vehicles === 98 && aug.ly_vehicles === 114,
    JSON.stringify([aug.trips, aug.ly_trips, aug.vehicles, aug.ly_vehicles]));
  check('the fleet is smaller than a year ago', near(aug.vehicle_ratio, 0.860, 0.001),
    String(aug.vehicle_ratio));
  check('and each vehicle is doing MORE than a year ago',
    near(aug.intensity_ratio, 1.146, 0.001), String(aug.intensity_ratio));
  /* The whole point of the decomposition: bookings barely moved (0.985) while
     both halves moved a lot in opposite directions. A page showing only the
     total says "flat" about a fleet that shrank 14% and sped up 15%. */
  check('total bookings barely moved while both halves moved a lot',
    near(aug.ratio, 0.985, 0.001)
    && Math.abs(aug.vehicle_ratio - 1) > 0.13 && Math.abs(aug.intensity_ratio - 1) > 0.13,
    String(aug.ratio));

  const split = decompose(aug);
  check('the split is reported in percent, both terms',
    near(split.vehicle_pct, -14, 0.2) && near(split.intensity_pct, 14.6, 0.2),
    JSON.stringify(split));
  /* Compared on the log scale, because the decomposition is multiplicative:
     -50% of the fleet and +100% per car are the same size of move. */
  check('and the larger of the two is named on the log scale, not the raw one',
    decompose({ vehicle_ratio: 0.5, intensity_ratio: 2, ratio: 1 }).led_by === 'fleet size',
    decompose({ vehicle_ratio: 0.5, intensity_ratio: 2, ratio: 1 }).led_by);
}

/* ── 3. THE RATIO HAS A RANGE, AND IT IS WIDE ────────────────────────── */
const sf = seasonalForecast(LIVE, { horizon: 12, byPlatform: MIX, regimeFrom: '2026-03' });
{
  check('the forecast window excludes a pair that is not a comparison',
    !sf.months_used.some((m) => ['2026-01', '2026-02', '2026-03'].includes(m)),
    JSON.stringify(sf.months_used));
  check('it is the three most recent comparable months',
    JSON.stringify(sf.months_used) === JSON.stringify(['2026-06', '2026-07', '2026-08']),
    JSON.stringify(sf.months_used));
  check('the ratio is taken like for like, over channels both months carry',
    sf.pairs_used.every((p) => p.like_for_like) && near(sf.ratio, 0.8707, 0.0005),
    `${sf.ratio} ${JSON.stringify(sf.pairs_used.map((p) => p.ratio))}`);
  /* Three observations, two degrees of freedom. A normal 1.96 here would
     understate the interval by more than half. */
  check('three ratios use a t multiplier of 4.30, not 1.96', sf.t_multiplier === 4.30,
    String(sf.t_multiplier));

  const half = sf.ratio_high - sf.ratio;
  const s = sf.ratio_sd;
  /* Tolerance rather than equality because ratio_sd and ratio_high are both
     served rounded to four places; the quantity being asserted is the
     sqrt(1 + 1/n) widening, which is 15% of the half-width and far outside it. */
  check('the interval is for a NEW ratio, not for the mean of the ones seen',
    near(half, 4.30 * s * Math.sqrt(1 + 1 / 3), 5e-4)
    && half > 4.30 * s, `${half.toFixed(4)} vs ${(4.30 * s).toFixed(4)}`);
  check('and it is wide enough to be honest about three points',
    half / sf.ratio > 0.2, String(half / sf.ratio));

  check('the fleet-size and intensity halves are reported separately',
    near(sf.vehicle_ratio, 0.7919, 0.0005) && near(sf.intensity_ratio, 1.1606, 0.0005),
    `${sf.vehicle_ratio} / ${sf.intensity_ratio}`);
  /* The finding the operator asked for, in one number: over three consecutive
     months the per-vehicle ratio sat at 1.149, 1.187, 1.146. That is a
     stable relationship; the fleet-size ratio in the same months is not. */
  check('the per-vehicle ratio is the stable half of the two',
    sf.intensity_sd < 0.03, String(sf.intensity_sd));
}

/* ── 4. THE FORECAST ITSELF ──────────────────────────────────────────── */
{
  const oct = sf.forecast.find((r) => r.m === '2026-10');
  check('October is built on October, not on last month',
    oct.base_m === '2025-10' && oct.base === 35703, `${oct.base_m}=${oct.base}`);
  check('and lands far above what a straight line through the recovery gives',
    oct.point > 28000 && oct.point < 36000, String(oct.point));
  check('every forecast month carries its interval',
    sf.forecast.filter((r) => r.point != null).every((r) => r.low != null && r.high != null));
  check('a channel that did not exist a year ago is a separate named term',
    oct.carry?.length === 1 && oct.carry[0].platform === 'hotel',
    JSON.stringify(oct.carry));
  check('and it is that channel’s own measured monthly mean, not a share of the total',
    oct.carry[0].trips > 600 && oct.carry[0].trips < 1000, JSON.stringify(oct.carry));

  /* A base month that is itself post-break carries the collapse already, so
     the ratio — measured as post-break over PRE-break — would subtract it a
     second time. Flagged rather than silently corrected. */
  const mar = sf.forecast.find((r) => r.m === '2027-03');
  check('a base month inside the current regime is flagged as such',
    mar.base_post_break === true && /within the current regime/.test(mar.base_regime),
    `${mar.base_regime} / ${mar.base_post_break}`);
  check('while a base month before the break is flagged as that',
    sf.forecast.find((r) => r.m === '2026-11').base_post_break === false,
    sf.forecast.find((r) => r.m === '2026-11').base_regime);

  /* The refusal that matters most: a month whose year-ago month is partial has
     no honest base, and renders ABSENT WITH A REASON rather than as a number
     short by however many days the base is missing. */
  const sep27 = sf.forecast.find((r) => r.m === '2027-09');
  check('a month whose base is partial renders absent, not short',
    sep27.point === null && /partial month/.test(sep27.reason), JSON.stringify(sep27));

  /* And the refusal for the whole model. */
  const thin = seasonalForecast(LIVE.filter((m) => m.m < '2026-06'), { byPlatform: MIX });
  check('fewer than three comparable pairs refuses rather than guessing',
    thin.ok === false && /Three is the minimum/.test(thin.reason), thin.reason);
  check('and the refusal lists the pairs it rejected, with their reasons',
    thin.months_rejected.length > 0 && thin.months_rejected.every((r) => r.reason),
    String(thin.months_rejected.length));
}

/* ── 5. THE SCOREBOARD, PUBLISHED WHICHEVER WAY IT FALLS ─────────────── */
{
  const sc = scoreModels(LIVE, { byPlatform: MIX, regimeFrom: '2026-03' });
  check('only the months that can be scored are scored',
    sc.n === 2 && sc.rows.map((r) => r.m).join() === '2026-07,2026-08',
    JSON.stringify(sc.rows.map((r) => r.m)));
  check('and the ones that cannot each say why',
    sc.unscorable.length > 0 && sc.unscorable.every((u) => u.reason),
    JSON.stringify(sc.unscorable.slice(-1)));
  check('every method is scored against the same actual',
    sc.rows.every((r) => r.actual > 0 && r.line != null && r.flat != null));
  /* THE UNCOMFORTABLE ONE. On these two months the straight line wins, and it
     wins because both sit inside the recovery where a lagged year-on-year
     ratio is biased low by construction. This assertion exists so that a
     future change which quietly stops publishing the losing number fails. */
  check('the new model does NOT win the two scorable months, and the table says so',
    sc.mean_abs_pct.line < sc.mean_abs_pct.seasonal,
    JSON.stringify(sc.mean_abs_pct));
}

/* ── 6. THE MONTH IN PROGRESS, AGAINST THE SAME DAYS A YEAR AGO ──────── */
{
  /* September 2025 and 2026 as production's /api/trips/daily answers them,
     reduced to the shape the function takes. The 22nd of September 2026 holds
     71 bookings because the collector had run once that morning — that day is
     the whole reason this guard exists. */
  const sep26 = [
    ...Array.from({ length: 21 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`,
      trips: Math.round(16095 / 21) })),
    { day: '2026-09-22', trips: 71 },
  ];
  const sep25 = Array.from({ length: 30 }, (_, i) => ({ day: `2025-09-${String(i + 1).padStart(2, '0')}`,
    trips: i < 21 ? Math.round(19867 / 21) : Math.round((29594 - 19867) / 9) }));

  const sd = sameDaysYearAgo(sep26, sep25, { lastWholeDay: '2026-09-21' });
  check('a day still being collected is not counted as a whole one',
    sd.through_day === 21 && sd.trips_so_far < 16166,
    `${sd.through_day} / ${sd.trips_so_far}`);
  check('the same days of the same month a year earlier are the comparison',
    near(sd.ly_same_days, 19867, 25) && near(sd.ratio, 0.810, 0.005),
    `${sd.ly_same_days} ratio ${sd.ratio}`);
  /* The month is completed on last year's within-month PROFILE, not on a flat
     run rate. September climbs all the way through, so the two differ by about
     a thousand bookings and the flat one is the low answer. */
  check('and the month is completed on last year’s shape, above the flat run rate',
    sd.projected > Math.round((sd.trips_so_far / 21) * 30),
    `${sd.projected} vs flat ${Math.round((sd.trips_so_far / 21) * 30)}`);
  check('the share of the month that had elapsed is reported, not assumed to be 21/30',
    sd.share_of_month_by_now < 0.7 && sd.share_of_month_by_now > 0.6,
    String(sd.share_of_month_by_now));
  check('no days on either side means no comparison rather than a zero',
    sameDaysYearAgo(sep26, []) === null && sameDaysYearAgo([], sep25) === null);
}

/* ── 7. TOURISM AS A REGRESSOR, WITH ITS FIT STATED ──────────────────── */
{
  const tf = tourismFit(LIVE, VISITORS, { byPlatform: MIX });
  check('tourism is fitted only over months of the same business',
    tf.ok && tf.n === 11 && !tf.months.includes('2025-01'),
    `n=${tf.n} ${tf.months?.slice(0, 2)}`);
  check('the months left out each carry the true reason',
    tf.excluded.some((e) => e.m === '2025-01' && /carried bolt/.test(e.reason))
    && tf.excluded.some((e) => e.m === '2026-04' && /not published/.test(e.reason)),
    JSON.stringify(tf.excluded.slice(0, 1)));
  /* The finding, and it is reported honestly in both directions: visitors
     explain most of what each car does and little of how many cars there
     are. The second is supposed NOT to fit — fleet size is an operator's
     decision, not the city's — and if it fitted as well as the first,
     something would be wrong with the first. */
  check('visitors explain most of the movement in work per vehicle',
    near(tf.per_vehicle.r2, 0.668, 0.01), String(tf.per_vehicle.r2));
  check('and little of the movement in how many vehicles there are',
    tf.vehicles.r2 < tf.per_vehicle.r2 / 2,
    `${tf.vehicles.r2} vs ${tf.per_vehicle.r2}`);
  check('the slope is reported in a named unit, not bare',
    /per million visitors/.test(tf.per_vehicle.unit), tf.per_vehicle.unit);
  check('and the typical distance from the line is reported beside r²',
    tf.per_vehicle.typical_error > 0, String(tf.per_vehicle.typical_error));

  const none = tourismFit(LIVE, new Map(), { byPlatform: MIX });
  check('no published figures refuses rather than fitting nothing',
    none.ok === false && /Three is the minimum/.test(none.reason), none.reason);
}

/* ── 8. THE HAND-TRANSCRIBED TABLE CHECKS ITSELF ─────────────────────── */
{
  const r = reconcile();
  check('the monthly series reconciles to every total Dubai published separately',
    r.length === 3 && r.every((c) => c.ok),
    JSON.stringify(r.map((c) => [c.label, c.got, c.expect, c.delta])));
  check('H1 2025 hits the published 9.88 million exactly',
    r.find((c) => c.label === 'H1 2025').delta === 0,
    String(r.find((c) => c.label === 'H1 2025').got));
  check('and the full year lands within 2,000 of the published 19.59 million',
    Math.abs(r.find((c) => c.label === 'Full year 2025').delta) <= 2000,
    String(r.find((c) => c.label === 'Full year 2025').delta));

  /* THE MONTHS DUBAI DID NOT PUBLISH ARE NOT HERE. A monthly regressor faked
     from an annual figure divided by twelve is exactly the reason-that-is-not-
     the-true-one CLAUDE.md forbids, and this is the assertion that stops a
     future hand deciding the gap looks untidy. */
  check('February to July 2026 carry no invented monthly figure',
    ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
      .every((m) => !VISITORS.has(m) && NOT_PUBLISHED.has(m)),
    JSON.stringify([...VISITORS.keys()].filter((m) => m > '2026-01' && m < '2026-08')));
  check('and each says the authority did not publish it, in words',
    [...NOT_PUBLISHED.values()].every((v) => /not published monthly/.test(v.reason)
      && /would be an invention/.test(v.reason)));
  check('every published month names who published it',
    [...VISITORS.values()].every((v) => v.published_by && v.source));
}

/* ── 9. A MODEL MAY NAME AN EVENT AND MAY NOT MOVE A NUMBER ──────────── */
{
  check('the calendar covers the whole forecast horizon', CALENDAR.size === 12);
  check('it says which model wrote it, and when',
    /GLM 5\.2/.test(CALENDAR_SOURCE.model) && CALENDAR_SOURCE.generated === '2026-09-22',
    CALENDAR_SOURCE.model);
  check('and carries the warning that nothing on the page is adjusted by it',
    /not measured/.test(CALENDAR_SOURCE.warning)
    && /No figure on this page is adjusted by it/.test(CALENDAR_SOURCE.warning),
    CALENDAR_SOURCE.warning);
  /* The reason the warning is not boilerplate. The same calendar generated on
     a different model returned Ramadan 1448 as ~17 February 2027, which is
     1447's date — a year stale, nine days out, and delivered with exactly the
     same confidence as everything else in the reply. */
  check('the Islamic dates are the ones UAE reporting published, not a year stale',
    /~8 Feb 2027/.test(CALENDAR.get('2027-02').events.join(' ')),
    CALENDAR.get('2027-02').events.join(' | '));
  check('and the check that caught it is recorded beside them',
    /year stale/.test(CALENDAR_SOURCE.checked), CALENDAR_SOURCE.checked);

  /* NO NUMBER. The calendar carries a direction and prose and nothing that
     could be multiplied into a forecast by a later hand looking for one. */
  const numeric = [...CALENDAR.values()].filter((v) =>
    Object.entries(v).some(([k, x]) => k !== 'events' && typeof x === 'number'));
  check('no calendar entry carries a number a forecast could be multiplied by',
    numeric.length === 0, JSON.stringify(numeric));
  check('each entry is a direction and a sentence, nothing more',
    [...CALENDAR.values()].every((v) => ['up', 'down', 'mixed', 'neutral'].includes(v.direction)
      && v.note.length < 140 && Array.isArray(v.events)));
}

/* ── 10. the arithmetic nobody should have to re-derive ──────────────── */
{
  check('lastYear crosses a year boundary', lastYear('2026-01') === '2025-01'
    && lastYear('2026-12') === '2025-12', lastYear('2026-01'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
