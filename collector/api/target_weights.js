/* THE MONTH SHARED BY WEEKDAY — what each day of the week is asked, learned
   from the fleet's own weeks.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-11: "I think the target distribution makes more sense
   hourly and daily based on previous performance. A historically bad day on a
   Sunday can't be expected to perform the same way as weekday." That replaces
   the EQUAL split chosen on 2026-10-02 (docs/COVERAGE.md, "The monthly revenue
   target"), which asked a Sunday for exactly what it asked a Thursday.

   MEASURED BEFORE BUILDING IT (production, /api/trips/daily, 2026-10-11).
   Each day's fares against its own week's average day — so a fleet that grew
   from 12,000 completed trips a month to 21,000 over those weeks does not read
   as "later weekdays are better" — averaged by weekday over the 8 complete
   weeks to Sun 4 Oct:
       fares   Mon 0.942  Tue 1.026  Wed 1.044  Thu 1.133  Fri 1.126  Sat 0.945  Sun 0.783
       trips   Mon 0.933  Tue 1.036  Wed 1.041  Thu 1.128  Fri 1.126  Sat 0.940  Sun 0.796
   The shape has held all year: Sep 2025 – Feb 2026 read Sun 0.767, Thu 1.135.
   Back-tested on every week from Oct 2025 to Jan 2026 and Aug to Sep 2026 —
   each day's share of its week, predicted from the N weeks before that week —
   the equal split misses by 10.5–11.2% on average; weights learned from 4 to
   26 weeks miss by 5.8–6.8%, and the window barely matters inside that range.
   EIGHT weeks: long enough that one odd week is an eighth of the answer,
   short enough to follow a fleet that changes (it nearly doubled in
   September 2026).

   THE RULE.
     · A WEEK is Monday to Sunday, complete, and over before the day the
       weights are learned for. Each of its days is divided by the week's
       average day; a weekday's weight is the mean of those over the weeks
       used. Each metric's seven weights average exactly 1 — so "AED a car a
       day" stays the AED a car on an AVERAGE day, and a week's total is
       unchanged by the weighting.
     · A week is LEFT OUT when any day in it brought under GAP_SHARE of the
       week's average day, in fares or in completed trips: that is a break in
       what was collected, not a quiet Sunday — and one such day would read
       as a weekday that earns nothing. Each week left out is named with its
       day.
     · Fewer than WEIGHT_MIN_WEEKS usable weeks: no weights. Every day is
       asked the same, and the page says why — a figure that cannot be
       learned is absent with its reason, never invented.
     · Holidays are not known to this rule. National Day, Eid and New Year
       move a week by up to 84% (the worst weeks of the back-test); a weekday
       weight cannot see them coming, and the day will read under or over
       for that reason.

   WHERE THEY APPLY.
     · The REVENUE target: each save learns its weights from the 8 weeks
       before the day it is made, stores them on its row
       (revenue_target.weights), and shares what it spreads by them
       (api/revenue_target.js). A save made before this rule stays the equal
       split it was: a day is always judged against what it was asked.
     · The TRIPS minimum (the Access page's low_trips_min, 12): the minimum on
       an average day. A day asks round(minimum × its weekday's trips weight),
       a whole number of trips, of every driver active on it — at 12 and the
       weights above: Sun 10, Mon 11, Tue 12, Wed 12, Thu 14, Fri 14, Sat 11,
       84 a week, exactly 7 × 12. One row per month in target_weights, frozen
       the first time the month is read on or after its first weighted day,
       so a Sunday's minimum never moves under a driver mid-month. The Target
       page, the Month target page, the 13:00/18:00 goal texts and the 08:00
       email all read that one number for a day (minimumOn), so none of them
       can ask a driver for something another does not.
     · From WEIGHTED_FROM: the day the operator ruled. The days of October
       before it keep the equal plans they were judged against. */

export const WEIGHT_WEEKS = 8;
export const WEIGHT_MIN_WEEKS = 4;
/* A day under this share of its week's average day is a gap, not a quiet day.
   Measured over every week from July 2025 to September 2026: the quietest
   days against their week were Sun 1 Feb 2026 (0.54) and late-Ramadan days
   near 0.6. The one day below 0.4 — Sun 1 Mar 2026 at 0.27, Yango silent —
   is where collected trips fell from about 700 a day to about 200 and stayed:
   a break, and a week that straddles one teaches nothing about weekdays. */
