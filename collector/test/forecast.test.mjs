/* Forecasting, and the several ways it can be a confident lie.
   ──────────────────────────────────────────────────────────────────────────
   Every check here is a way of producing a number that looks like a forecast
   and is not one. The live series is the reason: roughly 24,000 bookings a
   month through February 2026, 4,203 in March, then a climb back to 7,400. A
   line through that break predicts a recovery to 20,000 that nothing supports,
   and it predicts it to four significant figures. */
import { fit, interval, tMultiplier, lastBreak, regimeWindow, forecastMonths,
  weekdayShares, forecastDays } from '../src/forecast.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

/* ── the fit itself ──────────────────────────────────────────────────────── */
{
  const f = fit([{ x: 0, y: 2 }, { x: 1, y: 4 }, { x: 2, y: 6 }, { x: 3, y: 8 }]);
  check('a straight line is recovered exactly', near(f.slope, 2) && near(f.intercept, 2),
    `${f.slope} / ${f.intercept}`);
  check('a perfect fit has no residual scatter', near(f.s, 0), String(f.s));
  check('and an r² of 1', near(f.r2, 1), String(f.r2));

  const noisy = fit([{ x: 0, y: 10 }, { x: 1, y: 30 }, { x: 2, y: 15 }, { x: 3, y: 35 }]);
  check('scatter is measured, not assumed away', noisy.s > 5, String(noisy.s));
  check('a poor fit reports a poor r²', noisy.r2 < 0.6, String(noisy.r2));

  check('two points cannot report scatter, because they have none to report',
    fit([{ x: 0, y: 1 }, { x: 1, y: 2 }]).s === null);
  check('a single point is not a fit at all', fit([{ x: 0, y: 1 }]) === null);
  check('and neither is a vertical one', fit([{ x: 1, y: 1 }, { x: 1, y: 9 }]) === null);
}

/* ── the interval, which is the part that makes a point estimate usable ─── */
{
  check('small samples use a t multiplier, not 1.96',
    tMultiplier(3) > 3 && tMultiplier(30) < 2.1, `${tMultiplier(3)} / ${tMultiplier(30)}`);
  check('a normal multiplier on four points would understate the interval by a third',
    tMultiplier(2) / 1.96 > 2, String(tMultiplier(2) / 1.96));
  check('zero degrees of freedom has no multiplier rather than a default one',
    tMultiplier(0) === null);

  const f = fit([{ x: 0, y: 10 }, { x: 1, y: 30 }, { x: 2, y: 15 }, { x: 3, y: 35 }]);
  const nearIn = interval(f, 4), farOut = interval(f, 12);
  check('the interval widens the further out the prediction is', farOut > nearIn * 1.5,
    `${nearIn} → ${farOut}`);
  /* A prediction interval covers a NEW observation, not the fitted mean, and
     the two differ by a factor that matters on five points. Operations plans
     against what next month will be. */
  check('it is a prediction interval, so it exceeds the residual error itself',
    nearIn > f.s, `${nearIn} vs s=${f.s}`);
}

