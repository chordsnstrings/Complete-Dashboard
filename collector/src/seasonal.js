/* Year-on-year forecasting, and the three ways a seasonal claim goes wrong.
   ──────────────────────────────────────────────────────────────────────────
   `src/forecast.js` fits a straight line to the months since the last regime
   change. That is the right refusal and it is kept. What it cannot do is know
   that October is Dubai's high season, because it has never seen an October
   inside the current regime — the regime is six months old.

   The cost of that was measured on production on 2026-09-22, against the month
   in progress, which is the only out-of-sample evidence this page has:

     | September 2026, forecast by the straight line | 14,700 (11,100–18,300) |
     | September 2026, on its first 21 whole days    | 16,095 bookings        |
     | the same 21 days of September 2025            | 19,867 bookings        |
     | September 2026 completing on last year's shape| ~23,975                |

   The line is 39% low and the month is outside its 95% interval. It is low for
   a reason that is not scatter: August→September is the sharpest seasonal step
   in this city's year — the fleet did 14,234 bookings in August 2025 and
   29,594 in September 2025 — and a line fitted to March..August has no term
   that can express it.

   So this module adds the comparison the line cannot make: THE SAME MONTH A
   YEAR EARLIER. Three things have to be right for that to be honest, and each
   one exists here because getting it wrong produces a confident wrong number.

   1. A YEAR-AGO MONTH IS NOT AUTOMATICALLY COMPARABLE. This record starts in
      different months for different channels — Uber's first month is 2025-04,
      Yango's is 2025-09, the hotel channel's is 2026-07. Comparing January
      2026 (37,100 bookings, Uber + Bolt + Yango) against January 2025 (6,384
      bookings, BOLT ONLY) reports +481% growth, which is a fact about when we
      started collecting Uber and not about the fleet. Comparability is
      therefore MEASURED, from the channels that actually carried bookings in
      each month, and a pair that fails renders absent with the channel named.

   2. THE RATIO MUST BE TAKEN LIKE FOR LIKE. Where both months carry a channel,
      it counts; where only one does, it is quarantined into its own named term
      instead of being quietly folded into a growth rate.

   3. A RATIO FROM THREE MONTHS HAS A RANGE, AND IT IS WIDE. Three observations
      give two degrees of freedom and a t-multiplier of 4.30. Any interval
      narrower than that is arithmetic nobody did.

   And the part that keeps this from being the previous mistake wearing new
   clothes: THIS MODEL IS SCORED AGAINST THE OTHERS, on the months that can be
   scored, and it does not always win. `scoreModels` is the evidence, and the
   page prints it whichever way it comes out. */

import { fit, tMultiplier } from './forecast.js';

const addMonths = (ym, k) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const lastYear = (ym) => addMonths(ym, -12);
const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
};
const pct = (v) => Math.round(v * 1000) / 10;

/* The channels that carried bookings in a month, as a Map platform → bookings.
   `byPlatform` is keyed 'YYYY-MM' → Map; absent means we could not measure the
   mix for that month, which is a different thing from the month having no
   channels and is reported as such rather than as an empty set. */
const mixOf = (byPlatform, m) => (byPlatform instanceof Map ? byPlatform.get(m) : null);

/* Bookings in month `a` that sit on a channel which carried no booking at all
   in month `b`. This is the quantity that makes a year-on-year ratio a lie
   when it is large, and it is the reason the ratio below is taken over the
   intersection rather than over the totals. */
function exclusive(mixA, mixB) {
  const out = [];
  if (!mixA) return out;
  for (const [p, n] of mixA) {
    if (!n) continue;
    if (!mixB || !(mixB.get(p) > 0)) out.push({ platform: p, trips: n });
  }
  return out.sort((x, y) => y.trips - x.trips);
}
const shared = (mixA, mixB) => {
  if (!mixA || !mixB) return null;
  let n = 0;
  const names = [];
  for (const [p, v] of mixA) if (v > 0 && mixB.get(p) > 0) { n += v; names.push(p); }
  return { trips: n, platforms: names.sort() };
};

