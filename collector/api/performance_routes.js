/* A driver against their own record, and their place among the people they
   work beside.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked for "driver performance week by week, and month by month,
   a comparison of what they used to do, out of the active drivers what was
   their position, and whether it got better or worse", and then said what the
   subject of it is: "it's a performance difference of the solo driver not
   comparison between the fleet drivers."

   So the primary surface is ONE PERSON'S RECORD — /api/performance/driver —
   and the fleet ranking exists to answer the second half of the question,
   which is whether a change was theirs or the whole fleet's.

   api/performance_sql.js owns every definition and every piece of arithmetic
   used here, and its header carries the measurements behind each: why there
   are two positions and never a blend, why a position on a COUNT needs no
   exposure floor while a position on a RATE would, why an active day is a day
   with an ACCEPTED booking rather than a day with a trip row, and why the
   comparison is against four pooled periods rather than against last week.

   This file is the window, the assembly, and the sentences.

   ── ONE QUERY SERVES BOTH ROUTES, AND THAT IS NOT AN OPTIMISATION ────────
   A position is a fact about a population, so the driver route needs every
   other driver's numbers to compute the subject's place. Both routes therefore
   run the same periodsSql over the same window and differ only in what they
   return from it. That is also what makes them impossible to disagree: the
   number on the Record tab and the number in the fleet table are the same
   value out of the same array, not two queries that ought to match. */
import {
  periodsSql, PERF_GRAINS, isPerfGrain, BASELINE_PERIODS, RATE_GATES,
  position, splitChange, fleetFactor, surprise, band, wilson,
  bonferroniZ, SINGLE_Z, valueCoverage, valueRankable, VALUE_COVERAGE_MIN,
  periodSeries, periodEnd, periodProgress,
} from './performance_sql.js';
import { OFFER_CHANNELS } from './cancellation_sql.js';
import { dubaiIso } from '../src/util.js';

/* Thirteen weeks is a quarter and a bit — long enough to hold four baseline
   periods behind every period the page draws an arrow on, which is the real
   constraint: with the default the OLDEST period shown still has a full
   baseline underneath it, because the query fetches BASELINE_PERIODS more than
   it displays. Twenty-six is the cap because the scan is over trip_norm and
   the whole record is about 250,000 bookings; beyond that a rollup is the
   right answer, not a longer request. */
const SHOW_PERIODS = { week: 13, month: 13 };
const MAX_PERIODS = 26;

const num = (v) => (v == null ? null : Number(v));
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const r1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

const grainOfReq = (req) => (isPerfGrain(req.query.grain) ? String(req.query.grain) : 'week');
const showOf = (req, grain) => {
  const n = parseInt(req.query.periods, 10);
  if (!Number.isFinite(n) || n < 2) return SHOW_PERIODS[grain];
  return Math.min(n, MAX_PERIODS);
};

/* WHICH PERIODS, given a grain and how many the page shows.
   BASELINE_PERIODS more than the page displays, fetched and then hidden. The
   first draft fetched exactly what it displayed, and the oldest few periods on
   every chart came back with no verdict and the reason "not enough history" —
   which was a statement about the REQUEST, not about the driver, and the
   drivers it was said about had years of history. */
export function windowOf(grain, show, today = dubaiIso()) {
  const series = periodSeries(grain, today,
    Math.min(show + BASELINE_PERIODS, MAX_PERIODS + BASELINE_PERIODS));
  return { today, series, visible: series.slice(-show),
    from: series[0], to: periodEnd(grain, series[series.length - 1]) };
}

/* Everything the routes do to a result set, with no database in it.
   ─────────────────────────────────────────────────────────────────────────
   Exported, and the reason is mockapi.mjs. The fixture behind the browser
   tests used to restate each endpoint's response by hand, and a hand-restated
   shape drifts from the product the moment either side changes — which is how
   a screen can be certified against a response nothing ships. The mock now
   fabricates ROWS in the shape periodsSql returns, which is the right level to
   fake at, and calls this for everything above them. */
