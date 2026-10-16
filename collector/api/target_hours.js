/* TODAY'S TARGET, HOUR BY HOUR — revenue and trips, each against its own
   history.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-02, on the first page: "After that you can put in
   today's target, what target they should achieve within the specific hour
   of the day today to make sure we achieve the target in real time, and how
   much left for today. These are actionable data … every hour if they are on
   target or not based on hourly income of the day and possibilities.
   Including number of trips. These are separate panels each. Based on hourly
   historical trips for that hour, and what needs to be achieved based on
   that."

   THE HOURLY TARGET. Today's target (api/revenue_target.js: AED today needs,
   and active drivers × the trips minimum) is laid over the day the way the
   fleet's own days run: an hour's target = today's target × the share of a
   day's work that hour usually carries ON THIS WEEKDAY — the last 4 Sundays
   for a Sunday (since 2026-10-11; HOUR_WEEKS below; the 28 days pooled before
   that, and still when too few of them are on record) — by Dubai hour, fares
   for the revenue, completed trips for the trips. What
   that hour USUALLY does is printed beside it, so the gap between the usual
   and the target says how much harder than usual the hour has to work.

   ON TARGET OR NOT. An hour that has ended is over or under its own target.
   The running total says whether the day is: what the usual curve has done
   by the CUT (the current hour counted by the minutes gone) against what is
   done. The hours left share what is still to do in the same proportions —
   the CATCH-UP each must carry for the day to land — and the current hour's
   catch-up is for the minutes it has left.

   THE CUT IS THE DATA'S, NOT THE CLOCK'S. Bookings arrive with each
   collection run: on production at 10:59 the live strip's latest booking was
   10:27. Judged at 10:59 the fleet would read half an hour of trips behind
   with nothing wrong. So the day is judged at the last INTRADAY collection
   — the booking channels' `incremental` runs, which production runs together
   every half hour (Uber, Bolt and the hotel channel all finished within a
   minute of 11:01 on 2026-10-02) — and the page prints it. The nightly
   `catchup` re-reads the days gone and says nothing about today's progress,
   so it cannot move the cut, and nor can one channel left behind: the
   freshest cycle is the cut, and a channel that failed it shows as missing
   work on the page and as a failing source in the shell. A run stores its
   rows as it goes and writes its finish at the end: on production, the
   answer computed at 13:01 counted Uber trips that ended at 12:59 against a
   cut of 12:41, because the 13:01 run had stored them and not yet finished.
   Today is counted from every row stored, so the cut is the later of the
   last finished run and the newest row stored today (trip.ingested_at); with
   neither, the last booking counted stands in; never later than now.

   REPORTED, NOT REQUESTED. An hour holds the trips REQUESTED in it, and a
   provider files a trip only once it is over: on production, 161 Uber trips
   of 2026-10-01 were first collected 20 / 37 / 55 minutes (10th / median /
   90th percentile) after they were requested, and every one of the 28 days
   before it the same (docs/COVERAGE.md trap 47). The first build compared
   the day to the usual curve as if an hour were complete the minute it
   ended, and at 12:08 called 11:00–12:00 under and the day AED 2,344.78
   behind while half that hour's trips had not been filed yet. So the usual
   day is read as it was REPORTED: for each hour, the share of its final
   figure that had been collected by the cut's own clock time on each of the
   28 days (trip.ingested_at, which an upsert does not move; seenCurve). The
   day so far is judged against that; an hour that has ended is over as soon
   as it reaches its target — more can only add — and otherwise ARRIVING
   while a usual day would still add ARRIVING of it in the hour after the
   cut, judged "so far" against what the usual day had reported of it by now.
   Settled is not a fixed share: on production after 31fce4c, at 12:31, the
   usual day had 95.3–99.7% of the hours 00:00–10:00 in (fares; trips
   95.7–100%), the rest coming with the nightly catch-up or later, and a 98%
   line left 03:00 (97.8%) "arriving" nine hours on. A settled hour is judged against what the usual day had in of
   it by now too, so that remainder never counts against it; the shortfall
   it prints is against its target, as the table's columns read. Days whose
   rows were not collected live (a restore, a backfill) are left out of the
   timing; with fewer than HISTORY_MIN_DAYS live days the clock stands in,
   and the panel says so.

   REVENUE TODAY IS AN ESTIMATE, AND SAYS SO. Uber publishes a day's fares hours behind the ride (fetched hourly), so
   the latest hours' fares are not on record yet. The page's live strip already
   values the unpriced bookings at each channel's per-booking rate over its
   settled days (api/day_routes.js buildDay); that very estimate is spread
   over the hours here, each channel's projected value in proportion to its
   unpriced bookings in each hour, so the hours add up to exactly the strip's
   "≈ trip value" — two figures on one screen that cannot disagree. Trips are
   counted as they are collected; `latest_at` says how fresh that is.

   No revenue target set: the revenue panel is absent with that reason; the
   trips minimum always exists. Fewer than 7 days of history: no hourly
   target, said so. */