/* ── month against the same month a year earlier ────────────────────────── */
/* One row per observed month that HAS a year-ago month in the record, carrying
   both sides of every figure the operator asked to see side by side: bookings,
   active vehicles, and bookings per active vehicle. A fleet that grew is not a
   fleet that got busier, and the two must not be able to read the same. */
export function yearOnYear(months, { byPlatform = null, newChannelShare = 0.5 } = {}) {
  const by = new Map(months.map((m) => [m.m, m]));
  const rows = [];
  for (const cur of months) {
    const lyKey = lastYear(cur.m);
    const ly = by.get(lyKey);
    if (cur.no_data) continue;
    const row = {
      m: cur.m,
      ly_m: lyKey,
      partial: !!cur.partial_month,
      trips: cur.trips ?? null,
      ly_trips: ly && !ly.no_data ? ly.trips : null,
      vehicles: cur.vehicles ?? null,
      ly_vehicles: ly && !ly.no_data ? ly.vehicles : null,
      drivers: cur.drivers ?? null,
      ly_drivers: ly && !ly.no_data ? ly.drivers : null,
    };
    /* The year-ago month is simply not in the record. Not "zero" — this is the
       oldest stretch of the calendar and nothing was ever collected for it. */
    if (!ly || ly.no_data || !ly.trips) {
      rows.push({
        ...row,
        ratio: null,
        comparable: 'no',
        reason: `No booking was collected for ${lyKey}; the record begins after it.`,
      });
      continue;
    }
    if (ly.partial_month) {
      rows.push({
        ...row,
        ratio: null,
        comparable: 'no',
        reason: `${lyKey} is a month the record starts or stops inside, so it holds fewer days `
          + 'than it looks like it does and is short by construction.',
      });
      continue;
    }

    row.ratio = ly.trips ? cur.trips / ly.trips : null;
    row.per_vehicle = cur.vehicles ? cur.trips / cur.vehicles : null;
    row.ly_per_vehicle = ly.vehicles ? ly.trips / ly.vehicles : null;
    row.vehicle_ratio = ly.vehicles && cur.vehicles ? cur.vehicles / ly.vehicles : null;
    row.intensity_ratio = row.per_vehicle != null && row.ly_per_vehicle
      ? row.per_vehicle / row.ly_per_vehicle : null;

    const mixC = mixOf(byPlatform, cur.m);
    const mixL = mixOf(byPlatform, lyKey);
    if (!mixC || !mixL) {
      /* The per-channel grain is not available — a fresh database, or a rollup
         that has not run. The comparison is still made, on the totals, and the
         response says the like-for-like check could not be performed rather
         than implying it passed. */
      rows.push({
        ...row,
        like_ratio: null,
        comparable: 'unchecked',
        reason: 'The per-channel breakdown for one of these months is not available, so the '
          + 'two months could not be checked for carrying the same set of channels.',
      });
      continue;
    }
    const gained = exclusive(mixC, mixL);
    const lost = exclusive(mixL, mixC);
    const sh = shared(mixC, mixL);
    const shL = shared(mixL, mixC);
    row.new_channels = gained;
    row.lost_channels = lost;
    row.like_platforms = sh.platforms;
    row.like_trips = sh.trips;
    row.like_ly_trips = shL.trips;
    row.like_ratio = shL.trips ? sh.trips / shL.trips : null;

    const newShare = cur.trips ? sum(gained.map((g) => g.trips)) / cur.trips : 0;
    const lostShare = ly.trips ? sum(lost.map((g) => g.trips)) / ly.trips : 0;
    const worst = Math.max(newShare, lostShare);
    if (worst >= newChannelShare) {
      /* The two months are not two readings of one business. Naming which
         channel and how much of the month it is, is what makes this arguable
         rather than a rule somebody has to take on trust. */
      const which = lostShare >= newShare
        ? `${lost.map((c) => c.platform).join(', ')} carried ${pct(lostShare)}% of ${lyKey} `
          + 'and carried nothing in this month'
        : `${gained.map((c) => c.platform).join(', ')} carried ${pct(newShare)}% of this month `
          + `and carried nothing in ${lyKey}`;
      rows.push({
        ...row,
        comparable: 'no',
        reason: `These are not two readings of the same business: ${which}. `
          + 'A percentage change across that is a fact about when collection started, not about the fleet.',
      });
      continue;
    }
    rows.push({
      ...row,
      comparable: worst > 0 ? 'partly' : 'yes',
      new_share: newShare || 0,
      lost_share: lostShare || 0,
      reason: worst > 0
        ? `${[...gained, ...lost].map((c) => c.platform).join(', ')} runs in one of these months and not `
          + `the other, which is ${pct(worst)}% of the larger side. The ratio below is taken over the `
          + `channels both months carry (${sh.platforms.join(', ')}); the rest is reported separately.`
        : null,
    });
  }
  return rows;
}