export function shape(rows, { grain, show, today = dubaiIso() } = {}) {
  const { series, visible, from, to } = windowOf(grain, show, today);
  for (const r of rows) {
    r.completed = num(r.completed); r.bookings = num(r.bookings);
    r.accepted = num(r.accepted); r.declined = num(r.declined);
    r.dropped = num(r.dropped); r.rider_cancelled = num(r.rider_cancelled);
    r.unattributed = num(r.unattributed);
    r.value = num(r.value); r.priced = num(r.priced); r.priced_completed = num(r.priced_completed);
    r.km = num(r.km); r.measured = num(r.measured);
    r.active_days = num(r.active_days); r.offered_only_days = num(r.offered_only_days);
    r.platforms = r.platforms || [];
    r.on_offer_channel = r.platforms.some((p) => OFFER_CHANNELS.includes(p));
    /* Jobs per active day. The intensity term of the split — see
       api/performance_sql.js — and the quantity the fleet factor is measured
       on, because a total moves when the roster grows and this does not. */
    r.intensity = r.active_days ? r.completed / r.active_days : null;
    /* Value per COMPLETED-AND-PRICED job, which is the only denominator that
       makes the average a fare rather than a fare diluted by the trips whose
       fare has not arrived. */
    r.value_per_job = r.priced_completed ? r.value / r.priced_completed : null;
    const cov = valueCoverage(r);
    r.value_coverage = cov.covered == null ? null : Math.round(cov.covered * 1000) / 1000;
    r.value_rankable = valueRankable(r);
  }

  const byPeriod = new Map();
  const byPerson = new Map();
  for (const r of rows) {
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, []);
    byPeriod.get(r.period).push(r);
    if (!byPerson.has(r.person_key)) byPerson.set(r.person_key, new Map());
    byPerson.get(r.person_key).set(r.period, r);
  }

  /* ── the positions ──────────────────────────────────────────────────────
     Among ACTIVE drivers, on the operator's instruction — a person with no
     accepted work in the period is not in the column at all, rather than
     sitting at the bottom of it with a zero. Ranking somebody's day off is how
     a list of the worst performers fills up with people who were not there. */
  const periodMeta = new Map();
  for (const [p, rs] of byPeriod) {
    const active = rs.filter((r) => r.active_days > 0);
    const jobsVals = active.map((r) => r.completed);
    /* The value column is ranked only over the people whose value is
       comparable — see VALUE_COVERAGE_MIN. A driver below the floor is given
       no value position and a reason, never a low one. */
    const valueSet = active.filter((r) => r.value_rankable);
    const valueVals = valueSet.map((r) => r.value || 0);
    for (const r of active) {
      r.jobs_position = position(jobsVals, r.completed);
      if (r.value_rankable) {
        r.value_position = position(valueVals, r.value || 0);
      } else {
        r.value_position = null;
        r.value_position_absent = r.completed
          ? `a fare is on record for ${r.priced_completed} of ${r.completed} completed trips, `
            + `below the ${Math.round(VALUE_COVERAGE_MIN * 100)}% this column needs to be a `
            + 'comparison rather than a ranking of who has been invoiced yet'
          : 'no completed trip in this period, so there is no value to place';
      }
    }
    const med = (a) => {
      const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
      if (!v.length) return null;
      const h = v.length / 2;
      return v.length % 2 ? v[Math.floor(h)] : (v[h - 1] + v[h]) / 2;
    };
    periodMeta.set(p, {
      period: p,
      drivers: active.length,
      completed: active.reduce((a, r) => a + r.completed, 0),
      accepted: active.reduce((a, r) => a + r.accepted, 0),
      active_days: active.reduce((a, r) => a + r.active_days, 0),
      value: valueSet.length ? r2(valueSet.reduce((a, r) => a + (r.value || 0), 0)) : null,
      value_drivers: valueSet.length,
      jobs_median: med(jobsVals),
      intensity_median: med(active.map((r) => r.intensity)),
      value_median: valueVals.length ? med(valueVals) : null,
      intensities: active.map((r) => r.intensity).filter((x) => Number.isFinite(x)),
    });
  }

  const periods = series.map((p) => ({
    period: p,
    end: periodEnd(grain, p),
    ...periodProgress(grain, p, today),
  }));

  return { today, grain, series, visible, from, to, rows, byPeriod, byPerson, periodMeta, periods };
}