export const GAP_SHARE = 0.4;
export const WEIGHTED_FROM = '2026-10-11';
/* The newest week must have ENDED this many days before the day it is
   learned for. Uber prices a day overnight and sometimes most of a day later
   (fetched hourly; the 01:00 catch-up re-reads days gone), so a Sunday read
   on the Monday after is still filling: a month starting on a Monday froze
   its weights at about 00:00 from a Sunday seconds old, and 5% of Sunday
   still to come turns Sunday's 10 trips into 9 for the whole month
   (independent review, 2026-10-11). Two days: a Monday learns from the
   weeks to the Sunday before last. */
export const SETTLE_DAYS = 2;

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const dowOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const short = (d) => { const t = new Date(`${d}T12:00:00Z`); return `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`; };
const daysIn = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** The complete Monday-to-Sunday weeks that ended at least SETTLE_DAYS
    before `before`, newest first. */
export function weeksBefore(before, n = WEIGHT_WEEKS) {
  let sun = addDays(before, -SETTLE_DAYS);
  while (dowOf(sun) !== 0) sun = addDays(sun, -1);
  return Array.from({ length: n }, (_, i) => { const s = addDays(sun, -7 * i); return { mon: addDays(s, -6), sun: s }; });
}

/** Pure. `series` maps a Dubai day to {fares, completed}; the weights for a
    span that starts on `before`. Index 0 is Sunday (getUTCDay). */
export function weekdayWeights(series, before, { weeks = WEIGHT_WEEKS, min = WEIGHT_MIN_WEEKS } = {}) {
  const ws = weeksBefore(before, weeks);
  const sum = { fares: Array(7).fill(0), trips: Array(7).fill(0) };
  const used = [];
  const skipped = [];
  for (const w of ws) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(w.mon, i));
    const f = days.map((d) => Number(series.get(d)?.fares) || 0);
    const t = days.map((d) => Number(series.get(d)?.completed) || 0);
    const fm = f.reduce((s, v) => s + v, 0) / 7;
    const tm = t.reduce((s, v) => s + v, 0) / 7;
    const gap = days.findIndex((_, i) => !(f[i] >= GAP_SHARE * fm && fm > 0) || !(t[i] >= GAP_SHARE * tm && tm > 0));
    if (gap >= 0) {
      const share = fm > 0 ? f[gap] / fm : 0;
      skipped.push({ mon: w.mon, sun: w.sun, day: days[gap],
        why: `${short(days[gap])} brought ${Math.round(100 * Math.min(share, tm > 0 ? t[gap] / tm : 0))}% of its week’s average day — a gap in what was collected, not a quiet day` });
      continue;
    }
    days.forEach((d, i) => { sum.fares[dowOf(d)] += f[i] / fm; sum.trips[dowOf(d)] += t[i] / tm; });
    used.push({ mon: w.mon, sun: w.sun });
  }
  const basis = { weeks, used: used.length, from: ws[ws.length - 1].mon, to: ws[0].sun, before, skipped };
  if (used.length < min) {
    return { ok: false, fares: null, trips: null,
      basis: { ...basis, why: `Only ${used.length} of the ${weeks} weeks before ${short(before)} were whole enough to learn the `
        + `weekdays from (${min} are needed), so every day is asked the same.` } };
  }
  const norm = (a) => {
    const avg = a.map((v) => v / used.length);
    const mean = avg.reduce((s, v) => s + v, 0) / 7;
    return avg.map((v) => r4(v / mean));
  };
  return { ok: true, fares: norm(sum.fares), trips: norm(sum.trips), basis };
}

/** Fares and completed trips by Dubai day — the same definitions the month's
    arithmetic reads (api/revenue_target.js loadFacts). */
export async function loadSeries(q, from, to) {
  const rows = await q(
    `SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
            coalesce(sum(n.price) FILTER (WHERE n.has_fare), 0)::float AS fares,
            count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed
       FROM trip_norm n
      WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
      GROUP BY 1`, [from, to]);
  return new Map(rows.map((r) => [r.day, { fares: Number(r.fares), completed: Number(r.completed) }]));
}