/* ── the break, which is the whole reason this module exists ─────────────── */
const M = (m, trips, extra = {}) => ({ m, trips, no_data: false, partial_month: false, ...extra });
{
  const series = [
    M('2025-10', 23847), M('2025-11', 24973), M('2025-12', 19020), M('2026-01', 22089),
    M('2026-02', 17385), M('2026-03', 4203), M('2026-04', 4562), M('2026-05', 6464),
    M('2026-06', 6589), M('2026-07', 7356),
  ];
  /* lastBreak answers the plain descriptive question — "was there a large
     move between two adjacent months" — so on this series it correctly returns
     the most recent one, April → May at +42%. That is a real move and the UI
     labels it as one. It is NOT what chooses the forecast window, because a
     +42% step here is part of the recovery being forecast: cutting there threw
     away two thirds of the data. */
  const brk = lastBreak(series);
  check('the most recent large move is described as such', brk?.from === '2026-04' && brk?.change_pct === 42,
    JSON.stringify(brk));
  check('a tighter threshold still finds the collapse itself',
    lastBreak(series, 0.6)?.from === '2026-02', JSON.stringify(lastBreak(series, 0.6)));

  /* regimeWindow answers the question that matters for forecasting: how far
     back does ONE line still describe this? A rising recovery survives that
     test; the pre-collapse level does not. */
  const win = regimeWindow(series);
  check('the regime window keeps the whole recovery, not just the last three months',
    win.months.length === 5 && win.months[0].m === '2026-03',
    win.months.map((m) => m.m).join(','));
  check('and it cuts at the collapse, not at a step within the recovery',
    win.cut?.from === '2026-02' && win.cut?.change_pct === -76, JSON.stringify(win.cut));
  check('the months it refused to look at are named',
    win.excluded.length === 5 && win.excluded[win.excluded.length - 1].m === '2026-02',
    win.excluded.map((m) => m.m).join(','));

  /* The point of finding it. A fit across the break predicts a recovery that
     nothing in the data supports; a fit after it predicts the recovery that is
     actually happening. */
  const across = fit(series.map((m, i) => ({ x: i, y: m.trips })));
  const after = fit(series.slice(5).map((m, i) => ({ x: i, y: m.trips })));
  check('a fit across the break slopes the wrong way entirely',
    across.slope < 0 && after.slope > 0, `${across.slope} vs ${after.slope}`);

  const fc = forecastMonths(series);
  check('the forecast fits only the months since the break',
    fc.months_used.length === 5 && fc.months_used[0] === '2026-03',
    JSON.stringify(fc.months_used));
  check('the forecast names the boundary it refused to look behind',
    fc.break.from === '2026-02', JSON.stringify(fc.break));
  check('and names every month it excluded, so the choice is checkable',
    fc.months_excluded.length === 5, JSON.stringify(fc.months_excluded));
  check('the first forecast month follows the last observed one',
    fc.forecast[0].m === '2026-08', fc.forecast[0].m);
  check('and it is in the region the recent months are, not the region before the break',
    fc.forecast[0].point > 6000 && fc.forecast[0].point < 12000,
    String(fc.forecast[0].point));
  check('every forecast carries an interval, not just a number',
    fc.forecast.slice(0, 3).every((r) => r.low != null && r.high != null && r.high > r.low));
  check('the interval widens month by month',
    fc.forecast[5].high - fc.forecast[5].low > fc.forecast[0].high - fc.forecast[0].low);
  check('nothing is predicted below zero',
    fc.forecast.every((r) => r.point >= 0 && r.low >= 0));

  /* Past the third month a five-point fit is a line, and calling it a forecast
     borrows a credibility it has not got. */
  check('the first three months are labelled a forecast',
    fc.forecast.slice(0, 3).every((r) => r.kind === 'forecast'));
  check('everything after them is labelled an extrapolation',
    fc.forecast.slice(3).every((r) => r.kind === 'extrapolation'));

  check('a flat baseline is reported to compare the trend against',
    fc.flat_baseline > 0 && Math.abs(fc.flat_baseline - 6803) < 200, String(fc.flat_baseline));
  check('the typical distance from the line is reported in the metric’s own units',
    fc.typical_error > 0, String(fc.typical_error));
  check('a forecast rounded to the unit would claim a precision the interval denies',
    fc.forecast.every((r) => r.point % 100 === 0));
}

/* ── refusing ────────────────────────────────────────────────────────────── */
{
  const tooShort = forecastMonths([M('2026-06', 100), M('2026-07', 4000)]);
  check('two months produce a refusal, not a line through two points',
    tooShort.ok === false && /structural break|complete month/.test(tooShort.reason),
    JSON.stringify(tooShort.reason));
  check('the refusal says how many months it had', /Only 1 complete month/.test(tooShort.reason)
    || /Only 2 complete month/.test(tooShort.reason), tooShort.reason);
  check('an empty series refuses rather than dividing by zero',
    forecastMonths([]).ok === false);
  check('a series of only missing months refuses too',
    forecastMonths([{ m: '2026-01', no_data: true }, { m: '2026-02', no_data: true }]).ok === false);
}