/* ONE SCAN PER GRAIN PER DATA VERSION, NOT ONE PER PERIOD.
   ─────────────────────────────────────────────────────────────────────────
   The response cache keys on the whole URL, which is right for every other
   endpoint in this product and wrong for this one in a way that shows up as a
   nineteen-second page. Measured on production 2026-09-14, cache-busted:

     /api/performance/fleet?grain=week     4.7s
     /api/performance/fleet?grain=month   18.7s   (the month grain over 17
                                                   months IS the whole record)

   The page's default key is warmed (api/warm.js) and answers in 0.4–0.5s. But
   the period picker is thirteen chips, each of them its own URL and therefore
   its own cache key — and the SQL behind every one of them is IDENTICAL. Only
   fleetRecord()'s choice of which period to table differs, and that is pure
   JavaScript over a result set already in memory. So the first chip a reader
   clicks on the month view paid the full nineteen seconds, and so did the
   second.

   The shaped context is therefore held here, keyed on the same DATA VERSION
   the response cache uses — the latest finish time of a collection run or a
   rollup — so it is valid for exactly as long as the data behind it has not
   moved, and never longer. That is the property api/cache.js's header argues
   for at length, and copying the rule rather than inventing a TTL is what
   keeps the two from disagreeing about what "fresh" means.

   Two grains times at most two fleets is four contexts, a few thousand row
   objects. An in-flight map beside it so that two readers arriving together on
   a cold key run ONE nineteen-second query rather than two: this database is
   shared with the collector, and a basic-xxs feels the difference. */
const CTX = new Map();            // grain|show|fleet|today -> { version, ctx }
const CTX_INFLIGHT = new Map();   // the same key -> the promise already running

/* The version, read the same way api/cache.js and api/warm.js read it. On any
   error this returns a value that cannot repeat, so a database that cannot
   answer the question degrades to no caching rather than to stale caching —
   the safe direction, and the one that does not need explaining to a reader
   looking at a number they think is current. */
async function dataVersion(q) {
  try {
    const [r] = await q(`SELECT (SELECT max(finished_at) FROM collection_run) AS c,
                                (SELECT max(finished_at) FROM rollup_state)   AS r`);
    return `${r?.c || '-'}|${r?.r || '-'}`;
  } catch {
    return `unknown-${Date.now()}-${Math.random()}`;
  }
}

/* The query, and then shape(). Kept apart so the shaping above has no database
   in it and the mock can reach it. */
async function load(q, { grain, show, fleet }) {
  const w = windowOf(grain, show);
  /* The version is held BESIDE the entry, not inside the key.
     ─────────────────────────────────────────────────────────────────────
     It was part of the key, and the store then cleared the whole map before
     writing — which meant the week context and the month context evicted each
     other, every time, for as long as both were being asked for. Measured on
     production 2026-09-14 after the first deploy of this memo: five month
     chips in a row came back 24.9s, 1.1s, 0.7s, 28.4s, 27.9s. The pattern is
     api/warm.js's own pass, which asks for BOTH grains on every version
     change: its week request landed between two of mine and threw away the
     month context I had just paid twenty-eight seconds for.

     So the map is keyed on the QUESTION and carries the version as data. A
     stale entry is dropped when it is found stale, and entries for other
     questions are left alone. */
  const key = `${grain}|${show}|${fleet || ''}|${w.today}`;
  const version = await dataVersion(q);
  const held = CTX.get(key);
  if (held && held.version === version) return held.ctx;
  const running = CTX_INFLIGHT.get(key);
  if (running) return running;

  const run = (async () => {
    const params = [w.from, w.to];
    let where = 'n.local_day BETWEEN $1::date AND $2::date';
    if (fleet) { params.push(fleet); where += ` AND n.fleet_id = $${params.length}`; }
    const rows = await q(periodsSql({ grain, where }), params);
    const ctx = shape(rows, { grain, show, today: w.today });
    CTX.set(key, { version, ctx });
    /* Anything for a version the data has moved past can never be read again,
       so it goes — a cache that only ever adds is a leak with a nicer name.
       Only the stale ones: this is the line whose first version cleared the
       whole map. */
    for (const [k, v] of CTX) if (v.version !== version) CTX.delete(k);
    return ctx;
  })().finally(() => CTX_INFLIGHT.delete(key));

  CTX_INFLIGHT.set(key, run);
  return run;
}

