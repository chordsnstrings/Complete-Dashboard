/* MESSAGES TO DRIVERS BY SMS — the 05:00 cash reminder and the trip request.
   ═════════════════════════════════════════════════════════════════════════
   The operator's words (2026-09-28):

     "every night, exactly at 5 AM, every driver should get the following:
      Please deposit X amount of cash you received yesterday. Talk to your
      supervisor on WhatsApp."

     "Unauthorized trips once registered in the system should trigger SMS to
      the driver about the trip — requesting him to register the trip with
      Operations, NOT that it was unauthorized. … Please Register your trip
      from X to Y - z km with your supervisor - ADMIN."

   And their rulings on the questions the measurement raised: the STRICT
   filter for trips; UBER's mobile wins over HR's; a trip found at night waits
   until 07:00; live on the first night, with an off switch.

   A MESSAGE IS HELD, NEVER GUESSED. Each rule below is here because the
   measurement of production on 2026-09-28 found the case it guards (numbers
   in docs/COVERAGE.md "Driver messages by SMS"). A held message is still a
   row in sms_outbox, with the reason in words, so "why did this driver get
   nothing" has an answer on the Messages page.

   NOTHING HERE LOGS A NUMBER, A NAME OR A MESSAGE. A person id, a count and
   a reason code at most (src/log.js prints whatever it is handed). */
import { sendSms, uaeMobile, maskPhone } from './smsala.js';
import { PENDING, REFUSED } from '../api/identity_map.js';
import { attributionJoin, ATTRIBUTION_COLS, FRESH_BAND_MIN } from '../api/unauthorized_sql.js';
import { occCountsOnce } from '../api/occupancy_sql.js';
import { placeEnds } from '../api/place_sql.js';

/* ── Dubai's calendar (UTC+4, no daylight saving) ───────────────────────── */
const DXB_MS = 4 * 3600_000;
export const dubaiDay = (d) => new Date(d.getTime() + DXB_MS).toISOString().slice(0, 10);
export const dubaiHour = (d) => new Date(d.getTime() + DXB_MS).getUTCHours();
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** The instant a Dubai day begins. */
export const dubaiStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - DXB_MS);
/** The next 07:00 Dubai at or after `d`. */
export function next7am(d) {
  const today7 = new Date(dubaiStart(dubaiDay(d)).getTime() + 7 * 3600_000);
  return d < today7 ? today7 : new Date(today7.getTime() + 864e5);
}
const isNight = (d) => { const h = dubaiHour(d); return h >= 23 || h < 7; };

/* ── the words ──────────────────────────────────────────────────────────── */
const aed = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cashText = (amount) =>
  `Please deposit AED ${aed(amount)} of cash you received yesterday. Talk to your supervisor on WhatsApp.`;
export const tripText = (from, to, km) =>
  `Please Register your trip from ${from} to ${to} - ${km} km with your supervisor - ADMIN.`;

/* Why a message was held, in words the Messages page prints. */
export const HOLD_WHY = Object.freeze({
  identity_held: 'One of this driver’s accounts is in a same-person pair the register refused or holds back, so whose mobile is whose is not settled.',
  several_uber_numbers: 'Uber has more than one mobile for this driver.',
  several_hr_numbers: 'No Uber mobile, and HR’s roster has more than one.',
  no_number: 'No mobile on Uber or on HR’s roster for this driver.',
  number_shared: 'This mobile is also on another driver’s or employee’s record, so it may not be this driver’s.',
  no_account: 'This driver has no platform account on the register.',
  amount_not_final: 'A cash trip yesterday has no amount yet, so the total would be too low.',
  hotel_account_by_name: 'Some of the cash is on a hotel account keyed by a name rather than an id, which a spelling change can move to someone else.',
  channel_not_collected: 'A booking channel this driver works on did not collect yesterday, so their cash may be missing trips.',
  driver_not_certain: 'The trip does not name exactly one driver with evidence the strict rule accepts.',
  last_trip_stale: 'The driver is named only by an Uber trip more than 24.9 hours before this journey.',
  clock_skew: 'The tracker’s clock is off for this car, so the times cannot name a driver.',
  short: 'Shorter than 2 km.',
  near_booking: 'A booking on this car starts or ends within 30 minutes — likely driving to or from a pickup.',
  places_unreadable: 'The start or the end has no readable place name.',
  same_place: 'It starts and ends at the same named place.',
  cabman_dual_tracker: 'A CABMAN reading on a car that also carries FMS, whose CABMAN device may be filed under the wrong plate.',
  booking_channel_down: 'A booking channel this car uses did not collect that day, so a real booking may be missing.',
  driver_not_placed: 'The named driver’s account is not on the register, so there is no person to reach.',
  daily_cap: 'This driver has already had three trip messages today.',
  no_longer_unauthorized: 'By the time it was due, the journey was no longer judged unexplained.',
  switched_off: 'Driver messages of this kind were switched off when it was due.',
  not_complete: 'Yesterday’s cash was not complete by 09:00 Dubai, so no reminder was sent.',
});

