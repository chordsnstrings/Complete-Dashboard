/* THE LOW PERFORMERS — everyone below their target over a period, day by day,
   and whether they are getting better.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-19, after the bottom-45 PDFs of 16–19 Oct (the 30-day
   list, Tuesday against Thursday, the fortnight day by day): "I want reports
   like this for the low performer on the platform. there's a low performer
   tab. we need to make sure it's more comprehensive like this so that we can
   check their performance improvement as well." Then: "don't keep drivers who
   only drives in hotel, or let us filter it out", and who belongs on it:
   "anyone who is earning less than the target per day". Ruled the same day:
   days off COUNT against the target, the page opens on the month so far, and
   watch lists are kept by the Owner and the Operations managers
   (api/lowperf_watch.js).

   ── A DRIVER'S TARGET, and why it is the Month target page's ──────────────
   Nothing new is invented here. A day's PLAN is the month's target spread over
   its days (api/revenue_target.js computeMonth: AED a car a day × the cars that
   earned in the week before × the weekday's weight), and a driver's share of a
   day is that plan divided equally among the day's ACTIVE drivers — a
   completed trip in the 8 Dubai days up to and including it (driversActiveOn).
   That is api/target_month.js driverTargets, rule for rule, so for the same
   days this page and the Month target page name the same people with the same
   figures: test/lowperf.test.mjs holds the two side by side. The shares of a
   day add up to the day's plan, so every active driver at their share is the
   fleet at its plan.

   A driver active on a day they did not drive is still asked that day's share
   — "Count it", the operator's ruling. A week off shows as a week of red cells
   with "off" in them, never as a week that asked nothing.

   COUNTED DAYS are past days that are SETTLED (every channel delivered, 99% of
   bookings priced) in a month with a target. Any other day is left out and
   named with its reason: a day Uber has not finished pricing would make every
   driver look short by fares that have not been published.

   A period that crosses a month boundary is two months' arithmetic, each
   computed exactly as its own Month target page computes it (monthSpan, the
   month's own saves and weights) and read side by side.

   ── HOTEL DRIVERS ────────────────────────────────────────────────────────
   A driver whose every booking is on the hotel channel is waiting at a hotel
   rank, not choosing where to work, and the operator asked for them off the
   list or behind a switch. Three settings: hide the hotel-only (the default),
   hide the mostly-hotel too (more than half their bookings — the rule the
   bottom-45 report used), or show everyone. The share is over the period and
   the 7 days before it, which is the active rule's own reach: a driver active
   on the first day of the period was active because of a trip in that week.

   ── GETTING BETTER, against everyone else ──────────────────────────────────
   Three weeks, each a block of 7 days ending on the period's last COUNTED day
   (so with a settled Sunday at the end they are calendar weeks; with
   yesterday still being priced, they end the day before), each as a share of the
   person's target in it. A person IMPROVING moved at least TREND_POINTS
   percentage points more than everyone else did between the last two weeks;
   SLIPPING moved that much less; anything between is STEADY. Against everyone
   else, because a quiet week moves the whole fleet at once — the bottom-45
   Tuesday/Thursday report found its 44 down 12% while everyone else was down
   10%, and on their own figures alone they would all have read "slipping". A
   week with fewer than WEEK_MIN_ACTIVE active days is too short to say.

   ── WATCH LISTS ─────────────────────────────────────────────────────────
   A list saved on a day and followed from then on (api/lowperf_routes.js
   keeps them): its members day by day from two weeks before the save, and any
   two spans compared — by default the two weeks before the save against the
   days since — each member's share of target against everyone else's, by the
   same rule as the trend. Everyone else is everyone active on those days under
   the list's own hotel and fleet setting, less the list. Members are found by
   their person key and, if a merge in the identity register has re-keyed
   them since, by any of the platform accounts they held when saved. */