/* ── what moved: the fleet, or what each car did ────────────────────────── */
/* bookings = active vehicles × bookings per active vehicle, exactly. So the
   year-on-year change in bookings factorises into a fleet-size term and an
   intensity term, and the two must never be allowed to read the same: a fleet
   that halved while each car doubled did not stand still, and the operator's
   next move is different in each case. */
export function decompose(row) {
  if (!row || row.vehicle_ratio == null || row.intensity_ratio == null) return null;
  const v = row.vehicle_ratio - 1;
  const i = row.intensity_ratio - 1;
  return {
    vehicle_pct: pct(v),
    intensity_pct: pct(i),
    total_pct: pct(row.ratio - 1),
    /* Which of the two moved the number. Compared on the log scale because the
       decomposition is multiplicative: −50% of the fleet and +100% per car are
       the same size of move and cancel exactly, which a comparison of the raw
       percentages gets wrong in both directions. */
    led_by: Math.abs(Math.log(row.vehicle_ratio)) >= Math.abs(Math.log(row.intensity_ratio))
      ? 'fleet size' : 'work per vehicle',
  };
}

/* ── the year-on-year forecast ──────────────────────────────────────────── */
/* The model, in one sentence: next October is last October, multiplied by the
   ratio this fleet has been running at against its own year-ago months, plus a
   separately-named term for any channel that did not exist a year ago.

   Every part of that is a measured quantity with a scatter, and the scatter is
   what the interval is made of. */
