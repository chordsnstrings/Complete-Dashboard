/* Which days the SAFETY ALERT FEED actually covered, and the rate you are
   allowed to compute over them.
   ─────────────────────────────────────────────────────────────────────────
   alerts per 100 km is the product's headline safety figure, and until this
   module existed it improved every time a reader widened the range. Measured
   on production 2026-09-02, /api/kpis:

       days=7    trips  3,872   alerts  40,286   km  47,590   ->  84.7
       days=16   trips  8,022   alerts  69,338   km  99,538   ->  69.7
       days=30   trips 13,437   alerts  69,338   km 166,923   ->  41.5
       days=90   trips 33,432   alerts 373,951   km 401,880   ->  93.1

   The alert count is IDENTICAL at 16 and 30 days while distance rises 68%, so
   the rate halves. The cause is a 73-day hole in the alert feed, 2026-06-06 to
   2026-08-17 (/api/coverage, dataset_calendar.alerts: days_with_data 30,
   missing_days 73). Days 17 to 30 back from 2026-09-02 land inside it and
   contribute distance and no alerts. At 90 days the window reaches back past
   the hole to a stretch the feed did cover, so it doubles again — non-
   monotonic, and an operator widening the range watched fleet safety appear to
   improve by two thirds.

   Backfilling the hole moves those numbers and fixes nothing: the next feed
   outage reproduces it exactly. The bug is the arithmetic, which divided a
   16-day numerator by a 30-day denominator.

   ── The rule ────────────────────────────────────────────────────────────
   A ratio of alerts to distance may only be measured over the days the alert
   feed covered. Distance from a day the feed was dark belongs in NEITHER half
   of the ratio: not in the denominator, where it deflates the rate, and not in
   the numerator, where it cannot be — there is nothing there.

   A day is COVERED when the alert feed produced at least one row on it. That
   is an assumption, not a measurement, and it is stated in every response this
   module touches (`alert_coverage.rule`) because a quieter feed would break
   it: on a feed running a median 4,248 rows a day a day with none is a dead
   feed rather than a calm one, but a fleet of six cars could have a genuinely
   quiet Friday and this rule would silently drop it. It is the same rule
   /api/coverage already applies to decide days_with_data, so the safety pages
   and the coverage page cannot disagree about which days exist.

   What it does NOT catch, and should be said plainly: a PARTIAL outage. A day
   the feed answered with three rows instead of its usual few thousand passes
   this test and deflates the rate exactly the way a dark day did, only less.
   Catching that needs a threshold against the feed's own median — a real
   improvement, and a different decision, because a threshold can also throw
   away a genuinely quiet public holiday. The rule here is the conservative
   one: it only ever discards days the feed said nothing at all on.

   ── Why a day SET and not a narrowed window ─────────────────────────────
   The production hole sits in the MIDDLE of a 90-day window, so the covered
   days are not a contiguous sub-range and no from/to pair can express them.
   Every consumer therefore gets an array of Dubai calendar dates and filters
   with `= ANY($n::date[])` — see `coveredDays` below for the fragment.

   ── Why coverage is FLEET-WIDE and never per entity ─────────────────────
   Coverage answers "was the feed running", which is a property of the feed and
   not of a car or a person. Computed per plate it would read every well-driven
   car's quiet day as an outage and drop the distance that proves it was well
   driven — the exact inverse of the bug. When a caller narrows to one fleet
   the coverage is narrowed with it, because the FMS credential is per fleet
   and one fleet's outage is not the other's; the fleet it was measured for
   travels back on the response. */

/* The assumption, in the words the pages print. Exported so a page quotes the
   rule rather than paraphrasing it. */
export const ALERT_COVERED_DAY_RULE =
  'a day counts as covered when the alert feed produced at least one row on it; '
  + 'on a feed running thousands of rows a day, a day with none is an outage rather than a calm day';

const DAY_MS = 864e5;
const parseDay = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
/* toISOString, never String(date): String(new Date(...)) gives
   "Thu Aug 07 2026", which is not a date this product can bind or compare. */
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const spanDays = (from, to) => Math.max(0,
  Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1);