import {
  computeMonth, loadFacts, targetRows, monthSpan, tripsMin, driversActiveOn, monthOf, monthName,
  addDays, shortDay, validDay, DRIVER_DAYS,
} from './revenue_target.js';
import { loadDriverDays } from './target_month.js';
import { monthWeights } from './target_weights.js';
import { personKeyStored } from './custody_sql.js';
import { dubaiDay } from './window.js';

/* The longest period one answer covers: three months of days × a person grid
   is already a large page. */
export const MAX_DAYS = 93;
/* The trend: three blocks of seven days. */
export const WEEK = 7;
export const WEEKS = 3;
/* A week asks for this many active days before its share means anything. */
export const WEEK_MIN_ACTIVE = 3;
/* Points of target a person must move beyond everyone else to be named
   improving or slipping. Ten: the bottom-45 report's 44 were 2 points apart
   from everyone else over a Tuesday and a Thursday, which is noise. */
export const TREND_POINTS = 10;
export const HOTEL_MODES = ['hide', 'mostly', 'show'];
/* "Mostly hotel": more than half of a person's bookings. */
export const MOSTLY_HOTEL = 50;
export const BANDS = [
  { key: 'lt50', label: 'Under half of target', lo: 0, hi: 50 },
  { key: 'lt80', label: 'Half to 80% of target', lo: 50, hi: 80 },
  { key: 'lt100', label: '80% to target', lo: 80, hi: 100 },
];
export const bandOf = (pct) => (pct == null ? null : (BANDS.find((b) => pct < b.hi) || null)?.key ?? null);

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const pctOf = (a, b) => (b > 0 ? r1((100 * a) / b) : null);
const earlier = (a, b) => (a < b ? a : b);
const daysOver = (a, b) => {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
};

/* ── the period ──────────────────────────────────────────────────────────── */
/** The days asked about. Default: the month so far — the first of the month
    yesterday falls in, to yesterday (on the 1st that is the whole of the
    month before, the Month target page's own convention). Today is never in
    it: nothing of today is judged until tomorrow morning. */
export function periodOf({ from = null, to = null, today }) {
  const notes = [];
  const yesterday = addDays(today, -1);
  let t = validDay(to) ? String(to) : yesterday;
  if (t > yesterday) {
    notes.push(`The period ends ${shortDay(yesterday)}: ${shortDay(today)} is not over, and a day is judged the morning after it.`);
    t = yesterday;
  }
  let f = validDay(from) && String(from) <= t ? String(from) : `${monthOf(t)}-01`;
  if (daysOver(f, t).length > MAX_DAYS) {
    f = addDays(t, -(MAX_DAYS - 1));
    notes.push(`One answer covers at most ${MAX_DAYS} days, so the period starts ${shortDay(f)}.`);
  }
  return { from: f, to: t, notes };
}

/* ── what the database holds ─────────────────────────────────────────────── */
/** Per person: bookings by platform over [hotelFrom, to] (the hotel share);
    from `from` on, the period's own bookings, completions and cash rides; the
    car they drove most, their last booking and every platform account they
    were booked under. Cash is trip_ext.driver_holds_cash, the predicate
    #settlement and the driver page's cash trips count. */
