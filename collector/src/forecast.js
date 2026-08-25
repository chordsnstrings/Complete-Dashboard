/* Forecasting, and the several ways it can be a lie.
   ──────────────────────────────────────────────────────────────────────────
   This fleet's booking history has a structural break in it: roughly 24,000
   bookings a month through to February 2026, then 4,203 in March, then a slow
   climb back to about 7,400. Fitting anything across that break describes a
   fleet that does not exist. So the first thing this module does is find the
   break and refuse to look behind it.

   The rules it enforces, each of which exists because breaking it produces a
   confident number that is wrong:

   1. NEVER FIT ACROSS A STRUCTURAL BREAK. A line through 24,000 and 4,203
      predicts a recovery to 20,000 that nothing in the data supports.

   2. NEVER FIT ON A PARTIAL MONTH. The first and last months of any record
      hold fewer days than they look like they do. August 2025 holds eleven
      days; treated as a month it is an 84% collapse that never happened.

   3. A PREDICTION INTERVAL IS NOT OPTIONAL. Five points fitted with a line
      produce a point estimate whatever the scatter, and the point estimate is
      the least informative thing about it.

   4. BEYOND THE THIRD MONTH IT IS NOT A FORECAST. Extrapolating a five-point
      fit a year out is drawing a line, and calling it a forecast borrows a
      credibility it has not got. Those months are returned, labelled as
      extrapolation, with intervals wide enough to be honest about it.

   5. REFUSE RATHER THAN GUESS. Fewer than three usable months and this
      returns a refusal with the reason, not a number. */

/* ── ordinary least squares, with the interval that makes it useful ─────── */
export function fit(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const resid = points.map((p) => p.y - (intercept + slope * p.x));
  // Residual standard error. Two parameters fitted, so n-2 degrees of freedom;
  // with n=2 there is no scatter to measure and the interval is unknowable.
  const df = n - 2;
  const s = df > 0 ? Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / df) : null;
  const ssTot = points.reduce((a, p) => a + (p.y - my) ** 2, 0);
  const ssRes = resid.reduce((a, r) => a + r * r, 0);
  return { slope, intercept, s, n, mx, sxx, df,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
    predict: (x) => intercept + slope * x };
}

/* Two-sided 95% t multipliers for the small samples this actually sees. A
   normal 1.96 on four points understates the interval by about 40%. */
const T95 = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36,
  8: 2.31, 9: 2.26, 10: 2.23, 11: 2.20, 12: 2.18, 15: 2.13, 20: 2.09, 30: 2.04 };
export const tMultiplier = (df) => {
  if (df <= 0) return null;
  const keys = Object.keys(T95).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return T95[k];
  return 1.96;
};

/* The interval for a NEW observation, not for the fitted mean. Operations
   plans against what next month will actually be, not against where the line
   sits, and the two differ by a factor that matters on five points. */
export function interval(f, x) {
  if (!f || f.s == null) return null;
  const t = tMultiplier(f.df);
  if (t == null) return null;
  const se = f.s * Math.sqrt(1 + 1 / f.n + ((x - f.mx) ** 2) / f.sxx);
  return t * se;
}

/* ── how far back one trend still describes the series ──────────────────── */
/* The first version of this looked for the most recent month-over-month jump
   above a threshold and cut there. On the live series that found April → May,
   a +42% step which is part of the RECOVERY, and threw away two thirds of the
   data being recovered from. A single large move is not a regime change: this
   fleet's whole recent history is large moves.

   The right question is not "was there a jump" but "how far back can one line
   still describe this". So: start from the most recent three whole months and
   extend backwards a month at a time, keeping the window while the typical
   distance from the line stays comparable, and stopping when adding the next
   older month makes the fit dramatically worse. A recovery trend survives that
   test because a rising line fits it; the pre-collapse level does not, because
   no line fits 17,385 and 4,203 and 7,356 together.

   The test is SCALE-FREE: the typical distance from the line, as a fraction of
   the level being described. An absolute one does not work here, and neither
   does "twice the previous scatter" — the first window is three points, whose
   residual error has one degree of freedom and is far too unstable to be a
   baseline. On the live series that rejected April at 554 against 262 and cut
   a five-month recovery down to three.

   35% is loose enough to keep a recovery that doubles across the window (the
   live one sits at 8%) and tight enough to reject the pre-collapse level,
   which lands at 63% because no line fits 17,385 and 4,203 and 7,356. */