/* ── WAS IT THEM, OR WAS IT THE WEEK? ────────────────────────────────────
   The whole judgement for one person in one period, returned as a shape the
   renderer turns into a sentence. Every refusal to judge comes back with the
   true reason rather than a zero — the house rule this product exists to
   uphold. */
function judge(ctx, pk, periodIso, { nTested = 1 } = {}) {
  const { series, byPerson, periodMeta, grain, periods } = ctx;
  const mine = byPerson.get(pk);
  const row = mine?.get(periodIso) || null;
  const meta = periods.find((p) => p.period === periodIso);

  const out = {
    period: periodIso,
    complete: !!meta?.complete,
    elapsed_days: meta?.elapsed_days ?? null,
    total_days: meta?.total_days ?? null,
    verdict: null,
    absent: null,
  };

  /* A period still running cannot be compared with four that finished. Every
     dashboard that has ever drawn a week-on-week arrow has told everybody they
     were down on a Tuesday morning, and api/performer_routes.js already states
     the rule this follows: THE WEEK IS A COMPLETE WEEK. */
  if (!meta?.complete) {
    out.absent = `this ${PERF_GRAINS[grain].label} is ${meta?.elapsed_days ?? 0} of `
      + `${meta?.total_days ?? 0} days old, so there is nothing yet to compare with a finished one`;
    return out;
  }

  const idx = series.indexOf(periodIso);
  /* The baseline starts no earlier than the first period this person appears
     in. A period before somebody's first is not a period they did nothing in,
     it is a period we have no claim about — and treating it as a zero is how a
     driver in their third week is congratulated on an infinite improvement. */
  const firstSeen = series.find((p) => mine?.has(p));
  const firstIdx = firstSeen ? series.indexOf(firstSeen) : idx;
  const baseIso = series.slice(Math.max(firstIdx, idx - BASELINE_PERIODS), idx);
  const base = baseIso.map((p) => mine?.get(p) || null);

  if (baseIso.length < 2) {
    out.absent = baseIso.length
      ? `only one earlier ${PERF_GRAINS[grain].label} of theirs is on record, and one is not a record`
      : `this is the first ${PERF_GRAINS[grain].label} they appear in`;
    return out;
  }

  const baseDays = base.reduce((a, r) => a + (r?.active_days || 0), 0);
  const baseJobs = base.reduce((a, r) => a + (r?.completed || 0), 0);
  if (!baseDays) {
    out.absent = `they accepted no work in any of the previous ${baseIso.length} `
      + `${PERF_GRAINS[grain].plural}, so there is no usual to compare against`;
    return out;
  }

  const days1 = row?.active_days || 0;
  const jobs1 = row?.completed || 0;

  /* THEY ACCEPTED NOTHING. Not a verdict — a fact, and a different one.
     ───────────────────────────────────────────────────────────────────────
     Every quantity below is per ACTIVE DAY, so a period with no active day
     makes the expectation zero and the comparison vacuous: surprise() would
     come back with a null z and the page would print a verdict shape with no
     direction in it, which reads as "no change" for somebody who did not work
     at all. The absence is the finding here and it says which kind it is —
     an offer channel can tell a rest day from a day of offers nobody took,
     and Uber cannot. */
  if (!days1) {
    const offered = row?.offered_only_days || 0;
    out.absent = offered
      ? `they accepted no work in this ${PERF_GRAINS[grain].label}, though they were offered `
        + `some on ${offered} ${offered === 1 ? 'day' : 'days'} of it`
      : `they accepted no work in this ${PERF_GRAINS[grain].label}`;
    out.no_work = true;
    return out;
  }

  const rate0 = baseJobs / baseDays;
  const days0 = baseDays / baseIso.length;
  const rate1 = days1 ? jobs1 / days1 : 0;

  /* Did the whole fleet move? Medians of per-active-day intensity, baseline
     against this period — see fleetFactor(). Reported whether or not it is
     large, because "you did 18% less and the fleet did 15% less" is the answer
     and a page that shows only the first half of it is accusing somebody of
     the weather. */
  const baseInt = baseIso.flatMap((p) => periodMeta.get(p)?.intensities || []);
  const nowInt = periodMeta.get(periodIso)?.intensities || [];
  const fleet = fleetFactor(baseInt, nowInt);

  const expected = rate0 * fleet.factor * days1;
  const s = surprise(jobs1, expected, base.map((r) => r?.completed || 0));
  const threshold = nTested > 1 ? bonferroniZ(nTested) : SINGLE_Z;

  /* The split is against the person's own unadjusted baseline, deliberately.
     The verdict asks "is this more than we should have expected"; the split
     asks "what actually changed", and the answer to the second must add up to
     the change that happened, not to a change net of the fleet. Both are
     returned and the page labels them apart. */
  const split = splitChange({ days0, rate0, days1, rate1 });

  out.verdict = {
    jobs: jobs1,
    expected: r1(expected),
    /* Their own usual, before the fleet term, so a reader can see what the
       adjustment did rather than being handed only its output. */
    own_usual: r1(rate0 * days0),
    z: s.z == null ? null : Math.round(s.z * 100) / 100,
    sd: r1(s.sd),
    sd_basis: s.sd_basis,
    threshold: Math.round(threshold * 100) / 100,
    tested: nTested,
    direction: s.z == null ? null : (s.z > 0 ? 'up' : s.z < 0 ? 'down' : 'level'),
    /* The only place the word is used, and it means exactly one thing: the
       gap is larger than this driver's own period-to-period spread by more
       than the threshold, after the fleet's own movement is taken out. */
    changed: s.z == null ? null : Math.abs(s.z) >= threshold,
    fleet: {
      factor: Math.round(fleet.factor * 1000) / 1000,
      measured: fleet.measured,
      then: r2(fleet.fleet_then),
      now: r2(fleet.fleet_now),
      drivers_then: baseInt.length,
      drivers_now: nowInt.length,
    },
    split: {
      total: r1(split.total),
      days_part: r1(split.days_part),
      rate_part: r1(split.rate_part),
      days_then: r1(days0),
      days_now: days1,
      rate_then: r2(rate0),
      rate_now: r2(rate1),
    },
    /* Trip value gets a band rather than a z, and api/performance_sql.js says
       why: a spread floored at the square root of a sum of money is not a
       quantity, and four periods of money is too few to estimate one from. */
    value: {
      value: row?.value ?? null,
      band: band(row?.value ?? null, base.map((r) => (r?.value == null ? NaN : r.value))),
      per_job_now: r2(row?.value_per_job),
      per_job_then: r2((() => {
        const v = base.reduce((a, r) => a + (r?.value || 0), 0);
        const n = base.reduce((a, r) => a + (r?.priced_completed || 0), 0);
        return n ? v / n : null;
      })()),
      coverage: row?.value_coverage ?? null,
      rankable: !!row?.value_rankable,
      absent: row?.value_rankable ? null : (row?.value_position_absent || 'no completed trip in this period'),
    },
    baseline: {
      periods: baseIso.length,
      from: baseIso[0],
      to: baseIso[baseIso.length - 1],
      /* Which of those periods they actually worked. A baseline of four with
         one blank week in it is a different claim from a baseline of four
         worked weeks, and the page says which. */
      worked: base.filter((r) => (r?.active_days || 0) > 0).length,
      jobs: baseJobs,
      days: baseDays,
    },
  };
  return out;
}

