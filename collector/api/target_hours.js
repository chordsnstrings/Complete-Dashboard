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
   day's work that hour usually carries, measured over the last 28 days by
   Dubai hour — fares for the revenue, completed trips for the trips. What
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
   work on the page and as a failing source in the shell. With no intraday
   run today, the last booking counted stands in; never later than now.

   REVENUE TODAY IS AN ESTIMATE, AND SAYS SO. Uber prices a day overnight, so
   most of today's fares are not on record yet. The page's live strip already
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
import { dubaiDay } from './window.js';

export const HISTORY_DAYS = 28;
export const HISTORY_MIN_DAYS = 7;
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** The usual day, by Dubai hour, over the HISTORY_DAYS before `today`:
    completed trips (to yesterday) and fares (to the day before yesterday,
    which Uber has priced by now). */
export async function usualDay(q, today) {
  const tripsTo = addDays(today, -1);
  const faresTo = addDays(today, -2);
  const from = addDays(today, -HISTORY_DAYS);
  const faresFrom = addDays(faresTo, -(HISTORY_DAYS - 1));
  const [trips, fares, [td], [fd]] = await Promise.all([
    q(`SELECT n.local_hour AS h, count(*)::int AS n
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.outcome = 'completed'
        GROUP BY 1`, [from, tripsTo]),
    q(`SELECT n.local_hour AS h, coalesce(sum(n.price) FILTER (WHERE n.has_fare), 0)::float AS aed
         FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
        GROUP BY 1`, [faresFrom, faresTo]),
    q(`SELECT count(DISTINCT n.local_day)::int AS days FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.outcome = 'completed'`, [from, tripsTo]),
    q(`SELECT count(DISTINCT n.local_day)::int AS days FROM trip_norm n
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.has_fare`, [faresFrom, faresTo]),
  ]);
  const tripDays = td?.days || 0;
  const fareDays = fd?.days || 0;
  const tn = Array(24).fill(0);
  const fa = Array(24).fill(0);
  for (const r of trips) tn[r.h] = r.n;
  for (const r of fares) fa[r.h] = Number(r.aed);
  const tTot = tn.reduce((s, v) => s + v, 0);
  const fTot = fa.reduce((s, v) => s + v, 0);
  return {
    trips: { days: tripDays, from, to: tripsTo, ok: tripDays >= HISTORY_MIN_DAYS && tTot > 0,
      share: tn.map((v) => (tTot ? v / tTot : 0)), usual: tn.map((v) => (tripDays ? v / tripDays : 0)) },
    fares: { days: fareDays, from: faresFrom, to: faresTo, ok: fareDays >= HISTORY_MIN_DAYS && fTot > 0,
      share: fa.map((v) => (fTot ? v / fTot : 0)), usual: fa.map((v) => (fareDays ? v / fareDays : 0)) },
  };
}

/* Today's work so far, by hour: completed trips, and fares on record with
   each channel's bookings that carry none yet. */
async function todayByHour(q, today) {
  return q(`SELECT n.local_hour AS h, n.platform,
                   count(*)::int AS bookings,
                   count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed,
                   count(*) FILTER (WHERE n.has_fare)::int AS priced,
                   coalesce(sum(n.price) FILTER (WHERE n.has_fare), 0)::float AS fares,
                   max(n.requested_at) AS latest
              FROM trip_norm n
             WHERE n.local_day = $1::date AND n.is_booking
             GROUP BY 1, 2`, [today]);
}

/* One panel's hours: the target, the usual, what is done, on target or not,
   and what the hours left must carry. `cur` is the current hour and `gone`
   the fraction of it gone; `done[h]` what each hour has done. */