import { monthTarget, addDays, BOOKING_SOURCES } from './revenue_target.js';
import { buildDay } from './day_routes.js';
import { spreadByHour } from './projection_sql.js';
import { dubaiDay } from './window.js';

export const HISTORY_DAYS = 28;
export const HISTORY_MIN_DAYS = 7;
/* THE SAME WEEKDAY (the operator, 2026-10-11: the distribution "hourly and
   daily based on previous performance … A historically bad day on a Sunday
   can't be expected to perform the same way as weekday"). A Sunday's hours
   are shared the way the last HOUR_WEEKS Sundays ran, not the way the last 28
   days ran pooled. Back-tested on production's bookings, every day from 17
   Aug to 9 Oct 2026 (40 days with a full history), the share of the day put
   in the wrong hours: pooled 28 days 10.7%, the same weekday over the last 4
   weeks 9.3%, over the last 8 weeks 10.3%, half of each 9.9% — the gain is
   largest at the weekend (Saturday 12.1% → 9.6%, Sunday 13.9% → 11.5%), and
   8 weeks was worse than 4 because the fleet nearly doubled in September.
   Fewer than HOUR_MIN_DAYS of those days on record (a new fleet, a gap) and
   the pooled 28 days stand in, and the panel says which it used. When a
   trip REACHES us (seenCurve) is not a weekday matter and stays pooled. */
export const HOUR_WEEKS = 4;
export const HOUR_MIN_DAYS = 3;
/* An hour that ended is still arriving while a usual day would add at
   least this share of it in the hour after the cut. */
export const ARRIVING = 0.02;
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (d) => { const t = new Date(`${d}T12:00:00Z`); return `${t.getUTCDate()} ${MON[t.getUTCMonth()]}`; };

/* One metric's usual day from rows {d, h, v}: the same weekday as `today`
   over the last HOUR_WEEKS weeks when HOUR_MIN_DAYS of them are on record,
   else every day of the span pooled. `basis.text` is the phrase the pages
   print after "that hour carried". */
export function shapeOf(rows, { today, from, to }) {
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.d)) byDay.set(r.d, Array(24).fill(0));
    byDay.get(r.d)[r.h] += Number(r.v) || 0;
  }
  const held = [...byDay.entries()].filter(([, v]) => v.some((x) => x > 0));
  const add = (days) => days.reduce((acc, [, v]) => acc.map((x, h) => x + v[h]), Array(24).fill(0));
  const want = Array.from({ length: HOUR_WEEKS }, (_, i) => addDays(today, -7 * (i + 1)));
  const same = held.filter(([d]) => want.includes(d)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const weekday = WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];
  const useSame = same.length >= HOUR_MIN_DAYS;
  const pick = useSame ? same : held;
  const tot = add(pick);
  const T = tot.reduce((s, v) => s + v, 0);
  const n = pick.length;
  const basis = useSame
    ? { kind: 'weekday', weekday, days: n, dates: same.map(([d]) => d), from: same[0][0], to: same[n - 1][0],
      text: n === HOUR_WEEKS
        ? `on the last ${n} ${weekday} (${dm(same[0][0])} – ${dm(same[n - 1][0])})`
        : `on ${n} of the last ${HOUR_WEEKS} ${weekday} (${dm(same[0][0])} – ${dm(same[n - 1][0])}; `
          + `${want.filter((d) => !same.some(([x]) => x === d)).sort().map(dm).join(', ')} not on record)` }
    : { kind: 'pooled', days: n, from, to,
      text: `over the last ${n} ${n === 1 ? 'day' : 'days'} (${from} to ${to})`,
      why: `Only ${same.length} of the last ${HOUR_WEEKS} ${weekday} ${same.length === 1 ? 'is' : 'are'} on record, so the hours are shared the way every day of the last ${HISTORY_DAYS} ran.` };
  return { days: n, from: basis.from, to: basis.to, ok: (useSame || n >= HISTORY_MIN_DAYS) && T > 0,
    share: tot.map((v) => (T ? v / T : 0)), usual: tot.map((v) => (n ? v / n : 0)), basis };
}