/* The value split: a change in trip value is more jobs, or bigger fares, or
   both, and the same symmetric decomposition that separates days from
   intensity separates those. Kept beside judge() rather than inside it because
   it needs both periods priced and judge() must still answer when they are
   not. */
function valueSplit(row, base) {
  const jobs1 = row?.priced_completed || 0;
  const v1 = row?.value || 0;
  const jobs0all = base.reduce((a, r) => a + (r?.priced_completed || 0), 0);
  const v0all = base.reduce((a, r) => a + (r?.value || 0), 0);
  const n = base.length;
  if (!n || !jobs0all) return null;
  const jobs0 = jobs0all / n;
  const fare0 = v0all / jobs0all;
  const fare1 = jobs1 ? v1 / jobs1 : 0;
  const s = splitChange({ days0: jobs0, rate0: fare0, days1: jobs1, rate1: fare1 });
  return {
    total: r2(s.total), jobs_part: r2(s.days_part), fare_part: r2(s.rate_part),
    jobs_then: r1(jobs0), jobs_now: jobs1, fare_then: r2(fare0), fare_now: r2(fare1),
  };
}

/* The rate context. Never ranked and never given an arrow at week grain — the
   measured week-to-week rank correlation of completion percentage is 0.29, and
   api/performance_sql.js carries the measurement. Shown with an interval, or
   withheld with the count that is too small, so a reader is never handed a
   percentage the sample cannot support. */