export async function loadExtras(q, { hotelFrom, from, to }) {
  const pk = personKeyStored('t');
  const a = earlier(hotelFrom, from);
  const [plat, car] = await Promise.all([
    q(`SELECT ${pk} AS pk, n.platform,
              count(*) FILTER (WHERE n.local_day >= $4::date)::int AS bookings_w,
              count(*) FILTER (WHERE n.local_day >= $2::date)::int AS bookings,
              count(*) FILTER (WHERE n.local_day >= $2::date AND n.outcome = 'completed')::int AS completed,
              count(*) FILTER (WHERE n.local_day >= $2::date AND n.driver_holds_cash)::int AS cash
         FROM trip_ext n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
        WHERE n.local_day BETWEEN $1::date AND $3::date AND n.is_booking AND n.driver_name IS NOT NULL
        GROUP BY 1, 2`, [a, from, to, hotelFrom]),
    q(`SELECT ${pk} AS pk,
              mode() WITHIN GROUP (ORDER BY btrim(n.plate)) FILTER (WHERE coalesce(btrim(n.plate), '') <> '') AS plate,
              to_char(max(n.local_day), 'YYYY-MM-DD') AS last_booking,
              array_remove(array_agg(DISTINCT t.driver_ext_id), NULL) AS ids
         FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.driver_name IS NOT NULL
        GROUP BY 1`, [a, to]),
  ]);
  const out = new Map();
  const get = (k) => {
    if (!out.has(k)) out.set(k, emptyExtras());
    return out.get(k);
  };
  for (const r of plat) {
    const x = get(r.pk);
    x.bookings_w += Number(r.bookings_w) || 0;
    if (r.platform === 'hotel') x.hotel_w += Number(r.bookings_w) || 0;
    x.bookings += Number(r.bookings) || 0;
    x.completed += Number(r.completed) || 0;
    x.cash += Number(r.cash) || 0;
    if (Number(r.bookings)) x.by_platform[r.platform] = Number(r.bookings);
  }
  for (const r of car) Object.assign(get(r.pk), { plate: r.plate || null, last_booking: r.last_booking || null, ids: r.ids || [] });
  return out;
}
const emptyExtras = () => ({ bookings_w: 0, hotel_w: 0, bookings: 0, completed: 0, cash: 0, by_platform: {}, plate: null, last_booking: null, ids: [] });

/** Uber hours online per person over the period. Only Uber files
    availability (src/sources/uber_timeline.js → driver_timeline_event →
    driver_day.online_min); NULL there means it was never collected for that
    day, which is not zero. A person with two accounts is credited the longer
    of the two each day, never their sum — two apps open at once are one shift.
    An account two people's trips were filed under is credited to nobody: its
    hours cannot be split between them. */
export async function loadHours(q, from, to) {
  const pk = personKeyStored('t');
  const rows = await q(`
    WITH acct AS (
      SELECT t.driver_ext_id AS id, min(${pk}) AS pk
        FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
       WHERE n.local_day BETWEEN $1::date - ${DRIVER_DAYS} AND $2::date AND n.is_booking
         AND n.driver_name IS NOT NULL AND t.driver_ext_id IS NOT NULL
       GROUP BY 1 HAVING count(DISTINCT ${pk}) = 1),
    per_day AS (
      SELECT a.pk, d.day, max(d.online_min) AS online_min
        FROM acct a JOIN driver_day d ON d.driver_ext_id = a.id
       WHERE d.day BETWEEN $1::date AND $2::date AND d.online_min IS NOT NULL
       GROUP BY 1, 2)
    SELECT pk, sum(online_min)::float AS online_min, count(*)::int AS online_days FROM per_day GROUP BY 1`, [from, to]);
  return new Map(rows.map((r) => [r.pk, { online_min: Number(r.online_min) || 0, online_days: Number(r.online_days) || 0 }]));
}

/** Each month of [lo, to]'s arithmetic over its own span, exactly as its
    Month target page reads it, and the people's days over [lo, to]. */
async function loadDays(q, { lo, to, today, now, min }) {
  const months = [...new Set(daysOver(lo, to).map(monthOf))];
  const [trips, mos, dd] = await Promise.all([
    min ?? tripsMin(q),
    Promise.all(months.map(async (m) => {
      const span = monthSpan(m, today);
      const [rows, facts, mw] = await Promise.all([targetRows(q, m), loadFacts(q, span.from, span.to), monthWeights(q, m, { now })]);
      return { month: m, rows, facts, mw };
    })),
    loadDriverDays(q, lo, to),
  ]);
  return { min: trips, months: mos, dd };
}

/** Everything the list needs: the period, the trend's weeks before it, and
    the period's extras. */