/** The usual day, by Dubai hour, before `today`: completed trips (to
    yesterday) and fares (to the day before yesterday, which Uber has priced
    by now) — today's weekday over the last HOUR_WEEKS weeks (shapeOf). */
export async function usualDay(q, today) {
  const tripsTo = addDays(today, -1);
  const faresTo = addDays(today, -2);
  const from = addDays(today, -HISTORY_DAYS);
  const faresFrom = addDays(faresTo, -(HISTORY_DAYS - 1));
  const [trips, fares] = await Promise.all([
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS d, n.local_hour AS h, count(*)::int AS v
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.outcome = 'completed'
        GROUP BY 1, 2`, [from, tripsTo]),
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS d, n.local_hour AS h,
              coalesce(sum(n.price) FILTER (WHERE n.has_fare), 0)::float AS v
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
        GROUP BY 1, 2`, [faresFrom, faresTo]),
  ]);
  /* `window` is the whole span read — what seenCurve pools over, since when
     a trip reaches us does not depend on the weekday. */
  return {
    trips: { ...shapeOf(trips, { today, from, to: tripsTo }), window: { from, to: tripsTo } },
    fares: { ...shapeOf(fares, { today, from: faresFrom, to: faresTo }), window: { from: faresFrom, to: faresTo } },
  };
}

/** How much of each hour a usual day had REPORTED by the cut's clock time
    (`seen`) and an hour after it (`next`): per Dubai hour, the share of its
    completed trips (or, `fares`, of its fares) that had been collected by
    that time of day on that day, pooled
    over the days from..to whose rows were collected live — at least half of
    the day's bookings first collected within a day of being requested. A
    day restored or backfilled carries its restore's time, which says
    nothing about when a trip reaches us. null with fewer than
    HISTORY_MIN_DAYS such days. Same clock k days back is the cut less k
    whole days: Dubai keeps no daylight saving. */
export async function seenCurve(q, { from, to, today, cut, fares = false }) {
  const rows = await q(
    `WITH b AS (
       SELECT n.local_day AS d, n.local_hour AS h, n.ingested_at AS ing,
              ${fares ? 'n.price::float' : '1::float'} AS w,
              (n.ingested_at IS NOT NULL AND n.ingested_at < n.requested_at + interval '1 day') AS live
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.requested_at IS NOT NULL
          AND ${fares ? 'n.has_fare' : "n.outcome = 'completed'"}
     ), days AS (
       SELECT d FROM b GROUP BY d HAVING avg(CASE WHEN live THEN 1 ELSE 0 END) >= 0.5
     )
     SELECT b.h, sum(b.w)::float AS tot,
            coalesce(sum(b.w) FILTER (WHERE b.ing <= $3::timestamptz - ($4::date - b.d) * interval '1 day'), 0)::float AS seen,
            coalesce(sum(b.w) FILTER (WHERE b.ing <= $3::timestamptz + interval '1 hour' - ($4::date - b.d) * interval '1 day'), 0)::float AS next,
            (SELECT count(*) FROM days)::int AS days
       FROM b JOIN days USING (d)
      GROUP BY b.h`, [from, to, cut.toISOString(), today]);
  const days = rows[0]?.days || 0;
  if (days < HISTORY_MIN_DAYS) return { days, seen: null, next: null };
  const seen = Array(24).fill(0);
  const next = Array(24).fill(0);
  const frac = (v, tot) => (tot > 0 ? Math.min(1, Math.max(0, v / tot)) : 0);
  for (const r of rows) { seen[r.h] = frac(r.seen, r.tot); next[r.h] = frac(r.next, r.tot); }
  return { days, seen, next };
}

/* Today's work so far, by hour: completed trips, and fares on record with
   each channel's bookings that carry none yet. */
async function todayByHour(q, today) {
  return q(`SELECT n.local_hour AS h, n.platform,
                   count(*)::int AS bookings,
                   count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed,
                   count(*) FILTER (WHERE n.has_fare)::int AS priced,
                   coalesce(sum(n.price) FILTER (WHERE n.has_fare), 0)::float AS fares,
                   max(n.requested_at) AS latest, max(n.ingested_at) AS stored
              FROM trip_norm n
             WHERE n.local_day = $1::date AND n.is_booking
             GROUP BY 1, 2`, [today]);
}

/* One panel's hours: the target, the usual, what is done, on target or not,
   and what the hours left must carry. `cur` is the current hour and `gone`
   the fraction of it gone; `done[h]` what each hour has done. `seen[h]`, when
   history has it (seenCurve), is how much of hour h a usual day had reported
   by the cut, and `next[h]` an hour later; without them the clock stands in —
   every hour gone whole, this one by the minutes gone. */