export function seasonalForecast(months, {
  horizon = 12, k = 3, byPlatform = null, anchor = null, regimeFrom = null,
} = {}) {
  const pairs = yearOnYear(months, { byPlatform });
  const usable = pairs.filter((p) => !p.partial && p.comparable !== 'no'
    && (p.like_ratio ?? p.ratio) != null);
  const window = usable.slice(-k);
  const complete = months.filter((m) => !m.no_data && !m.partial_month);

  if (window.length < 3) {
    return {
      ok: false,
      reason: window.length === 0
        ? 'No month in this record can be compared with the same month a year earlier. Either the record '
          + 'is under a year old, or every year-ago month carried a different set of channels.'
        : `Only ${window.length} month(s) can be compared with the same month a year earlier. Three is the `
          + 'minimum, because a ratio taken from two months has no scatter to put a range around it.',
      months_used: window.map((p) => p.m),
      months_rejected: pairs.filter((p) => p.comparable === 'no')
        .map((p) => ({ m: p.m, ly_m: p.ly_m, reason: p.reason })),
    };
  }

  const ratios = window.map((p) => p.like_ratio ?? p.ratio);
  const R = mean(ratios);
  const s = sd(ratios);
  const df = ratios.length - 1;
  const t = tMultiplier(df);
  /* A prediction interval for a NEW ratio, not a confidence interval for the
     mean of the ones observed. Operations plans against what next month will
     be; the two differ by the sqrt(1 + 1/n) factor, which on three points is
     15% of an already wide number. */
  const half = t != null && s != null ? t * s * Math.sqrt(1 + 1 / ratios.length) : null;

  const byMonth = new Map(months.map((m) => [m.m, m]));
  const last = complete.length ? complete[complete.length - 1] : null;
  const liveMix = last ? mixOf(byPlatform, last.m) : null;
  /* What a channel that did not exist a year ago is worth, per month: its own
     mean over the complete months it has actually run. This is a measurement
     of the channel, never a share of the total, and it is carried as its own
     named term so that nobody can read it as growth in the old business. */
  const channelRun = new Map();
  if (byPlatform instanceof Map && liveMix) {
    for (const [p] of liveMix) {
      const series = complete
        .map((m) => mixOf(byPlatform, m.m)?.get(p))
        .filter((v) => v > 0);
      if (series.length) channelRun.set(p, { mean: mean(series), months: series.length });
    }
  }

  const from = anchor || (months.length ? months[months.length - 1].m : null);
  const out = [];
  for (let step = 1; step <= horizon; step++) {
    const m = addMonths(from, step);
    const base = byMonth.get(lastYear(m));
    const row = { m, base_m: lastYear(m), days: daysInMonth(m),
      kind: step <= 3 ? 'forecast' : 'extrapolation' };
    if (!base || base.no_data || base.partial_month || !base.trips) {
      /* No year-ago month to stand on. This is a refusal, not a zero, and the
         straight line is still there for these months. */
      out.push({ ...row, point: null, low: null, high: null,
        reason: !base || base.no_data
          ? `Nothing was collected for ${lastYear(m)}, so this month has no year-ago month to be compared with.`
          : `${lastYear(m)} is a partial month — the record starts or stops inside it — so it is short by `
            + 'construction and would understate this month by however many days it is missing.' });
      continue;
    }
    const baseMix = mixOf(byPlatform, base.m);
    /* The base, restricted to channels that are still running. A channel that
       has stopped must not be projected forward, and one that started since
       the base month is not in the base at all — it is the carry below. */
    let baseLike = base.trips;
    let carry = [];
    if (baseMix && liveMix) {
      baseLike = shared(baseMix, liveMix).trips;
      carry = [...liveMix.keys()]
        .filter((p) => !(baseMix.get(p) > 0) && channelRun.has(p))
        .map((p) => ({ platform: p, trips: Math.round(channelRun.get(p).mean),
          months: channelRun.get(p).months }));
    }
    const carryTotal = sum(carry.map((c) => c.trips));
    const point = baseLike * R + carryTotal;
    const lo = half == null ? null : Math.max(0, baseLike * (R - half) + carryTotal);
    const hi = half == null ? null : baseLike * (R + half) + carryTotal;
    out.push({
      ...row,
      base: base.trips,
      base_like: Math.round(baseLike),
      base_vehicles: base.vehicles ?? null,
      carry: carry.length ? carry : null,
      point: Math.round(point / 100) * 100,
      low: lo == null ? null : Math.round(lo / 100) * 100,
      high: hi == null ? null : Math.round(hi / 100) * 100,
      /* A base month that is itself inside the current regime is a different
         object from one before the break, and the difference changes what the
         number means. Every ratio in the window was measured as a post-break
         month over a PRE-break month, so it carries the whole size of the
         collapse inside it. Applied to a base that is itself post-break, it
         subtracts the collapse a second time from a month that already has it:
         2027-03 comes back at 6,900 against a 2026-03 of 6,987, implying the
         fleet ends next March no better off than it was in the worst month it
         has ever had, which nothing supports.

         Flagged rather than dropped, because a plan wants a shape for the
         year — and flagged rather than silently corrected, because the
         correction would be a second model nobody asked for. The first version
         of this test asked whether any pair's year-ago month was at or after
         the base, which is a different question and answered "before the
         break" for every month of 2027. */
      base_regime: regimeFrom && base.m >= regimeFrom ? 'within the current regime' : 'before the break',
      /* Restated as a boolean because the front end branches on it and a
         string comparison in a template is how that goes wrong quietly. */
      base_post_break: !!(regimeFrom && base.m >= regimeFrom),
    });
  }

  return {
    ok: true,
    method: 'year-on-year ratio',
    months_used: window.map((p) => p.m),
    pairs_used: window.map((p) => ({ m: p.m, ly_m: p.ly_m,
      ratio: +(p.like_ratio ?? p.ratio).toFixed(3),
      like_for_like: p.like_ratio != null })),
    k: ratios.length,
    ratio: +R.toFixed(4),
    ratio_sd: s == null ? null : +s.toFixed(4),
    ratio_low: half == null ? null : +(R - half).toFixed(4),
    ratio_high: half == null ? null : +(R + half).toFixed(4),
    t_multiplier: t,
    /* The two halves of the ratio, because the operator asked for them by
       name and because they mean different things about the same number. */
    vehicle_ratio: (() => {
      const v = window.map((p) => p.vehicle_ratio).filter((x) => x != null);
      return v.length ? +mean(v).toFixed(4) : null;
    })(),
    intensity_ratio: (() => {
      const v = window.map((p) => p.intensity_ratio).filter((x) => x != null);
      return v.length ? +mean(v).toFixed(4) : null;
    })(),
    intensity_sd: (() => {
      const v = window.map((p) => p.intensity_ratio).filter((x) => x != null);
      return v.length > 1 ? +sd(v).toFixed(4) : null;
    })(),
    months_rejected: pairs.filter((p) => p.comparable === 'no')
      .map((p) => ({ m: p.m, ly_m: p.ly_m, reason: p.reason })),
    forecast: out,
  };
}

