import { JOIN_TRIP } from './custody_sql.js';
import { DECLINED_SQL, DROPPED_SQL, CANCEL_CASE } from './cancellation_sql.js';

/* ONE PERSON, ONE PERIOD, AND WHETHER THEY GOT BETTER OR WORSE.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked for "driver performance week by week, and month by month,
   a comparison of what they used to do, out of the active drivers what was
   their position, and whether it got better or worse" — and then said plainly
   what the point of it is: "it's a performance difference of the solo driver
   not comparison between the fleet drivers."

   So the subject of this module is ONE DRIVER AGAINST THEIR OWN RECORD. The
   fleet position rides beside it as context, because a person cannot read
   their own change without knowing whether the whole fleet moved with them.

   ── WHAT IS RANKED, AND WHY THERE ARE TWO OF THEM ────────────────────────
   Two positions, never blended, on the operator's instruction: "rank on jobs
   done and on trip value but separately so that we can understand".

   That instruction is also the right call on this data. api/income_sql.js
   carries the reason a BLENDED money rank is indefensible: the hotel channel
   reports a GROSS fare and Uber's statement reports a payout NET of commission
   and of the cash the driver already took, so one blended column puts a hotel
   driver above an Uber driver who earned more and gives the page no way to
   show it. Two columns can disagree, and where they do the disagreement is the
   finding — a driver 12th on jobs and 40th on value is driving short hops,
   which is a real thing to say to them.

   TRIP VALUE HERE IS GROSS FARES, sum(price) over has_fare, and that choice
   needed checking rather than assuming, because sql/schema_v18.sql says in so
   many words that "the Uber trip export has no fare column at all, so price is
   NULL on every Uber row" — which would have made a fare rank a ranking of the
   9% of this fleet's work that is not Uber. That comment is now stale: the
   payments walk fills trip.price, and /api/revenue measured on production
   2026-09-14 puts priced bookings against all bookings, per month, at

     2025-09  uber 25711/28210      2026-03  uber  5091/6065
     2025-12  uber 24101/26649      2026-06  uber  9066/10047
     2026-02  uber 22638/25437      2026-08  uber 11248/12445

   — 89% to 91% of every booking in every month back to the start of the
   record, and 100.0% of the bookings that could carry a fare, the remainder
   being cancellations that charged nothing. So gross trip value IS measurable
   for this fleet's main channel and it is what the operator asked to rank on.

   It is NOT the fleet's receipts and the page must never call it that: Uber
   takes 25% out of it, Yango around 23%, and the driver has already pocketed
   any cash. `priced` and `completed` travel with the figure so coverage is
   stated, and a person whose coverage is short gets no value POSITION at all —
   see valueRankable() below.

   ── POSITION IS FOR EVERY ACTIVE DRIVER, AND THAT IS MEASURED ────────────
   The operator chose "out of the active drivers", not out of some rated
   subset. That is defensible HERE and would not have been on a rate. Measured
   on production 2026-09-14, Spearman rank correlation between consecutive
   weeks over every active driver with NO exposure floor at all:

     completed jobs        0.71  0.77  0.83  0.71  0.72  0.79
     jobs per active day   0.76  0.77  0.77  0.73  0.76  0.82

   A driver who completed three jobs completed three jobs; a COUNT has no
   small-sample problem, and position on it is a stable property of a person.
   The same measurement is what forbids ranking a RATE weekly: completion
   percentage between consecutive weeks runs 0.15 to 0.53, median 0.29, even
   restricted to drivers with twenty or more trips in BOTH weeks. That is
   mostly noise, so rates are carried as context with an interval and never
   given a position or an arrow at week grain.

   ── THE DENOMINATOR THAT IS NOT trips ────────────────────────────────────
   An ACTIVE DAY is a Dubai day on which the person had at least one ACCEPTED
   booking. Not a day with a trip row.

   trip_norm.is_booking is (platform <> 'fms'), with no outcome filter, so a
   Bolt broadcast offer IS a booking. A Bolt driver shown three offers and
   taking none has three booking rows on a day they did no work; the identical
   rest day for an Uber driver produces no row at all, because Uber's export
   contains dispatched trips only. Counting days with any booking would
   therefore mean AVAILABILITY on Bolt and DISPATCH on Uber — and the 64%
   against 15% cancellation-rate artefact measured in docs/COVERAGE.md would
   walk straight back in through the denominator of the very figure chosen to
   escape it. accepted = bookings minus offers never accepted, using the same
   DECLINED_SQL the Cancellations page and /api/kpis already count with.

   ── ONE DEFINITION, NOT A FOURTH COPY ────────────────────────────────────
   Every cancellation expression here is imported from api/cancellation_sql.js.
   That file's header says why: two definitions of a cancellation in one
   product is how two pages come to disagree about one morning. This module
   adds a third surface and imports rather than restates. */