export function hoursOf({ target, share, usual, done, cur, gone, seen = null, next = null, money = false }) {
  const R = money ? r2 : r1;
  const eps = money ? 0.005 : 1e-9;
  const need = share.map((s) => target * s);
  const vis = share.map((_, h) => (h > cur ? 0 : seen ? Math.min(1, Math.max(0, seen[h] || 0)) : h < cur ? 1 : gone));
  const doneSoFar = done.reduce((s, v, h) => s + (h <= cur ? v : 0), 0);
  /* Due by now: what the usual day, scaled to the target, had REPORTED by
     this clock — like against like, since today is read the same way. */
  const needByNow = need.reduce((s, v, h) => s + v * vis[h], 0);
  const left = Math.max(0, target - doneSoFar);
  /* What is still to do, shared over what is left of the day in the usual
     day's proportions: what this hour has still to report, then every hour
     after it. What the hours just gone have still to report counts when it
     lands, and `left` falls with it — so this asks the hours to come for all
     of it, never less than the day needs. */
  const restShare = share.reduce((s, v, h) => s + (h > cur ? v : h === cur ? v * (1 - vis[h]) : 0), 0);
  let cumNeed = 0;
  let cumDone = 0;
  const hours = share.map((s, h) => {
    cumNeed += need[h];
    if (h <= cur) cumDone += done[h];
    const expect = need[h] * vis[h];
    const coming = seen && next ? Math.max(0, Math.min(1, next[h] || 0) - vis[h]) : 0;
    /* An hour gone that asked nothing and did nothing is neither: "on
       target" over two zeros is a claim about nothing. Over is final the
       moment it is reached — a late report only adds. Otherwise, while the
       usual day would still add ARRIVING of it within the hour, it is still
       arriving, judged so far; after that it is settled, and judged against
       what the usual day had in of it by now — on the clock, all of it. */
    const state = h > cur ? 'future' : h === cur ? 'now'
      : !need[h] && !done[h] ? 'idle'
        : done[h] >= need[h] - eps ? 'over'
          : coming >= ARRIVING ? 'arriving'
            : done[h] >= expect - eps ? 'over' : 'under';
    const catchUp = h < cur || !restShare ? null
      : left * (h === cur ? s * (1 - vis[h]) : s) / restShare;
    return {
      h, label: `${String(h).padStart(2, '0')}:00`, share: Math.round(s * 10000) / 10000,
      usual: R(usual[h]), need: R(need[h]), done: h <= cur ? R(done[h]) : null,
      diff: h < cur ? R(done[h] - (state === 'arriving' ? expect : need[h])) : null, state,
      so_far: state === 'arriving' ? (done[h] >= expect - eps ? 'over' : 'under') : null,
      expect: h <= cur ? R(expect) : null,
      reported: h <= cur ? Math.round(vis[h] * 1000) / 1000 : null,
      cum_need: R(cumNeed), cum_done: h <= cur ? R(cumDone) : null,
      catch_up: catchUp == null ? null : R(catchUp),
    };
  });
  return {
    target: R(target), done: R(doneSoFar), left: R(left), need_by_now: R(needByNow),
    ahead: R(doneSoFar - needByNow), met: doneSoFar >= target,
    usual_day: R(usual.reduce((s, v) => s + v, 0)), hours,
    this_hour: hours[cur] ? { label: `${hours[cur].label}–${String((cur + 1) % 24).padStart(2, '0')}:00`,
      need: hours[cur].need, catch_up: hours[cur].catch_up, done: hours[cur].done, usual: hours[cur].usual,
      expect: hours[cur].expect } : null,
    arriving: hours.filter((r) => r.state === 'arriving').length,
  };
}

/** When today's bookings are counted to: the last intraday collection of
    any booking channel today. */