/* ── who a mobile belongs to ─────────────────────────────────────────────── */
/* Every account in a pair the same-person register REFUSED (measured to be
   two men) or holds PENDING (a simultaneous-trip contradiction). Measured on
   2026-09-28: one refused man's spine carries a Yango account whose number
   is the other man's — texting "any number of this person" would reach the
   wrong man. */
export const HELD_IDS = new Set([
  ...REFUSED.flatMap((r) => [r.a?.id, r.b?.id]),
  ...PENDING.flatMap((p) => [p.keep?.id, ...(p.merge?.ids || [])]),
].filter(Boolean).map(String));

/* Everything the number choice reads, loaded once per run. */
export async function loadPhoneBook(q) {
  const [accounts, comp, hr] = await Promise.all([
    q(`SELECT driver_id::text AS person, platform, external_id FROM driver_platform_id
        WHERE detached_at IS NULL AND driver_id IS NOT NULL`),
    q(`SELECT platform, driver_ext_id, phone FROM driver_compliance
        WHERE phone IS NOT NULL AND btrim(phone) <> ''`),
    /* The latest HR export by the day HR made it, not by upload time: an
       older export uploaded late is history (src/hr_roster.js). */
    q(`SELECT fleet_id, employee_id, phone, matched_accounts FROM hr_roster_row
        WHERE upload_id = (SELECT id FROM hr_roster_upload ORDER BY export_date DESC, id DESC LIMIT 1)`),
  ]);
  const personAccounts = new Map();
  const accountPerson = new Map();
  for (const a of accounts) {
    if (!personAccounts.has(a.person)) personAccounts.set(a.person, []);
    personAccounts.get(a.person).push({ platform: a.platform, id: String(a.external_id) });
    accountPerson.set(`${a.platform}:${a.external_id}`, a.person);
  }
  const uberNums = new Map();
  const hrNums = new Map();
  const owners = new Map();
  const own = (num, who) => { if (!owners.has(num)) owners.set(num, new Set()); owners.get(num).add(who); };
  const addTo = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const c of comp) {
    const num = uaeMobile(c.phone);
    if (!num) continue;
    const person = accountPerson.get(`${c.platform}:${c.driver_ext_id}`);
    own(num, person ? `p:${person}` : `acct:${c.platform}:${c.driver_ext_id}`);
    if (person && c.platform === 'uber') addTo(uberNums, person, num);
  }
  for (const r of hr) {
    const num = uaeMobile(r.phone);
    if (!num) continue;
    const persons = new Set((Array.isArray(r.matched_accounts) ? r.matched_accounts : [])
      .map((m) => accountPerson.get(`${m.platform}:${m.ext_id}`)).filter(Boolean));
    if (!persons.size) own(num, `hr:${r.fleet_id}:${r.employee_id}`);
    for (const p of persons) { own(num, `p:${p}`); addTo(hrNums, p, num); }
  }
  return { personAccounts, uberNums, hrNums, owners };
}