/* The grains the product offers, and the Postgres bucket for each. `week` is
   Monday-start, which is what date_trunc does and what api/performer_routes.js
   already anchors its week on — and, per sql/schema_v23.sql, the grid Uber's
   own billing weeks use. The two must agree or a period label points at a
   different seven days from the one the figure covers. */
/* PERF_GRAINS, not GRAINS, and the prefix is load-bearing.
   test/mount.mjs builds the harness's injection set by spreading EVERY
   api/*_sql.js module over an explicit list of helpers — and the spread comes
   last, so an export here silently wins against the name above it. api/window.js
   exports GRAINS and the mounted slice of api/server.js uses it, so a plain
   GRAINS in this file would have replaced the product's grain table with this
   two-entry one inside every route the harness mounts, with no error anywhere:
   the routes would simply have stopped recognising 'day' and 'quarter'.
   test/sql_module_names.test.mjs now fails on any such collision. */
export const PERF_GRAINS = {
  week: { trunc: 'week', label: 'week', plural: 'weeks' },
  month: { trunc: 'month', label: 'month', plural: 'months' },
};

export const isPerfGrain = (g) => Object.prototype.hasOwnProperty.call(PERF_GRAINS, String(g || ''));

/* HOW MANY PRIOR PERIODS A BASELINE IS MADE OF.
   Four, pooled — not the single previous period. One week against one week is
   two noisy draws and the difference of two noisy things is noisier than
   either; four pooled periods give the comparison something with a shape. */
export const BASELINE_PERIODS = 4;

/* The exposure below which a RATE is not stated, and below which it is stated
   but not ranked. Positions on a COUNT are exempt: see the header — a count
   needs no floor. These are the numbers the response carries so the page
   states them rather than deriving a second copy. */
export const RATE_GATES = { show: 30, rank: 100 };

/* Per person, per period, over a window.
   ─────────────────────────────────────────────────────────────────────────
   FROM trip_norm with JOIN_TRIP, not from driver_day. driver_day is the
   cheaper table and it was the first choice, but three of the figures this
   module needs are not on it and one of the three it does carry is the wrong
   one:

     - it has no `accepted`, so the active-day denominator above cannot be
       built from it without a migration;
     - its `fares` column is documented NULL for every Uber trip (v41's own
       COMMENT says so), and its `money` is the statement/payout basis — the
       fleet's receipts, which is a different question from the gross trip
       value the operator asked to rank on, and which the Earnings tab of the
       driver profile already answers;
     - its `trips` is the contaminated count the header describes.

   Reading trip_norm costs a scan the pre-aggregate would not, and buys numbers
   that agree with /api/kpis and /api/cancellations by construction because
   they are the same expressions. A rollup can come later if the scan proves
   slow; a second set of definitions cannot be taken back. */