export async function loadLowperf(q, { from, to, today, now = new Date(), min = null }) {
  /* The trend's weeks end on the period's last COUNTED day, which a morning
     with yesterday still unpriced puts a day or two before `to`: a further
     week of days is read so the first week is whole even then. */
  const lo = earlier(from, addDays(to, -(WEEK * (WEEKS + 1) - 1)));
  const [days, extras, hours] = await Promise.all([
    loadDays(q, { lo, to, today, now, min }),
    loadExtras(q, { hotelFrom: addDays(from, -(DRIVER_DAYS - 1)), from, to }),
    loadHours(q, from, to),
  ]);
  return { from, to, lo, today, ...days, extras, hours };
}

/* ── the days ────────────────────────────────────────────────────────────── */
/** Pure. Every day of [lo, to] as the Month target page judges it: its plan,
    whether it counts, who was active on it and each one's share. */
export function judgeDays({ lo, to, today, months, min }) {
  const byDay = new Map();
  for (const mo of months) {
    const t = computeMonth({ month: mo.month, today, rows: mo.rows, facts: mo.facts, min, mw: mo.mw });
    for (const d of t.days) {
      if (d.day < lo || d.day > to) continue;
      let why = null;
      let active = null;
      if (d.state !== 'past') why = `${d.label} is not over yet.`;
      else if (!t.target) why = `No target was set for ${monthName(mo.month)}, so its days ask nothing of a driver.`;
      else if (!d.settled) why = d.why;
      if (d.state === 'past') active = driversActiveOn(mo.facts, d.day);
      const counted = !why && d.plan != null && active.size > 0;
      if (!why && !counted) why = `Nobody was active on ${d.label}.`;
      byDay.set(d.day, {
        day: d.day, label: d.label, dow: d.dow, month: mo.month, counted, why,
        plan: counted ? d.plan : null,
        active_n: active ? active.size : null,
        share: counted ? d.plan / active.size : null,
        trips_min: d.trips_min ?? min,
        active,
      });
    }
  }
  return daysOver(lo, to).map((d) => byDay.get(d)).filter(Boolean);
}
/** The days as a page prints them (the active sets stay on the server). */
const publicDays = (days) => days.map((d) => ({
  day: d.day, label: d.label, dow: d.dow, counted: d.counted,
  plan: r2(d.plan), active: d.active_n, share: r2(d.share), trips_min: d.trips_min, why: d.counted ? null : d.why,
}));

/** Pure. One person's figures over a set of judged days: what they earned and
    were asked, the days they were active and drove, and the grid. */
export function tally(pk, days, dd) {
  const a = { gross: 0, target: 0, trips: 0, trips_target: 0, days_active: 0, days_driven: 0, days_off: 0 };
  const grid = [];
  for (const d of days) {
    const x = dd.byDay.get(d.day)?.get(pk) || null;
    const on = !!(d.counted && d.active.has(pk));
    const fares = x ? x.gross : 0;
    const trips = x ? x.trips : 0;
    grid.push({ fares: r2(fares), trips, active: d.active ? d.active.has(pk) : null, share: on ? r2(d.share) : null });
    if (!on) continue;
    a.days_active += 1;
    a.target += d.share;
    a.trips_target += d.trips_min;
    a.gross += fares;
    a.trips += trips;
    if (trips > 0) a.days_driven += 1; else a.days_off += 1;
  }
  return { ...a, pct: pctOf(a.gross, a.target), grid };
}
/** A tally as a page prints it, without the grid. */
const figures = (x) => ({ gross: r2(x.gross), target: r2(x.target), pct: x.pct, days_active: x.days_active,
  days_driven: x.days_driven, trips: x.trips, trips_target: x.trips_target });