export function hoursOf({ target, share, usual, done, cur, gone, money = false }) {
  const R = money ? r2 : r1;
  const need = share.map((s) => target * s);
  const doneSoFar = done.reduce((s, v, h) => s + (h <= cur ? v : 0), 0);
  const needByNow = need.reduce((s, v, h) => s + (h < cur ? v : h === cur ? v * gone : 0), 0);
  const left = Math.max(0, target - doneSoFar);
  /* What is still to do, shared over what is left of the day in the usual
     day's proportions: the rest of this hour, then every hour after it. */
  const restShare = share.reduce((s, v, h) => s + (h > cur ? v : h === cur ? v * (1 - gone) : 0), 0);
  let cumNeed = 0;
  let cumDone = 0;
  const hours = share.map((s, h) => {
    cumNeed += need[h];
    if (h <= cur) cumDone += done[h];
    /* An hour gone that asked nothing and did nothing is neither: "on
       target" over two zeros is a claim about nothing. */
    const state = h < cur ? (!need[h] && !done[h] ? 'idle' : done[h] >= need[h] - (money ? 0.005 : 1e-9) ? 'over' : 'under')
      : h === cur ? 'now' : 'future';
    const catchUp = h < cur || !restShare ? null
      : left * (h === cur ? s * (1 - gone) : s) / restShare;
    return {
      h, label: `${String(h).padStart(2, '0')}:00`, share: Math.round(s * 10000) / 10000,
      usual: R(usual[h]), need: R(need[h]), done: h <= cur ? R(done[h]) : null,
      diff: h < cur ? R(done[h] - need[h]) : null, state,
      cum_need: R(cumNeed), cum_done: h <= cur ? R(cumDone) : null,
      catch_up: catchUp == null ? null : R(catchUp),
    };
  });
  return {
    target: R(target), done: R(doneSoFar), left: R(left), need_by_now: R(needByNow),
    ahead: R(doneSoFar - needByNow), met: doneSoFar >= target,
    usual_day: R(usual.reduce((s, v) => s + v, 0)), hours,
    this_hour: hours[cur] ? { label: `${hours[cur].label}–${String((cur + 1) % 24).padStart(2, '0')}:00`,
      need: hours[cur].need, catch_up: hours[cur].catch_up, done: hours[cur].done, usual: hours[cur].usual } : null,
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
  const latestBooking = rows.reduce((m, r) => (r.latest && (!m || new Date(r.latest) > m) ? new Date(r.latest) : m), null);
  const cutAt = [ran || latestBooking || now, now].reduce((a, b) => (a < b ? a : b));
  const local = new Date(cutAt.getTime() + 4 * 3600e3);
  const sameDay = local.toISOString().slice(0, 10) === today;
  const cur = sameDay ? local.getUTCHours() : 0;
  const gone = sameDay ? (local.getUTCMinutes() * 60 + local.getUTCSeconds()) / 3600 : 0;
  const clock = sameDay ? hhmm(cutAt) : '00:00';
  const td = t.days.find((d) => d.state === 'today') || null;

  /* Trips done, by hour. */
  const tripsDone = Array(24).fill(0);
  for (const r of rows) tripsDone[r.h] += r.completed;
  /* Revenue done, by hour: fares on record, and the live strip's own
     projection for each channel spread over that channel's unpriced bookings. */
  const faresDone = Array(24).fill(0);
  for (const r of rows) faresDone[r.h] += Number(r.fares);
  const parts = day?.headline?.projection_parts || [];
  for (const p of parts) {
    const mine = rows.filter((r) => r.platform === p.platform);
    const unpriced = mine.reduce((s, r) => s + Math.max(0, r.bookings - r.priced), 0);
    if (!unpriced || !p.value) continue;
    for (const r of mine) faresDone[r.h] += (p.value * Math.max(0, r.bookings - r.priced)) / unpriced;
  }
  const projected = parts.reduce((s, p) => s + (Number(p.value) || 0), 0);

  const revenue = !t.summary || t.summary.today_needs == null
    ? { absent: t.why || 'No revenue target is set for today.' }
    : !usual.fares.ok
      ? { absent: `An hour's revenue target needs ${HISTORY_MIN_DAYS} days of priced fares to learn the usual day from; `
        + `${usual.fares.days} ${usual.fares.days === 1 ? 'is' : 'are'} on record.` }
      : { ...hoursOf({ target: t.summary.today_needs, share: usual.fares.share, usual: usual.fares.usual,
        done: faresDone, cur, gone, money: true }),
      estimate: projected > 0, projected: r2(projected), measured: r2(rows.reduce((s, r) => s + Number(r.fares), 0)),
      basis: { days: usual.fares.days, from: usual.fares.from, to: usual.fares.to } };
  const trips = !td || !td.trips_target
    ? { absent: 'Nobody has completed a trip in the last 8 days, so today asks for none.' }
    : !usual.trips.ok
      ? { absent: `An hour's trips target needs ${HISTORY_MIN_DAYS} days of completed trips to learn the usual day from; `
        + `${usual.trips.days} ${usual.trips.days === 1 ? 'is' : 'are'} on record.` }
      : { ...hoursOf({ target: td.trips_target, share: usual.trips.share, usual: usual.trips.usual,
        done: tripsDone, cur, gone }),
      active: td.active_drivers, min: t.trips_min,
      basis: { days: usual.trips.days, from: usual.trips.from, to: usual.trips.to } };
  return {
    today, clock, hour: cur, now_clock: hhmm(now), at: now.toISOString(), cut_at: cutAt.toISOString(),
    cut_by: ran ? 'collection' : latestBooking ? 'last_booking' : 'clock',
    lag_min: Math.round((now - cutAt) / 60000),
    latest_at: latestBooking ? latestBooking.toISOString() : null,
    month: t.month, month_name: t.month_name, revenue, trips,
  };
}