export function periodsSql({ grain = 'week', where = 'TRUE' } = {}) {
  const g = PERF_GRAINS[grain] || PERF_GRAINS.week;
  return `
    WITH day AS (
      /* One row per person per Dubai day. The fold happens HERE, before any
         day is counted, because a person working two platform accounts on one
         day has two sets of rows and counting those as two days is the defect
         api/economics_routes.js records at :1015 — thirteen days worked inside
         a seven-day window, which put one man on the best-earning and the
         worst-earning list at the same time. */
      SELECT coalesce(nullif(t.person_key, ''), n.driver_ext_id)          AS person_key,
             n.local_day,
             date_trunc('${g.trunc}', n.local_day)::date                  AS period,
             count(*)::int                                                AS bookings,
             count(*) FILTER (WHERE ${DECLINED_SQL})::int                 AS declined,
             count(*) FILTER (WHERE n.outcome = 'completed')::int         AS completed,
             count(*) FILTER (WHERE ${DROPPED_SQL})::int                  AS dropped,
             count(*) FILTER (WHERE ${CANCEL_CASE} = 'rider')::int        AS rider_cancelled,
             count(*) FILTER (WHERE ${CANCEL_CASE} = 'unattributed')::int AS unattributed,
             /* Gross trip value: what riders were charged. has_fare already
                excludes a complimentary ride, which carries a price nobody
                paid. Not the fleet's receipts — see the header. */
             sum(n.price) FILTER (WHERE n.has_fare)                       AS value,
             count(*) FILTER (WHERE n.has_fare)::int                      AS priced,
             /* The coverage denominator for value, and it is COMPLETED rather
                than all bookings: a cancellation that charged nothing is not a
                fare we are missing, it is a fare that does not exist. Counting
                it as a gap is how Bolt came to read 63.8% covered on a month it
                priced 312 of 313 completed rides (api/income_sql.js). */
             count(*) FILTER (WHERE n.outcome = 'completed' AND n.has_fare)::int
                                                                          AS priced_completed,
             sum(n.distance_km) FILTER (WHERE n.has_distance)             AS km,
             count(*) FILTER (WHERE n.has_distance)::int                  AS measured,
             array_agg(DISTINCT n.platform)                               AS platforms,
             max(n.driver_name)                                           AS driver_name,
             min(n.driver_ext_id)                                         AS driver_ext_id
        FROM trip_norm n
        ${JOIN_TRIP}
       WHERE n.is_booking AND ${where}
       GROUP BY 1, 2, 3),
    /* THE PLATFORM LIST IS AGGREGATED ON ITS OWN, AND THAT IS NOT A STYLE
       CHOICE. The first draft of this query unnested the per-day platform
       array in the FROM clause of the period aggregate —
       FROM day, LATERAL unnest(platforms) AS p GROUP BY 1, 2 — which is the
       oldest multiplication bug there is: a day on which somebody worked Uber
       AND Bolt produced two rows, so every count, every sum and, worst of all,
       the active_days count(*) beside them doubled for exactly the people who
       work two channels. It was caught by reading, not by a test, because a
       doubled count is still a plausible-looking number. The set expansion
       happens in its own CTE and joins back one row per person-period. */
    plat AS (
      SELECT d.person_key, d.period, array_agg(DISTINCT p ORDER BY p) AS platforms
        FROM day d, LATERAL unnest(d.platforms) AS p
       WHERE p IS NOT NULL
       GROUP BY 1, 2)
    SELECT d.person_key,
           to_char(d.period, 'YYYY-MM-DD')                               AS period,
           max(d.driver_name)                                            AS driver_name,
           min(d.driver_ext_id)                                          AS driver_ext_id,
           sum(d.completed)::int                                         AS completed,
           sum(d.bookings)::int                                          AS bookings,
           (sum(d.bookings) - sum(d.declined))::int                      AS accepted,
           sum(d.declined)::int                                          AS declined,
           sum(d.dropped)::int                                           AS dropped,
           sum(d.rider_cancelled)::int                                   AS rider_cancelled,
           sum(d.unattributed)::int                                      AS unattributed,
           round(sum(d.value)::numeric, 2)                               AS value,
           sum(d.priced)::int                                            AS priced,
           sum(d.priced_completed)::int                                  AS priced_completed,
           round(sum(d.km)::numeric, 1)                                  AS km,
           sum(d.measured)::int                                          AS measured,
           /* THE DENOMINATOR. A day counts when the person accepted something
              on it — see the header. count(*) over this CTE is already a count
              of DAYS, because the fold above made it one row per person-day. */
           count(*) FILTER (WHERE d.bookings - d.declined > 0)::int       AS active_days,
           /* Days on which SOMETHING was filed but nothing was accepted. Kept
              apart rather than folded into active_days or dropped silently: on
              an offer channel this is a day the driver was shown work and took
              none, which is a real fact, and on Uber it cannot occur. */
           count(*) FILTER (WHERE d.bookings - d.declined = 0)::int       AS offered_only_days,
           coalesce(pl.platforms, ARRAY[]::text[])                        AS platforms
      FROM day d
      LEFT JOIN plat pl ON pl.person_key = d.person_key AND pl.period = d.period
     GROUP BY d.person_key, d.period, pl.platforms
     ORDER BY d.person_key, d.period`;
}

