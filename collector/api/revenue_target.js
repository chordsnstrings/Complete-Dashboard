/* THE MONTHLY REVENUE TARGET — one gross figure for both fleets, shared over
   the cars that work, and re-spread every morning.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-02:
     "Every month, the admin will set a specific revenue target. the first page
      will show how much every day we need to earn and yesterday were we over
      or under … The revenue target will be gross income (before the platform
      commissions) and it will automatically change the rest of the days
      target if one day it has not been met … 10 vehicles mean each car needs
      to make 10AED to reach the target. In the middle of the month if 5 more
      cars get activated that means the target changes, and instead of 100 per
      day, then it would be 150 per day, and accordingly the initial month's
      target will change too."
   and, asked the same day: ONE target for both fleets; a car counts when it
   EARNED in the last 7 days; the month is split EQUALLY over its days; a day
   OVER target lowers the rest exactly as a day under raises it; the trips
   target is the 08:00 email's minimum per ACTIVE driver (raised to 12); and
   3,000 over 30 days at 10 cars becomes 3,800 when 5 cars join on day 15 —
   a car owes only the days it is in the fleet.

   THE ARITHMETIC, in the words the page uses.
     · AED A CAR A DAY (the rate) is fixed when the target is saved:
         rate = target ÷ (days in the month × cars that earned in the 7 days
         before the save). 1,705,000 ÷ (31 × 101) = 544.55.
     · A day's PLAN is rate × the cars that earned in the 7 days before it. A
       car that joins adds rate × the days left; one that has not earned for a
       week takes them away. The MONTH TARGET is the sum of the plans: 3,000
       becomes 3,800 in the example above, and nobody re-types anything.
     · What a day NEEDS is its plan + the shortfall so far ÷ the days left
       (that day included). A shortfall raises every remaining day evenly and
       a surplus lowers them the same way; never below zero.
     · The days of the month before the FIRST save are planned at the cars
       counted at that save, so the month target reads exactly what was typed
       the moment it is saved. A LATER save keeps every day already gone at
       the plan it had and re-spreads only what is left: editing the target
       never re-scores history, and a day is judged against what it was asked.

   WHAT COUNTS AS EARNED: FARES — the price on every booking, before any
   platform commission: api/income_sql.js platformFares' sum, the figure
   /api/day prints as the day's fares (AED 52,103.03 for 1 October 2026).
   Never "money in", which carries Uber net of its 25% commission.

   A CAR THAT EARNED: a plate on a booking that carries a fare above zero.
   An ACTIVE DRIVER: src/low_trips_email.js's own rule — a completed trip in
   the 8 Dubai days up to and including the day — so this page and the 08:00
   email can never disagree about who is active (test/revenue_target pins it).

   THE TRIPS MINIMUM, the second chart. The operator, the same day, once the
   revenue chart was built: "There should also be a minimum 12 trips per day
   per active driver. there should be a similar chart for that too." A day
   asks every driver active on it for the minimum (the Access page's
   low_trips_min, the 08:00 email's): it is OVER when the fleet's completed
   trips reach active drivers × the minimum. A FLOOR, not a quota — a day
   short is not carried into the next, because a minimum a day has nothing to
   re-spread; each morning starts at the minimum again. It is judged by the
   same settled rule as the revenue (a channel that has not delivered the day
   may still hold its trips), and it is there whether or not a revenue target
   is set: the minimum always exists.

   SHARED BY WEEKDAY, FROM 2026-10-11 (api/target_weights.js). The operator:
   "A historically bad day on a Sunday can't be expected to perform the same
   way as weekday." The equal split above stands for the saves made under it;
   every save since carries seven weekday weights learned from the fleet's
   own last 8 weeks (Sun 0.78 … Thu 1.13 of an average day, measured that
   morning), and then:
     · AED A CAR A DAY is the AED a car on an AVERAGE day; a day's PLAN is
       rate × its cars × its weekday's weight. The rate is fixed so the plans
       of the days it spreads over add up to what was typed, whatever mix of
       weekdays they are: target ÷ (cars × the sum of their weights).
     · A SHORTFALL is caught up over the days left IN THE SAME PROPORTIONS: a
       day needs its plan + the shortfall × its weight ÷ the weights of the
       days left (it included). With every weight 1 that is the even spread
       above, exactly.
     · The TRIPS MINIMUM is the minimum on an average day; a day asks
       round(minimum × its weekday's trips weight) of each active driver
       (minimumOn) — at 12, a Sunday 10 and a Thursday 14.
     · The month in progress when the rule arrived was re-shaped once, by a
       recorded system save that keeps its month target, its rate and every
       day already gone exactly as they were (applyWeightCutover).

   A FIGURE THAT CANNOT BE MEASURED IS ABSENT WITH ITS REASON. A day is judged
   only once it is SETTLED: every booking channel that has been collecting
   delivered it (a run whose window COVERS the day and that finished after the
   day ended — docs/COVERAGE.md trap 41), and 99% of its chargeable bookings
   carry a fare (src/monthly_report.js READY_COVERAGE). Uber publishes a
   day's fares hours after the rides (fetched hourly), so TODAY is never judged. An unsettled day that has ALREADY
   beaten what it needed is over whatever arrives later, and says "at least";
   one still short says what it is waiting for.

   BY VEHICLE CLASS, FROM 2026-10-29 (sql/schema_v111.sql class_target). The
   operator: "Let me set targets vehicle wise. Make model year - per day
   target, which will reflect everywhere." One rate for every car asked a
   Highlander and a Lexus ES the same, and a fleet that is 42 BYD Han EVs and
   36 Model Ys (the 104 cars counted that morning, eight classes, every one
   with its make, model and year on file) does not earn that way. So:
     · The Owner sets AED A CAR ON AN AVERAGE DAY for each make + model +
       year, and one figure for EVERY OTHER CAR — a class given no figure, or
       a plate with no make or model on file (133 of the 273 on the register
       that day, none of them earning). The weekday weights still apply, as
       the operator ruled on 2026-10-11: the figure is an average day's.
     · A day's PLAN is the sum, over the cars counted on it, of each car's
       class rate × the day's weekday weight. Under one rate for every car
       that is rate × cars × weight — the rule above, to the fils — so the
       days saved before the classes keep every figure they were judged on.
     · A class save is a SAVE like any other: a new row, never edited,
       governing from the Dubai day it was made. It does not end with its
       month: it governs every later month until the next save (the rates are
       a car's, not a month's), and a month it carries into shares its days
       by that month's own weekday weights, frozen on its 1st
       (api/target_weights.js monthWeights), not by the weeks before a save
       made months ago. A later save of either kind wins from its own day.
     · There is no typed month figure under it: the MONTH TARGET is the sum
       of the plans, and it floats with the cars exactly as before.
     · A DRIVER'S SHARE of a day (api/target_month.js, api/lowperf.js) is the
       day's plan shared in proportion to the class rate of the car each
       active driver drove that day — on a day off, the car they last drove
       in the 8-day window that makes them active. The shares still add up
       to the day's plan; under one rate for every car they are equal, as
       they always were. */
import { personKeyStored } from './custody_sql.js';
import { dubaiDay } from './window.js';
import { getConfig, setConfig } from './access/service.js';
import { appendAudit } from './access/audit.js';
import { TRIP_RUN_SQL } from './run_kinds.js';
import { learnWeights, monthWeights, minimumOn, weightOf, dowOf } from './target_weights.js';

/* The booking channels whose collection decides whether a day is complete.
   The FMS tracker's journeys are in `trip` too, and are not bookings. */
export const BOOKING_SOURCES = ['uber', 'bolt', 'yango', 'hotel'];
/* A car is active on a day when it earned in the 7 days before it. */
export const CAR_DAYS = 7;
/* src/low_trips_email.js ACTIVE_DAYS: the day itself and the 7 before it. */
export const DRIVER_DAYS = 8;
/* src/monthly_report.js READY_COVERAGE. */
export const SETTLED_COVERAGE = 99;
/* src/low_trips_email.js minTrips(): the Access page's low_trips_min, or 10. */
export const tripsTarget = (cfg) => {
  const n = Number(cfg?.low_trips_min);
  return Number.isInteger(n) && n >= 1 ? n : 10;
};
/* Bigger than any month this fleet has grossed by three orders of magnitude:
   a target above it is a typo, not a plan. */
export const MAX_TARGET = 1e9;

const PLATFORM = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel' };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pairName = (p) => `${PLATFORM[p.source] || cap(p.source)} · ${cap(p.fleet)}`;

/* ── calendar arithmetic on Dubai day strings ────────────────────────────── */
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const daysIn = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const monthOf = (day) => day.slice(0, 7);
export const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
export const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))
  && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && addDays(d, 0) === d;
/* "Thu 1 Oct" — how the page names a day. Spelled out rather than asked of
   Intl: Node's en-GB writes September "Sept", and the trip message, the
   emails and the pages all write "Sep". */
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  return `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`;
};
export const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB',
  { month: 'long', year: 'numeric', timeZone: 'UTC' });
