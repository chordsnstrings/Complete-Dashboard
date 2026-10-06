/* THE DAY'S GOAL, BY TEXT, TO A DRIVER WHO IS BEHIND IT — 13:00 AND 18:00.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-06: "SMS drivers based on their targets for the
   month … a text at 1 PM, 6 PM on the day unless we see that the performance
   is going towards the target … in a way that helps them drive to the
   target, and in simple english." Then, on the plan: one goal for everyone
   ("many of our drivers do … sometimes hotels, sometimes Uber sometimes bolt.
   It doesn't make sense to send them different texts"), a fixed daily goal,
   English only, nothing to a driver on pace, focus on AREAS, and a dry run
   first.

   THE GOAL is the month target's own per-driver minimum: low_trips_min on the
   Access page (12 since 2026-10-02), the same number the Target page asks of
   every active driver. Trips, counted across every app a person drives on
   (driver_platform_id folds the accounts), because trips are what every
   channel reports during the day. Revenue is not: Uber prices its trips only
   on the nightly catch-up, so a midday AED figure for an Uber driver would be
   an estimate, and this product does not text a driver an estimate of what
   they earned.

   ON PACE is the Target page's own reading, so the text and the page cannot
   disagree. api/target_hours.js judges the fleet's trips against what a usual
   day had REPORTED by the last collection (trap 47 — Uber files a trip ~37
   minutes after it is requested), and the share of the day due by now is
   need_by_now ÷ target. A driver's need by now is their goal × that share. A
   driver at 85% of it or more is left alone; so is one who has met the goal.

   NOT EVERYONE WHO IS BEHIND IS TEXTED, and every reason is recorded:
     · not started — no booking today and never online on Uber today. At
       13:00 that is a night shift or a day off, not a driver to chase;
     · a channel the driver used in the last 8 days has not collected in the
       last 90 minutes, so trips may be missing and "you have 2" may be false;
     · the phone book's own holds (src/driver_sms.js phoneFor);
     · the last collection is over 45 minutes old: the whole run waits, and
       at :30 gives up for that slot rather than text on stale numbers.

   THE AREAS are where booked rides began at these hours over the last 28
   days: FMS-tracked journeys matched to a booking (verdict 'authorized',
   counted once across the two FMS readings), named by place_cell — the
   fleet's own gazetteer — and cleaned by readablePlace() so a street number
   or a stray code never reaches a driver.

   DRY RUN FIRST. sms_target is 'dry' by default: every message is decided
   and written to the outbox, held with reason dry_run, and nothing is sent.
   The Messages page shows exactly what would have gone. */
import { sendSms, maskPhone, encodingFor } from './smsala.js';
import { loadPhoneBook, phoneFor, dubaiDay, dubaiHour, addDays, dubaiStart, readablePlace } from './driver_sms.js';
import { minTrips, ACTIVE_DAYS } from './low_trips_email.js';
import { targetHours } from '../api/target_hours.js';
import { placeAt } from '../api/place_sql.js';
import { occCountsOnce } from '../api/occupancy_sql.js';

export const SLOTS = Object.freeze({ 13: { from: 13, to: 16, label: '1-5 PM' }, 18: { from: 18, to: 21, label: '6-10 PM' } });
export const ON_PACE = 0.85;          // at or above this share of need-by-now, nothing is sent
export const STALE_MIN = 45;          // the last collection older than this: wait, then give up
export const FRESH_CHANNEL_MIN = 90;  // a channel not collected within this is not trusted for today
export const AREA_DAYS = 28;
export const MAX_SENDS = 300;         // per run: a brake on a wrong curve texting the whole fleet
const SMS_MAX = 160;

/** The text. One GSM-7 segment; the name is dropped before anything else is
 *  cut, then the second area, then the closing line. */