/**
 * Fold a list of days the feed produced rows on into the coverage record every
 * consumer carries. Pure, so a test can build one without a database.
 *
 * @param days  ['YYYY-MM-DD', ...] — days inside [from, to] with >= 1 alert row
 */
export function alertCoverageOf(days, from, to, { fleet = null } = {}) {
  const windowDays = spanDays(from, to);
  const covered = [...new Set((days || []).map((d) => String(d).slice(0, 10)))]
    .filter((d) => d >= from && d <= to).sort();
  const measured = covered.length > 0;

  /* The DARK runs inside the window, so a page can name the outage rather than
     only counting it. Runs are found across the whole window, not only between
     the first and last covered day: a window whose leading fortnight is dark is
     as unmeasured as one with a hole in the middle, and /api/coverage's
     span-only rule is right there for a different question (a feed that has no
     history is not a feed with a hole). Here the window is the question. */
  const seen = new Set(covered);
  const gaps = [];
  let run = null;
  for (let t = parseDay(from); t <= parseDay(to); t += DAY_MS) {
    const d = isoDay(t);
    if (seen.has(d)) { if (run) { gaps.push(run); run = null; } }
    else if (run) { run.to = d; run.days += 1; }
    else run = { from: d, to: d, days: 1 };
  }
  if (run) gaps.push(run);

  return {
    from, to, fleet,
    window_days: windowDays,
    covered_days: covered.length,
    uncovered_days: windowDays - covered.length,
    /* The set itself, because the covered days are not a range and a caller
       checking the arithmetic needs to know which ones they were. */
    days: covered,
    first_covered: covered[0] ?? null,
    last_covered: covered[covered.length - 1] ?? null,
    gaps: gaps.sort((a, b) => b.days - a.days).slice(0, 20),
    complete: measured && covered.length === windowDays,
    /* False means NOT MEASURED, and a page must render it as those words. A
       window the feed was dark for the whole of has no safety rate — it does
       not have a rate of zero, and it does not have a silent null. */
    measured,
    rule: ALERT_COVERED_DAY_RULE,
    basis: !measured
      ? `not measured — the alert feed produced nothing in these ${windowDays} days`
      : covered.length === windowDays
        ? `measured over all ${windowDays} day${windowDays === 1 ? '' : 's'} in this window`
        : `measured over ${covered.length} of the ${windowDays} days in this window`,
  };
}

/**
 * Ask the database which days the feed covered.
 *
 * @param q      the route's query helper
 * @param from   'YYYY-MM-DD' Dubai calendar day
 * @param to     'YYYY-MM-DD' Dubai calendar day
 * @param fleet  narrow to one fleet's feed, or null for the whole record
 */
export async function alertCoverage(q, from, to, { fleet = null } = {}) {
  /* to_char rather than a bare date column: node-postgres hands a `date` back
     as a JS Date in the server's zone, and formatting one of those later is
     how a Dubai day becomes the day before. The string is the value. */
  const rows = await q(
    `SELECT to_char((occurred_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day
       FROM alert
      WHERE occurred_at IS NOT NULL
        AND (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR fleet_id = $3)
      GROUP BY 1 ORDER BY 1`,
    [from, to, fleet]);
  return alertCoverageOf(rows.map((r) => r.day), from, to, { fleet });
}

/* The predicate every denominator narrows itself with. An empty day set binds
   as an empty array and matches nothing, which is the correct answer for a
   window the feed never covered: no distance, and therefore no rate. */
export const coveredDays = (col, n) => `${col} = ANY($${n}::date[])`;