/* ── the straight line, refitted on a truncated series ──────────────────── */
/* Only used by the scoreboard below, which has to ask what each model WOULD
   have said with the months after T hidden. It is deliberately the same shape
   as src/forecast.js's fit so that the comparison is between the methods and
   not between two people's arithmetic. */
function lineForecast(series, target) {
  const usable = series.filter((m) => !m.no_data && !m.partial_month && m.trips != null);
  if (usable.length < 3) return null;
  const base = usable[0].m;
  const idx = (ym) => {
    const [y1, m1] = base.split('-').map(Number);
    const [y2, m2] = ym.split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1);
  };
  const f = fit(usable.map((m) => ({ x: idx(m.m), y: Number(m.trips) })));
  return f ? Math.max(0, f.predict(idx(target))) : null;
}

/* ── the scoreboard ─────────────────────────────────────────────────────── */
/* A forecast nobody ever scores is a decoration, and a NEW forecast nobody
   scores against the old one is a decoration somebody was paid for. This runs
   every method one step ahead over the months that can be scored, using only
   the months before each target, and reports the error whichever way it falls.

   It is expected to be an uncomfortable table. On the live series the straight
   line wins the two months that can be scored — both of which sit inside the
   recovery, where the year-on-year ratio was still climbing steeply and a
   lagged ratio is biased low by construction. September, the one month in this
   record with a large seasonal step, is the reverse. Two scored months cannot
   settle that, and the page says so rather than picking a winner it cannot
   demonstrate. */