/** The trend's three weeks, oldest first, the last ending on `end`. */
export function weeksOf(end) {
  return Array.from({ length: WEEKS }, (_, i) => {
    const e = addDays(end, -WEEK * (WEEKS - 1 - i));
    const s = addDays(e, -(WEEK - 1));
    return { from: s, to: e, label: `${shortDay(s)} – ${shortDay(e)}` };
  });
}

/** Pure. A move from span A to span B against everyone else's: improving,
    slipping or steady, or why it cannot be said. `a`, `b` a person's figures
    (pct, days_active) and labels; `ra`, `rb` everyone else's pct; `need` the
    active days each span asks for. */
export function verdictOf(a, b, ra, rb, need = WEEK_MIN_ACTIVE) {
  const none = (why) => ({ verdict: null, change: null, rest_change: null, relative: null, why });
  for (const w of [b, a]) {
    if (w.days_active < need) {
      return none(`Active on ${w.days_active} counted ${w.days_active === 1 ? 'day' : 'days'} of ${w.label} — `
        + `${need === 1 ? 'it needs one' : `a span needs ${need}`} to say.`);
    }
  }
  if (ra == null || rb == null) return none('Everyone else has no counted day in one of the two spans, so there is nothing to hold the change against.');
  const change = r1(b.pct - a.pct);
  const restChange = r1(rb - ra);
  const relative = r1(change - restChange);
  const verdict = relative >= TREND_POINTS ? 'improving' : relative <= -TREND_POINTS ? 'slipping' : 'steady';
  return { verdict, change, rest_change: restChange, relative, why: null };
}
export const trendOf = (weeks, rest) => verdictOf(weeks[WEEKS - 2], weeks[WEEKS - 1], rest[WEEKS - 2].pct, rest[WEEKS - 1].pct);

/** Pure. A set of tallies summed: gross against targets. */
const sumOf = (list) => {
  const g = list.reduce((s, x) => s + x.gross, 0);
  const t = list.reduce((s, x) => s + x.target, 0);
  return { people: list.length, gross: r2(g), target: r2(t), pct: pctOf(g, t) };
};

/** Pure. Who is in the population, and who the hotel and fleet settings
    hide: everyone active on a counted day of `days`. */
function populationOf(days, { dd, extras, hotel, fleet, keep = new Set() }) {
  const people = new Set();
  for (const d of days) if (d.counted) for (const pk of d.active) people.add(pk);
  const hidden = { hotel_only: 0, mostly_hotel: 0, other_fleet: 0 };
  const out = [];
  for (const pk of people) {
    const w = dd.who.get(pk) || {};
    const ex = extras.get(pk) || emptyExtras();
    const hotelShare = pctOf(ex.hotel_w, ex.bookings_w);
    const hotelOnly = ex.bookings_w > 0 && ex.hotel_w === ex.bookings_w;
    if (!keep.has(pk)) {
      if (fleet && w.fleet !== fleet) { hidden.other_fleet += 1; continue; }
      if (hotelOnly && hotel !== 'show') { hidden.hotel_only += 1; continue; }
      if (!hotelOnly && hotel === 'mostly' && hotelShare != null && hotelShare > MOSTLY_HOTEL) { hidden.mostly_hotel += 1; continue; }
    }
    out.push({ pk, w, ex, hotelShare, hotelOnly });
  }
  return { pop: out, hidden };
}