/** The mobile for one person — Uber's first, then HR's — or why none. */
export function phoneFor(book, person) {
  const key = String(person);
  const accts = book.personAccounts.get(key) || [];
  if (!accts.length) return { hold: 'no_account' };
  if (accts.some((a) => HELD_IDS.has(a.id))) return { hold: 'identity_held' };
  let phone; let source;
  const uber = [...(book.uberNums.get(key) || [])];
  if (uber.length > 1) return { hold: 'several_uber_numbers' };
  if (uber.length === 1) { [phone] = uber; source = 'uber'; } else {
    const hr = [...(book.hrNums.get(key) || [])];
    if (hr.length > 1) return { hold: 'several_hr_numbers' };
    if (!hr.length) return { hold: 'no_number' };
    [phone] = hr; source = 'hr';
  }
  const others = [...(book.owners.get(phone) || [])].filter((o) => o !== `p:${key}`);
  if (others.length) return { hold: 'number_shared' };
  return { phone, source };
}

/* ── the outbox ──────────────────────────────────────────────────────────── */
/** Insert a decided message. Returns its id, or null when the dedupe key was
 *  already used — which is what makes every run safe to repeat. */
async function decide(q, row) {
  const cols = Object.keys(row);
  const [r] = await q(
    `INSERT INTO sms_outbox (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, cols.map((c) => row[c]));
  return r ? r.id : null;
}
async function deliver(q, id, { to, text, ref, send }) {
  const r = await send({ to, text, type: 'transactional', ref });
  await q(`UPDATE sms_outbox SET status = $2, provider_message_id = $3, error = $4, sender = coalesce($5, sender),
             sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
  [id, r.ok ? 'sent' : 'failed', r.messageId || null, r.ok ? null : `${r.error}: ${r.detail || ''}`.slice(0, 300), r.sender || null]);
  return r.ok;
}

/* ── collection health ───────────────────────────────────────────────────── */
/* (platform, fleet) pairs whose booking collector ran — ok or partial — after
   `since`, over a window reaching `day`. A pair absent from the set did not. */
async function collectedPairs(q, day, since) {
  const rows = await q(
    `SELECT source, fleet_id FROM collection_run
      WHERE source IN ('uber', 'bolt', 'yango', 'hotel') AND fleet_id IS NOT NULL
        AND status IN ('ok', 'partial') AND finished_at >= $2 AND window_end >= $1::date
      GROUP BY 1, 2`, [day, since.toISOString()]);
  return new Set(rows.map((r) => `${r.source}:${r.fleet_id}`));
}

/* ═════════════════════════ the 05:00 cash reminder ═════════════════════════ */
/* Yesterday's cash, per person, from trip_cash (sql/schema_v80.sql): Uber's
   own cash_collected where the payments report has it — 11.1% above the fare
   on every one of 73 Uber cash trips measured, because it is what the rider
   actually handed over — and the fare on the other channels. A driver with
   no cash gets nothing: a reminder to deposit AED 0.00 is noise, and the
   house rule forbids printing a nought for an absence.

   Complete or not at all. Uber's figures arrive with the nightly catch-up
   (21:00 UTC = 01:00 Dubai), which finished by 01:18 Dubai on the day
   measured; on a weekday the running week can be throttled. So the run asks
   every fifteen minutes from 05:00 and sends the moment yesterday is
   complete, and at 09:00 gives up for the day and says so. */