export function regimeWindow(months, { minMonths = 3, maxScatter = 0.35 } = {}) {
  const usable = months.filter((m) => !m.no_data && !m.partial_month && m.trips != null);
  if (usable.length <= minMonths) return { months: usable, excluded: [], cut: null };

  const scatterOf = (rows) => {
    const f = fit(rows.map((m, i) => ({ x: i, y: Number(m.trips) })));
    if (!f || f.s == null) return null;
    const mean = rows.reduce((a, m) => a + Number(m.trips), 0) / rows.length;
    return mean > 0 ? f.s / mean : null;
  };

  let best = usable.slice(-minMonths);
  for (let take = minMonths + 1; take <= usable.length; take++) {
    const candidate = usable.slice(-take);
    const cv = scatterOf(candidate);
    if (cv == null || cv > maxScatter) break;
    best = candidate;
  }
  const kept = new Set(best.map((m) => m.m));
  const excluded = usable.filter((m) => !kept.has(m.m));
  return {
    months: best,
    excluded,
    // The boundary the window closed at, described the way a break is.
    cut: excluded.length
      ? (() => {
        const a = excluded[excluded.length - 1], b = best[0];
        return { from: a.m, to: b.m,
          change_pct: a.trips ? Math.round(((b.trips - a.trips) / a.trips) * 100) : null };
      })()
      : null,
  };
}

/* Kept as the plain descriptive question — "was there a large move between
   these two adjacent months" — which the UI uses to label breaks. It is NOT
   what chooses the forecast window; regimeWindow does that. */
export function lastBreak(months, threshold = 0.4) {
  const usable = months.filter((m) => !m.no_data && !m.partial_month);
  for (let i = usable.length - 1; i > 0; i--) {
    const a = usable[i - 1], b = usable[i];
    if (!a.trips) continue;
    if (Math.abs((b.trips - a.trips) / a.trips) >= threshold) {
      return { from: a.m, to: b.m, change_pct: Math.round(((b.trips - a.trips) / a.trips) * 100) };
    }
  }
  return null;
}

const addMonths = (ym, k) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/* ── the monthly forecast ───────────────────────────────────────────────── */
export function forecastMonths(months, { horizon = 12, metric = 'trips' } = {}) {
  const win = regimeWindow(months);
  const usable = win.months.filter((m) => m[metric] != null);

  if (usable.length < 3) {
    const whole = months.filter((m) => !m.no_data && !m.partial_month).length;
    return {
      ok: false,
      reason: whole === 0
        ? 'No complete month of data to forecast from. A month the record starts or ends inside is '
          + 'short by construction, and fitting one as though it were whole understates every month after it.'
        : `Only ${usable.length} complete month(s) describe the current regime. Three is the minimum `
          + 'this will fit a line through, because two points always fit one perfectly and say nothing '
          + 'about the scatter around it.',
      break: win.cut, months_used: usable.map((m) => m.m),
      months_excluded: win.excluded.map((m) => m.m),
    };
  }

  const base = usable[0].m;
  const idx = (ym) => {
    const [y1, m1] = base.split('-').map(Number);
    const [y2, m2] = ym.split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1);
  };
  const points = usable.map((m) => ({ x: idx(m.m), y: Number(m[metric]) }));
  const f = fit(points);

  // A flat baseline to compare the fit against. If the line is no better than
  // "the same as the last three months", say so rather than dressing it up.
  const recent = usable.slice(-3);
  const flat = recent.reduce((a, m) => a + Number(m[metric]), 0) / recent.length;

  /* The horizon starts after the newest month the record has ANY row for, not
     after the newest COMPLETE one.
     ─────────────────────────────────────────────────────────────────────────
     `usable` holds complete months only, so on 2026-08-25 the last fitted
     month was July and forecast[0] was AUGUST — the month already in progress.
     Production published {m:"2026-08", point:12100, low:8100, high:16100}
     beside in_progress {days_so_far:25, trips_so_far:9801}: an interval whose
     floor sat below what was already banked, presented as a prediction. The
     daily rota inherited it and planned from 2026-08-01, naming "the busiest
     expected day" eighteen days in the past.

     The month in progress is still predicted — it is the only out-of-sample
     evidence this fit has — but it is returned separately, as
     `current_month`, so a horizon means the months that have not started. */
  const lastFitted = usable[usable.length - 1].m;
  const lastObserved = months.length ? months[months.length - 1].m : lastFitted;
  const anchor = lastObserved > lastFitted ? lastObserved : lastFitted;
  const rowFor = (ym, kind) => {
    const x2 = idx(ym);
    const point2 = Math.max(0, f.predict(x2));
    const pm2 = interval(f, x2);
    return {
      m: ym,
      point: Math.round(point2 / 100) * 100,
      low: pm2 == null ? null : Math.max(0, Math.round((point2 - pm2) / 100) * 100),
      high: pm2 == null ? null : Math.round((point2 + pm2) / 100) * 100,
      flat: Math.round(flat / 100) * 100,
      days: daysInMonth(ym),
      kind,
    };
  };
  /* The prediction for the month already under way, for the in-progress
     self-check and for nothing else. NULL when the newest observed month is
     itself complete, because then there is no month in progress. */
  const currentMonth = anchor > lastFitted ? rowFor(anchor, 'in_progress') : null;
  const out = [];
  for (let k = 1; k <= horizon; k++) {
    const ym = addMonths(anchor, k);
    const x = idx(ym);
    const point = Math.max(0, f.predict(x));
    const pm = interval(f, x);
    out.push({
      m: ym,
      /* Rounded to a hundred. A forecast printed to the unit invites a
         precision the interval flatly contradicts. */
      point: Math.round(point / 100) * 100,
      low: pm == null ? null : Math.max(0, Math.round((point - pm) / 100) * 100),
      high: pm == null ? null : Math.round((point + pm) / 100) * 100,
      flat: Math.round(flat / 100) * 100,
      days: daysInMonth(ym),
      /* Past the third month a five-point fit is a line, not a forecast. The
         months are returned because a plan needs a shape for the year, and
         labelled because nobody should budget against them. */
      kind: k <= 3 ? 'forecast' : 'extrapolation',
    });
  }

  return {
    ok: true,
    metric,
    break: win.cut,
    months_used: usable.map((m) => m.m),
    months_excluded: win.excluded.map((m) => m.m),
    n: f.n,
    slope_per_month: Math.round(f.slope),
    r2: f.r2 == null ? null : +f.r2.toFixed(3),
    /* Residual standard error in the metric's own units: the typical distance
       between a month and the line. Reported because it is the number that
       says whether the line means anything. */
    typical_error: f.s == null ? null : Math.round(f.s),
    flat_baseline: Math.round(flat / 100) * 100,
    /* Does the trend beat "assume next month looks like the last three"? On a
       short series it frequently does not, and saying so is the difference
       between a forecast and a decoration. */
    beats_flat: f.s != null && f.r2 != null && f.r2 >= 0.5,
    /* The last month the line was fitted through, and the month the horizon
       counts from. They differ exactly when a month is in progress, and saying
       so is what stops a reader taking forecast[0] for a prediction about a
       month that is already two thirds spent. */
    fitted_to: lastFitted,
    horizon_from: anchor,
    current_month: currentMonth,
    forecast: out,
  };
}