/** Pure. A person's row: who they are and their figures over `days`. */
function rowOf(p, t, hours) {
  const { w, ex } = p;
  const h = hours.get(p.pk) || null;
  return {
    pk: p.pk, name: w.name || '(unnamed)', driver_ext_id: w.driver_ext_id || null, ids: ex.ids || [], fleet: w.fleet || null,
    plate: ex.plate || null, platforms: w.platforms || [],
    hotel_share: p.hotelShare, hotel_only: p.hotelOnly,
    gross: r2(t.gross), gross_target: r2(t.target), gross_short: r2(Math.max(0, t.target - t.gross)), gross_pct: t.pct,
    band: t.target > 0 && t.gross < t.target - 0.005 ? bandOf(t.pct) : null,
    days_active: t.days_active, days_driven: t.days_driven, days_off: t.days_off,
    per_day_driven: t.days_driven ? r2(t.gross / t.days_driven) : null,
    per_day_target: t.days_active ? r2(t.target / t.days_active) : null,
    trips: t.trips, trips_target: t.trips_target, trips_pct: pctOf(t.trips, t.trips_target),
    bookings: ex.bookings, completed: ex.completed, completion_pct: pctOf(ex.completed, ex.bookings),
    cash_bookings: ex.cash, cash_pct: pctOf(ex.cash, ex.bookings),
    by_platform: ex.by_platform,
    online_h: h ? r1(h.online_min / 60) : null, online_days: h ? h.online_days : 0,
    last_booking: ex.last_booking || null,
    days: t.grid,
  };
}

/** Pure. The whole answer, from loadLowperf's bundle. `hotel` one of
    HOTEL_MODES; `fleet` 'ecosine' | 'egari' | null. */
export function lowperfOf({ from, to, lo, today, min, months, dd, extras, hours, hotel = 'hide', fleet = null, notes = [] }) {
  const all = judgeDays({ lo, to, today, months, min });
  const period = all.filter((d) => d.day >= from);
  const counted = period.filter((d) => d.counted);
  /* The weeks end on the last day that can be judged: ending them on an
     unsettled yesterday would make the latest "week" six days long and
     compare it with a whole one. */
  const anchor = counted.length ? counted[counted.length - 1].day : to;
  const weekDefs = weeksOf(anchor);
  const weekDays = weekDefs.map((w) => all.filter((d) => d.day >= w.from && d.day <= w.to));

  const { pop, hidden } = populationOf(period, { dd, extras, hotel, fleet });
  for (const p of pop) {
    p.t = tally(p.pk, period, dd);
    p.weeks = weekDays.map((ds, i) => ({ ...weekDefs[i], ...tally(p.pk, ds, dd) }));
  }
  const below = pop.filter((p) => p.t.target > 0 && p.t.gross < p.t.target - 0.005);
  const belowSet = new Set(below.map((p) => p.pk));
  const rest = pop.filter((p) => !belowSet.has(p.pk));
  const yard = (list) => ({ ...sumOf(list.map((p) => p.t)),
    weeks: weekDefs.map((w, i) => sumOf(list.map((p) => p.weeks[i]))) });
  const restY = yard(rest);

  const rows = below.map((p) => ({
    ...rowOf(p, p.t, hours),
    weeks: p.weeks.map((x) => ({ gross: r2(x.gross), target: r2(x.target), pct: x.pct, days_active: x.days_active })),
    trend: verdictOf(p.weeks[WEEKS - 2], p.weeks[WEEKS - 1], restY.weeks[WEEKS - 2].pct, restY.weeks[WEEKS - 1].pct),
  }));
  /* Furthest behind first: the smallest share of target, then the most AED
     short, then the name — so the order is the same on every reload. */
  rows.sort((a, b) => a.gross_pct - b.gross_pct || b.gross_short - a.gross_short || a.name.localeCompare(b.name));

  const bands = Object.fromEntries(BANDS.map((b) => [b.key, rows.filter((r) => r.band === b.key).length]));
  const trend = { improving: 0, steady: 0, slipping: 0, unknown: 0 };
  for (const r of rows) trend[r.trend.verdict || 'unknown'] += 1;
  return {
    from, to, today, hotel, fleet, notes,
    trips_min: min,
    why: !period.length ? 'The period has no days in it.'
      : !counted.length ? 'No day of the period can be judged yet — each is named below with its reason.'
        : null,
    counted_days: counted.length,
    left_out: period.filter((d) => !d.counted).map((d) => ({ day: d.day, label: d.label, why: d.why })),
    days: publicDays(period),
    weeks: weekDefs.map((w, i) => ({ ...w, counted_days: weekDays[i].filter((d) => d.counted).length })),
    bands: BANDS,
    totals: {
      population: pop.length, below: rows.length, on_target: pop.length - rows.length,
      hidden_hotel_only: hidden.hotel_only, hidden_mostly_hotel: hidden.mostly_hotel, hidden_other_fleet: hidden.other_fleet,
      bands, trend,
      plan: r2(counted.reduce((s, d) => s + d.plan, 0)),
      /* Summed unrounded, then rounded once: a sum of figures each already
         rounded to the fils drifts (2,833.34 for two shares of 1,416.665). */
      below_gross: r2(below.reduce((s, p) => s + p.t.gross, 0)),
      below_target: r2(below.reduce((s, p) => s + p.t.target, 0)),
      below_short: r2(below.reduce((s, p) => s + (p.t.target - p.t.gross), 0)),
    },
    yardstick: { rest: restY, below: yard(below) },
    rows,
  };
}

