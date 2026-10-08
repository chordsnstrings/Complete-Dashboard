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

   A FIGURE THAT CANNOT BE MEASURED IS ABSENT WITH ITS REASON. A day is judged
   only once it is SETTLED: every booking channel that has been collecting
   delivered it (a run whose window COVERS the day and that finished after the
   day ended — docs/COVERAGE.md trap 41), and 99% of its chargeable bookings
   carry a fare (src/monthly_report.js READY_COVERAGE). Uber prices a day
   overnight, so TODAY is never judged. An unsettled day that has ALREADY
   beaten what it needed is over whatever arrives later, and says "at least";
   one still short says what it is waiting for. */
import { personKeyStored } from './custody_sql.js';
import { dubaiDay } from './window.js';
import { getConfig, setConfig } from './access/service.js';
import { appendAudit } from './access/audit.js';
import { TRIP_RUN_SQL } from './run_kinds.js';

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
    q(`SELECT DISTINCT to_char(n.local_day, 'YYYY-MM-DD') AS day, btrim(n.plate) AS plate
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
          AND n.has_fare AND n.price > 0 AND coalesce(btrim(n.plate), '') <> ''`, [from, to]),
    /* One person, one row — the stored fold of api/custody_sql.js, the same
       answer the 08:00 email's personKey() gives and a hundred times cheaper. */
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, ${personKeyStored('t')} AS pk, count(*)::int AS trips
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
  for (const r of cars) {
    if (!carDays.has(r.day)) carDays.set(r.day, new Set());
    carDays.get(r.day).add(r.plate);
  }
  const personDays = new Map();
  for (const r of people) {
    if (!personDays.has(r.day)) personDays.set(r.day, new Map());
    personDays.get(r.day).set(r.pk, r.trips);
  }
  return {
    from, to, days: byDay, carDays, personDays,
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

const normRow = (r) => ({
  id: Number(r.id),
  gross: Number(r.gross_target),
  cars: Number(r.cars),
  rate: Number(r.rate),
  past_plan: Number(r.past_plan || 0),
  set_day: typeof r.set_day === 'string' ? r.set_day.slice(0, 10) : dubaiDay(new Date(r.set_day)),
  set_at: new Date(r.set_at).toISOString(),
  set_by: r.set_by == null ? null : Number(r.set_by),
  set_by_label: r.set_by_label || '',
});
const bySave = (a, b) => (a.set_at < b.set_at ? -1 : a.set_at > b.set_at ? 1 : a.id - b.id);

/* ── the month, day by day ───────────────────────────────────────────────── */
/** Pure: the month's plan, needs and verdicts from the saves and the facts.
    `today` is the Dubai day the page is speaking on; `min` the trips a day an
    active driver is asked for. */
export function computeMonth({ month, today, rows = [], facts, min = 10 }) {
  const D = daysIn(month);
  const first = `${month}-01`;
  const last = addDays(first, D - 1);
  const saves = rows.map(normRow).sort(bySave);
  const carsNow = carsAsOf(facts, today).size;
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
  for (let i = 0; i < D; i++) {
    const day = addDays(first, i);
    const left = D - i;  // this day and the ones after it
    const state = day < today ? 'past' : day === today ? 'today' : 'future';
    const save = saves.length ? inForce(day) : null;
    const cars = save && day < firstSave ? save.cars
      : state === 'future' ? carsNow : carsAsOf(facts, day).size;
    const plan = save ? save.rate * cars : null;
    const f = facts.days.get(day);
    const earned = state === 'future' ? null : (f ? Number(f.fares) : 0);
    const needed = save && state !== 'future' ? Math.max(0, plan + shortfall / left) : null;

    raw.push({ plan, needed });
    const row = {
      day, dow: new Date(`${day}T12:00:00Z`).getUTCDay(), label: shortDay(day), state,
      cars, rate: save ? save.rate : null, plan: r2(plan), needed: r2(needed),
      earned: r2(earned), diff: null, pct: null, verdict: null, provisional: false,
      settled: null, why: null, coverage: null,
      bookings: f ? f.bookings : (state === 'future' ? null : 0),
      trips: null, active_drivers: null, trips_target: null, trips_per_active: null,
      reached: null, drove: null, trips_verdict: null, trips_diff: null, trips_pct: null,
      trips_provisional: false,
    };
    if (state !== 'future') {
      const ppl = facts.personDays.get(day) || new Map();
      const active = driversActiveOn(facts, day).size;
      const trips = [...ppl.values()].reduce((s, n) => s + n, 0);
      Object.assign(row, {
        trips, active_drivers: active, trips_target: active * min,
        trips_per_active: active ? r2(trips / active) : null,
        reached: [...ppl.values()].filter((n) => n >= min).length, drove: ppl.size,
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
    const L = t ? D - days.indexOf(t) : D;
    days.forEach((x, i) => {
      if (x.state !== 'future') return;
      raw[i].needed = Math.max(0, raw[i].plan + (t ? shortfall / L : 0));
      x.needed = r2(raw[i].needed);
    });
  }

  const past = days.filter((x) => x.state === 'past');
  const latest = saves.length ? saves[saves.length - 1] : null;
  const sum = (xs, k) => xs.reduce((s, x) => s + (x[k] || 0), 0);
  const rawPlan = (xs) => xs.reduce((s, x) => s + (raw[days.indexOf(x)].plan || 0), 0);
  const monthTargetNow = saves.length ? rawPlan(days) : null;
  const plannedToDate = rawPlan(past);
  const earnedToDate = sum(past, 'earned');
  const summary = saves.length ? {
    month_target: r2(monthTargetNow),
    gross_set: latest.gross,
    rate: latest.rate,
    cars_at_set: latest.cars,
    cars_now: carsNow,
    since_set: r2(monthTargetNow - latest.gross),
    earned: r2(earnedToDate),
    planned: r2(plannedToDate),
    ahead: r2(earnedToDate - plannedToDate),
    to_go: r2(Math.max(0, monthTargetNow - earnedToDate)),
    days_left: t ? D - days.indexOf(t) : (today < first ? D : 0),
    today_needs: t ? t.needed : null,
    today_per_car: t && t.cars ? r2(raw[days.indexOf(t)].needed / t.cars) : null,
    today_cars: t ? t.cars : null,
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
    month_end_pace: past.length ? r2((earnedToDate / past.length) * D) : null,
    pace_pct: past.length && monthTargetNow ? r2((100 * (earnedToDate / past.length) * D) / monthTargetNow) : null,
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
    today_trips: t ? t.trips : null,
    days_gone: tdays.length,
    avg_trips_day: tdays.length ? r1(tsum('trips') / tdays.length) : null,
    avg_active: tdays.length ? r1(driverDays / tdays.length) : null,
  };
  return {
    month, month_name: monthName(month), today, first, last, days_in_month: D,
    target: latest ? {
      gross: latest.gross, rate: latest.rate, cars: latest.cars, set_day: latest.set_day,
      set_at: latest.set_at, saves: saves.length,
    } : null,
    why: latest ? null : `No target is set for ${monthName(month)}. The Owner sets it in Set up › Access.`,
    trips_min: min,
    trips_summary: tripsSummary,
    summary, days,
    saves,
    plannedRaw: plannedToDate,
  };
}

/* ── reading it ──────────────────────────────────────────────────────────── */
export async function targetRows(q, month) {
  return q(`SELECT id, gross_target, cars, rate, past_plan, to_char(set_day, 'YYYY-MM-DD') AS set_day,
                   set_at, set_by, set_by_label
              FROM revenue_target WHERE month = $1::date ORDER BY set_at, id`, [`${month}-01`]);
}
const cfgDb = (q) => ({ query: (t, p) => q(t, p).then((rows) => ({ rows })) });

/** The month as the page shows it: the arithmetic, the day before today
    (which on the 1st belongs to the month before), and the figures the
    admin panel prints beside the target box. */
export async function monthTarget(q, { month = null, today = null, now = new Date(), min = null } = {}) {
  const day = today || dubaiDay(now);
  const m = month || monthOf(day);
  const D = daysIn(m);
  const first = `${m}-01`;
  const last = addDays(first, D - 1);
  /* Reach back far enough for the first day's 7-day car window and 8-day
     driver window, and forward to whichever is later: the month's end or
     today (a month set in advance still counts today's cars). */
  const from = addDays(first < day ? first : day, -(DRIVER_DAYS + 1));
  const to = last > day ? last : day;
  const trips = min ?? tripsTarget(await getConfig(cfgDb(q)));
  const [rows, facts] = await Promise.all([targetRows(q, m), loadFacts(q, from, to)]);
  const out = computeMonth({ month: m, today: day, rows, facts, min: trips });

  /* Yesterday's verdict is the headline. On the 1st it belongs to the month
     before, which has its own target (or none, said so). */
  const yday = addDays(day, -1);
  if (monthOf(yday) === m) out.yesterday = out.days.find((x) => x.day === yday) || null;
  else if (monthOf(yday) < m) {
    const pm = monthOf(yday);
    const prev = computeMonth({ month: pm, today: day, rows: await targetRows(q, pm),
      facts: await loadFacts(q, addDays(`${pm}-01`, -(DRIVER_DAYS + 1)), yday), min: trips });
    out.yesterday = prev.days.find((x) => x.day === yday) || null;
    out.yesterday_month = { month: pm, month_name: prev.month_name, target: prev.target, why: prev.why,
      summary: prev.summary };
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
  let rate; let pastPlan = 0;
  const pastDays = today <= first ? 0 : Math.min(D, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 864e5));
  if (!earlier.length) {
    rate = g / (D * cars);
    pastPlan = rate * cars * pastDays;
  } else {
    const was = computeMonth({ month, today, rows: earlier, facts });
    pastPlan = was.plannedRaw;
    rate = (g - pastPlan) / (cars * (D - pastDays));
    if (!(rate > 0)) {
      return { error: 'below_past', status: 409,
        detail: `The days of ${monthName(month)} already gone were planned at AED ${r2(pastPlan).toLocaleString('en-US', { minimumFractionDigits: 2 })}; `
          + 'a month target at or below that leaves nothing for the days left.' };
    }
  }
  const [row] = await q(
    `INSERT INTO revenue_target (month, gross_target, cars, rate, past_plan, set_day, set_at, set_by, set_by_label)
     VALUES ($1::date, $2, $3, $4, $5, $6::date, $7, $8, $9)
     RETURNING id, gross_target, cars, rate, past_plan, to_char(set_day, 'YYYY-MM-DD') AS set_day, set_at, set_by, set_by_label`,
    [first, r2(g), cars, Math.round(rate * 1e6) / 1e6, r2(pastPlan), today, now.toISOString(), by, String(byLabel || '').slice(0, 200)]);
  return { row: normRow(row), month };
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