function rates(row) {
  const acc = row?.accepted || 0;
  const out = { accepted: acc, show_at: RATE_GATES.show, rank_at: RATE_GATES.rank };
  if (acc < RATE_GATES.show) {
    out.absent = `${acc} accepted booking${acc === 1 ? '' : 's'} in this period — a percentage `
      + `over fewer than ${RATE_GATES.show} says more about the sample than the driver`;
    return out;
  }
  const comp = wilson(row.completed, acc);
  const drop = wilson(row.dropped, acc);
  out.completion = { pct: Math.round(comp.p * 1000) / 10, lo: Math.round(comp.lo * 1000) / 10, hi: Math.round(comp.hi * 1000) / 10 };
  out.dropped = { pct: Math.round(drop.p * 1000) / 10, lo: Math.round(drop.lo * 1000) / 10, hi: Math.round(drop.hi * 1000) / 10 };
  return out;
}

/* One person's whole record, from a shaped context. */
export function driverRecord(ctx, pk, { id = null, keys = [] } = {}) {
  const grain = ctx.grain;
  const show = ctx.visible.length;
  const mine = ctx.byPerson.get(pk) || new Map();
  const any = [...mine.values()][0] || null;

  const periods = ctx.visible.map((p) => {
    const row = mine.get(p) || null;
    const meta = ctx.periods.find((x) => x.period === p);
    const pm = ctx.periodMeta.get(p) || null;
    const base = ctx.series.slice(Math.max(0, ctx.series.indexOf(p) - BASELINE_PERIODS), ctx.series.indexOf(p))
      .map((x) => mine.get(x) || null);
    return {
      period: p,
      end: meta?.end || null,
      complete: !!meta?.complete,
      elapsed_days: meta?.elapsed_days ?? null,
      total_days: meta?.total_days ?? null,
      worked: !!(row && row.active_days > 0),
      completed: row?.completed ?? 0,
      bookings: row?.bookings ?? 0,
      accepted: row?.accepted ?? 0,
      declined: row?.declined ?? 0,
      dropped: row?.dropped ?? 0,
      rider_cancelled: row?.rider_cancelled ?? 0,
      unattributed: row?.unattributed ?? 0,
      active_days: row?.active_days ?? 0,
      offered_only_days: row?.offered_only_days ?? 0,
      intensity: r2(row?.intensity),
      value: row?.value ?? null,
      value_per_job: r2(row?.value_per_job),
      value_coverage: row?.value_coverage ?? null,
      value_rankable: !!row?.value_rankable,
      /* `??`, because value_position_absent is only written onto rows that
         were ACTIVE in the period — a row for a period the driver accepted
         nothing in would otherwise carry `undefined`, which drops out of JSON
         entirely and leaves the page with a blank it cannot explain. The house
         rule is that a blank names its reason. */
      value_absent: row && !row.value_rankable
        ? (row.value_position_absent
          ?? 'they accepted no work in this period, so there is no value to place')
        : null,
      km: row?.km ?? null,
      platforms: row?.platforms || [],
      on_offer_channel: !!row?.on_offer_channel,
      jobs_position: row?.jobs_position || null,
      value_position: row?.value_position || null,
      rates: rates(row),
      /* What everybody else did in the same period, so the line behind the
         driver's own is drawn from the same array the position came from. */
      fleet_jobs_median: pm?.jobs_median ?? null,
      fleet_intensity_median: pm ? r2(pm.intensity_median) : null,
      fleet_value_median: pm?.value_median == null ? null : r2(pm.value_median),
      fleet_drivers: pm?.drivers ?? 0,
      judgement: judge(ctx, pk, p, { nTested: 1 }),
      value_split: valueSplit(mine.get(p) || null, base),
    };
  });

  /* The latest COMPLETE period is the one the headline speaks about. The
     current one is on the chart, marked partial, and says nothing. */
  const latest = [...periods].reverse().find((p) => p.complete) || null;

  return {
    grain,
    periods_shown: show,
    baseline_periods: BASELINE_PERIODS,
    today: ctx.today,
    person_key: pk,
    keys,
    driver: { id: any?.driver_ext_id || (String(id || '').startsWith('name:') ? null : id),
      name: any?.driver_name || null },
    /* Empty is an answer, and it is not a 404: the person exists, and they
       did not work in the window the reader chose. */
    absent: mine.size ? null
      : `no booking on any channel between ${ctx.visible[0]} and ${periodEnd(grain, ctx.visible[ctx.visible.length - 1])}`,
    periods,
    latest_complete: latest ? latest.period : null,
    offer_channels: OFFER_CHANNELS,
    value_coverage_min: VALUE_COVERAGE_MIN,
    rate_gates: RATE_GATES,
  };
}

