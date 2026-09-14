/* The arithmetic behind "better or worse", checked where it is cheap to check.
   ──────────────────────────────────────────────────────────────────────────
   test/performance_record.test.mjs proves the behaviour end to end against a
   database. This file proves the identities the behaviour rests on, which a
   fixture cannot: that the split of a change accounts for ALL of it, that a
   percentile behaves at the boundaries and in a tie, that an interval over
   nothing does not claim certainty, and that a week is seven days even when it
   crosses a month, a year, or a February.

   Every one of these is a property that would fail silently. A split that
   leaves a remainder still prints two plausible numbers; a percentile that is
   off by one at a tie still prints a percentile. */
import {
  splitChange, position, wilson, band, surprise, fleetFactor,
  invNorm, bonferroniZ, SINGLE_Z, valueCoverage, valueRankable, VALUE_COVERAGE_MIN,
  periodStart, periodEnd, periodSeries, periodProgress, PERF_GRAINS, isPerfGrain,
  BASELINE_PERIODS, RATE_GATES,
} from '../api/performance_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ── the split accounts for the whole change ────────────────────────────── */
{
  /* Swept rather than sampled: the identity has to hold for a fall as well as
     a rise, for a change in one factor alone, and for zero on either side —
     the last of which is a real driver, the one who did not work this week. */
  let worst = 0;
  for (const d0 of [0, 1, 3.5, 6, 31]) {
    for (const r0 of [0, 0.5, 4, 12.25]) {
      for (const d1 of [0, 1, 3.5, 6, 31]) {
        for (const r1 of [0, 0.5, 4, 12.25]) {
          const s = splitChange({ days0: d0, rate0: r0, days1: d1, rate1: r1 });
          worst = Math.max(worst, Math.abs((s.days_part + s.rate_part) - s.total));
        }
      }
    }
  }
  check('the days part and the intensity part always add to the whole change',
    worst < 1e-9, `worst residual ${worst}`);
}
check('a change in days alone is charged entirely to days',
  near(splitChange({ days0: 4, rate0: 5, days1: 6, rate1: 5 }).rate_part, 0));
check('a change in intensity alone is charged entirely to intensity',
  near(splitChange({ days0: 4, rate0: 5, days1: 4, rate1: 8 }).days_part, 0));
{
  /* The cross term. Two more days AND a job a day faster: the naive split
     (d1-d0)*r0 and d0*(r1-r0) leaves 2*1 = 2 jobs unassigned. The symmetric
     one hands half of it to each, which is why the parts still add up. */
  const s = splitChange({ days0: 4, rate0: 5, days1: 6, rate1: 6 });
  check('the cross term is shared rather than dropped',
    near(s.total, 16) && near(s.days_part, 11) && near(s.rate_part, 5),
    JSON.stringify(s));
}

/* ── the percentile ─────────────────────────────────────────────────────── */
check('the top of a column is 100 and the bottom is 0',
  position([1, 2, 3, 4], 4).percentile === 100 && position([1, 2, 3, 4], 1).percentile === 0);
check('a lone member is 50, not 100 — there is nobody to be above',
  position([7], 7).percentile === 50 && position([7], 7).of === 1);
check('a tie carries its size, so a page can tell one person at the bottom from ninety',
  position([5, 5, 5, 9], 5).tied === 3 && position([5, 5, 5, 9], 5).percentile === 0,
  JSON.stringify(position([5, 5, 5, 9], 5)));
check('the rank is the ordinal an operator reads, 1 = most',
  position([1, 2, 2, 9], 9).rank === 1 && position([1, 2, 2, 9], 2).rank === 2
    && position([1, 2, 2, 9], 1).rank === 4,
  JSON.stringify([position([1, 2, 2, 9], 2).rank, position([1, 2, 2, 9], 1).rank]));
check('the unrounded percentile travels, so an inverted scale rounds once',
  near(position([0, 1, 2, 3], 1).raw, 100 / 3) && position([0, 1, 2, 3], 1).percentile === 33,
  String(position([0, 1, 2, 3], 1).raw));
check('an empty population does not throw and does not claim a median',
  position([], 3).of === 0 && position([], 3).median === null);

/* ── the interval ───────────────────────────────────────────────────────── */
{
  const w = wilson(0, 4);
  check('nought out of four is not certainty — the textbook interval says it is',
    w.p === 0 && w.lo === 0 && w.hi > 0.3, JSON.stringify(w));
  const f = wilson(4, 4);
  check('four out of four is not certainty either',
    f.p === 1 && f.lo < 0.7 && f.hi === 1, JSON.stringify(f));
  check('the interval narrows as the sample grows',
    (wilson(50, 100).hi - wilson(50, 100).lo) > (wilson(500, 1000).hi - wilson(500, 1000).lo));
  check('and over nothing at all it reports nothing rather than zero',
    wilson(0, 0).p === null && wilson(0, 0).n === 0);
}

/* ── the band ───────────────────────────────────────────────────────────── */
check('above every one of the last four, inside them, and below every one',
  band(50, [10, 20, 30, 40]).where === 'above'
    && band(25, [10, 20, 30, 40]).where === 'within'
    && band(5, [10, 20, 30, 40]).where === 'below');
check('the band says how often it happens for no reason at all',
  near(band(50, [10, 20, 30, 40]).by_chance, 0.2));
check('one earlier period is not a band, and says so',
  band(5, [10]).where === null && /too few/.test(band(5, [10]).why));
check('a missing value is not placed anywhere',
  band(null, [1, 2, 3]).where === null);