/* ── a tracker losing power is not a driving style ────────────────────────
   The alert feed carries five types. Four of them are things a driver did:
   Sharp Turn, Harsh Brake, Harsh Acceleration, OverSpeed. The fifth, Main
   Power Lost, is the box on the car complaining about its own wiring.

   api/public/app.js already separates them on the #safety donuts, with the
   comment "charted together they were one number under a heading about harsh
   driving". Every RANKING went on using the total. Measured on production over
   the whole alert record: L26356 is 42.6% device fault and its rate falls from
   530 to 304 per 100 km once the box leaves the numerator; L85082 687 -> 412;
   L86970 344 -> 205. The people move too — the driver #safety named hardest
   goes from 311 to 187 and out of the top three.

   And the worst case is the opposite one. L38439 (56 alerts over 3,900 km) and
   L39421 (23 over 518 km) are 100% device fault. They have no driving
   measurement AT ALL, and the page ranked them as the two cleanest cars in the
   fleet. That is why the driving count is carried separately rather than
   simply subtracted: a plate with alerts and no driving events must render as
   unmeasured, because the fix for a misleading low number is not a different
   low number.

   Matched on the type string, with the same words the client-side classifier
   uses, so the two cannot disagree about what a device fault is. A type this
   pattern has never seen counts as driving — the safe direction, since an
   unrecognised type is far more likely to be a new behaviour event than a new
   hardware fault, and a device fault wrongly counted as driving inflates one
   car's rate while the reverse silently exonerates it. */
export const DEVICE_FAULT_WORDS = ['power', 'battery', 'tamper', 'disconnect', 'gps'];
const RE = new RegExp(DEVICE_FAULT_WORDS.join('|'), 'i');

/** SQL: true for an alert that is the hardware complaining about itself. */
export const DEVICE_FAULT_SQL = (col = 'alert_type') =>
  `${col} ~* '${DEVICE_FAULT_WORDS.join('|')}'`;
/** SQL: true for an alert that is something a driver did. NULL counts as driving. */
export const DRIVING_EVENT_SQL = (col = 'alert_type') =>
  `(${col} IS NULL OR ${col} !~* '${DEVICE_FAULT_WORDS.join('|')}')`;
/** The same test in JS, for rows already fetched. */
export const isDeviceFault = (t) => RE.test(String(t == null ? '' : t));

/** A count expression for the driving half, for a SELECT list. */
export const drivingCount = (col = 'alert_type') =>
  `count(*) FILTER (WHERE ${DRIVING_EVENT_SQL(col)})::int`;
/** And for the hardware half, so a page can say why a rate is absent. */
export const deviceCount = (col = 'alert_type') =>
  `count(*) FILTER (WHERE ${DEVICE_FAULT_SQL(col)})::int`;

/**
 * alerts per 100 km, over the covered days only.
 *
 * Both arguments must already be restricted to `cov.days` — the numerator is
 * restricted by construction (there are no alerts on a day with no alerts) and
 * the denominator has to be narrowed by its caller's own query, because every
 * call site measures distance from a different table.
 *
 * Null, never 0, when it cannot be measured: absence renders as an em-dash
 * with a reason, and a zero here would read as a perfect safety record.
 */
export function alertRate(alerts, km, cov, digits = 1, { device = 0 } = {}) {
  if (!cov || !cov.measured) return null;
  const d = Number(km);
  if (!(d > 0)) return null;
  /* Every alert on this vehicle is the box complaining about its own power.
     There is no driving measurement here, and 0.0 would rank it as the safest
     car in the fleet — which is exactly what production did with L38439 and
     L39421. Absent, with a reason, the same as any other unmeasured rate. */
  if (!(Number(alerts) > 0) && Number(device) > 0) return null;
  return +(((Number(alerts) || 0) * 100) / d).toFixed(digits);
}

/** Why the rate is absent, in the words a page prints beside the em-dash. */
export function alertRateReason(km, cov, { alerts = null, device = 0 } = {}) {
  if (!cov || !cov.measured) {
    return 'not measured — the alert feed covered none of the days in this window';
  }
  if (!(Number(km) > 0)) {
    return 'no distance was measured on the days the alert feed covered';
  }
  /* Said in full, because "no driving events" alone reads as a clean record
     and this is the opposite: the box reported, and everything it reported was
     about itself. */
  if (alerts != null && !(Number(alerts) > 0) && Number(device) > 0) {
    return `not measured — all ${Number(device)} alerts on this vehicle are the tracker `
      + 'reporting its own power loss, so nothing here measures driving';
  }
  return null;
}