/* Everybody active in one period, on both bases, from a shaped context. */
export function fleetRecord(ctx, { period: wanted = null } = {}) {
  const grain = ctx.grain;
  const complete = ctx.visible.filter((p) => ctx.periods.find((x) => x.period === p)?.complete);
  const asked = wanted && ctx.visible.includes(wanted) ? wanted : null;
  const periodIso = asked || complete[complete.length - 1] || ctx.visible[ctx.visible.length - 1];
  const meta = ctx.periods.find((x) => x.period === periodIso);

  const rs = (ctx.byPeriod.get(periodIso) || []).filter((r) => r.active_days > 0);

  /* Every driver who is testable gets tested, and the threshold is set from
     how many that is — see bonferroniZ(). At |z| >= 2 down a list of 122
     people, six drivers are flagged every week for no reason at all, and
     they are at the TOP of the list because the list is sorted by z. */
  const judged = rs.map((r) => ({ row: r, j: judge(ctx, r.person_key, periodIso, { nTested: 1 }) }));
  const testable = judged.filter((x) => x.j.verdict && x.j.verdict.z != null);
  const threshold = bonferroniZ(Math.max(1, testable.length));

  const table = judged.map(({ row, j }) => ({
    person_key: row.person_key,
    driver_ext_id: row.driver_ext_id,
    driver_name: row.driver_name,
    platforms: row.platforms,
    on_offer_channel: row.on_offer_channel,
    completed: row.completed,
    accepted: row.accepted,
    dropped: row.dropped,
    active_days: row.active_days,
    intensity: r2(row.intensity),
    value: row.value,
    value_per_job: r2(row.value_per_job),
    value_coverage: row.value_coverage,
    value_rankable: row.value_rankable,
    value_absent: row.value_rankable ? null
      : (row.value_position_absent ?? 'no completed trip in this period, so there is no value to place'),
    jobs_position: row.jobs_position,
    value_position: row.value_position,
    rates: rates(row),
    /* The movement, restated against the fleet-wide threshold rather than
       the single-driver one the judgement was computed with. Both numbers
       travel so the page can say which test it is applying. */
    z: j.verdict?.z ?? null,
    direction: j.verdict?.direction ?? null,
    changed: j.verdict?.z == null ? null : Math.abs(j.verdict.z) >= threshold,
    expected: j.verdict?.expected ?? null,
    split: j.verdict?.split ?? null,
    baseline: j.verdict?.baseline ?? null,
    no_verdict: j.verdict ? null : j.absent,
  }));

  const pm = ctx.periodMeta.get(periodIso) || null;
  const movers = table.filter((t) => t.changed).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  return {
    grain,
    today: ctx.today,
    period: periodIso,
    period_end: meta?.end || null,
    period_complete: !!meta?.complete,
    period_partial_note: meta?.complete ? null
      : `this ${PERF_GRAINS[grain].label} is ${meta?.elapsed_days ?? 0} of ${meta?.total_days ?? 0} `
        + 'days old; the figures are real but they are not a finished period and carry no verdict',
    periods: ctx.visible.map((p) => {
      const m = ctx.periodMeta.get(p) || null;
      const x = ctx.periods.find((y) => y.period === p);
      return {
        period: p, end: x?.end || null, complete: !!x?.complete,
        /* How much of the period has actually happened, carried so a chart can
           draw an unfinished bucket hollow instead of at full weight. Without
           these two the last bar of every fleet chart is a short solid bar
           that reads as a collapse and is only the calendar. */
        elapsed_days: x?.elapsed_days ?? null,
        total_days: x?.total_days ?? null,
        drivers: m?.drivers ?? 0,
        completed: m?.completed ?? 0,
        accepted: m?.accepted ?? 0,
        active_days: m?.active_days ?? 0,
        value: m?.value ?? null,
        value_drivers: m?.value_drivers ?? 0,
        jobs_median: m?.jobs_median ?? null,
        intensity_median: m ? r2(m.intensity_median) : null,
        value_median: m?.value_median == null ? null : r2(m.value_median),
      };
    }),
    summary: pm ? {
      drivers: pm.drivers,
      completed: pm.completed,
      accepted: pm.accepted,
      active_days: pm.active_days,
      value: pm.value,
      value_drivers: pm.value_drivers,
      jobs_median: pm.jobs_median,
      intensity_median: r2(pm.intensity_median),
      value_median: pm.value_median == null ? null : r2(pm.value_median),
    } : null,
    /* Named so the page can print the sentence rather than invent one: this
       is a fleet-wide test over this many people, at this threshold. */
    movement: {
      tested: testable.length,
      untested: table.length - testable.length,
      threshold: Math.round(threshold * 100) / 100,
      single_threshold: SINGLE_Z,
      why: `${table.length} drivers were active and ${testable.length} of them have enough of `
        + 'their own history to be compared with. Testing that many people at the usual '
        + 'one-in-twenty bar would flag several every period for no reason, so the bar here is '
        + `|z| ${Math.round(threshold * 100) / 100}, which is one-in-twenty spread across all of them.`,
    },
    movers,
    rows: table,
    offer_channels: OFFER_CHANNELS,
    value_coverage_min: VALUE_COVERAGE_MIN,
    rate_gates: RATE_GATES,
  };
}