/** The weights a span starting on `before` is shared by, from the database. */
export async function learnWeights(q, before) {
  const ws = weeksBefore(before);
  return weekdayWeights(await loadSeries(q, ws[ws.length - 1].mon, ws[0].sun), before);
}

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** A month's trips weights: the frozen row, or — the first time the month is
    read on or after its first weighted day BY THE REAL CLOCK — learned and
    frozen; before that, learned and NOT frozen (a month looked at in
    advance, or through an ?asof= in the future, which the first build froze
    from weeks that had not happened yet). null for a month wholly before the
    rule. The rule's first day is the day the first month was frozen — the
    deploy — so the trips minimum and the revenue re-shape (which runs at
    that boot and freezes its month here) start on the same day, whatever day
    the deploy lands; WEIGHTED_FROM is only its floor. */
export async function monthWeights(q, month, { now = new Date() } = {}) {
  const first = `${month}-01`;
  const last = addDays(first, daysIn(month) - 1);
  const realToday = new Date(now.getTime() + 4 * 3600e3).toISOString().slice(0, 10);   // Dubai keeps UTC+4
  const read = async () => {
    const [r] = await q(`SELECT to_char(from_day, 'YYYY-MM-DD') AS from_day, trips, fares, basis
                           FROM target_weights WHERE month = $1::date`, [first]);
    return r ? { month, from_day: r.from_day, trips: parse(r.trips), fares: parse(r.fares), basis: parse(r.basis), frozen: true } : null;
  };
  const kept = await read();
  if (kept) return kept;
  const [st] = await q(`SELECT to_char(min(from_day), 'YYYY-MM-DD') AS d FROM target_weights`);
  const ruleStart = st?.d || (realToday > WEIGHTED_FROM ? realToday : WEIGHTED_FROM);
  if (last < ruleStart) return null;
  const from = first > ruleStart ? first : ruleStart;
  const lw = await learnWeights(q, from);
  const out = { month, from_day: from, trips: lw.ok ? lw.trips : null, fares: lw.ok ? lw.fares : null, basis: lw.basis, frozen: false };
  if (realToday < from) return out;
  await q(`INSERT INTO target_weights (month, from_day, trips, fares, basis) VALUES ($1::date, $2::date, $3::jsonb, $4::jsonb, $5::jsonb)
           ON CONFLICT (month) DO NOTHING`,
  [first, from, out.trips ? JSON.stringify(out.trips) : null, out.fares ? JSON.stringify(out.fares) : null, JSON.stringify(out.basis)]);
  return (await read()) || out;
}

/** The trips a day asks of each active driver: the minimum on an average day
    × the day's weekday weight, a whole number, never below 1. */
export function minimumOn(base, mw, day) {
  if (!mw || !mw.trips || day < mw.from_day) return { min: base, weight: 1, weighted: false };
  const w = Number(mw.trips[dowOf(day)]) || 1;
  return { min: Math.max(1, Math.round(base * w)), weight: w, weighted: true };
}

/** The share of a save's AED a car a day that `day` is asked for. */
export const weightOf = (save, day) => (save && Array.isArray(save.weights) ? Number(save.weights[dowOf(day)]) || 1 : 1);

/** "Mon 0.94 · Tue 1.03 · …" — Monday first, the way the fleet reads a week. */
export const weightsLine = (w) => (Array.isArray(w)
  ? [1, 2, 3, 4, 5, 6, 0].map((i) => `${WD[i]} ${Number(w[i]).toFixed(2)}`).join(' · ') : null);

/** "12 on an average day — Mon 11, Tue 12, … Sun 10", or "12 a day" with no
    weights: the one way every page, file and email words the minimum. */
export function minimumWords(base, weights) {
  if (!Array.isArray(weights)) return `${base} a day`;
  const per = [1, 2, 3, 4, 5, 6, 0].map((i) => `${WD[i]} ${Math.max(1, Math.round(base * Number(weights[i])))}`).join(', ');
  return `${base} on an average day — ${per}`;
}