/* OFFER_CHANNELS is deliberately NOT re-exported from here. It was, for the
   convenience of a caller wanting one import — and a re-export is a second
   export of the same name across api/*_sql.js, which is the collision
   test/sql_module_names.test.mjs exists to forbid. Callers import it from
   api/cancellation_sql.js, which owns it. */

/* ── THE POSITION, and it is deliberately not computed in SQL ─────────────
   api/driver_routes.js:2766 already has this function, and it is the reason
   this one exists in JavaScript rather than as a window function: two
   percentile definitions for one driver on adjacent tabs of one page is
   exactly the class of defect this product keeps paying for. The formula is
   copied because the FORMULA is the contract — strictly-below over n-1, a
   lone member at 50, the size of the tie travelling with the number.

   The tie matters more here than it looks. On a week, dozens of drivers
   genuinely share a completed count, and a percentile of 0 is 0 whether one
   person is at the bottom or ninety are level there. The renderer decides
   which sentence that wants; this returns the shape. */
export function position(values, v) {
  const vals = [...values].map((x) => Number(x) || 0).sort((a, b) => a - b);
  const me = Number(v) || 0;
  let below = 0;
  while (below < vals.length && vals[below] < me) below++;
  let tied = 0;
  for (const x of vals) if (x === me) tied++;
  const raw = vals.length > 1 ? (below / (vals.length - 1)) * 100 : 50;
  return {
    percentile: Math.round(raw),
    /* The unrounded percentile, carried so a caller that INVERTS the scale can
       round once rather than twice. api/driver_routes.js:2766 reports several
       metrics where low is good and computes Math.round(100 - raw); rounding
       here first and subtracting there gives a different answer by one at an
       exact half, and two tabs of one page disagreeing by a point is precisely
       what sharing this function is meant to prevent. */
    raw,
    /* The ordinal an operator reads, 1 = most. Carried beside the percentile
       and never instead of it: the active set moves week to week, so "40th"
       means a different thing every week while a percentile does not. A page
       that prints the rank alone across periods is comparing two different
       denominators and calling it a change. */
    rank: vals.length - below - tied + 1,
    of: vals.length,
    tied,
    median: vals.length ? vals[Math.floor(vals.length / 2)] : null,
  };
}

/* Is this person's trip value comparable to the next person's?
   ─────────────────────────────────────────────────────────────────────────
   A value position is a ranking of sums, and a sum over 40% of somebody's
   completed trips belongs nowhere near a sum over all of the next person's.
   Uber sits at 100% of chargeable bookings and Bolt at 99.7% in a normal
   month, so this gate almost never fires — which is the point: when it DOES
   fire, something is genuinely missing and the page must say so instead of
   ranking the person at the bottom of a column they are not in. */
export const VALUE_COVERAGE_MIN = 0.8;

export function valueCoverage(row) {
  const done = Number(row?.completed) || 0;
  if (!done) return { covered: null, priced: Number(row?.priced_completed) || 0, completed: 0 };
  const priced = Number(row?.priced_completed) || 0;
  return { covered: priced / done, priced, completed: done };
}