export function performanceRoutes(app, { q, wrap }) {
  /* ── one person's record ──────────────────────────────────────────────── */
  app.get('/api/performance/driver', wrap(async (req, res) => {
    const id = req.query.id || null;
    const personQ = req.query.person || null;
    if (!id && !personQ) {
      return res.status(400).json({ error: 'id or person required' });
    }
    /* Resolve the requested platform id to the person key everything here
       groups on. person_key on `trip` already carries the verified merge
       register (sql/schema_v53.sql, generated from api/identity_map.js), so
       both records of a merged person answer the same key — which is what
       makes opening either account show one record rather than two halves. */
    let keys = [];
    if (personQ) {
      keys = [personQ];
    } else if (String(id).startsWith('name:')) {
      keys = [String(id).slice(5)];
    } else {
      const found = await q(
        `SELECT DISTINCT coalesce(nullif(person_key, ''), driver_ext_id) AS pk
           FROM trip WHERE driver_ext_id = $1`, [id]);
      keys = found.map((r) => r.pk).filter(Boolean);
    }
    if (!keys.length) {
      return res.status(404).json({ error: 'unknown driver', id });
    }

    const grain = grainOfReq(req);
    const show = showOf(req, grain);
    const ctx = await load(q, { grain, show, fleet: req.query.fleet || null });

    /* One person can hold more than one key only when their name is spelled
       two different ways on two accounts that the register has not joined.
       Taking the busiest is right and saying so is necessary: the alternative
       is silently summing two people who might not be one. */
    const present = keys.filter((k) => ctx.byPerson.has(k));
    const pk = present.sort((a, b) => {
      const sum = (k) => [...ctx.byPerson.get(k).values()].reduce((t, r) => t + r.completed, 0);
      return sum(b) - sum(a);
    })[0] || keys[0];

    return res.json(driverRecord(ctx, pk, { id, keys }));
  }));

  /* ── everybody, for one period, on both bases ──────────────────────────── */
  app.get('/api/performance/fleet', wrap(async (req, res) => {
    const grain = grainOfReq(req);
    const show = showOf(req, grain);
    const ctx = await load(q, { grain, show, fleet: req.query.fleet || null });

    return res.json(fleetRecord(ctx, { period: req.query.period || null }));
  }));
}