/* The moment a Dubai day ends (Dubai keeps UTC+4 all year). */
const endOfDay = (d) => Date.parse(`${addDays(d, 1)}T00:00:00+04:00`);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/* ── what the database holds, for a span of days ─────────────────────────── */
/* Four reads over the span, each grouped by day, and nothing else: the
   arithmetic below is plain JavaScript over these, so a test can hand it a
   fleet of ten cars without a database. */
export async function loadFacts(q, from, to) {
  const [days, cars, people, runs] = await Promise.all([
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
              coalesce(round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2), 0)::float AS fares,
              count(*) FILTER (WHERE n.has_fare)::int AS priced,
              count(*) FILTER (WHERE n.outcome = 'completed' OR n.has_fare)::int AS chargeable,
              count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed,
              count(*)::int AS bookings
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
        GROUP BY 1`, [from, to]),
    /* Each plate's fares on each day, and whether it EARNED (a fare above
       zero) — the same rows the DISTINCT read gave, plus their sum, so a
       vehicle class's earnings come from the read that already counts its
       cars. */
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, btrim(n.plate) AS plate,
              coalesce(round(sum(n.price)::numeric, 2), 0)::float AS fares,
              bool_or(n.price > 0) AS earned
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
          AND n.has_fare AND coalesce(btrim(n.plate), '') <> ''
        GROUP BY 1, 2`, [from, to]),
    /* One person, one row — the stored fold of api/custody_sql.js, the same
       answer the 08:00 email's personKey() gives and a hundred times cheaper. */
    /* …and the car each person drove most that day, which a class rate asks
       their share of the day by (driverShares). */
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, ${personKeyStored('t')} AS pk, count(*)::int AS trips,
              mode() WITHIN GROUP (ORDER BY nullif(btrim(n.plate), '')) AS plate
         FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
          AND n.outcome = 'completed' AND n.driver_name IS NOT NULL
        GROUP BY 1, 2`, [from, to]),
    q(`SELECT source, fleet_id AS fleet, to_char(window_start, 'YYYY-MM-DD') AS ws,
              to_char(window_end, 'YYYY-MM-DD') AS we, max(finished_at) AS fin
         FROM collection_run
        WHERE source = ANY($3::text[]) AND fleet_id IS NOT NULL AND status IN ('ok', 'partial')
          AND ${TRIP_RUN_SQL}
          AND finished_at >= $1::date - 14 AND window_end >= $1::date - 1 AND window_start <= $2::date
        GROUP BY 1, 2, 3, 4`, [from, to, BOOKING_SOURCES]),
  ]);
  const byDay = new Map(days.map((r) => [r.day, r]));
  const carDays = new Map();
  const plateFares = new Map();
  for (const r of cars) {
    if (!plateFares.has(r.day)) plateFares.set(r.day, new Map());
    plateFares.get(r.day).set(r.plate, Number(r.fares) || 0);
    if (!r.earned) continue;
    if (!carDays.has(r.day)) carDays.set(r.day, new Set());
    carDays.get(r.day).add(r.plate);
  }
  const personDays = new Map();
  const personCar = new Map();
  for (const r of people) {
    if (!personDays.has(r.day)) personDays.set(r.day, new Map());
    personDays.get(r.day).set(r.pk, r.trips);
    if (r.plate) {
      if (!personCar.has(r.day)) personCar.set(r.day, new Map());
      personCar.get(r.day).set(r.pk, r.plate);
    }
  }
  return {
    from, to, days: byDay, carDays, personDays, plateFares, personCar,
    runs: runs.map((r) => ({ source: r.source, fleet: r.fleet, ws: r.ws, we: r.we, fin: new Date(r.fin).getTime() })),
  };
}

/* Distinct members of the per-day sets over [a, b], days inclusive. */
const unionOver = (map, a, b) => {
  const out = new Set();
  for (let d = a; d <= b; d = addDays(d, 1)) for (const x of (map.get(d)?.keys?.() || map.get(d) || [])) out.add(x);
  return out;
};
/** The cars that earned in the CAR_DAYS days before `day`. */
export const carsAsOf = (facts, day) => unionOver(facts.carDays, addDays(day, -CAR_DAYS), addDays(day, -1));
/** The drivers active on `day`: a completed trip in the 8 days to and including it. */
export const driversActiveOn = (facts, day) => unionOver(facts.personDays, addDays(day, -(DRIVER_DAYS - 1)), day);

/** Whether a day is complete enough to be judged, and if not, why not. */
export function settledness(facts, day) {
  /* The channels expected to deliver it: every one that has collected at
     all in the 14 days before it (src/daily_report.js channelsCollected). */
  const since = endOfDay(day) - 15 * 864e5;
  const expected = new Map();
  for (const r of facts.runs) if (r.fin >= since) expected.set(`${r.source}:${r.fleet}`, r);
  const missing = [];
  for (const [key, p] of expected) {
    const ok = facts.runs.some((r) => `${r.source}:${r.fleet}` === key
      && r.ws <= day && r.we >= day && r.fin >= endOfDay(day));
    if (!ok) missing.push({ source: p.source, fleet: p.fleet });
  }
  const f = facts.days.get(day);
  const coverage = f && f.chargeable ? (100 * f.priced) / f.chargeable : 100;
  const why = [];
  if (missing.length) {
    why.push(`${missing.map(pairName).join(', ')} ${missing.length === 1 ? 'has' : 'have'} not delivered `
      + `${shortDay(day)} yet`);
  }
  if (coverage < SETTLED_COVERAGE) {
    why.push(`only ${(Math.floor(coverage * 10) / 10).toFixed(1)}% of ${shortDay(day)}’s bookings carry a fare yet `
      + '— Uber publishes fares hours after the ride, sometimes most of a day later, and they are fetched every hour');
  }
  return { settled: !why.length, missing, coverage: r2(coverage), why: why.length ? `${cap(why.join('; '))}.` : null };
}

const jsonOf = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
/* Where a save's weights came from, as a page may show it: the weeks, the
   weeks used and left out (with why), or why there are none — never the
   re-shape's own bookkeeping, which holds car counts and money. */
export const publicBasis = (b) => (b ? {
  weeks: b.weeks ?? null, used: b.used ?? null, from: b.from ?? null, to: b.to ?? null, before: b.before ?? null,
  skipped: Array.isArray(b.skipped) ? b.skipped.map((k) => ({ mon: k.mon, sun: k.sun, day: k.day, why: k.why })) : [],
  why: b.why ?? null, cutover: !!b.cutover,
} : null);
const normRow = (r) => {
  const w = jsonOf(r.weights);
  return {
    id: Number(r.id),
    gross: Number(r.gross_target),
    cars: Number(r.cars),
    rate: Number(r.rate),
    past_plan: Number(r.past_plan || 0),
    set_day: typeof r.set_day === 'string' ? r.set_day.slice(0, 10) : dubaiDay(new Date(r.set_day)),
    set_at: new Date(r.set_at).toISOString(),
    set_by: r.set_by == null ? null : Number(r.set_by),
    set_by_label: r.set_by_label || '',
    /* Seven weekday weights (index 0 Sunday), or null: a save made before
       2026-10-11 shares its days equally, as it always did. */
    weights: Array.isArray(w) && w.length === 7 ? w.map(Number) : null,
    weights_basis: jsonOf(r.weights_basis),
  };
};
const bySave = (a, b) => (a.set_at < b.set_at ? -1 : a.set_at > b.set_at ? 1 : a.id - b.id);

/* ── vehicle classes (sql/schema_v111.sql) ───────────────────────────────── */
/* A car's class is its make + model + year as the vehicle register spells
   them — coalesce(vehicle, vehicle_plate), the pair every vehicle page reads
   (api/vehicle_routes.js /api/vehicle/profile). Keyed case- and
   space-insensitively, so "Model Y" from one channel and "MODEL Y" from
   another are one class; shown as the register spells it. A plate with no
   make or model has no class. One with no year is its own class, named so:
   a year the register does not hold is not invented. */
const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
export const classKey = (make, model, year) => `${norm(make).toLowerCase()}|${norm(model).toLowerCase()}|${year == null || year === '' ? '' : Number(year)}`;
export const classLabel = (c) => `${norm(c.make)} ${norm(c.model)}${c.year == null || c.year === '' ? ' (year not on file)' : ` ${c.year}`}`;
/* A day rate above this is a typo, not a plan: the best class earned under
   AED 500 a car on an average day when this was written. */
export const MAX_CLASS_RATE = 100000;

/** plate → {key, make, model, year, label} for every plate the register
    gives a make and model. */
export async function loadClasses(q) {
  const rows = await q(
    `SELECT p.plate, coalesce(v.make, vp.make) AS make, coalesce(v.model, vp.model) AS model,
            coalesce(v.year, vp.year) AS year
       FROM (SELECT plate FROM vehicle UNION SELECT plate FROM vehicle_plate) p
       LEFT JOIN vehicle v ON v.plate = p.plate
       LEFT JOIN vehicle_plate vp ON vp.plate = p.plate`);
  const out = new Map();
  for (const r of rows) {
    if (!norm(r.make) || !norm(r.model)) continue;
    const c = { make: norm(r.make), model: norm(r.model), year: r.year == null ? null : Number(r.year) };
    out.set(String(r.plate).trim(), { ...c, key: classKey(c.make, c.model, c.year), label: classLabel(c) });
  }
  return out;
}

/* The two rows of a month's class breakdown that are not a class. */
const NO_CLASS = '\u0000none';
const NO_PLATE = '\u0000plate';
/** AED a car on an average day `save` asks of a class (null key: a car with
    no make or model on file). */
const classRateOf = (save, key) => (!save ? null : save.kind !== 'class' ? save.rate
  : key != null && save.rateBy.has(key) ? save.rateBy.get(key) : save.other);
/** A save as a page may show it: a class save's rates as a list (its Map is
    the arithmetic's), a month save as it always was. */
const publicSave = (x, first) => (x.kind === 'class' ? {
  kind: 'class', id: x.id, set_day: x.set_day, set_at: x.set_at, set_by: x.set_by, set_by_label: x.set_by_label,
  rates: x.rates.map(({ make, model, year, label, rate }) => ({ make, model, year, label, rate })),
  other_rate: x.other, cars_at_set: x.cars_at_set, weights: x.weights, weights_basis: publicBasis(x.weights_basis),
  carried: x.set_day < first, weights_month: x.weights_month || null,
} : { ...x, weights_basis: publicBasis(x.weights_basis) });
/** The cars a class save counted at the moment it was made. */
const carsAtSave = (x) => (x.cars_at_set || []).reduce((n, c) => n + (Number(c.cars) || 0), 0);

/** Every class save made on or before `upTo`, oldest first. */
export async function classRows(q, upTo) {
  return q(`SELECT id, to_char(set_day, 'YYYY-MM-DD') AS set_day, set_at, set_by, set_by_label,
                   rates, other_rate, cars, weights, weights_basis
              FROM class_target WHERE set_day <= $1::date ORDER BY set_at, id`, [upTo]);
}
export const normClassRow = (r) => {
  const w = jsonOf(r.weights);
  const rates = (jsonOf(r.rates) || []).map((x) => ({ make: norm(x.make), model: norm(x.model),
    year: x.year == null || x.year === '' ? null : Number(x.year), rate: Number(x.rate) }))
    .map((x) => ({ ...x, key: classKey(x.make, x.model, x.year), label: classLabel(x) }));
  return {
    kind: 'class',
    id: Number(r.id),
    set_day: typeof r.set_day === 'string' ? r.set_day.slice(0, 10) : dubaiDay(new Date(r.set_day)),
    set_at: new Date(r.set_at).toISOString(),
    set_by: r.set_by == null ? null : Number(r.set_by),
    set_by_label: r.set_by_label || '',
    rates,
    rateBy: new Map(rates.map((x) => [x.key, x.rate])),
    other: Number(r.other_rate),
    cars_at_set: jsonOf(r.cars) || [],
    weights: Array.isArray(w) && w.length === 7 ? w.map(Number) : null,
    weights_basis: jsonOf(r.weights_basis),
  };
};
/** AED a car on an average day that `save` asks of `plate`: one figure for
    every car under a month save; under a class save, the car's class's
    figure, or the figure for every other car. */
export const rateOf = (save, plate, classOf) => {
  if (!save) return null;
  if (save.kind !== 'class') return save.rate;
  const c = plate ? classOf?.get(plate) : null;
  const r = c ? save.rateBy.get(c.key) : undefined;
  return r ?? save.other;
};
/** The car a person is asked their share by on `day`: the one they drove
    most that day; on a day they did not drive, the one they last drove in
    the window that makes them active (driversActiveOn). */
export function carOf(facts, pk, day) {
  for (let i = 0; i < DRIVER_DAYS; i++) {
    const p = facts.personCar?.get(addDays(day, -i))?.get(pk);
    if (p) return p;
  }
  return null;
}
/** Pure. Each active driver's share of a day's plan: equal under one rate
    for every car — plan ÷ drivers, exactly as before the classes — and
    under a class save in proportion to the class rate of the car each one
    drove (carOf), so the shares still add up to the plan. A driver whose
    car cannot be named is asked by the figure for every other car. */
export function driverShares(t, facts, day, plan, active) {
  const out = new Map();
  if (plan == null || !active || !active.size) return out;
  const save = t?.saveOn?.get(day) || null;
  if (!save || save.kind !== 'class') {
    for (const pk of active) out.set(pk, plan / active.size);
    return out;
  }
  const r = new Map();
  let sum = 0;
  for (const pk of active) {
    const x = rateOf(save, carOf(facts, pk, day), t.classOf);
    r.set(pk, x);
    sum += x;
  }
  for (const pk of active) out.set(pk, sum > 0 ? (plan * r.get(pk)) / sum : plan / active.size);
  return out;
}

/* ── the month, day by day ───────────────────────────────────────────────── */
/** Pure: the month's plan, needs and verdicts from the saves and the facts.
    `today` is the Dubai day the page is speaking on; `min` the trips an
    active driver is asked for on an average day; `mw` the month's weekday
    weights for that minimum (api/target_weights.js monthWeights), or null;
    `classes` the class saves (classRows), `classOf` each plate's class
    (loadClasses). */
export function computeMonth({ month, today, rows = [], facts, min = 10, mw = null, classes = [], classOf = new Map() }) {
  const D = daysIn(month);
  const first = `${month}-01`;
  const last = addDays(first, D - 1);
  /* The class saves that reach this month: every one made in it, and the
     last one made before it — the one in force on its 1st (any earlier one
     is superseded from day one). Class rates share a month's days by the
     month's own weekday weights, frozen on its 1st (api/target_weights.js
     monthWeights) — so a rate saved in October does not ask March to run
     the way August and September did — and by the weights learned at the
     save only when the month has none. */
  const cls = classes.map((r) => (r.kind === 'class' ? r : normClassRow(r))).filter((x) => x.set_day <= last).sort(bySave);
  const carried = cls.filter((x) => x.set_day < first).pop() || null;
  const monthW = Array.isArray(mw?.fares) && mw.fares.length === 7 ? mw.fares.map(Number) : null;
  const shaped = (x) => (monthW ? { ...x, weights: monthW, weights_basis: mw.basis, weights_month: month } : x);
  const saves = [...rows.map(normRow).map((x) => ({ ...x, kind: 'month' })),
    ...(carried ? [shaped(carried)] : []), ...cls.filter((x) => x.set_day >= first).map(shaped)].sort(bySave);
  const nowSet = carsAsOf(facts, today);
  const carsNow = nowSet.size;
  const firstSave = saves.length ? saves[0].set_day : null;
  /* The last save made on the first day anything was saved: what the days
     before it are planned at. A typo corrected ten minutes later must not be
     what 1 October was asked for. */
  const anchor = saves.filter((r) => r.set_day === firstSave).pop() || null;
  const inForce = (d) => {
    let r = null;
    for (const x of saves) if (x.set_day <= d) r = x;
    return r || anchor;
  };

  let shortfall = 0;   // plan − earned over the days already judged
  const days = [];
  /* The plans and needs unrounded: a month total summed from figures already
     rounded to the fils drifts — 27 days at 131.85 is 3,559.95, and the month
     read AED 3,999.95 for a target typed as 4,000. Rounded only to print. */
  const raw = [];
  /* Each day's weekday weight under the save in force for it — 1 under a
     save made before the weights. A day's share of the shortfall is its
     weight ÷ the weights of the days from it to the month's end AS THAT SAME
     SAVE WEIGHS THEM — what it was asked when it was today. Summing the
     later days under the saves in force for THEM (the first build) let a
     later save re-score days already judged: a weighted save on 12 Oct moved
     the need of every day of 1–11 Oct, and a day met to the fils could turn
     "under" (independent review, 2026-10-11). All 1, a share is 1 ÷ the days
     left: the even spread, exactly as before. */
  const dayAt = Array.from({ length: D }, (_, i) => addDays(first, i));
  const saveAt = dayAt.map((d) => (saves.length ? inForce(d) : null));
  const wOf = dayAt.map((d, i) => weightOf(saveAt[i], d));
  const leftFor = new Map();   // save → the weights of days i..D-1 under it, for every i
  const wLeftUnder = (save) => {
    const key = save || 'none';
    if (!leftFor.has(key)) {
      const a = Array(D + 1).fill(0);
      for (let i = D - 1; i >= 0; i--) a[i] = a[i + 1] + weightOf(save, dayAt[i]);
      leftFor.set(key, a);
    }
    return leftFor.get(key);
  };
  /* Day i's share of a shortfall spread from day `from` on, under the save
     in force on `from`. */
  const shareOf = (i, from) => {
    const s = saveAt[from];
    const left = wLeftUnder(s)[from];
    return left > 0 ? weightOf(s, dayAt[i]) / left : 1 / (D - from);
  };
  /* Each vehicle class's part of the month: its cars, its plan and what its
     plates earned, day by day into one row a class (classBreakdown). */
  const byClass = new Map();
  const yday = addDays(today, -1);
  const part = (plate) => {
    const c = plate ? classOf.get(plate) : null;
    const key = c ? c.key : NO_CLASS;
    if (!byClass.has(key)) {
      byClass.set(key, { key: c ? c.key : null, make: c?.make ?? null, model: c?.model ?? null, year: c?.year ?? null,
        label: c ? c.label : 'No make or model on file', month_plan: 0, planned: 0, earned: 0, plan_today: 0,
        yday_plan: null, yday_earned: null, cars_now: 0, plates: new Set() });
    }
    return byClass.get(key);
  };
  const saveOn = new Map();
  const dayInfo = new Map();
  for (let i = 0; i < D; i++) {
    const day = addDays(first, i);
    const state = day < today ? 'past' : day === today ? 'today' : 'future';
    const save = saves.length ? inForce(day) : null;
    saveOn.set(day, save);
    /* The cars the day counts: on a day before a MONTH save, the cars that
       save was shared over (the anchor rule above); otherwise the day's own
       — today's, for a day to come. */
    const flatAnchor = !!save && save.kind !== 'class' && day < firstSave;
    const set = state === 'future' ? nowSet : carsAsOf(facts, day);
    const cars = flatAnchor ? save.cars : set.size;
    let plan = null;
    if (save && save.kind === 'class') {
      let sum = 0;
      for (const p of set) sum += rateOf(save, p, classOf);
      plan = sum * wOf[i];
    } else if (save) plan = save.rate * cars * wOf[i];
    dayInfo.set(day, { save, flatAnchor, set, w: wOf[i], plan });
    if (plan != null) {
      /* Each car's part of the plan: its class rate × the weight; on an
         anchored day, the plan over the day's own cars evenly — one rate for
         every car is what that save asked. */
      for (const p of set) {
        const v = flatAnchor ? plan / set.size : rateOf(save, p, classOf) * wOf[i];
        const a = part(p);
        a.month_plan += v;
        if (state === 'past') a.planned += v;
        if (state === 'today') a.plan_today += v;
        if (day === yday) a.yday_plan = (a.yday_plan || 0) + v;
      }
    }
    if (state === 'past') {
      let plated = 0;
      for (const [p, fares] of facts.plateFares?.get(day) || []) {
        const a = part(p);
        a.earned += fares;
        a.plates.add(p);
        if (day === yday) a.yday_earned = (a.yday_earned || 0) + fares;
        plated += fares;
      }
      const loose = Number(facts.days.get(day)?.fares || 0) - plated;
      if (Math.abs(loose) >= 0.005) {
        if (!byClass.has(NO_PLATE)) byClass.set(NO_PLATE, { key: null, label: 'Fares with no plate', earned: 0, yday_earned: null, no_plate: true });
        const a = byClass.get(NO_PLATE);
        a.earned += loose;
        if (day === yday) a.yday_earned = (a.yday_earned || 0) + loose;
      }
    }
    const f = facts.days.get(day);
    const earned = state === 'future' ? null : (f ? Number(f.fares) : 0);
    const needed = save && state !== 'future' ? Math.max(0, plan + shortfall * shareOf(i, i)) : null;
    const tmin = minimumOn(min, mw, day);

    raw.push({ plan, needed });
    const row = {
      day, dow: dowOf(day), label: shortDay(day), state,
      /* `rate` is the AED a car THIS day is asked for — the save's rate on
         an average day × this weekday's weight; `weight` that weight. Under
         class rates, the average over the day's cars. */
      cars, rate: !save ? null : save.kind === 'class' ? (cars ? plan / cars : null) : save.rate * wOf[i],
      weight: save ? Math.round(wOf[i] * 1e4) / 1e4 : null,
      plan: r2(plan), needed: r2(needed),
      earned: r2(earned), diff: null, pct: null, verdict: null, provisional: false,
      settled: null, why: null, coverage: null,
      bookings: f ? f.bookings : (state === 'future' ? null : 0),
      trips: null, active_drivers: null, trips_target: null, trips_per_active: null,
      /* The trips this day asks of each active driver (api/target_weights.js
         minimumOn): the minimum on an average day × the weekday's weight. */
      trips_min: tmin.min, trips_weight: tmin.weighted ? tmin.weight : null,
      reached: null, drove: null, trips_verdict: null, trips_diff: null, trips_pct: null,
      trips_provisional: false,
    };
    if (state !== 'future') {
      const ppl = facts.personDays.get(day) || new Map();
      const active = driversActiveOn(facts, day).size;
      const trips = [...ppl.values()].reduce((s, n) => s + n, 0);
      Object.assign(row, {
        trips, active_drivers: active, trips_target: active * tmin.min,
        trips_per_active: active ? r2(trips / active) : null,
        reached: [...ppl.values()].filter((n) => n >= tmin.min).length, drove: ppl.size,
      });
    }
    if (state === 'past') {
      const s = settledness(facts, day);
      Object.assign(row, { settled: s.settled, why: s.why, coverage: s.coverage });
      if (save) {
        row.diff = r2(earned - needed);
        row.pct = needed > 0 ? r2((100 * earned) / needed) : null;
        if (earned >= needed - 0.005) { row.verdict = 'over'; row.provisional = !s.settled; }
        else row.verdict = s.settled ? 'under' : 'unsettled';
        shortfall += plan - earned;
      }
      /* The trips floor: this day's own active drivers × the minimum, and
         nothing carried from the day before. Over before the day settled is
         over "at least", exactly as the revenue says it. */
      if (row.trips_target) {
        row.trips_diff = row.trips - row.trips_target;
        row.trips_pct = r2((100 * row.trips) / row.trips_target);
        if (row.trips >= row.trips_target) { row.trips_verdict = 'over'; row.trips_provisional = !s.settled; }
        else row.trips_verdict = s.settled ? 'under' : 'unsettled';
      }
    }
    days.push(row);
  }

  /* The days to come need their plan plus today's share of the shortfall —
     what each will need if today is exactly met. */
  const t = days.find((x) => x.state === 'today') || null;
  if (saves.length) {
    const ti = t ? days.indexOf(t) : 0;
    days.forEach((x, i) => {
      if (x.state !== 'future') return;
      raw[i].needed = Math.max(0, raw[i].plan + (t ? shortfall * shareOf(i, ti) : 0));
      x.needed = r2(raw[i].needed);
    });
  }

  const past = days.filter((x) => x.state === 'past');
  const latest = saves.length ? saves[saves.length - 1] : null;
  const classed = latest?.kind === 'class';
  /* Under class rates "AED a car on an average day" is the average over
     today's cars: what the classes ask, car for car. */
  let rateNow = latest ? latest.rate : null;
  if (classed) {
    let sum = 0;
    for (const p of nowSet) sum += rateOf(latest, p, classOf);
    rateNow = carsNow ? sum / carsNow : latest.other;
  }
  for (const p of nowSet) part(p).cars_now += 1;
  const tw = t ? t.weight : null;
  const classesOut = [...byClass.values()]
    .filter((a) => a.no_plate || a.cars_now || a.month_plan || Math.abs(a.earned) >= 0.005)
    .map((a) => (a.no_plate ? { key: null, label: a.label, no_plate: true, earned: r2(a.earned), yday_earned: r2(a.yday_earned) } : {
      key: a.key, make: a.make, model: a.model, year: a.year, label: a.label,
      rate: latest ? r2(classRateOf(latest, a.key)) : null,
      uses_other: classed && (a.key == null || !latest.rateBy.has(a.key)),
      today_rate: latest && tw != null ? r2(classRateOf(latest, a.key) * tw) : null,
      cars_now: a.cars_now,
      plan_today: latest && t ? r2(a.plan_today) : null,
      yday_plan: r2(a.yday_plan), yday_earned: r2(a.yday_earned),
      month_plan: latest ? r2(a.month_plan) : null,
      planned: latest ? r2(a.planned) : null,
      earned: r2(a.earned),
      ahead: latest ? r2(a.earned - a.planned) : null,
      pct: latest && a.planned > 0 ? r1((100 * a.earned) / a.planned) : null,
      /* The plates counted with no make or model on file, so the page can
         name them and say why they are asked the figure for every other car. */
      plates: a.key == null ? [...nowSet].filter((p) => !classOf.has(p)).sort().slice(0, 50) : undefined,
    }))
    .sort((x, y) => (x.no_plate ? 1 : 0) - (y.no_plate ? 1 : 0) || (x.key == null ? 1 : 0) - (y.key == null ? 1 : 0)
      || (y.cars_now || 0) - (x.cars_now || 0) || (y.month_plan || 0) - (x.month_plan || 0) || x.label.localeCompare(y.label));
  /* The figure the OWNER typed, and the cars it was typed over: the last save
     that is not the weekday re-shape (applyWeightCutover). The re-shape's own
     row carries what it spreads and the cars it spreads over, so its rate
     and its cars belong together; "set at … over N cars" is the Owner's. */
  const typed = [...saves].reverse().find((x) => x.set_by_label !== 'system:reweight') || latest;
  const sum = (xs, k) => xs.reduce((s, x) => s + (x[k] || 0), 0);
  const rawPlan = (xs) => xs.reduce((s, x) => s + (raw[days.indexOf(x)].plan || 0), 0);
  const monthTargetNow = saves.length ? rawPlan(days) : null;
  const plannedToDate = rawPlan(past);
  const earnedToDate = sum(past, 'earned');
  const paceEnd = !past.length || !saves.length ? null
    : saves[saves.length - 1].weights && plannedToDate > 0
      ? earnedToDate + (earnedToDate / plannedToDate) * Math.max(0, monthTargetNow - plannedToDate)
      : (earnedToDate / past.length) * D;
  const typedClass = typed?.kind === 'class';
  const summary = saves.length ? {
    month_target: r2(monthTargetNow),
    /* Under class rates there is no typed month figure: the month is the sum
       of the plans, and "set at" names the day the rates were saved. */
    gross_set: typedClass ? null : typed.gross,
    rate: classed ? r2(rateNow) : latest.rate,
    /* the cars the rate in force was taken over */
    rate_cars: classed ? carsNow : latest.cars,
    cars_at_set: typedClass ? carsAtSave(typed) : typed.cars,
    cars_now: carsNow,
    since_set: typedClass ? null : r2(monthTargetNow - typed.gross),
    kind: latest.kind,
    other_rate: classed ? latest.other : null,
    rates_set_day: classed ? latest.set_day : null,
    earned: r2(earnedToDate),
    planned: r2(plannedToDate),
    ahead: r2(earnedToDate - plannedToDate),
    to_go: r2(Math.max(0, monthTargetNow - earnedToDate)),
    days_left: t ? D - days.indexOf(t) : (today < first ? D : 0),
    today_needs: t ? t.needed : null,
    today_per_car: t && t.cars ? r2(raw[days.indexOf(t)].needed / t.cars) : null,
    today_cars: t ? t.cars : null,
    /* The weekday weights the days left are shared by (the latest save's),
       where they were learned, and today's — null under a save made before
       them, which shares the month equally. */
    weighted: !!latest.weights,
    weights: latest.weights,
    weights_basis: publicBasis(latest.weights_basis),
    today_weight: t ? t.weight : null,
    met: monthTargetNow > 0 && earnedToDate >= monthTargetNow,
    judged: past.filter((x) => x.verdict === 'over' || x.verdict === 'under').length,
    over: past.filter((x) => x.verdict === 'over').length,
    under: past.filter((x) => x.verdict === 'under').length,
    unsettled: past.filter((x) => x.verdict === 'unsettled').length,
    /* What the month is moving towards (the operator, 2026-10-02: "so that
       they know what their today's target is, and what monthly target is and
       what they are moving towards … a bit more granular with more data"):
       what every day left must bring on average, the average day so far, and
       where the month lands if every day left is like that average. */
    days_gone: past.length,
    per_day_left: t && D - days.indexOf(t) ? r2(Math.max(0, monthTargetNow - earnedToDate) / (D - days.indexOf(t))) : null,
    avg_day: past.length ? r2(earnedToDate / past.length) : null,
    /* Where the month lands at this pace. Shared by weekday, "the average
       day × the days in the month" projects a run of Sundays over a month of
       Thursdays: a month meeting every day's plan exactly read 79.0% on its
       2nd and red (independent review, 2026-10-11). So a weighted month runs
       its days left at the share of plan the days gone brought; equal, the
       average day as before. */
    month_end_pace: past.length ? r2(paceEnd) : null,
    pace_pct: past.length && monthTargetNow ? r2((100 * paceEnd) / monthTargetNow) : null,
    pace_basis: past.length ? (latest.weights ? 'plan' : 'average_day') : null,
    best: past.length ? (({ day, label, earned }) => ({ day, label, earned }))(past.reduce((a, b) => ((b.earned ?? -1) > (a.earned ?? -1) ? b : a))) : null,
    worst: past.length ? (({ day, label, earned }) => ({ day, label, earned }))(past.reduce((a, b) => ((b.earned ?? Infinity) < (a.earned ?? Infinity) ? b : a))) : null,
  } : null;
  /* The trips chart's own summary — set or not, the minimum exists. "A
     driver a day" is the month's trips ÷ its active driver-days, so a day
     with 130 drivers weighs more than one with 30; an average of the days'
     own ratios would let a thin day count as much as a full one. */
  const tdays = past.filter((x) => x.trips_target);
  const tsum = (k) => tdays.reduce((s, x) => s + (x[k] || 0), 0);
  const driverDays = tsum('active_drivers');
  const tripsSummary = {
    min,
    trips: tsum('trips'),
    needed: tsum('trips_target'),
    driver_days: driverDays,
    reached: tsum('reached'),
    per_active: driverDays ? r2(tsum('trips') / driverDays) : null,
    judged: tdays.filter((x) => x.trips_verdict === 'over' || x.trips_verdict === 'under').length,
    over: tdays.filter((x) => x.trips_verdict === 'over').length,
    under: tdays.filter((x) => x.trips_verdict === 'under').length,
    unsettled: tdays.filter((x) => x.trips_verdict === 'unsettled').length,
    today_target: t ? t.trips_target : null,
    today_active: t ? t.active_drivers : null,
    /* `min` is the minimum on an average day; `today_min` what today asks
       of each active driver, by its weekday (api/target_weights.js). */
    today_min: t ? t.trips_min : null,
    weighted: !!(mw && mw.trips),
    weights: mw && mw.trips ? mw.trips : null,
    weights_from: mw ? mw.from_day : null,
    weights_basis: mw ? mw.basis : null,
    today_trips: t ? t.trips : null,
    days_gone: tdays.length,
    avg_trips_day: tdays.length ? r1(tsum('trips') / tdays.length) : null,
    avg_active: tdays.length ? r1(driverDays / tdays.length) : null,
  };
  const result = {
    month, month_name: monthName(month), today, first, last, days_in_month: D,
    target: latest ? {
      gross: typedClass ? null : typed.gross, rate: classed ? r2(rateNow) : latest.rate,
      cars: typedClass ? carsAtSave(typed) : typed.cars, set_day: typed.set_day,
      set_at: typed.set_at, saves: saves.length, weighted: !!latest.weights,
      kind: latest.kind,
      rates: classed ? latest.rates.map(({ make, model, year, label, rate }) => ({ make, model, year, label, rate })) : null,
      other_rate: classed ? latest.other : null,
    } : null,
    /* Each vehicle class's part of the month — its cars, rate, plan and
       earnings — under either kind of save: under one rate for every car it
       is still each class's share of the month. */
    classes: classesOut,
    why: latest ? null : `No target is set for ${monthName(month)}. The Owner sets it in Set up › Access.`,
    trips_min: min,
    trips_summary: tripsSummary,
    summary, days,
    /* weights_basis made public: the re-shape's carries cars and money
       (cars_now, month_target_kept, rate_before) that the access manifest
       does not shape, and a reader without them must not get them here. */
    saves: saves.map((x) => publicSave(x, first)),
    plannedRaw: plannedToDate,
    monthRaw: monthTargetNow,
  };
  /* For the drivers' shares (driverShares): the save in force on each day
     and the plates' classes; for a car's own page (carTarget), its part of a
     day's plan — the rule the class breakdown above sums, so a car's page
     and its class's row cannot disagree: null with no target, 0 on a day it
     was not counted. Not enumerable, so never in an answer. */
  const carPlanOn = (day, plate) => {
    const x = dayInfo.get(day);
    if (!x || x.plan == null) return null;
    if (!x.set.has(plate)) return 0;
    return x.flatAnchor ? x.plan / x.set.size : rateOf(x.save, plate, classOf) * x.w;
  };
  Object.defineProperties(result, { saveOn: { value: saveOn }, classOf: { value: classOf }, carPlanOn: { value: carPlanOn } });
  return result;
}

/* ── reading it ──────────────────────────────────────────────────────────── */
export async function targetRows(q, month) {
  return q(`SELECT id, gross_target, cars, rate, past_plan, to_char(set_day, 'YYYY-MM-DD') AS set_day,
                   set_at, set_by, set_by_label, weights, weights_basis
              FROM revenue_target WHERE month = $1::date ORDER BY set_at, id`, [`${month}-01`]);
}
const cfgDb = (q) => ({ query: (t, p) => q(t, p).then((rows) => ({ rows })) });

/** The days a month's arithmetic reads: back far enough for the first day's
    7-day car window and 8-day driver window, and forward to whichever is
    later — the month's end or today (a month set in advance still counts
    today's cars). Shared with the month page (api/target_month.js), so the
    two cannot read different spans for the same month. */
export function monthSpan(m, day) {
  const first = `${m}-01`;
  const last = addDays(first, daysIn(m) - 1);
  return { first, last, from: addDays(first < day ? first : day, -(DRIVER_DAYS + 1)), to: last > day ? last : day };
}
/** The trips a day an active driver is asked for, from the Access page. */
export const tripsMin = async (q) => tripsTarget(await getConfig(cfgDb(q)));

/** The month as the page shows it: the arithmetic, the day before today
    (which on the 1st belongs to the month before), and the figures the
    admin panel prints beside the target box. */
export async function monthTarget(q, { month = null, today = null, now = new Date(), min = null } = {}) {
  const day = today || dubaiDay(now);
  const m = month || monthOf(day);
  const { from, to } = monthSpan(m, day);
  const trips = min ?? await tripsMin(q);
  const [rows, facts, mw, classes, classOf] = await Promise.all([targetRows(q, m), loadFacts(q, from, to),
    monthWeights(q, m, { now }), classRows(q, monthSpan(m, day).last), loadClasses(q)]);
  const out = computeMonth({ month: m, today: day, rows, facts, min: trips, mw, classes, classOf });

  /* Yesterday's verdict is the headline. On the 1st it belongs to the month
     before, which has its own target (or none, said so). */
  const yday = addDays(day, -1);
  if (monthOf(yday) === m) out.yesterday = out.days.find((x) => x.day === yday) || null;
  else if (monthOf(yday) < m) {
    const pm = monthOf(yday);
    const prev = computeMonth({ month: pm, today: day, rows: await targetRows(q, pm),
      facts: await loadFacts(q, addDays(`${pm}-01`, -(DRIVER_DAYS + 1)), yday), min: trips,
      mw: await monthWeights(q, pm, { now }), classes, classOf });
    out.yesterday = prev.days.find((x) => x.day === yday) || null;
    out.yesterday_month = { month: pm, month_name: prev.month_name, target: prev.target, why: prev.why,
      summary: prev.summary };
    /* Yesterday's arithmetic for one car, for the Today workbook's "Cars
       yesterday" (not enumerable: never in an answer). */
    Object.defineProperties(out, { yesterdaySaveOn: { value: prev.saveOn }, yesterdayPlanOn: { value: prev.carPlanOn } });
  }
  out.context = await context(q, day, facts);
  out.fleets = await byFleet(q, m, day);
  return out;
}

/* Each fleet's part of the month and of yesterday: one target for both
   fleets, and still the first thing ops asks is which fleet is carrying it.
   The month runs to yesterday, the same days the month so far is judged on;
   on the 1st it is empty and yesterday is the month before's last day. */
async function byFleet(q, month, day) {
  const first = `${month}-01`;
  const yday = addDays(day, -1);
  const rows = await q(
    `SELECT n.fleet_id AS fleet,
            coalesce(round(sum(n.price) FILTER (WHERE n.has_fare AND n.local_day >= $1::date AND n.local_day < $3::date)::numeric, 2), 0)::float AS earned,
            coalesce(round(sum(n.price) FILTER (WHERE n.has_fare AND n.local_day = $2::date)::numeric, 2), 0)::float AS earned_yday,
            count(*) FILTER (WHERE n.outcome = 'completed' AND n.local_day >= $1::date AND n.local_day < $3::date)::int AS trips,
            count(*) FILTER (WHERE n.outcome = 'completed' AND n.local_day = $2::date)::int AS trips_yday,
            count(DISTINCT btrim(n.plate)) FILTER (WHERE n.has_fare AND n.price > 0 AND n.local_day >= $4::date AND n.local_day < $3::date)::int AS cars_week
       FROM trip_norm n
      WHERE n.local_day BETWEEN least($1::date, $4::date) AND $3::date AND n.is_booking AND n.fleet_id IS NOT NULL
      GROUP BY 1 ORDER BY 1`, [first, yday, day, addDays(day, -CAR_DAYS)]);
  return rows.map((r) => ({ fleet: r.fleet, earned: r.earned, earned_yday: r.earned_yday, trips: r.trips,
    trips_yday: r.trips_yday, cars_week: r.cars_week }));
}

/* What the Owner reads while typing a target: the cars it will be shared
   over, yesterday's earning cars (the operator asked for exactly that), the
   drivers the trips target is multiplied by, and last month for scale. */
async function context(q, day, facts) {
  const yday = addDays(day, -1);
  const pmFirst = `${monthOf(addDays(`${monthOf(day)}-01`, -1))}-01`;
  const pmLast = addDays(`${monthOf(day)}-01`, -1);
  const [lm] = await q(
    `SELECT coalesce(round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2), 0)::float AS fares,
            count(*) FILTER (WHERE n.has_fare)::int AS priced,
            count(DISTINCT btrim(n.plate)) FILTER (WHERE n.has_fare AND n.price > 0
              AND coalesce(btrim(n.plate), '') <> '')::int AS cars
       FROM trip_norm n WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking`, [pmFirst, pmLast]);
  const droveWeek = [];
  for (let i = 1; i <= 7; i++) droveWeek.push((facts.personDays.get(addDays(day, -i)) || new Map()).size);
  return {
    cars_7_days: carsAsOf(facts, day).size,
    cars_yesterday: (facts.carDays.get(yday) || new Set()).size,
    active_drivers: driversActiveOn(facts, yday).size,
    drivers_a_day: r2(droveWeek.reduce((s, n) => s + n, 0) / 7),
    last_month: {
      month: monthOf(pmFirst), month_name: monthName(monthOf(pmFirst)),
      fares: lm ? Number(lm.fares) : null, cars: lm ? lm.cars : null,
      avg_fare: lm && lm.priced ? r2(Number(lm.fares) / lm.priced) : null,
    },
  };
}

/* ── setting it ──────────────────────────────────────────────────────────── */
/** Save a target for `month`. Returns {row, month: …} or {error, status, detail}. */
export async function saveTarget(q, { month, gross, now = new Date(), by = null, byLabel = '' }) {
  if (!validMonth(month)) return { error: 'bad_month', status: 400, detail: 'Choose a month.' };
  const g = Number(gross);
  if (!Number.isFinite(g) || g <= 0 || g > MAX_TARGET) {
    return { error: 'bad_target', status: 400, detail: 'Enter the month’s gross target in AED, above zero.' };
  }
  const today = dubaiDay(now);
  const D = daysIn(month);
  const first = `${month}-01`;
  const last = addDays(first, D - 1);
  if (last < today) {
    return { error: 'month_over', status: 409,
      detail: `${monthName(month)} is over; the target it was judged against stays as it was.` };
  }
  const facts = await loadFacts(q, addDays(first < today ? first : today, -(DRIVER_DAYS + 1)), last > today ? last : today);
  const cars = carsAsOf(facts, today).size;
  if (!cars) {
    return { error: 'no_cars', status: 409,
      detail: 'No car earned in the last 7 days, so there is nothing to share a target over yet.' };
  }
  /* Saves from EARLIER days keep the days already gone at their plan. Saves
     from today are being replaced by this one, so they do not count. */
  const earlier = (await targetRows(q, month)).filter((r) => normRow(r).set_day < today);
  /* The weekday weights this save shares by, learned from the 8 complete
     weeks before today (api/target_weights.js); too few usable weeks and
     there are none — every day asked the same, and the basis says why. The
     rate is fixed so the plans of the days it spreads over add up to what is
     typed: what is spread ÷ (cars × the sum of those days' weights). With
     no weights that sum is the number of days, as it always was. */
  const lw = await learnWeights(q, today);
  const weights = lw.ok ? lw.fares : null;
  const wSum = (a, b) => { let s = 0; for (let d = a; d <= b; d = addDays(d, 1)) s += weights ? weights[dowOf(d)] : 1; return s; };
  const restFrom = today > first ? today : first;
  /* A class save made before today plans every day of this month after it
     (and, the month's first save, the days before it): those days are gone
     at their plan, exactly as under an earlier month save. */
  /* …shared by the month's own frozen weights, as every reader of the month
     shares them (computeMonth `shaped`): without them the days gone were
     planned here at the class save's own weights — 10,000 where the page
     read 10,300 — and the month read 300 over what was typed, "cars have
     joined" with none joined (independent review, 2026-10-29). */
  const [classes, classOf, mwSave] = await Promise.all([classRows(q, addDays(today, -1)), loadClasses(q), monthWeights(q, month, { now })]);
  let rate; let pastPlan = 0;
  if (!earlier.length && !(classes.length && today > first)) {
    /* The days before the first save are planned at its cars, so the whole
       month is shared at once. */
    rate = g / (cars * wSum(first, last));
    pastPlan = today > first ? rate * cars * wSum(first, addDays(today, -1)) : 0;
  } else {
    const was = computeMonth({ month, today, rows: earlier, facts, classes, classOf, mw: mwSave });
    pastPlan = was.plannedRaw;
    rate = (g - pastPlan) / (cars * wSum(restFrom, last));
    if (!(rate > 0)) {
      return { error: 'below_past', status: 409,
        detail: `The days of ${monthName(month)} already gone were planned at AED ${r2(pastPlan).toLocaleString('en-US', { minimumFractionDigits: 2 })}; `
          + 'a month target at or below that leaves nothing for the days left.' };
    }
  }
  const [row] = await q(
    `INSERT INTO revenue_target (month, gross_target, cars, rate, past_plan, set_day, set_at, set_by, set_by_label, weights, weights_basis)
     VALUES ($1::date, $2, $3, $4, $5, $6::date, $7, $8, $9, $10::jsonb, $11::jsonb)
     RETURNING id, gross_target, cars, rate, past_plan, to_char(set_day, 'YYYY-MM-DD') AS set_day, set_at, set_by, set_by_label,
               weights, weights_basis`,
    [first, r2(g), cars, Math.round(rate * 1e6) / 1e6, r2(pastPlan), today, now.toISOString(), by, String(byLabel || '').slice(0, 200),
      weights ? JSON.stringify(weights) : null, JSON.stringify(lw.basis)]);
  return { row: normRow(row), month };
}

/* ── setting the class rates ─────────────────────────────────────────────── */
/* What a class "usually" earns, beside its box: its plates' fares over the
   settled days of the last USUAL_DAYS ÷ the car-days it counted on them —
   the rate at which those days would have met a plan to the fils. Four
   whole weeks, so every weekday is in it the same number of times. */
export const USUAL_DAYS = 28;

/** Save AED a car on an average day for each class and for every other car.
    `rates` is [{make, model, year, rate}]; a class left out, or sent with no
    figure, is asked the figure for every other car. Returns {row} or
    {error, status, detail}. */
export async function saveClassTarget(q, { rates = [], other, now = new Date(), by = null, byLabel = '' }) {
  const today = dubaiDay(now);
  /* Rounded to the fils BEFORE it is checked: 0.004 passed a check made on
     the raw figure and was stored as 0 — a class asked nothing, and an
     every-other-car figure that broke the table's CHECK into a 500
     (independent review, 2026-10-29). */
  const num = (v) => (v === '' || v == null ? null : r2(Number(v)));
  const fine = (v) => Number.isFinite(v) && v > 0 && v <= MAX_CLASS_RATE;
  const o = num(other);
  if (!fine(o)) return { error: 'bad_other', status: 400, detail: 'Enter the AED a day for every other car, above zero.' };
  if (!Array.isArray(rates)) return { error: 'bad_rates', status: 400, detail: 'Send the classes as a list.' };
  const classOf = await loadClasses(q);
  const known = new Map([...classOf.values()].map((c) => [c.key, c]));
  const seen = new Set();
  const clean = [];
  for (const x of rates) {
    const r = num(x?.rate);
    if (r == null) continue;
    const key = classKey(x?.make, x?.model, x?.year);
    const c = known.get(key);
    if (!c) return { error: 'unknown_class', status: 400, detail: `${classLabel(x || {})} is not a make, model and year on the vehicle register.` };
    if (seen.has(key)) return { error: 'duplicate_class', status: 400, detail: `${c.label} is listed twice.` };
    if (!fine(r)) return { error: 'bad_rate', status: 400, detail: `Enter the AED a day for ${c.label}, above zero.` };
    seen.add(key);
    clean.push({ make: c.make, model: c.model, year: c.year, rate: r });
  }
  /* The cars each class counts at the save, for the history. */
  const facts = await loadFacts(q, addDays(today, -(CAR_DAYS + 1)), today);
  const counts = new Map();
  let otherCars = 0;
  for (const p of carsAsOf(facts, today)) {
    const c = classOf.get(p);
    if (!c) { otherCars += 1; continue; }
    if (!counts.has(c.key)) counts.set(c.key, { make: c.make, model: c.model, year: c.year, cars: 0 });
    counts.get(c.key).cars += 1;
  }
  const cars = [...counts.values()].sort((a, b) => b.cars - a.cars);
  if (otherCars) cars.push({ make: null, model: null, year: null, cars: otherCars });
  const lw = await learnWeights(q, today);
  const [row] = await q(
    `INSERT INTO class_target (set_day, set_at, set_by, set_by_label, rates, other_rate, cars, weights, weights_basis)
     VALUES ($1::date, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     RETURNING id, to_char(set_day, 'YYYY-MM-DD') AS set_day, set_at, set_by, set_by_label, rates, other_rate, cars,
               weights, weights_basis`,
    [today, now.toISOString(), by, String(byLabel || '').slice(0, 200), JSON.stringify(clean), o, JSON.stringify(cars),
      lw.ok ? JSON.stringify(lw.fares) : null, JSON.stringify(lw.basis)]);
  return { row: normClassRow(row) };
}

/** What the Owner's class panel prints beside the boxes: every class on the
    register, the cars each counts today, and what each usually earns a car
    a day (USUAL_DAYS) — with the plates counted that have no class. */
export async function classEditor(q, { today }) {
  const from = addDays(today, -USUAL_DAYS);
  const [classOf, facts] = await Promise.all([loadClasses(q), loadFacts(q, addDays(from, -(DRIVER_DAYS + 1)), addDays(today, -1))]);
  const rows = new Map();
  const get = (c) => {
    const key = c ? c.key : NO_CLASS;
    if (!rows.has(key)) rows.set(key, { key: c ? c.key : null, make: c?.make ?? null, model: c?.model ?? null, year: c?.year ?? null,
      label: c ? c.label : 'No make or model on file', plates: 0, cars_now: 0, earned: 0, car_days: 0 });
    return rows.get(key);
  };
  for (const c of classOf.values()) get(c).plates += 1;
  const nowSet = carsAsOf(facts, today);
  const bare = [];
  for (const p of nowSet) {
    const c = classOf.get(p) || null;
    get(c).cars_now += 1;
    if (!c) bare.push(p);
  }
  let days = 0, fleetFares = 0, fleetCarDays = 0;
  for (let d = from; d < today; d = addDays(d, 1)) {
    if (!settledness(facts, d).settled) continue;
    days += 1;
    for (const p of carsAsOf(facts, d)) { get(classOf.get(p) || null).car_days += 1; fleetCarDays += 1; }
    for (const [p, f] of facts.plateFares?.get(d) || []) get(classOf.get(p) || null).earned += f;
    fleetFares += Number(facts.days.get(d)?.fares || 0);
  }
  const list = [...rows.values()].map((r) => ({
    key: r.key, make: r.make, model: r.model, year: r.year, label: r.label, plates: r.plates, cars_now: r.cars_now,
    usual: r.car_days ? r2(r.earned / r.car_days) : null, car_days: r.car_days,
  })).sort((a, b) => (a.key == null ? 1 : 0) - (b.key == null ? 1 : 0) || b.cars_now - a.cars_now || b.plates - a.plates
    || a.label.localeCompare(b.label));
  return {
    usual_from: from, usual_to: addDays(today, -1), usual_days: days,
    fleet_usual: fleetCarDays ? r2(fleetFares / fleetCarDays) : null,
    cars_now: nowSet.size,
    classes: list.filter((r) => r.key != null),
    unclassed: { cars_now: bare.length, plates: bare.sort().slice(0, 50), usual: list.find((r) => r.key == null)?.usual ?? null },
  };
}

/* ── one car against its class's rate ────────────────────────────────────── */
/** A car's own target, for its vehicle page: its class, the AED a car on an
    average day its class is asked (or the figure for every other car, and
    why), today's weekday share of it, and the last `days` days — what it
    was asked (0 on a day it was not counted: it had not earned in the 7
    days before), what it earned, and the verdict once the day settled. The
    days are computeMonth's own, read through carPlanOn, over just the span
    they need. */
export async function carTarget(q, plate, { now = new Date(), today = null, days = 7 } = {}) {
  const day = today || dubaiDay(now);
  const from = addDays(day, -days);
  const to = addDays(day, -1);
  const [classOf, facts, min] = await Promise.all([loadClasses(q), loadFacts(q, addDays(from, -(DRIVER_DAYS + 1)), day), tripsMin(q)]);
  const cls = classOf.get(plate) || null;
  const out = [];
  let t = null;
  for (const m of [...new Set([monthOf(from), monthOf(day)])]) {
    const last = addDays(`${m}-01`, daysIn(m) - 1);
    const [rows, mw, classes] = await Promise.all([targetRows(q, m), monthWeights(q, m, { now }), classRows(q, last)]);
    t = computeMonth({ month: m, today: day, rows, facts, min, mw, classes, classOf });
    for (const d of t.days) {
      if (d.day < from || d.day > to) continue;
      const plan = t.carPlanOn(d.day, plate);
      const earned = facts.plateFares?.get(d.day)?.get(plate) || 0;
      const counted = carsAsOf(facts, d.day).has(plate);
      out.push({ day: d.day, label: d.label, weight: d.weight, counted, plan: r2(plan), earned: r2(earned),
        diff: plan ? r2(earned - plan) : null, pct: plan ? r1((100 * earned) / plan) : null,
        verdict: !plan ? null : earned >= plan - 0.005 ? 'over' : d.settled ? 'under' : 'unsettled',
        settled: d.settled, why: d.settled ? null : d.why });
    }
  }
  const save = t?.saveOn?.get(day) || null;
  const rate = save ? rateOf(save, plate, classOf) : null;
  const tw = t?.days.find((d) => d.day === day)?.weight ?? null;
  const judged = out.filter((d) => d.plan && d.settled);
  const sum = (k) => judged.reduce((n, d) => n + (d[k] || 0), 0);
  return {
    plate, today: day, from, to,
    class: cls ? { make: cls.make, model: cls.model, year: cls.year, label: cls.label } : null,
    kind: save ? save.kind : null,
    rate: r2(rate),
    /* Asked the figure for every other car: no class on file, or a class
       the Owner gave no figure of its own. */
    uses_other: !!save && save.kind === 'class' && !(cls && save.rateBy.has(cls.key)),
    counted_today: carsAsOf(facts, day).has(plate),
    today_weight: tw, today_rate: rate != null && tw != null ? r2(rate * tw) : null,
    days: out,
    totals: judged.length ? { days: judged.length, plan: r2(sum('plan')), earned: r2(sum('earned')),
      pct: sum('plan') ? r1((100 * sum('earned')) / sum('plan')) : null,
      over: judged.filter((d) => d.verdict === 'over').length } : null,
    why: save ? null : 'No target is in force today. The Owner sets the daily targets in Set up › Access.',
  };
}

/* ── the day the weekday rule arrived ────────────────────────────────────── */
/* The operator, 2026-10-11: "A historically bad day on a Sunday can't be
   expected to perform the same way as weekday." A month already under way
   was saved under the equal split, and its saves carry no weights. Re-saving
   it with the figure typed would NOT be neutral: the month target floats with
   the cars (October: AED 1,750,500 typed over 101 cars, AED 1,795,786.01
   with 104 on 11 Oct), and a re-save of the typed figure would quietly undo
   that. So the month is re-shaped by a save of its own, made once per month
   at boot and recorded on the audit chain as `target.reweight` by
   `system:reweight`, that keeps three things exactly:
     · the month target as it stands (what the equal rule would have made
       of it) — the rate is (that − the days gone) ÷ (today's cars × the
       weights of the days left); over whole weeks that is the same rate;
     · every day already gone, at the plan it was judged against (it is a
       LATER save, and a later save never re-scores history);
     · the Owner's own figures where the pages say "set at": the re-shape's
       row holds what IT spreads (the month as it stands) and the cars it
       spreads over, so its rate and cars belong together, and computeMonth
       reads "set at … over N cars" from the last save that is not this one
       (an independent review found the first build paired a rate taken over
       104 cars with the 101 the Owner typed over).
   A month whose weights cannot be learned (too few whole weeks) is left as
   it is and logged; the next boot tries again. */
export async function applyWeightCutover(db, { now = new Date(), log = () => {} } = {}) {
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  const today = dubaiDay(now);
  const months = (await q(`SELECT DISTINCT to_char(month, 'YYYY-MM') AS m FROM revenue_target
                            WHERE (month + interval '1 month')::date > $1::date ORDER BY 1`, [today])).map((r) => r.m);
  const out = [];
  for (const m of months) {
    const rows = await targetRows(q, m);
    const saves = rows.map(normRow).sort(bySave);
    const latest = saves[saves.length - 1];
    if (!latest || latest.weights) continue;
    /* A class save after it governs the month from its day with weights of
       its own (the month's), so there is nothing to re-shape — and a system
       save inserted now would override the Owner's class figures from today
       (independent review, 2026-10-29). */
    const classes = (await classRows(q, monthSpan(m, today).last)).map(normClassRow);
    if (classes.some((c) => c.set_at > latest.set_at)) {
      out.push({ month: m, done: false, why: 'governed by daily targets by vehicle class' });
      continue;
    }
    const lw = await learnWeights(q, today);
    if (!lw.ok) {
      log(`target ${m} stays shared equally: ${lw.basis.why}`);
      out.push({ month: m, done: false, why: lw.basis.why });
      continue;
    }
    const { first, last, from, to } = monthSpan(m, today);
    const facts = await loadFacts(q, from, to);
    /* An earlier class save may still plan the days before the month save
       (carried in, or the month's anchor): read the month as its page does.
       With none, exactly as before. */
    const [classOf, mwNow] = classes.length ? await Promise.all([loadClasses(q), monthWeights(q, m, { now })]) : [new Map(), null];
    const was = computeMonth({ month: m, today, rows, facts, classes, classOf, mw: mwNow });
    const cars = carsAsOf(facts, today).size;
    const restFrom = today > first ? today : first;
    let wsum = 0;
    for (let d = restFrom; d <= last; d = addDays(d, 1)) wsum += lw.fares[dowOf(d)];
    const rate = cars && wsum ? (was.monthRaw - was.plannedRaw) / (cars * wsum) : 0;
    if (!(rate > 0)) {
      out.push({ month: m, done: false, why: 'nothing left to share' });
      continue;
    }
    const basis = { ...lw.basis, cutover: true, cars_now: cars, month_target_kept: r2(was.monthRaw),
      rate_before: latest.rate, from_save: latest.id };
    const [row] = await q(
      `INSERT INTO revenue_target (month, gross_target, cars, rate, past_plan, set_day, set_at, set_by, set_by_label, weights, weights_basis)
       VALUES ($1::date, $2, $3, $4, $5, $6::date, $7, NULL, 'system:reweight', $8::jsonb, $9::jsonb) RETURNING id`,
      [first, r2(was.monthRaw), cars, Math.round(rate * 1e6) / 1e6, r2(was.plannedRaw), today, now.toISOString(),
        JSON.stringify(lw.fares), JSON.stringify(basis)]);
    const detail = { month: m, row: row.id, month_target: r2(was.monthRaw), rate_before: latest.rate,
      rate_after: Math.round(rate * 1e6) / 1e6, weights: lw.fares, weeks: `${lw.basis.from}..${lw.basis.to}`, used: lw.basis.used };
    await appendAudit(db, { actorLabel: 'system:reweight', action: 'target.reweight', subjectType: 'revenue_target',
      subjectId: row.id, detail });
    /* The trips minimum by weekday starts the same day: freeze this month's
       trips weights now, at the boot that re-shaped its revenue. */
    if (first <= today && today <= last) await monthWeights(q, m, { now });
    log(`target ${m} shared by weekday from ${today}: month target ${r2(was.monthRaw)} kept, rate ${latest.rate} → ${detail.rate_after}`);
    out.push({ month: m, done: true, ...detail });
  }
  return out;
}

/* ── the deploy seed ─────────────────────────────────────────────────────── */
/* TARGET_SEED="2026-10 1705000 trips=12", set on the platform: the target the
   operator asked for on 2026-10-02 ("set the target to 12 trips per day, per
   active driver, and 1.6M gross income", then, before it went out, "set
   october target to 1.705 Million not 1.6"), applied at the API's first boot
   that sees it, the way BOOTSTRAP_OWNER_* created the first Owner. Once only:
   the seed string is written to the access audit chain, and a boot that finds
   it there does nothing — so the Owner's own later changes are never undone
   by a restart. It never overwrites a month that already has a target. */
export async function applyTargetSeed(db, { seed = process.env.TARGET_SEED, now = new Date(), log = () => {} } = {}) {
  const raw = String(seed || '').trim().replace(/\s+/g, ' ');
  if (!raw) return { done: false, why: 'not configured' };
  const m = /^(\d{4}-(?:0[1-9]|1[0-2])) (\d+(?:\.\d+)?)(?: trips=(\d{1,3}))?$/.exec(raw);
  if (!m) return { done: false, why: 'malformed' };
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  const [seen] = await q(`SELECT 1 AS ok FROM access_audit WHERE action = 'target.seed' AND detail->>'seed' = $1 LIMIT 1`, [raw]);
  if (seen) return { done: false, why: 'already applied' };
  const out = { seed: raw, month: m[1], gross: Number(m[2]), trips: m[3] ? Number(m[3]) : null, row: null };
  const [has] = await q(`SELECT 1 AS ok FROM revenue_target WHERE month = $1::date LIMIT 1`, [`${out.month}-01`]);
  if (!has) {
    const r = await saveTarget(q, { month: out.month, gross: out.gross, now, by: null, byLabel: 'system:seed' });
    if (r.error) { log(`target seed not applied: ${r.detail}`); return { done: false, why: r.detail }; }
    out.row = r.row.id;
  }
  if (out.trips != null && out.trips >= 1 && out.trips <= 100) await setConfig(db, 'low_trips_min', out.trips, null);
  await appendAudit(db, { actorLabel: 'system:seed', action: 'target.seed', subjectType: 'revenue_target',
    subjectId: out.row, detail: out });
  log(`target seed applied: ${raw}`);
  return { done: true, ...out };
}