export const valueRankable = (row) => {
  const c = valueCoverage(row);
  return c.covered != null && c.covered >= VALUE_COVERAGE_MIN;
};

/* ── WAS IT A CHANGE, OR WAS IT A WEEK? ───────────────────────────────────
   Everything below exists to keep the page from calling noise a change. A
   dashboard that prints a red arrow every time a driver has an ordinary bad
   week teaches its readers to ignore red arrows, and then it cannot tell them
   anything when one matters.

   Three quantities, and the third is the product of the first two:

     active days   D   how many Dubai days they accepted work on
     intensity     I   completed jobs per active day
     output        O   completed jobs, = D x I

   The verdict is given on OUTPUT, because that is what the operator asked
   about, and then output's change is SPLIT between the two things that can
   cause it. A driver down eighteen jobs who worked two fewer days and was
   otherwise identical is a rota fact; a driver down eighteen jobs on the same
   number of days is a driving fact. The page is useless if it cannot tell
   those apart, and a single percentage cannot. */

/* The symmetric (Shapley) split of a change in a product into its two
   factors. Exact by construction — days_part + rate_part is identically
   D1*I1 - D0*I0 — so the two parts can be printed beside the total without a
   remainder term that a reader has to be told to ignore.

   The naive split, (D1-D0)*I0 for days and D0*(I1-I0) for rate, leaves the
   cross term (D1-D0)*(I1-I0) unassigned; on a driver who worked two more days
   AND went faster, that term is the interesting part of the story and dropping
   it understates both halves. Each factor is credited at the MEAN of the two
   periods' other factor, which hands each half of the cross term to the change
   that produced it. test/performance_math.test.mjs holds the identity. */
export function splitChange({ days0, rate0, days1, rate1 }) {
  const d0 = Number(days0) || 0; const r0 = Number(rate0) || 0;
  const d1 = Number(days1) || 0; const r1 = Number(rate1) || 0;
  return {
    total: d1 * r1 - d0 * r0,
    days_part: (d1 - d0) * ((r0 + r1) / 2),
    rate_part: (r1 - r0) * ((d0 + d1) / 2),
  };
}

/* DID THE WHOLE FLEET MOVE?
   ─────────────────────────────────────────────────────────────────────────
   A driver's week is not judged against their own history in a vacuum. Eid,
   a fortnight of rain, a school holiday and a competitor's promotion all move
   every driver at once, and a page that charges those to the individual is
   accusing people of the weather. The expected value is therefore the driver's
   own baseline SCALED by how the fleet moved between that baseline and this
   period.

   The fleet term is a ratio of MEDIANS of per-active-day intensity, not of
   totals: a total moves when the roster grows, and the roster grew from 84 to
   122 active drivers over ten weeks, which would have been read as every
   incumbent driver improving by 45%. A median over people is immune to that
   and to the handful of very large drivers who would otherwise carry it.

   Returned rather than applied silently, and carried in the response, because
   "you did 18% less work than usual and the fleet did 15% less" is the whole
   answer and a page that hides the second half of it is not honest. */
export function fleetFactor(baselineIntensities, periodIntensities) {
  const med = (a) => {
    const v = a.map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
    if (!v.length) return null;
    const h = v.length / 2;
    return v.length % 2 ? v[Math.floor(h)] : (v[h - 1] + v[h]) / 2;
  };
  const b = med(baselineIntensities);
  const p = med(periodIntensities);
  if (!b || !p) return { factor: 1, measured: false, fleet_then: b, fleet_now: p };
  return { factor: p / b, measured: true, fleet_then: b, fleet_now: p };
}