export async function lowperfView(q, { from = null, to = null, hotel = 'hide', fleet = null, now = new Date(), today = null, min = null } = {}) {
  const day = today || dubaiDay(now);
  const p = periodOf({ from, to, today: day });
  const bundle = await loadLowperf(q, { from: p.from, to: p.to, today: day, now, min });
  return lowperfOf({ ...bundle, hotel: HOTEL_MODES.includes(hotel) ? hotel : 'hide',
    fleet: ['ecosine', 'egari'].includes(fleet) ? fleet : null, notes: p.notes });
}

/* ── a watch list, followed ──────────────────────────────────────────────── */
/* How far before the save the grid starts. */
export const WATCH_BEFORE = 14;

/** The spans a watch page compares. Default: the WATCH_BEFORE days before the
    save against the save day to yesterday. Either may be given as two days. */
export function spansOf({ saved, today, a = null, b = null }) {
  const yesterday = addDays(today, -1);
  const span = (x, dflt) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(String(x || ''));
    if (!m || !validDay(m[1]) || (m[2] && !validDay(m[2]))) return dflt;
    const f = m[1];
    const t = m[2] || m[1];
    return f <= t && t <= yesterday ? { from: f, to: t } : dflt;
  };
  const before = { from: addDays(saved, -WATCH_BEFORE), to: addDays(saved, -1) };
  const after = { from: saved, to: yesterday < saved ? saved : yesterday };
  const A = span(a, before);
  const B = span(b, after);
  const lab = (s) => (s.from === s.to ? shortDay(s.from) : `${shortDay(s.from)} – ${shortDay(s.to)}`);
  return { a: { ...A, label: lab(A) }, b: { ...B, label: lab(B) }, defaults: !a && !b };
}

/** Everything a watch page needs: the grid's days and both spans, read once. */
export async function loadWatch(q, { saved, a, b, today, now = new Date(), min = null }) {
  const yesterday = addDays(today, -1);
  let lo = [addDays(saved, -WATCH_BEFORE), a.from, b.from].sort()[0];
  const to = [yesterday, a.to, b.to].sort().pop();
  if (daysOver(lo, to).length > MAX_DAYS * 2) lo = addDays(to, -(MAX_DAYS * 2 - 1));
  const [days, extras, hours] = await Promise.all([
    loadDays(q, { lo, to, today, now, min }),
    loadExtras(q, { hotelFrom: addDays(lo, -(DRIVER_DAYS - 1)), from: lo, to }),
    loadHours(q, lo, to),
  ]);
  return { lo, to, today, ...days, extras, hours };
}

/** Pure. A saved list followed: each member day by day, both spans, and the
    move from one to the other against everyone else's. `members` are
    [{ pk, ids, name }] as saved. */