export function scoreModels(months, { byPlatform = null, k = 3, regimeFrom = null } = {}) {
  const complete = months.filter((m) => !m.no_data && !m.partial_month);
  const rows = [];
  const unscorable = [];
  for (let i = 0; i < complete.length; i++) {
    const target = complete[i];
    const prior = months.filter((m) => m.m < target.m);
    const priorComplete = prior.filter((m) => !m.no_data && !m.partial_month);
    const pairs = yearOnYear([...prior, target], { byPlatform })
      .filter((p) => p.m < target.m && !p.partial && p.comparable !== 'no'
        && (p.like_ratio ?? p.ratio) != null);
    const self = yearOnYear([...prior, target], { byPlatform }).find((p) => p.m === target.m);
    if (!self || self.comparable === 'no' || pairs.length < k) {
      unscorable.push({ m: target.m,
        reason: !self || self.comparable === 'no'
          ? `${target.m} has no comparable month a year earlier`
          : `only ${pairs.length} comparable year-on-year pair(s) existed before ${target.m}; `
            + `${k} are needed` });
      continue;
    }
    const sf = seasonalForecast(prior.concat([{ ...target, trips: null, no_data: true }]),
      { horizon: 1, k, byPlatform, anchor: prior.length ? prior[prior.length - 1].m : null });
    // The seasonal model's own one-step row for this target.
    const srow = sf.ok ? (sf.forecast || []).find((r) => r.m === target.m) : null;
    const line = regimeFrom
      ? lineForecast(priorComplete.filter((m) => m.m >= regimeFrom), target.m)
      : lineForecast(priorComplete, target.m);
    const recent = priorComplete.slice(-3);
    const flat = recent.length ? mean(recent.map((m) => Number(m.trips))) : null;
    const err = (v) => (v == null || !target.trips ? null
      : +(((v - target.trips) / target.trips) * 100).toFixed(1));
    rows.push({
      m: target.m,
      actual: target.trips,
      seasonal: srow && srow.point != null ? srow.point : null,
      seasonal_err_pct: err(srow && srow.point != null ? srow.point : null),
      line: line == null ? null : Math.round(line),
      line_err_pct: err(line),
      flat: flat == null ? null : Math.round(flat),
      flat_err_pct: err(flat),
    });
  }
  const mae = (key) => {
    const v = rows.map((r) => r[key]).filter((x) => x != null).map(Math.abs);
    return v.length ? +mean(v).toFixed(1) : null;
  };
  return {
    rows,
    unscorable,
    n: rows.length,
    mean_abs_pct: {
      seasonal: mae('seasonal_err_pct'),
      line: mae('line_err_pct'),
      flat: mae('flat_err_pct'),
    },
  };
}

/* ── tourism as a regressor, with its fit quality stated ────────────────── */
/* The operator asked for Dubai's visitor numbers to be brought in. They are
   brought in as a REGRESSOR and reported with their r², which is the only way
   a reader can tell whether the relationship is in the data or in the hope.

   Two fits, not one, and the difference between them is the finding. Visitors
   against bookings per active vehicle is the demand question. Visitors against
   the number of active vehicles is the supply question, and it is not supposed
   to fit — fleet size is an operator's decision, not the city's. If the second
   fits as well as the first, something is wrong with the first. */