/* HOW SURPRISING IS THIS COUNT, given what this person usually does?
   ─────────────────────────────────────────────────────────────────────────
   Two spreads are combined and the LARGER is used, which is deliberately the
   conservative choice in both directions:

     the Poisson floor, sqrt(expected). Jobs arrive as a count; even a driver
     who never changes their behaviour varies by about this much, and no
     estimate of spread may claim to be tighter than the arrival process.

     the person's own spread across the baseline periods. Real driver weeks are
     OVERDISPERSED relative to Poisson — shifts get swapped, a car goes in for
     service, a wedding takes a Saturday — and using the Poisson floor alone
     flags a third of the roster as significantly changed every single week,
     which is how a dashboard trains people to ignore it.

   With BASELINE_PERIODS = 4 the sample standard deviation has three degrees of
   freedom and is itself noisy, which is exactly why it is a floor-and-take-the
   -larger rather than a replacement: a person who happened to have four
   near-identical weeks does not get a hair trigger.

   The threshold is not applied here. This returns z, the page decides — and
   the fleet-wide "biggest movers" list uses a different threshold from a single
   driver's own page, for the reason bonferroniZ() gives. */
export function surprise(observed, expected, baselineValues = []) {
  const obs = Number(observed) || 0;
  const exp = Number(expected);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { z: null, sd: null, expected: exp, why: 'no baseline to expect against' };
  }
  const vals = baselineValues.map(Number).filter(Number.isFinite);
  let own = null;
  if (vals.length >= 2) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
    own = Math.sqrt(varr);
  }
  const sd = Math.max(Math.sqrt(exp), own || 0);
  return {
    z: (obs - exp) / sd,
    sd,
    expected: exp,
    poisson_sd: Math.sqrt(exp),
    own_sd: own,
    /* Which of the two spreads decided it, so a reader who asks "why is this
       not flagged" gets an answer rather than a shrug. */
    sd_basis: own != null && own > Math.sqrt(exp) ? "this driver's own week-to-week spread"
      : 'the arrival spread of a count',
  };
}

/* THE THRESHOLD, AND WHY IT DEPENDS ON HOW MANY PEOPLE ARE ON THE PAGE.
   ─────────────────────────────────────────────────────────────────────────
   |z| >= 2 on one driver is a 1-in-20 claim. Applied down a list of 122
   drivers it is six false alarms per week, every week, and they will be at the
   top of the list because the list is sorted by z. A fleet-wide movers list
   therefore uses a Bonferroni threshold over the number of people tested; a
   single driver's own page, which tests one person, uses 2.

   Acklam's rational approximation for the inverse normal CDF, accurate to
   about 1.15e-9 over the whole range — good enough by four orders of magnitude
   for a threshold that is printed to one decimal. */
export function invNorm(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const lo = 0.02425; const hi = 1 - lo;
  let q; let r;
  if (p < lo) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > hi) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const SINGLE_Z = 2;

export function bonferroniZ(nTested, alpha = 0.05) {
  const n = Math.max(1, Number(nTested) || 1);
  return Math.abs(invNorm((alpha / n) / 2));
}

/* A rate, with the interval that says how much of it is the sample.
   ─────────────────────────────────────────────────────────────────────────
   Wilson rather than the textbook normal interval, because the textbook one
   is wrong at exactly the values this product reports: at 0 successes it gives
   a width of zero, so a driver with 0 of 4 dropped is shown a dropped rate of
   0% with no uncertainty at all, which is a claim the data does not support.
   Wilson's interval is bounded in [0,1] and never degenerate. */
export function wilson(k, n, z = 1.96) {
  const hits = Number(k) || 0; const tries = Number(n) || 0;
  if (!tries) return { p: null, lo: null, hi: null, n: 0 };
  const p = hits / tries;
  const z2 = z * z;
  const denom = 1 + z2 / tries;
  const centre = (p + z2 / (2 * tries)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * tries)) / tries)) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n: tries };
}

/* ── PERIOD ARITHMETIC ────────────────────────────────────────────────────
   A period that has not finished cannot be compared with four that have, and
   the first version of every dashboard that has ever shown a week-on-week
   arrow has told everybody they are down on a Tuesday morning. The current
   period is carried, labelled partial, with the days it has actually had — and
   it is given no verdict at all. That is the house rule from
   api/performer_routes.js: "THE WEEK IS A COMPLETE WEEK."

   Dubai dates throughout. The +04:00 arithmetic is src/util.js's job on the
   collector side; these operate on the YYYY-MM-DD strings the SQL above
   already emitted in Dubai time, so there is no second timezone here to get
   wrong. Noon UTC for every intermediate Date, because these values have days
   added to them and are then read back as calendar dates. */