export async function cashDepositRun({ q, now = new Date(), send = sendSms, cfg = {}, final = false, dry = false, book = null }) {
  const D = addDays(dubaiDay(now), -1);
  const runKey = `cash-run:${D}`;
  const [done] = await q(`SELECT status, detail FROM sms_outbox WHERE dedupe_key = $1`, [runKey]);
  if (done && done.detail?.finished) return { day: D, already: true };
  const note = async (status, reason, detail) => {
    if (dry) return;
    await q(`INSERT INTO sms_outbox (kind, dedupe_key, status, hold_reason, business_day, detail)
             VALUES ('cash_run', $1, $2, $3, $4, $5)
             ON CONFLICT (dedupe_key) DO UPDATE SET status = $2, hold_reason = $3, detail = $5`,
    [runKey, status, reason, D, JSON.stringify(detail)]);
  };
  if (cfg.sms_cash === 'off') { await note('held', 'switched_off', { finished: true }); return { day: D, off: true }; }

  const dayEnd = dubaiStart(addDays(D, 1));
  /* Complete: every fleet with Uber cash yesterday had an ok catch-up after
     the day ended, and no Uber cash trip is still without Uber's figure. */
  const uberFleets = await q(
    `SELECT DISTINCT fleet_id FROM trip_cash
      WHERE platform = 'uber' AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $1`, [D]);
  const caught = new Set((await q(
    `SELECT fleet_id FROM collection_run
      WHERE source = 'uber' AND mode = 'catchup' AND status = 'ok' AND window_end >= $1::date AND finished_at >= $2
      GROUP BY 1`, [D, dayEnd.toISOString()])).map((r) => r.fleet_id));
  const missingCatchup = uberFleets.map((r) => r.fleet_id).filter((f) => !caught.has(f));
  const [{ n: notFinal }] = await q(
    `SELECT count(*)::int AS n FROM trip_cash
      WHERE platform = 'uber' AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $1
        AND cash_basis <> 'payments_report'`, [D]);
  if (missingCatchup.length || notFinal > 0) {
    const detail = { finished: final, missing_catchup: missingCatchup, uber_cash_trips_without_figure: notFinal };
    await note('held', final ? 'not_complete' : 'waiting', detail);
    return { day: D, waiting: !final, gaveUp: final, ...detail };
  }

  const rows = await q(
    `SELECT a.driver_id::text AS person, tc.platform, tc.fleet_id, tc.driver_ext_id, tc.cash_amount
       FROM trip_cash tc
       LEFT JOIN driver_platform_id a ON a.platform = tc.platform AND a.external_id = tc.driver_ext_id
                                     AND a.detached_at IS NULL
      WHERE (tc.requested_at AT TIME ZONE 'Asia/Dubai')::date = $1`, [D]);
  const people = new Map();
  let unplaced = 0; let unplacedAed = 0;
  for (const r of rows) {
    if (!r.person) { unplaced += 1; unplacedAed += Number(r.cash_amount || 0); continue; }
    if (!people.has(r.person)) people.set(r.person, { amount: 0, unvalued: 0, pairs: new Set(), hotelByName: false });
    const p = people.get(r.person);
    if (r.cash_amount == null) p.unvalued += 1; else p.amount += Number(r.cash_amount);
    p.pairs.add(`${r.platform}:${r.fleet_id}`);
    if (r.platform === 'hotel' && !/^[0-9a-f]{24}$/i.test(String(r.driver_ext_id))) p.hotelByName = true;
  }
  /* The channels each person worked on in the last 30 days, and whether each
     collected after yesterday ended: a Bolt collector refused all night means
     a Bolt driver's cash is short by trips nobody fetched. */
  const persons = [...people.keys()];
  const worked = persons.length ? await q(
    `SELECT DISTINCT a.driver_id::text AS person, t.platform, t.fleet_id FROM trip t
       JOIN driver_platform_id a ON a.platform = t.platform AND a.external_id = t.driver_ext_id AND a.detached_at IS NULL
      WHERE a.driver_id::text = ANY($1::text[]) AND t.requested_at >= $2 AND t.fleet_id IS NOT NULL`,
    [persons, new Date(dayEnd.getTime() - 31 * 864e5).toISOString()]) : [];
  for (const w of worked) people.get(w.person)?.pairs.add(`${w.platform}:${w.fleet_id}`);
  const collected = await collectedPairs(q, D, dayEnd);
  const pb = book || await loadPhoneBook(q);

  const out = { day: D, people: 0, sent: 0, held: 0, holds: {}, unplaced_trips: unplaced, unplaced_aed: Math.round(unplacedAed * 100) / 100, decisions: [] };
  for (const [person, p] of people) {
    const amount = Math.round(p.amount * 100) / 100;
    if (!(amount > 0) && !p.unvalued) continue;
    out.people += 1;
    const down = [...p.pairs].filter((k) => !collected.has(k));
    /* The amount's own reasons first, the number's second: a driver with no
       number whose Bolt trips are missing is held because the AMOUNT is
       wrong — that is what the operator has to fix for that day, and it
       would still be wrong once a number is filed. */
    let hold = null;
    if (p.unvalued) hold = 'amount_not_final';
    else if (p.hotelByName) hold = 'hotel_account_by_name';
    else if (down.length) hold = 'channel_not_collected';
    const ph = phoneFor(pb, person);
    if (!hold && ph.hold) hold = ph.hold;
    const text = cashText(amount);
    out.decisions.push({ person, amount, hold, to: ph.phone ? maskPhone(ph.phone) : null, source: ph.source || null, down });
    if (hold) { out.held += 1; out.holds[hold] = (out.holds[hold] || 0) + 1; }
    if (dry) continue;
    const id = await decide(q, {
      kind: 'cash_deposit', dedupe_key: `cash:${person}:${D}`, person_id: Number(person), business_day: D,
      destination: ph.phone || null, message_text: text, status: hold ? 'held' : 'queued', hold_reason: hold,
      detail: JSON.stringify({ amount, source: ph.source || null, channels_not_collected: down }),
    });
    if (!id || hold) continue;
    if (await deliver(q, id, { to: ph.phone, text, ref: `fm-cash-${D}-${person}`, send })) out.sent += 1;
  }
  await note('sent', null, { finished: true, people: out.people, sent: out.sent, held: out.held, holds: out.holds,
    unplaced_trips: out.unplaced_trips, unplaced_aed: out.unplaced_aed });
  return out;
}