/* ── the spread ─────────────────────────────────────────────────────────── */
{
  /* The Poisson floor. Four identical baseline weeks give a sample spread of
     zero, and dividing by that is how every driver becomes significant. */
  const s = surprise(30, 40, [40, 40, 40, 40]);
  check('an unvarying baseline still gets the arrival spread of a count',
    near(s.sd, Math.sqrt(40)) && s.sd_basis === 'the arrival spread of a count',
    JSON.stringify(s));
  /* And the other way: a driver whose weeks swing wildly is not flagged for
     another ordinary swing. */
  const v = surprise(30, 40, [10, 70, 20, 60]);
  check('a driver with a wide record of their own is judged against that record',
    v.sd > Math.sqrt(40) && /own week-to-week spread/.test(v.sd_basis), JSON.stringify(v));
  check('the same gap is significant for the steady driver and not for the erratic one',
    Math.abs(s.z) > Math.abs(v.z), `${s.z} vs ${v.z}`);
  check('no expectation means no z, with the reason said',
    surprise(5, 0, [0, 0]).z === null && /no baseline/.test(surprise(5, 0, [0, 0]).why));
}

/* ── the fleet term ─────────────────────────────────────────────────────── */
{
  /* A ratio of MEDIANS, so a roster that grew from 84 to 122 people does not
     read as every incumbent improving by 45%. */
  const before = Array.from({ length: 84 }, (_, i) => 4 + (i % 5));
  const after = Array.from({ length: 122 }, (_, i) => 4 + (i % 5));
  check('a bigger roster at the same intensity is not a fleet-wide improvement',
    near(fleetFactor(before, after).factor, 1), JSON.stringify(fleetFactor(before, after)));
  check('a genuine fleet-wide halving is measured as one',
    near(fleetFactor([4, 4, 4, 4], [2, 2, 2, 2]).factor, 0.5));
  check('with nothing to measure it, the factor is 1 and says it was not measured',
    fleetFactor([], []).factor === 1 && fleetFactor([], []).measured === false);
}

/* ── the threshold ──────────────────────────────────────────────────────── */
check('one driver tested is the ordinary one-in-twenty bar',
  Math.abs(bonferroniZ(1) - 1.959963985) < 1e-6, String(bonferroniZ(1)));
check('a hundred and twenty-two of them is a much higher bar',
  bonferroniZ(122) > 3.5 && bonferroniZ(122) < 3.6, String(bonferroniZ(122)));
check('and the bar only ever rises with the number tested',
  bonferroniZ(2) > bonferroniZ(1) && bonferroniZ(500) > bonferroniZ(122));
check('the single-driver threshold is the one the driver page uses', SINGLE_Z === 2);
check('the inverse normal is right at the points anybody would check',
  Math.abs(invNorm(0.5)) < 1e-12 && Math.abs(invNorm(0.975) - 1.959963985) < 1e-6
    && Math.abs(invNorm(0.995) - 2.575829304) < 1e-6,
  JSON.stringify([invNorm(0.5), invNorm(0.975), invNorm(0.995)]));

/* ── value coverage ─────────────────────────────────────────────────────── */
check('a driver priced on every completed trip is rankable on value',
  valueRankable({ completed: 40, priced_completed: 40 }));
check('one priced on a fifth of them is not, and the shortfall is reported',
  !valueRankable({ completed: 40, priced_completed: 8 })
    && near(valueCoverage({ completed: 40, priced_completed: 8 }).covered, 0.2));
check('the floor is the one the response publishes',
  VALUE_COVERAGE_MIN > 0.5 && VALUE_COVERAGE_MIN < 1);
check('and a period with no completed trip has no coverage rather than 0%',
  valueCoverage({ completed: 0, priced_completed: 0 }).covered === null);

/* ── the calendar ───────────────────────────────────────────────────────── */
check('a week starts on Monday and ends six days later',
  periodStart('week', '2026-09-14') === '2026-09-14'
    && periodStart('week', '2026-09-20') === '2026-09-14'
    && periodEnd('week', '2026-09-14') === '2026-09-20');
check('a week that crosses a month is still seven days',
  periodStart('week', '2026-09-01') === '2026-08-31'
    && periodEnd('week', '2026-08-31') === '2026-09-06');
check('a week that crosses a year is still seven days',
  periodEnd('week', '2025-12-29') === '2026-01-04');
check('February is as long as February is',
  periodEnd('month', '2026-02-01') === '2026-02-28'
    && periodEnd('month', '2024-02-01') === '2024-02-29');
check('a month series is month starts, oldest first, ending in the current one',
  JSON.stringify(periodSeries('month', '2026-09-14', 3)) === '["2026-07-01","2026-08-01","2026-09-01"]');
check('a week series is week starts, oldest first, ending in the current one',
  JSON.stringify(periodSeries('week', '2026-09-16', 3)) === '["2026-08-31","2026-09-07","2026-09-14"]');
{
  const a = periodProgress('week', '2026-09-14', '2026-09-16');
  check('a week two days in is two of seven days old and not complete',
    a.complete === false && a.elapsed_days === 3 && a.total_days === 7, JSON.stringify(a));
  check('a week that has ended is complete',
    periodProgress('week', '2026-09-07', '2026-09-16').complete === true);
  check('the last day of a period is not yet a complete period',
    periodProgress('week', '2026-09-14', '2026-09-20').complete === false,
    JSON.stringify(periodProgress('week', '2026-09-14', '2026-09-20')));
}

/* ── the constants the response publishes ───────────────────────────────── */
check('both grains are offered and nothing else is',
  isPerfGrain('week') && isPerfGrain('month') && !isPerfGrain('day') && !isPerfGrain(''),
  Object.keys(PERF_GRAINS).join(','));
check('the baseline is four periods and the rate gates are stated, not implied',
  BASELINE_PERIODS === 4 && RATE_GATES.show === 30 && RATE_GATES.rank === 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