const atNoon = (iso) => new Date(`${iso}T12:00:00Z`);
const isoOf = (d) => d.toISOString().slice(0, 10);

export function periodEnd(grain, startIso) {
  const d = atNoon(startIso);
  if (grain === 'month') {
    return isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
  }
  return isoOf(new Date(d.getTime() + 6 * 864e5));
}

export function periodStart(grain, dayIso) {
  const d = atNoon(dayIso);
  if (grain === 'month') return isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12)));
  const dow = (d.getUTCDay() + 6) % 7;                       // 0 = Monday
  return isoOf(new Date(d.getTime() - dow * 864e5));
}

/** The `count` period starts ending at and including the one `todayIso` is in,
    oldest first. The current one is included so the page can show it as the
    partial period it is rather than silently starting a week behind. */
export function periodSeries(grain, todayIso, count) {
  const out = [];
  let cur = periodStart(grain, todayIso);
  for (let i = 0; i < count; i++) {
    out.unshift(cur);
    const prevDay = isoOf(new Date(atNoon(cur).getTime() - 864e5));
    cur = periodStart(grain, prevDay);
  }
  return out;
}

/** How much of a period has happened, as of a Dubai date. */
export function periodProgress(grain, startIso, todayIso) {
  const end = periodEnd(grain, startIso);
  const total = Math.round((atNoon(end) - atNoon(startIso)) / 864e5) + 1;
  if (todayIso > end) return { complete: true, elapsed_days: total, total_days: total };
  if (todayIso < startIso) return { complete: false, elapsed_days: 0, total_days: total };
  return {
    complete: false,
    elapsed_days: Math.round((atNoon(todayIso) - atNoon(startIso)) / 864e5) + 1,
    total_days: total,
  };
}

/* WHERE DOES THIS PERIOD SIT AMONG THE PERSON'S OWN RECENT ONES?
   ─────────────────────────────────────────────────────────────────────────
   A rank of the current period against its own baseline, and it assumes
   nothing about a distribution. It exists for trip value, which surprise()
   above cannot honestly judge: that function floors its spread at sqrt of the
   expected value, which is the arrival spread of a COUNT and means nothing
   applied to a sum of money — the square root of four thousand dirhams is not
   a quantity. With four baseline periods a sample standard deviation of money
   has three degrees of freedom and is itself mostly noise, so rather than
   dress that up as a z, the page says the true and checkable thing: this week
   was above all four of the last four, or inside them, or below all four.

   "Above all of the last four" happens by chance one time in five when nothing
   has changed, and the page says so rather than implying a discovery. */
export function band(value, baselineValues = []) {
  /* value == null, not Number.isFinite(Number(value)). Number(null) is 0 and 0
     is perfectly finite, so a driver with NO trip value on record — every
     completed trip still unpriced, which is a real and common state — was
     placed BELOW all four of their baseline periods and the page would have
     told them their earnings had collapsed. Absent is not zero: it is the one
     rule this product exists to hold. */
  const v = value == null || value === '' ? NaN : Number(value);
  const vals = baselineValues.map(Number).filter(Number.isFinite);
  if (!Number.isFinite(v) || vals.length < 2) {
    return { where: null, n: vals.length, min: null, max: null,
      why: vals.length ? 'too few earlier periods to place this one against' : 'no earlier periods' };
  }
  const min = Math.min(...vals); const max = Math.max(...vals);
  return {
    where: v > max ? 'above' : v < min ? 'below' : 'within',
    n: vals.length,
    min,
    max,
    /* One in 2^n that a genuinely unchanged quantity lands above all n, and
       the same below — carried so the sentence can be honest about how often
       this happens for no reason at all. */
    by_chance: 1 / (vals.length + 1),
  };
}