/* ═════════════════════════ the trip request ═════════════════════════════ */
/* A journey the reconciler judged unexplained (occupancy_segment, verdict
   'unauthorized', the row that counts the ride once), ENDED after the
   feature went live (sms_state.trip_since) and in the last 24 hours, and at
   least two hours ago — the reconciler withholds a verdict for 120 minutes
   after a ride ends. Passed through the operator's STRICT filter; everything
   that fails it is held with its reason. */
const OK_TIERS = new Set(['bracketed', 'last_trip', 'sole_custodian']);

/** A place name a driver can read: the first part before a comma, starting
 *  with a letter, words and at most a trailing district number ("Al Barsha
 *  1"). "93 D65" and "16 9 St" are street codes, not places. */
export function readablePlace(area) {
  const a = String(area || '').split(',')[0].replace(/\s+/g, ' ').trim();
  if (a.length < 3 || a.length > 40) return null;
  return /^[A-Za-z][A-Za-z'’ .-]*[A-Za-z.](?: \d{1,2})?$/.test(a) ? a : null;
}

export async function tripRegisterRun({ q, now = new Date(), send = sendSms, cfg = {}, dry = false, book = null }) {
  if (cfg.sms_trip === 'off') return { off: true };
  const [since] = await q(`SELECT value FROM sms_state WHERE key = 'trip_since'`);
  if (!since) return { error: 'no trip_since watermark (schema_v88 not applied)' };
  const from = new Date(Math.max(Date.parse(since.value), now.getTime() - 24 * 3600_000));
  const until = new Date(now.getTime() - 120 * 60_000);
  if (from >= until) return { candidates: 0 };
  const segs = await q(
    `SELECT o.source, o.plate, o.fleet_id, o.started_at, o.ended_at, o.distance_km, o.nearest_gap_min,
            ${placeEnds('o')}, ${ATTRIBUTION_COLS}
       FROM occupancy_segment o
       ${attributionJoin('o')}
      WHERE o.verdict = 'unauthorized' AND ${occCountsOnce('o')}
        AND o.ended_at > $1 AND o.ended_at <= $2
      ORDER BY o.ended_at`, [from.toISOString(), until.toISOString()]);
  const out = { candidates: segs.length, sent: 0, queued: 0, held: 0, skipped: 0, holds: {}, decisions: [] };
  if (!segs.length) return out;

  /* Cars carrying both trackers: a CABMAN reading on one of them may be
     filed under the wrong plate (docs/COVERAGE.md). */
  const dual = new Set((await q(
    `SELECT plate FROM occupancy_segment WHERE started_at >= now() - interval '30 days'
      GROUP BY plate HAVING bool_or(source = 'cabman') AND bool_or(source LIKE 'fms%')`)).map((r) => r.plate));
  const pb = book || await loadPhoneBook(q);

  for (const s of segs) {
    const start = new Date(s.started_at); const end = new Date(s.ended_at || s.started_at);
    /* The same journey, reported again: FMS files a provisional record and a
       final one about 13.6 h later with a different start, and every pass
       deletes and re-inserts its window. Matched by overlap on the plate. */
    const [seen] = await q(
      `SELECT 1 FROM sms_outbox WHERE kind = 'trip_register' AND plate = $1
          AND trip_start <= $3::timestamptz + interval '15 minutes'
          AND trip_end >= $2::timestamptz - interval '15 minutes' LIMIT 1`,
      [s.plate, start.toISOString(), end.toISOString()]);
    if (seen) { out.skipped += 1; continue; }

    const cands = Array.isArray(s.attribution_candidates) ? s.attribution_candidates : [];
    const from_ = readablePlace(s.start_place?.area);
    const to_ = readablePlace(s.end_place?.area);
    const km = Math.round(Number(s.distance_km || 0));
    const day = dubaiDay(start);
    let hold = null;
    if (s.attribution_candidate_count !== 1 || !OK_TIERS.has(s.attribution_tier)) hold = 'driver_not_certain';
    else if (s.attribution_tier === 'last_trip' && !(Number(s.attribution_last_trip_gap_min) <= FRESH_BAND_MIN)) hold = 'last_trip_stale';
    else if (s.clock_skew_min != null) hold = 'clock_skew';
    else if (!(Number(s.distance_km) >= 2)) hold = 'short';
    else if (s.nearest_gap_min != null && Math.abs(Number(s.nearest_gap_min)) < 30) hold = 'near_booking';
    else if (!from_ || !to_) hold = 'places_unreadable';
    else if (from_.toLowerCase() === to_.toLowerCase()) hold = 'same_place';
    else if (s.source === 'cabman' && dual.has(s.plate)) hold = 'cabman_dual_tracker';

    /* A booking channel this car used in the last 14 days that did not
       collect for its fleet after the journey's day: a real booking may be
       missing, and the journey only looks unexplained. */
    if (!hold) {
      const used = await q(
        `SELECT DISTINCT platform FROM trip WHERE plate = $1 AND fleet_id = $2
            AND requested_at >= $3::timestamptz - interval '14 days' AND requested_at < $3::timestamptz`,
        [s.plate, s.fleet_id, end.toISOString()]);
      const collected = await collectedPairs(q, day, end);
      if (used.some((u) => !collected.has(`${u.platform}:${s.fleet_id}`))) hold = 'booking_channel_down';
    }
    let person = null;
    if (!hold) {
      const c = cands[0] || {};
      const [a] = await q(
        `SELECT driver_id::text AS person FROM driver_platform_id
          WHERE external_id = $1 AND detached_at IS NULL AND driver_id IS NOT NULL LIMIT 1`, [String(c.id || '')]);
      person = a?.person || null;
      if (!person) hold = 'driver_not_placed';
    }
    let ph = {};
    if (!hold) { ph = phoneFor(pb, person); if (ph.hold) hold = ph.hold; }
    if (!hold) {
      const [{ n }] = await q(
        `SELECT count(*)::int AS n FROM sms_outbox WHERE kind = 'trip_register' AND person_id = $1
            AND status IN ('sent', 'queued') AND (trip_start AT TIME ZONE 'Asia/Dubai')::date = $2::date`, [Number(person), day]);
      if (n >= 3) hold = 'daily_cap';
    }
    const text = from_ && to_ ? tripText(from_, to_, km) : null;
    const wait = !hold && isNight(now);
    out.decisions.push({ plate: s.plate, started_at: s.started_at, tier: s.attribution_tier, hold,
      person, to: ph.phone ? maskPhone(ph.phone) : null, km, from: from_, to_place: to_, waits_until_7: wait });
    if (hold) { out.held += 1; out.holds[hold] = (out.holds[hold] || 0) + 1; }
    if (dry) continue;
    const id = await decide(q, {
      kind: 'trip_register', dedupe_key: `trip:${s.plate}:${start.toISOString()}`,
      person_id: person ? Number(person) : null, fleet_id: s.fleet_id, destination: ph.phone || null,
      message_text: text, status: hold ? 'held' : 'queued', hold_reason: hold,
      not_before: wait ? next7am(now).toISOString() : null,
      plate: s.plate, trip_start: start.toISOString(), trip_end: end.toISOString(), business_day: day,
      detail: JSON.stringify({ source: s.source, tier: s.attribution_tier, km, phone_source: ph.source || null }),
    });
    if (!id || hold) continue;
    if (wait) { out.queued += 1; continue; }
    if (await deliver(q, id, { to: ph.phone, text, ref: `fm-trip-${id}`, send })) out.sent += 1;
  }
  return out;
}

/* ── 07:00: the trip messages found overnight ─────────────────────────────── */
export async function flushQueued({ q, now = new Date(), send = sendSms, cfg = {} }) {
  const due = await q(
    `SELECT id, kind, destination, message_text, plate, trip_start, trip_end FROM sms_outbox
      WHERE status = 'queued' AND (not_before IS NULL OR not_before <= $1) ORDER BY id LIMIT 200`, [now.toISOString()]);
  let sent = 0; let held = 0;
  for (const m of due) {
    const off = (m.kind === 'trip_register' && cfg.sms_trip === 'off') || (m.kind === 'cash_deposit' && cfg.sms_cash === 'off');
    let reason = off ? 'switched_off' : null;
    /* Re-read before sending: a later pass may have found the booking. */
    if (!reason && m.kind === 'trip_register') {
      const [still] = await q(
        `SELECT 1 FROM occupancy_segment WHERE plate = $1 AND verdict = 'unauthorized'
            AND started_at <= $3 AND coalesce(ended_at, started_at) >= $2 LIMIT 1`, [m.plate, m.trip_start, m.trip_end]);
      if (!still) reason = 'no_longer_unauthorized';
    }
    if (reason) {
      await q(`UPDATE sms_outbox SET status = 'held', hold_reason = $2 WHERE id = $1 AND status = 'queued'`, [m.id, reason]);
      held += 1; continue;
    }
    /* Claimed before sending, so two workers cannot send one message twice. */
    const [claim] = await q(`UPDATE sms_outbox SET status = 'failed', error = 'sending' WHERE id = $1 AND status = 'queued' RETURNING id`, [m.id]);
    if (!claim) continue;
    if (await deliver(q, m.id, { to: m.destination, text: m.message_text, ref: `fm-${m.kind}-${m.id}`, send })) sent += 1;
  }
  return { due: due.length, sent, held };
}

/* ── delivery reports ────────────────────────────────────────────────────── */
export async function checkDeliveries({ q, report }) {
  const rows = await q(
    `SELECT id, provider_message_id FROM sms_outbox
      WHERE status = 'sent' AND provider_message_id IS NOT NULL AND provider_status IS NULL
        AND sent_at < now() - interval '2 minutes' AND sent_at > now() - interval '2 days'
        AND (dlr_checked_at IS NULL OR dlr_checked_at < now() - interval '15 minutes')
      ORDER BY sent_at LIMIT 100`);
  let got = 0;
  for (const r of rows) {
    const d = await report(r.provider_message_id);
    await q(`UPDATE sms_outbox SET dlr_checked_at = now(), provider_status = $2, cost = coalesce($3, cost) WHERE id = $1`,
      [r.id, d.ok ? d.status : null, d.ok ? d.cost : null]);
    if (d.ok && d.status) got += 1;
  }
  return { checked: rows.length, got };
}