export function nudgeText({ name, goal, done, areas = [], window }) {
  const left = Math.max(0, goal - done);
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const hi = first && /^[A-Za-z][A-Za-z'.-]{1,19}$/.test(first) ? `Hi ${first}, ` : 'Hi, ';
  const body = (h, a, close) => `${h}your goal today is ${goal} trips. You have ${done}, ${left} to go. `
    + (a.length ? `Busy ${window}: ${a.join(', ')}.` : `The busy hours are ${window}.`)
    + (close ? (a.length ? ' Stay online there to reach it.' : ' Stay online then to reach it.') : '');
  const tries = [[hi, areas.slice(0, 2), true], ['Hi, ', areas.slice(0, 2), true], ['Hi, ', areas.slice(0, 1), true],
    ['Hi, ', areas.slice(0, 1), false], ['Hi, ', [], false]];
  for (const [h, a, c] of tries) {
    const t = body(h, a, c);
    if (t.length <= SMS_MAX && encodingFor(t) === '0') return t;
  }
  return body('Hi, ', [], false);
}

/** One driver, judged. Pure, so the rule is testable without a database. */
export function judge({ goal, done, started, frac, channelsFresh }) {
  if (!started) return { skip: 'not_started' };
  if (done >= goal) return { skip: 'goal_met' };
  const needNow = goal * frac;
  if (done >= needNow * ON_PACE) return { skip: 'on_pace', need_now: needNow };
  if (!channelsFresh) return { hold: 'channel_not_fresh', need_now: needNow };
  return { behind: true, need_now: needNow };
}

/** The busiest pickup areas over this slot's hours, best first. */
export async function busyAreas(q, slot, { now = new Date() } = {}) {
  const s = SLOTS[slot];
  const rows = await q(
    `SELECT a.place->>'area' AS area, count(*)::int AS n
       FROM (SELECT ${placeAt('o.start_lat', 'o.start_lng')} AS place
               FROM occupancy_segment o
              WHERE o.started_at >= $1::timestamptz - interval '${AREA_DAYS} days' AND o.started_at < $1::timestamptz
                AND o.verdict = 'authorized'
                AND extract(hour FROM o.started_at AT TIME ZONE 'Asia/Dubai') BETWEEN $2 AND $3
                AND ${occCountsOnce('o')}) a
      WHERE a.place IS NOT NULL AND (a.place->>'votes')::int >= 3
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [now.toISOString(), s.from, s.to]);
  const out = [];
  for (const r of rows) {
    const name = readablePlace(r.area);
    if (name && !out.some((x) => x.name === name)) out.push({ name, n: r.n });
  }
  return out;
}

/** Today's completed trips and bookings per person, the people active in the
 *  last ACTIVE_DAYS, their channels, and who was online on Uber today. */
async function people(q, today, now) {
  const from = addDays(today, -ACTIVE_DAYS);
  const [todayRows, active, online, names] = await Promise.all([
    q(`SELECT a.driver_id::text AS person, count(*) FILTER (WHERE n.outcome = 'completed')::int AS done,
              count(*)::int AS bookings
         FROM trip_norm n
         JOIN driver_platform_id a ON a.platform = n.platform AND a.external_id = n.driver_ext_id AND a.detached_at IS NULL
        WHERE n.local_day = $1::date AND n.is_booking
        GROUP BY 1`, [today]),
    q(`SELECT a.driver_id::text AS person, array_agg(DISTINCT n.platform || ':' || coalesce(n.fleet_id, '')) AS chans
         FROM trip_norm n
         JOIN driver_platform_id a ON a.platform = n.platform AND a.external_id = n.driver_ext_id AND a.detached_at IS NULL
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.outcome = 'completed'
        GROUP BY 1`, [from, today]),
    q(`SELECT DISTINCT a.driver_id::text AS person
         FROM driver_status_event e
         JOIN driver_platform_id a ON a.platform = 'uber' AND a.external_id = e.driver_ext_id AND a.detached_at IS NULL
        WHERE e.at >= $1 AND e.at <= $2 AND e.status IN ('online', 'ontrip')`,
    [dubaiStart(today).toISOString(), now.toISOString()]),
    q(`SELECT id::text AS person, full_name FROM driver`),
  ]);
  return {
    today: new Map(todayRows.map((r) => [r.person, r])),
    active: new Map(active.map((r) => [r.person, r.chans || []])),
    online: new Set(online.map((r) => r.person)),
    names: new Map(names.map((r) => [r.person, r.full_name])),
  };
}

/** platform:fleet pairs whose booking collector finished ok/partial within
 *  FRESH_CHANNEL_MIN over a window covering today. */
async function freshChannels(q, today, now) {
  const rows = await q(
    `SELECT source, fleet_id FROM collection_run
      WHERE status IN ('ok', 'partial') AND fleet_id IS NOT NULL AND finished_at >= $2
        AND window_start <= $1::date AND window_end >= $1::date
      GROUP BY 1, 2`, [today, new Date(now.getTime() - FRESH_CHANNEL_MIN * 60000).toISOString()]);
  return new Set(rows.map((r) => `${r.source}:${r.fleet_id}`));
}

export async function targetNudgeRun({ q, now = new Date(), send = sendSms, cfg = {}, final = false, dry = false,
  book = null, hours = null }) {
  const D = dubaiDay(now);
  const slot = dubaiHour(now) >= 18 ? 18 : 13;
  const runKey = `target-run:${D}:${slot}`;
  const mode = ['on', 'off', 'dry'].includes(cfg.sms_target) ? cfg.sms_target : 'dry';
  const [done] = dry ? [] : await q(`SELECT detail FROM sms_outbox WHERE dedupe_key = $1`, [runKey]);
  if (done && done.detail?.finished) return { day: D, slot, already: true };
  const note = async (status, reason, detail) => {
    if (dry) return;
    await q(`INSERT INTO sms_outbox (kind, dedupe_key, status, hold_reason, business_day, detail)
             VALUES ('target_run', $1, $2, $3, $4, $5)
             ON CONFLICT (dedupe_key) DO UPDATE SET status = $2, hold_reason = $3, detail = $5`,
    [runKey, status, reason, D, JSON.stringify(detail)]);
  };
  if (mode === 'off') { await note('held', 'switched_off', { finished: true, slot }); return { day: D, slot, off: true }; }

  const goal = minTrips(cfg);
  const th = hours || await targetHours(q, { now, min: goal });
  if (th.trips?.absent || !(th.trips?.target > 0)) {
    const detail = { finished: true, slot, why: th.trips?.absent || 'No trips target for today.' };
    await note('held', 'no_target_curve', detail);
    return { day: D, slot, held: 'no_target_curve', ...detail };
  }
  if (th.today !== D || th.lag_min > STALE_MIN) {
    const detail = { finished: final, slot, lag_min: th.lag_min, cut_at: th.cut_at };
    await note('held', final ? 'data_stale' : 'waiting', detail);
    return { day: D, slot, waiting: !final, gaveUp: final, ...detail };
  }
  const frac = Math.min(1, Math.max(0, th.trips.need_by_now / th.trips.target));

  const [pp, fresh, areas, pb] = await Promise.all([
    people(q, D, now), freshChannels(q, D, now), busyAreas(q, slot, { now }), book || loadPhoneBook(q)]);
  const areaNames = areas.map((a) => a.name);
  const out = { day: D, slot, mode, goal, frac: Math.round(frac * 1000) / 1000, clock: th.clock, lag_min: th.lag_min,
    areas: areaNames.slice(0, 3), active: pp.active.size, behind: 0, sent: 0, held: 0, skipped: {}, holds: {}, decisions: [] };
  for (const [person, chans] of pp.active) {
    const t = pp.today.get(person) || { done: 0, bookings: 0 };
    const started = t.bookings > 0 || pp.online.has(person);
    const channelsFresh = chans.every((c) => fresh.has(c));
    const j = judge({ goal, done: t.done, started, frac, channelsFresh });
    if (j.skip) { out.skipped[j.skip] = (out.skipped[j.skip] || 0) + 1; continue; }
    out.behind += 1;
    const ph = phoneFor(pb, person);
    let hold = j.hold || ph.hold || null;
    if (!hold && mode === 'dry') hold = 'dry_run';
    if (!hold && out.sent >= MAX_SENDS) hold = 'run_cap';
    const text = nudgeText({ name: pp.names.get(person), goal, done: t.done, areas: areaNames, window: SLOTS[slot].label });
    out.decisions.push({ person, done: t.done, need_now: Math.round(j.need_now * 10) / 10, hold,
      to: ph.phone ? maskPhone(ph.phone) : null, text });
    if (hold) { out.held += 1; out.holds[hold] = (out.holds[hold] || 0) + 1; }
    if (dry) continue;
    const [r] = await q(
      `INSERT INTO sms_outbox (kind, dedupe_key, person_id, business_day, destination, message_text, status, hold_reason, detail)
       VALUES ('target_nudge', $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [`target:${person}:${D}:${slot}`, Number(person), D, ph.phone || null, text, hold ? 'held' : 'queued', hold,
        JSON.stringify({ slot, goal, done: t.done, need_now: j.need_now, frac, channels: chans, source: ph.source || null })]);
    if (!r || hold) continue;
    const res = await send({ to: ph.phone, text, type: 'transactional', ref: `fm-target-${D}-${slot}-${person}` });
    await q(`UPDATE sms_outbox SET status = $2, provider_message_id = $3, error = $4, sender = coalesce($5, sender),
               sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
    [r.id, res.ok ? 'sent' : 'failed', res.messageId || null, res.ok ? null : `${res.error}: ${res.detail || ''}`.slice(0, 300), res.sender || null]);
    if (res.ok) out.sent += 1;
  }
  await note('sent', null, { finished: true, slot, mode, goal, frac: out.frac, clock: out.clock, areas: out.areas,
    active: out.active, behind: out.behind, sent: out.sent, held: out.held, skipped: out.skipped, holds: out.holds });
  return out;
}