export function tourismFit(months, visitors, { byPlatform = null, mixTolerance = 0.5 } = {}) {
  const complete = months.filter((m) => !m.no_data && !m.partial_month && m.trips > 0);
  if (!complete.length) return { ok: false, reason: 'No complete month of bookings to fit against.' };
  const latest = complete[complete.length - 1];
  const latestMix = mixOf(byPlatform, latest.m);
  const used = [];
  const excluded = [];
  for (const m of complete) {
    const v = visitors.get(m.m);
    if (!v || v.visitors == null) {
      excluded.push({ m: m.m,
        reason: 'Dubai’s tourism authority has not published a visitor figure for this month.' });
      continue;
    }
    const mix = mixOf(byPlatform, m.m);
    if (mix && latestMix) {
      /* The same comparability test the year-on-year pairs use, applied
         against the month the fleet is actually in now. A month that was one
         channel and is now four is not a reading of this business, and a
         regression that includes it is fitting the collection history. */
      const own = exclusive(mix, latestMix);
      const theirs = exclusive(latestMix, mix);
      const ownShare = m.trips ? sum(own.map((c) => c.trips)) / m.trips : 0;
      const theirShare = latest.trips ? sum(theirs.map((c) => c.trips)) / latest.trips : 0;
      if (Math.max(ownShare, theirShare) >= mixTolerance) {
        excluded.push({ m: m.m,
          reason: `This month carried ${[...mix.keys()].sort().join(', ')} where the fleet now runs `
            + `${[...latestMix.keys()].sort().join(', ')}; the channels that differ are `
            + `${pct(Math.max(ownShare, theirShare))}% of the larger month.` });
        continue;
      }
    }
    if (!m.vehicles) {
      excluded.push({ m: m.m, reason: 'No active-vehicle count for this month.' });
      continue;
    }
    used.push({ m: m.m, visitors: v.visitors, trips: m.trips, vehicles: m.vehicles,
      per_vehicle: m.trips / m.vehicles });
  }
  if (used.length < 3) {
    return { ok: false, n: used.length, months: used.map((u) => u.m), excluded,
      reason: `Only ${used.length} month(s) have both a published Dubai visitor figure and a booking `
        + 'count taken over the same set of channels the fleet runs now. Three is the minimum a fit '
        + 'can report a scatter from.' };
  }
  const shape = (yf, unit) => {
    const f = fit(used.map((u) => ({ x: u.visitors / 1000, y: yf(u) })));
    return f ? {
      slope: +f.slope.toFixed(3), intercept: +f.intercept.toFixed(1),
      r2: f.r2 == null ? null : +f.r2.toFixed(3),
      typical_error: f.s == null ? null : +f.s.toFixed(1), unit,
    } : null;
  };
  return {
    ok: true,
    n: used.length,
    months: used.map((u) => u.m),
    excluded,
    series: used,
    per_vehicle: shape((u) => u.per_vehicle, 'bookings per active vehicle, per million visitors'),
    bookings: shape((u) => u.trips, 'bookings per million visitors'),
    vehicles: shape((u) => u.vehicles, 'active vehicles per million visitors'),
  };
}

/* ── the month in progress, compared with the same days a year earlier ──── */
/* The existing self-check projects the month by its own run rate, which
   assumes the rest of the month resembles the part collected. In a month whose
   demand climbs all the way through — which September in Dubai does — that
   understates, and it understated by about 8% on 2026-09-22.

   The same days of the same month a year earlier carry the within-month shape,
   so this compares like with like and then completes the month on last year's
   profile. It is still a check rather than a better forecast, because it
   assumes the shape repeats. */
export function sameDaysYearAgo(currentDays, lastYearDays, { lastWholeDay = null } = {}) {
  if (!currentDays?.length || !lastYearDays?.length) return null;
  const dayNo = (d) => Number(String(d).slice(8, 10));
  const cur = currentDays.filter((d) => !lastWholeDay || d.day <= lastWholeDay);
  if (!cur.length) return null;
  const through = Math.max(...cur.map((d) => dayNo(d.day)));
  const curSum = sum(cur.map((d) => Number(d.trips) || 0));
  const lyThrough = lastYearDays.filter((d) => dayNo(d.day) <= through);
  const lySum = sum(lyThrough.map((d) => Number(d.trips) || 0));
  const lyWhole = sum(lastYearDays.map((d) => Number(d.trips) || 0));
  if (!lySum || !lyWhole) return null;
  return {
    through_day: through,
    trips_so_far: curSum,
    ly_same_days: lySum,
    ly_whole_month: lyWhole,
    ratio: +(curSum / lySum).toFixed(3),
    share_of_month_by_now: +(lySum / lyWhole).toFixed(4),
    /* Completing the month on last year's own within-month profile rather than
       on a flat run rate. Both are stated; they differ by exactly how much the
       month ramps. */
    projected: Math.round(curSum / (lySum / lyWhole)),
  };
}