/* ── the shape of a month, by weekday ───────────────────────────────────── */
/* A monthly total is not a plan. Operations rosters by day, and this fleet's
   weekdays are not alike. The share of each weekday is measured over recent
   COMPLETE weeks and applied to the forecast total, weighted by how many of
   each weekday the target month actually contains — which is why two months
   with the same forecast can need different rotas. */
export function weekdayShares(days, { weeks = 8 } = {}) {
  if (!days.length) return null;
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
  const cut = sorted.slice(-weeks * 7);
  const by = new Map();
  for (const d of cut) {
    const dow = new Date(`${d.day}T00:00:00Z`).getUTCDay();
    const c = by.get(dow) || { dow, total: 0, n: 0 };
    c.total += Number(d.trips) || 0; c.n++;
    by.set(dow, c);
  }
  const rows = [...by.values()].sort((a, b) => a.dow - b.dow);
  if (rows.length < 7 || rows.some((r) => r.n === 0)) return null;
  const meanPerDow = rows.map((r) => ({ dow: r.dow, mean: r.total / r.n, n: r.n }));
  const grand = meanPerDow.reduce((a, r) => a + r.mean, 0);
  if (!grand) return null;
  return meanPerDow.map((r) => ({ ...r, share: r.mean / grand, mean: +r.mean.toFixed(1) }));
}

/* Spread a monthly forecast across that month's actual days. */
export function forecastDays(ym, monthTotal, shares) {
  if (!shares || monthTotal == null) return [];
  const n = daysInMonth(ym);
  const dows = [];
  for (let d = 1; d <= n; d++) {
    dows.push(new Date(`${ym}-${String(d).padStart(2, '0')}T00:00:00Z`).getUTCDay());
  }
  // Total weight for this specific month: a month with five Fridays needs more
  // than a month with four, and dividing the total evenly hides that.
  const w = (dow) => shares.find((s) => s.dow === dow)?.share || 0;
  const totalWeight = dows.reduce((a, d) => a + w(d), 0);
  if (!totalWeight) return [];
  return dows.map((dow, i) => ({
    day: `${ym}-${String(i + 1).padStart(2, '0')}`,
    dow,
    expected: Math.round((monthTotal * w(dow)) / totalWeight),
  }));
}