export function watchOf({ watch, members, a, b, lo, to, today, min, months, dd, extras, hours }) {
  const all = judgeDays({ lo, to, today, months, min });
  const inSpan = (s) => all.filter((d) => d.day >= s.from && d.day <= s.to);
  const A = inSpan(a);
  const B = inSpan(b);
  const gridFrom = addDays(watch.saved_day, -WATCH_BEFORE) < lo ? lo : addDays(watch.saved_day, -WATCH_BEFORE);
  const grid = all.filter((d) => d.day >= gridFrom);

  /* A member saved under a person key that a merge has since re-keyed is
     found by the platform accounts they held when saved. */
  const byId = new Map();
  for (const [pk, ex] of extras) for (const id of ex.ids || []) if (!byId.has(id)) byId.set(id, pk);
  const known = (pk) => dd.who.has(pk) || extras.has(pk);
  const found = [];
  const missing = [];
  for (const m of members) {
    const pk = known(m.pk) ? m.pk : (m.ids || []).map((id) => byId.get(id)).find(Boolean) || null;
    if (pk) found.push({ ...m, now: pk });
    else missing.push({ name: m.name || null, why: 'No booking under this person or any account they held when the list was saved, on any day shown.' });
  }
  const keep = new Set(found.map((m) => m.now));
  const { pop } = populationOf(all.filter((d) => (d.day >= a.from && d.day <= a.to) || (d.day >= b.from && d.day <= b.to)),
    { dd, extras, hotel: watch.hotel || 'hide', fleet: watch.fleet || null, keep });
  const rest = pop.filter((p) => !keep.has(p.pk));
  const need = (s) => Math.min(WEEK_MIN_ACTIVE, s.filter((d) => d.counted).length) || 1;
  const sA = { ...a, counted_days: A.filter((d) => d.counted).length };
  const sB = { ...b, counted_days: B.filter((d) => d.counted).length };
  const restA = sumOf(rest.map((p) => tally(p.pk, A, dd)));
  const restB = sumOf(rest.map((p) => tally(p.pk, B, dd)));

  const seen = new Set();
  const rows = [];
  for (const m of found) {
    if (seen.has(m.now)) continue;            // two saved entries a merge has made one person
    seen.add(m.now);
    const ex = extras.get(m.now) || emptyExtras();
    const w = dd.who.get(m.now) || { name: m.name };
    const hotelShare = pctOf(ex.hotel_w, ex.bookings_w);
    const p = { pk: m.now, w, ex, hotelShare, hotelOnly: ex.bookings_w > 0 && ex.hotel_w === ex.bookings_w };
    const g = tally(m.now, grid, dd);
    const ta = tally(m.now, A, dd);
    const tb = tally(m.now, B, dd);
    rows.push({
      ...rowOf(p, g, hours),
      saved_pk: m.pk, rekeyed: m.pk !== m.now, at_save: m.at_save || null,
      a: figures(ta), b: figures(tb),
      move: verdictOf({ ...ta, label: a.label }, { ...tb, label: b.label }, restA.pct, restB.pct, Math.min(need(A), need(B))),
    });
  }
  rows.sort((x, y) => (x.b.pct ?? Infinity) - (y.b.pct ?? Infinity) || x.name.localeCompare(y.name));
  const listA = sumOf(rows.map((r) => ({ gross: r.a.gross, target: r.a.target })));
  const listB = sumOf(rows.map((r) => ({ gross: r.b.gross, target: r.b.target })));
  const moves = { improving: 0, steady: 0, slipping: 0, unknown: 0 };
  for (const r of rows) moves[r.move.verdict || 'unknown'] += 1;
  const ch = (x, y) => (x.pct == null || y.pct == null ? null : r1(y.pct - x.pct));
  return {
    watch, today, from: gridFrom, to,
    a: sA, b: sB,
    days: publicDays(grid),
    list: { a: listA, b: listB, change: ch(listA, listB) },
    rest: { people: rest.length, a: restA, b: restB, change: ch(restA, restB) },
    moves,
    missing,
    rows,
  };
}