async function collectedTo(q, today) {
  const [r] = await q(
    `SELECT max(finished_at) AS fin FROM collection_run
      WHERE source = ANY($1::text[]) AND mode = 'incremental' AND status IN ('ok', 'partial')
        AND finished_at >= $2::timestamptz`, [BOOKING_SOURCES, `${today}T00:00:00+04:00`]);
  return r && r.fin ? new Date(r.fin) : null;
}
const hhmm = (d) => new Date(d.getTime() + 4 * 3600e3).toISOString().slice(11, 16);
const countDays = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Everything the first page's two hourly panels print. */
export async function targetHours(q, { now = new Date(), min = null } = {}) {
  const today = dubaiDay(now);
  const [t, usual, rows, day, ran] = await Promise.all([
    monthTarget(q, { today, now, min }),
    usualDay(q, today),
    todayByHour(q, today),
    buildDay(q, today).catch(() => null),
    collectedTo(q, today),
  ]);
  const newest = (k) => rows.reduce((m, r) => (r[k] && (!m || new Date(r[k]) > m) ? new Date(r[k]) : m), null);
  const latestBooking = newest('latest');
  const stored = newest('stored');
  const byRows = stored && (!ran || stored > ran);
  const cutAt = [(byRows ? stored : ran) || latestBooking || now, now].reduce((a, b) => (a < b ? a : b));
  const local = new Date(cutAt.getTime() + 4 * 3600e3);
  const sameDay = local.toISOString().slice(0, 10) === today;
  const cur = sameDay ? local.getUTCHours() : 0;
  const gone = sameDay ? (local.getUTCMinutes() * 60 + local.getUTCSeconds()) / 3600 : 0;
  const clock = sameDay ? hhmm(cutAt) : '00:00';
  const td = t.days.find((d) => d.state === 'today') || null;
  /* How much of each hour a usual day had reported by this clock. Before
     today's first collection nothing of today is due yet. */
  const none = { days: null, seen: Array(24).fill(0), next: Array(24).fill(0) };
  const [tSeen, fSeen] = sameDay ? await Promise.all([
    seenCurve(q, { from: usual.trips.window.from, to: usual.trips.window.to, today, cut: cutAt }),
    seenCurve(q, { from: usual.fares.window.from, to: usual.fares.window.to, today, cut: cutAt, fares: true }),
  ]) : [none, none];
  const timing = (x, what) => (x.seen ? { days: x.days }
    : { days: x.days || 0, why: `When ${what} reach us is on record for ${countDays(x.days || 0)} collected live, `
      + `fewer than the ${HISTORY_MIN_DAYS} needed, so the day is read by the clock: an hour that has ended is judged `
      + 'whole, though its last trips may still be on their way.' });

  /* Trips done, by hour. */
  const tripsDone = Array(24).fill(0);
  for (const r of rows) tripsDone[r.h] += r.completed;
  /* Revenue done, by hour: fares on record, and the live strip's own
     projection for each channel spread over that channel's unpriced bookings. */
  const faresDone = Array(24).fill(0);
  for (const r of rows) faresDone[r.h] += Number(r.fares);
  const parts = day?.headline?.projection_parts || [];
  spreadByHour(parts, rows).forEach((v, h) => { faresDone[h] += v; });
  const projected = parts.reduce((s, p) => s + (Number(p.value) || 0), 0);

  const revenue = !t.summary || t.summary.today_needs == null
    ? { absent: t.why || 'No revenue target is set for today.' }
    : !usual.fares.ok
      ? { absent: `An hour's revenue target needs ${HISTORY_MIN_DAYS} days of priced fares to learn the usual day from; `
        + `${usual.fares.days} ${usual.fares.days === 1 ? 'is' : 'are'} on record.` }
      : { ...hoursOf({ target: t.summary.today_needs, share: usual.fares.share, usual: usual.fares.usual,
        done: faresDone, cur, gone, seen: fSeen.seen, next: fSeen.next, money: true }),
      estimate: projected > 0, projected: r2(projected), measured: r2(rows.reduce((s, r) => s + Number(r.fares), 0)),
      basis: usual.fares.basis,
      timing: timing(fSeen, 'fares') };
  const trips = !td || !td.trips_target
    ? { absent: 'Nobody has completed a trip in the last 8 days, so today asks for none.' }
    : !usual.trips.ok
      ? { absent: `An hour's trips target needs ${HISTORY_MIN_DAYS} days of completed trips to learn the usual day from; `
        + `${usual.trips.days} ${usual.trips.days === 1 ? 'is' : 'are'} on record.` }
      : { ...hoursOf({ target: td.trips_target, share: usual.trips.share, usual: usual.trips.usual,
        done: tripsDone, cur, gone, seen: tSeen.seen, next: tSeen.next }),
      active: td.active_drivers, min: td.trips_min, min_average: t.trips_min, min_weight: td.trips_weight,
      basis: usual.trips.basis,
      timing: timing(tSeen, 'trips') };
  return {
    today, clock, hour: cur, now_clock: hhmm(now), at: now.toISOString(), cut_at: cutAt.toISOString(),
    cut_by: byRows ? 'received' : ran ? 'collection' : latestBooking ? 'last_booking' : 'clock',
    lag_min: Math.round((now - cutAt) / 60000),
    latest_at: latestBooking ? latestBooking.toISOString() : null,
    month: t.month, month_name: t.month_name, revenue, trips,
  };
}