/* ── partial months, which are short by construction and not down ────────── */
{
  const withPartial = [
    M('2026-03', 4203), M('2026-04', 4562), M('2026-05', 6464), M('2026-06', 6589),
    M('2026-07', 7356), M('2026-08', 5927, { partial_month: true, days_in_record: 21 }),
  ];
  const fc = forecastMonths(withPartial);
  check('a partial month is never fitted, however recent it is',
    !fc.months_used.includes('2026-08'), JSON.stringify(fc.months_used));
  /* The horizon counts from the newest OBSERVED month, not the newest fitted
     one. Anchored on the last whole month, forecast[0] was August — the month
     already three weeks spent — and production published
     {m:"2026-08", point:12100, low:8100, high:16100} beside in_progress
     {days_so_far:25, trips_so_far:9801}: an interval whose floor sat below
     what was already banked, presented as a prediction, with the daily rota
     planning from the 1st and naming its busiest expected day eighteen days in
     the past. */
  check('the horizon starts at the first month that has not started',
    fc.forecast[0].m === '2026-09', fc.forecast[0].m);
  check('and the month in progress is predicted separately, for the self-check',
    fc.current_month?.m === '2026-08' && fc.current_month.kind === 'in_progress',
    JSON.stringify(fc.current_month));
  check('the two anchors are both stated, since they differ only mid-month',
    fc.fitted_to === '2026-07' && fc.horizon_from === '2026-08',
    JSON.stringify([fc.fitted_to, fc.horizon_from]));
  check('a record ending on a whole month has no month in progress at all',
    forecastMonths(withPartial.slice(0, 5)).current_month === null
    && forecastMonths(withPartial.slice(0, 5)).forecast[0].m === '2026-08',
    JSON.stringify(forecastMonths(withPartial.slice(0, 5)).forecast[0]));
  /* And it must not register as a break either — a short month looks like a
     collapse and would truncate the very series being fitted. */
  check('a partial month is not mistaken for a structural break',
    lastBreak(withPartial)?.to !== '2026-08', JSON.stringify(lastBreak(withPartial)));
}

/* ── the shape of a month ────────────────────────────────────────────────── */
{
  // Eight weeks where Friday and Saturday run at double the weekday rate.
  const days = [];
  for (let i = 0; i < 56; i++) {
    const d = new Date(Date.UTC(2026, 5, 1 + i));
    const key = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    days.push({ day: key, trips: dow === 5 || dow === 6 ? 200 : 100 });
  }
  const sh = weekdayShares(days);
  check('every weekday gets a share', sh.length === 7);
  check('the shares sum to one', near(sh.reduce((a, s) => a + s.share, 0), 1, 1e-9));
  check('a busy weekday carries roughly twice the share of a quiet one',
    near(sh.find((s) => s.dow === 5).share / sh.find((s) => s.dow === 1).share, 2, 0.01),
    String(sh.find((s) => s.dow === 5).share / sh.find((s) => s.dow === 1).share));
  check('a series shorter than a full week has no shape to report',
    weekdayShares(days.slice(0, 3)) === null);
  check('and neither has an empty one', weekdayShares([]) === null);

  /* The point of weighting by the target month's own days: two months with the
     same forecast need different rotas when one has five Fridays. */
  const jan = forecastDays('2027-01', 9300, sh);   // 31 days, five Fridays
  const feb = forecastDays('2027-02', 9300, sh);   // 28 days, four of each
  check('a day-by-day plan covers every day of the month', jan.length === 31 && feb.length === 28);
  check('the days sum to about the month total',
    Math.abs(jan.reduce((a, d) => a + d.expected, 0) - 9300) < 40,
    String(jan.reduce((a, d) => a + d.expected, 0)));
  const janFri = jan.filter((d) => d.dow === 5).length;
  const febFri = feb.filter((d) => d.dow === 5).length;
  check('a month with more Fridays gets more Fridays in the plan', janFri > febFri,
    `${janFri} vs ${febFri}`);
  check('and a busy day is planned busier than a quiet one in the same month',
    jan.find((d) => d.dow === 5).expected > jan.find((d) => d.dow === 1).expected);
  check('no plan is produced without a measured shape', forecastDays('2027-01', 9300, null).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
