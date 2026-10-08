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
import { attributionJoin, ATTRIBUTION_COLS } from '../api/unauthorized_sql.js';
import { occCountsOnce } from '../api/occupancy_sql.js';
import { placeEnds } from '../api/place_sql.js';
import { TRIP_RUN_SQL } from '../api/run_kinds.js';

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
/* THE CHANNELS THE AMOUNT COVERS, NAMED IN THE MESSAGE — the operator,
   2026-09-29: "send even if bolt doesn't work. At least uber is there. write
   Uber as well in case you want to be clear." A driver who took cash on Uber
   and on Bolt, on a night Bolt's collector failed, is asked for the Uber cash
   and told it is the Uber cash — never handed a total that silently leaves
   Bolt out. Always named, including when every channel is in, so the words
   never mean different things on different mornings. */
const CHANNEL_WORD = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'hotel' };
const CHANNEL_ORDER = ['uber', 'bolt', 'yango', 'hotel'];
export const channelWords = (platforms = []) => {
  const known = CHANNEL_ORDER.filter((c) => platforms.includes(c));
  const other = [...new Set(platforms.filter((c) => !CHANNEL_ORDER.includes(c)))].sort();
  const w = [...known, ...other].map((c) => CHANNEL_WORD[c] || c);
  return w.length <= 1 ? (w[0] || '') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`;
};
export const cashText = (amount, platforms = []) => {
  const list = channelWords(platforms);
  return `Please deposit AED ${aed(amount)} of ${list ? `${list} ` : ''}cash you received yesterday. Talk to your supervisor on WhatsApp.`;
};
export const tripText = (from, to, km, day = null) =>
  `Please Register your trip ${day ? `on ${shortDay(day)} ` : ''}from ${from} to ${to} - ${km} km with your supervisor - ADMIN.`;
/* "29 Sep" — the day of a trip texted late (a re-check, below), so the driver
   can tell which trip it means. A trip texted the day it ends needs none, and
   keeps the operator's wording exactly. */
const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('Sept', 'Sep');

/* Why a message was held, in words the Messages page prints. */
export const HOLD_WHY = Object.freeze({
  identity_held: 'One of this driver’s accounts is in a same-person pair the register refused or holds back, so whose mobile is whose is not settled.',
  several_uber_numbers: 'Uber has more than one mobile for this driver.',
  several_hr_numbers: 'No Uber mobile, and HR’s roster has more than one.',
  no_number: 'No mobile on Uber or on HR’s roster for this driver.',
  number_shared: 'This mobile is also on another driver’s or employee’s record, so it may not be this driver’s.',
  no_account: 'This driver has no platform account on the register.',
  amount_not_final: 'Every cash trip this driver took yesterday is on a channel with no amount yet, so there is nothing certain to ask for.',
  hotel_account_by_name: 'The only cash yesterday is on a hotel account keyed by a name rather than an id, which a spelling change can move to someone else.',
  channel_not_collected: 'Every channel this driver took cash on yesterday failed to collect, so there is no certain amount to ask for. Cash on a channel that did collect is always sent.',
  driver_not_certain: 'The trip does not name exactly one driver with evidence the strict rule accepts.',
  /* No longer applied (the operator, 2026-09-29: "We send to the last driver
     of the vehicle"); kept so a message held under it before then still
     reads its reason. */
  last_trip_stale: 'The driver is named only by an Uber trip more than 24.9 hours before this journey (held before 29 September 2026, when this stopped being a reason to hold).',
  clock_skew: 'The tracker’s clock is off for this car, so the times cannot name a driver.',
  short: 'Shorter than 4 km.',
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
  /* The goal texts, src/target_sms.js. */
  dry_run: 'Dry run: decided and written here, not sent. Switch the goal texts to On in Access → Settings to send them.',
  channel_not_fresh: 'An app this driver used in the last 8 days has not collected in the last 90 minutes, so today’s trip count may be short.',
  run_cap: 'This run had already sent its 300 messages, the brake on a wrong reading texting the whole fleet.',
  no_target_curve: 'The Target page has no trips target for today, so nobody can be judged behind it.',
  data_stale: 'The last collection was over 45 minutes old at :30, so this slot’s goal texts were not sent.',
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
/* The channels a booking can arrive through. `trip` also files the FMS
   tracker's own journeys under platform 'fms' — 155,403 rows for Ecosine and
   86,366 for Egari on 2026-10-01 — and those are not bookings: nothing can
   "collect" them for a day. The car's channels were read from every platform
   in `trip`, so every FMS-tracked car counted 'fms' among them, never found it
   collected, and every journey on it that passed the other checks was held as
   booking_channel_down — for good; the re-check could never release one.
   Both sides now read this one list. */
const BOOKING_SOURCES = ['uber', 'bolt', 'yango', 'hotel'];
/* (platform, fleet) pairs whose booking collector ran — ok or partial — after
   `since`, over a window COVERING `day`. A pair absent from the set did not.
   Covering, not merely reaching: the half-hourly run's window is the last 3
   days, so for an older journey "a run ended on or after its day" was true of
   every run and said nothing about the day itself — only the nightly 30-day
   catch-up fetches it, and on 2026-09-30 that run failed for Bolt Ecosine. */
export async function collectedPairs(q, day, since) {
  const rows = await q(
    `SELECT source, fleet_id FROM collection_run
      WHERE source = ANY($3::text[]) AND fleet_id IS NOT NULL
        AND status IN ('ok', 'partial') AND finished_at >= $2 AND ${TRIP_RUN_SQL}
        AND window_start <= $1::date AND window_end >= $1::date
      GROUP BY 1, 2`, [day, since.toISOString(), BOOKING_SOURCES]);
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
  /* Per person, per CHANNEL: what each channel put in their hand yesterday,
     so a channel that cannot be counted is left out on its own and the rest
     is still asked for. */
  const people = new Map();
  let unplaced = 0; let unplacedAed = 0;
  for (const r of rows) {
    if (!r.person) { unplaced += 1; unplacedAed += Number(r.cash_amount || 0); continue; }
    if (!people.has(r.person)) people.set(r.person, { channels: new Map(), worked: new Set() });
    const p = people.get(r.person);
    if (!p.channels.has(r.platform)) p.channels.set(r.platform, { amount: 0, trips: 0, unvalued: 0, fleets: new Set(), byName: false });
    const c = p.channels.get(r.platform);
    c.trips += 1;
    if (r.cash_amount == null) c.unvalued += 1; else c.amount += Number(r.cash_amount);
    if (r.fleet_id) c.fleets.add(r.fleet_id);
    if (r.platform === 'hotel' && !/^[0-9a-f]{24}$/i.test(String(r.driver_ext_id))) c.byName = true;
  }
  /* The channels each person worked on in the last 30 days. One that did not
     collect after yesterday ended may hold cash trips nobody fetched; it is
     not in the amount either way, and the record names it. */
  const persons = [...people.keys()];
  const worked = persons.length ? await q(
    `SELECT DISTINCT a.driver_id::text AS person, t.platform, t.fleet_id FROM trip t
       JOIN driver_platform_id a ON a.platform = t.platform AND a.external_id = t.driver_ext_id AND a.detached_at IS NULL
      WHERE a.driver_id::text = ANY($1::text[]) AND t.requested_at >= $2 AND t.fleet_id IS NOT NULL`,
    [persons, new Date(dayEnd.getTime() - 31 * 864e5).toISOString()]) : [];
  for (const w of worked) people.get(w.person)?.worked.add(`${w.platform}:${w.fleet_id}`);
  const collected = await collectedPairs(q, D, dayEnd);
  const pb = book || await loadPhoneBook(q);

  /* Why a channel is left out of the amount, in the order the whole-message
     hold reports it when nothing is left. */
  const LEFT_OUT = { not_collected: 'channel_not_collected', not_priced: 'amount_not_final', hotel_by_name: 'hotel_account_by_name' };
  const out = { day: D, people: 0, sent: 0, held: 0, partial: 0, holds: {}, unplaced_trips: unplaced,
    unplaced_aed: Math.round(unplacedAed * 100) / 100, decisions: [] };
  for (const [person, p] of people) {
    const included = [];
    const leftOut = [];
    let sum = 0;
    for (const [platform, c] of p.channels) {
      const fleets = [...c.fleets];
      const why = fleets.some((f) => !collected.has(`${platform}:${f}`)) ? 'not_collected'
        : c.unvalued ? 'not_priced'
          : c.byName ? 'hotel_by_name' : null;
      if (why) {
        leftOut.push({ platform, fleets, trips: c.trips, known_aed: Math.round(c.amount * 100) / 100, why });
      } else if (c.amount > 0) {
        included.push(platform);
        sum += c.amount;
      }
    }
    /* A channel worked on lately that did not collect, with no cash trip of
       it seen yesterday: named, because its cash may simply not have been
       fetched. */
    for (const k of p.worked) {
      const [platform, fleet] = k.split(':');
      if (!collected.has(k) && !p.channels.has(platform)) leftOut.push({ platform, fleets: [fleet], trips: 0, known_aed: 0, why: 'not_collected' });
    }
    const amount = Math.round(sum * 100) / 100;
    const seen = leftOut.filter((x) => x.trips > 0);
    if (!(amount > 0) && !seen.length) continue;
    out.people += 1;
    /* Nothing certain left: held with the reason of the channel that took it
       away. Otherwise the number's own reasons, as before. */
    let hold = amount > 0 ? null : LEFT_OUT[seen[0].why];
    const ph = phoneFor(pb, person);
    if (!hold && ph.hold) hold = ph.hold;
    const text = amount > 0 ? cashText(amount, included) : null;
    if (!hold && seen.length) out.partial += 1;
    out.decisions.push({ person, amount, hold, to: ph.phone ? maskPhone(ph.phone) : null, source: ph.source || null,
      channels: included, left_out: leftOut });
    if (hold) { out.held += 1; out.holds[hold] = (out.holds[hold] || 0) + 1; }
    if (dry) continue;
    /* The amount per channel, kept beside the total. The 08:00 cash email
       (src/cash_sms_email.js) tells the cash desk how much of what each
       driver was asked for came from which platform, and it must be the
       split of the figure the driver was TEXTED — recomputed later from
       trip_cash it could differ, because a late fare moves the table and
       never the message. Until 2026-09-30 only the total and the list were
       kept, so for a driver texted before then on two channels the split
       is not known. */
    const byChannel = included.map((platform) => {
      const c = p.channels.get(platform);
      return { platform, amount: Math.round(c.amount * 100) / 100, trips: c.trips, fleets: [...c.fleets] };
    });
    const id = await decide(q, {
      kind: 'cash_deposit', dedupe_key: `cash:${person}:${D}`, person_id: Number(person), business_day: D,
      destination: ph.phone || null, message_text: text, status: hold ? 'held' : 'queued', hold_reason: hold,
      detail: JSON.stringify({ amount, source: ph.source || null, channels: included, by_channel: byChannel, left_out: leftOut }),
    });
    if (!id || hold) continue;
    if (await deliver(q, id, { to: ph.phone, text, ref: `fm-cash-${D}-${person}`, send })) out.sent += 1;
  }
  await note('sent', null, { finished: true, people: out.people, sent: out.sent, held: out.held, partial: out.partial,
    holds: out.holds, unplaced_trips: out.unplaced_trips, unplaced_aed: out.unplaced_aed });
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
/* THE TWO RULINGS OF 2026-09-29 (the operator, over a held row reading "The
   driver is named only by an Uber trip more than 24.9 hours before this
   journey"): "this is fine. We send to the last driver of the vehicle. But
   keep 4 km minimum to send text."
     · a driver named by their LAST Uber trip on the car is texted however
       long ago that trip was — within the attribution ladder's own reach
       (api/unauthorized_sql.js STALE_CAP_MIN, 21.97 days), which is what
       "the last driver of the vehicle" is. The 24.9-hour band no longer
       holds anything back (it still decides only how the page words the
       evidence);
     · nothing under 4 km is texted. It was 2 km. */
export const MIN_TRIP_KM = 4;

/** A place name a driver can read: the first part before a comma, starting
 *  with a letter, words and at most a trailing district number ("Al Barsha
 *  1"). "93 D65" and "16 9 St" are street codes, not places.
 *
 *  A BUILDING NUMBER IN FRONT OF A ROAD IS NOT A CODE. Measured 2026-10-01 over
 *  the 58 unexplained rides of 29 Sep – 1 Oct: 13 were held as "no readable
 *  place", the largest single reason, and most of the names refused were
 *  addresses — "33 Sheikh Rashid Rd", "352 Al Rasheed Road", "146 Al Khaleej
 *  Rd", "308 Damascus Street" — or numbered streets, "30th St", "19 5th
 *  Street". The building number is dropped and the road kept; an ordinal
 *  street ("30th St", "5th Street") is a name. What remains refused is what
 *  was always meant: a bare road code ("93 D65" → "D65") and a number with a
 *  street ("16 9 St"). */
const ORDINAL_STREET = /^\d{1,3}(?:st|nd|rd|th) (?:St|Street|Rd|Road|Ave|Avenue)\.?$/i;
export function readablePlace(area) {
  let a = String(area || '').split(',')[0].replace(/\s+/g, ' ').trim();
  const rest = a.replace(/^\d{1,4} (?=\S)/, '');
  if (rest !== a && (/^[A-Za-z]{2}/.test(rest) || ORDINAL_STREET.test(rest))) a = rest;
  if (a.length < 3 || a.length > 40) return null;
  if (ORDINAL_STREET.test(a)) return a;
  return /^[A-Za-z][A-Za-z'’ .-]*[A-Za-z.](?: \d{1,2})?$/.test(a) ? a : null;
}

/* ── one journey, judged ─────────────────────────────────────────────────── */
/* The segment columns the decision reads, with the attribution beside them —
   written once for the pass over new journeys and the re-check below. */
const SEGMENT_SQL = (where) => `
  SELECT o.source, o.plate, o.fleet_id, o.started_at, o.ended_at, o.distance_km, o.nearest_gap_min,
         o.verdict, o.ingested_at, ${placeEnds('o')}, ${ATTRIBUTION_COLS}
    FROM occupancy_segment o
    ${attributionJoin('o')}
   WHERE ${occCountsOnce('o')} AND ${where}`;

/** Every check one journey has to pass, in the order a hold is reported.
 *
 *  WHO THE EVIDENCE NAMES IS RECORDED WHETHER OR NOT THE MESSAGE GOES.
 *  ──────────────────────────────────────────────────────────────────────────
 *  This used to look the driver up only once every other check had passed,
 *  so a journey held for any reason — under 4 km, a booking 20 minutes away, a
 *  place with no readable name, the tracker's clock — was filed with no person
 *  and the Messages page printed "nobody the evidence names" under it. Measured
 *  2026-10-01 over the 58 unexplained rides of 29 Sep – 1 Oct: the evidence
 *  named exactly one driver on 51 of them (bracketed 9, last trip 33, sole
 *  custodian 9), and the page said nobody on every held row. The operator read
 *  it as "it finds the car but cannot find the driver". So the person is
 *  resolved whenever the evidence names one, and the candidates are kept by
 *  name when it names several, and the hold says why the text did not go. */
async function judgeTrip(q, s, { pb, dual, now }) {
  const start = new Date(s.started_at); const end = new Date(s.ended_at || s.started_at);
  const cands = Array.isArray(s.attribution_candidates) ? s.attribution_candidates : [];
  const from_ = readablePlace(s.start_place?.area);
  const to_ = readablePlace(s.end_place?.area);
  const km = Math.round(Number(s.distance_km || 0));
  const day = dubaiDay(start);
  const named = s.attribution_candidate_count === 1 && OK_TIERS.has(s.attribution_tier);
  let person = null;
  if (named) {
    const c = cands[0] || {};
    const [a] = await q(
      `SELECT driver_id::text AS person FROM driver_platform_id
        WHERE external_id = $1 AND detached_at IS NULL AND driver_id IS NOT NULL LIMIT 1`, [String(c.id || '')]);
    person = a?.person || null;
  }
  let hold = null;
  if (!named) hold = 'driver_not_certain';
  else if (s.clock_skew_min != null) hold = 'clock_skew';
  else if (!(Number(s.distance_km) >= MIN_TRIP_KM)) hold = 'short';
  else if (s.nearest_gap_min != null && Math.abs(Number(s.nearest_gap_min)) < 30) hold = 'near_booking';
  else if (!from_ || !to_) hold = 'places_unreadable';
  else if (from_.toLowerCase() === to_.toLowerCase()) hold = 'same_place';
  else if (s.source === 'cabman' && dual.has(s.plate)) hold = 'cabman_dual_tracker';

  /* A booking channel this car used in the last 14 days that did not
     collect for its fleet after the journey's day: a real booking may be
     missing, and the journey only looks unexplained. */
  let used = [];
  if (!hold) {
    used = (await q(
      `SELECT DISTINCT platform FROM trip WHERE plate = $1 AND fleet_id = $2 AND platform = ANY($4::text[])
          AND requested_at >= $3::timestamptz - interval '14 days' AND requested_at < $3::timestamptz`,
      [s.plate, s.fleet_id, end.toISOString(), BOOKING_SOURCES])).map((u) => u.platform);
    const collected = await collectedPairs(q, day, end);
    if (used.some((u) => !collected.has(`${u}:${s.fleet_id}`))) hold = 'booking_channel_down';
  }
  if (!hold && !person) hold = 'driver_not_placed';
  let ph = {};
  if (!hold) { ph = phoneFor(pb, person); if (ph.hold) hold = ph.hold; }
  if (!hold) {
    const [{ n }] = await q(
      `SELECT count(*)::int AS n FROM sms_outbox WHERE kind = 'trip_register' AND person_id = $1
          AND status IN ('sent', 'queued') AND (trip_start AT TIME ZONE 'Asia/Dubai')::date = $2::date`, [Number(person), day]);
    if (n >= 3) hold = 'daily_cap';
  }
  return { start, end, day, km, from_, to_, hold, person, ph, used, wait: !hold && isNight(now),
    candidates: cands.map((c) => c.name).filter(Boolean).slice(0, 4) };
}

export async function tripRegisterRun({ q, now = new Date(), send = sendSms, cfg = {}, dry = false, book = null }) {
  if (cfg.sms_trip === 'off') return { off: true };
  const [since] = await q(`SELECT value FROM sms_state WHERE key = 'trip_since'`);
  if (!since) return { error: 'no trip_since watermark (schema_v88 not applied)' };
  const from = new Date(Math.max(Date.parse(since.value), now.getTime() - 24 * 3600_000));
  const until = new Date(now.getTime() - 120 * 60_000);
  const out = { candidates: 0, sent: 0, queued: 0, held: 0, skipped: 0, holds: {}, decisions: [],
    rechecked: 0, released: 0, explained: 0 };
  const segs = from < until ? await q(`${SEGMENT_SQL(`o.verdict = 'unauthorized' AND o.ended_at > $1 AND o.ended_at <= $2`)}
      ORDER BY o.ended_at`, [from.toISOString(), until.toISOString()]) : [];
  out.candidates = segs.length;

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

    const d = await judgeTrip(q, s, { pb, dual, now });
    const text = d.from_ && d.to_ ? tripText(d.from_, d.to_, d.km) : null;
    out.decisions.push({ plate: s.plate, started_at: s.started_at, tier: s.attribution_tier, hold: d.hold,
      person: d.person, to: d.ph.phone ? maskPhone(d.ph.phone) : null, km: d.km, from: d.from_, to_place: d.to_,
      waits_until_7: d.wait });
    if (d.hold) { out.held += 1; out.holds[d.hold] = (out.holds[d.hold] || 0) + 1; }
    if (dry) continue;
    const id = await decide(q, {
      kind: 'trip_register', dedupe_key: `trip:${s.plate}:${d.start.toISOString()}`,
      person_id: d.person ? Number(d.person) : null, fleet_id: s.fleet_id, destination: d.ph.phone || null,
      message_text: text, status: d.hold ? 'held' : 'queued', hold_reason: d.hold,
      not_before: d.wait ? next7am(now).toISOString() : null,
      plate: s.plate, trip_start: d.start.toISOString(), trip_end: d.end.toISOString(), business_day: d.day,
      detail: JSON.stringify({ source: s.source, tier: s.attribution_tier, km: d.km, phone_source: d.ph.source || null,
        ...(d.person ? {} : { candidates: d.candidates }) }),
    });
    if (!id || d.hold) continue;
    if (d.wait) { out.queued += 1; continue; }
    if (await deliver(q, id, { to: d.ph.phone, text, ref: `fm-trip-${id}`, send })) out.sent += 1;
  }
  if (!dry) Object.assign(out, await recheckChannelDown({ q, now, send, pb, dual, out }));
  if (!dry) out.named = await nameHeldRows({ q, now, pb, dual });
  return out;
}

/* ── the rows filed before the driver was recorded ───────────────────────── */
/* A journey is filed once and skipped on every later pass (the overlap test
   above), so the rows held before 2026-10-01 — the ones on the operator's
   screen when they asked why the driver was not found — kept "nobody the
   evidence names" even after the run learned to record him. Each pass names
   the driver (or the candidates) on recent held rows that carry neither,
   from the same judgement. Nothing else about the row changes: not its hold,
   not its text, and nothing is sent — the hold was the decision at the time.
   A row the evidence names nobody on gets an empty candidate list, so it is
   looked at once, not every half hour. */
async function nameHeldRows({ q, now, pb, dual }) {
  const rows = await q(
    `SELECT id, plate, trip_start, trip_end FROM sms_outbox
      WHERE kind = 'trip_register' AND status = 'held' AND person_id IS NULL
        AND NOT (coalesce(detail, '{}'::jsonb) ? 'candidates') AND trip_end > $1
      ORDER BY trip_end DESC LIMIT 100`, [new Date(now.getTime() - RECHECK_DAYS * 864e5).toISOString()]);
  let named = 0;
  for (const m of rows) {
    const [s] = await q(`${SEGMENT_SQL(`o.plate = $1 AND o.started_at <= $3::timestamptz + interval '15 minutes'
        AND coalesce(o.ended_at, o.started_at) >= $2::timestamptz - interval '15 minutes'`)}
      ORDER BY (o.verdict = 'unauthorized') DESC, o.started_at LIMIT 1`,
    [m.plate, new Date(m.trip_start).toISOString(), new Date(m.trip_end).toISOString()]);
    const d = s ? await judgeTrip(q, s, { pb, dual, now }) : { person: null, candidates: [] };
    await q(`UPDATE sms_outbox SET person_id = $2,
                    detail = coalesce(detail, '{}'::jsonb) || $3::jsonb
              WHERE id = $1 AND person_id IS NULL`,
    [m.id, d.person ? Number(d.person) : null, JSON.stringify(d.person ? { named_at: now.toISOString() }
      : { candidates: d.candidates, named_at: now.toISOString() })]);
    if (d.person) named += 1;
  }
  return named;
}

/* ── a channel that did not collect, collecting again ────────────────────── */
/* The operator, 2026-10-01: "if and when bolt collects, and the trip is
   verified as unauthorized do let those drivers know." Bolt for Ecosine did
   not collect from 2026-09-28 until its portal login was replaced on 1 Oct,
   and every journey on a car that works Bolt was held as
   booking_channel_down — rightly, since a Bolt booking nobody had fetched
   may explain it — and then never looked at again.

   Each pass now looks again at those holds, for RECHECK_DAYS after the
   journey. One is released only when BOTH are true:
     · every channel the car used has since collected that day (the same test
       that held it), and
     · the journey has been JUDGED AGAIN since then — its segment was written
       by a reconcile pass after the channel's run finished (the reconcile
       deletes and re-inserts its window, so ingested_at is when it last
       judged). A segment still carrying the verdict from before the data
       arrived could be one the new Bolt booking explains.
   Still unexplained, and every other check still passed: texted, naming the
   day, since it is late. Explained by the new data: held as
   no_longer_unauthorized, the reason the 07:00 re-read already uses. */
export const RECHECK_DAYS = 7;
async function recheckChannelDown({ q, now, send, pb, dual }) {
  /* late_sent / late_failed: what the gateway said to each released text —
     "released" alone does not say a driver was reached. */
  const res = { rechecked: 0, released: 0, explained: 0, late_sent: 0, late_failed: 0 };
  const held = await q(
    `SELECT id, plate, fleet_id, trip_start, trip_end FROM sms_outbox
      WHERE kind = 'trip_register' AND status = 'held' AND hold_reason = 'booking_channel_down'
        AND trip_end > $1 ORDER BY trip_end LIMIT 200`, [new Date(now.getTime() - RECHECK_DAYS * 864e5).toISOString()]);
  for (const m of held) {
    /* Cheap first: is every channel this car used collected for the day yet?
       Most holds are still waiting, and the attribution query below is not
       one to run for each of them every half hour. */
    const end0 = new Date(m.trip_end);
    const used0 = (await q(
      `SELECT DISTINCT platform FROM trip WHERE plate = $1 AND fleet_id = $2 AND platform = ANY($4::text[])
          AND requested_at >= $3::timestamptz - interval '14 days' AND requested_at < $3::timestamptz`,
      [m.plate, m.fleet_id, end0.toISOString(), BOOKING_SOURCES])).map((u) => u.platform);
    const collected0 = await collectedPairs(q, dubaiDay(new Date(m.trip_start)), end0);
    if (used0.some((u) => !collected0.has(`${u}:${m.fleet_id}`))) continue;
    res.rechecked += 1;
    const [s] = await q(`${SEGMENT_SQL(`o.plate = $1 AND o.started_at <= $3::timestamptz + interval '15 minutes'
        AND coalesce(o.ended_at, o.started_at) >= $2::timestamptz - interval '15 minutes'`)}
      ORDER BY (o.verdict = 'unauthorized') DESC, o.started_at LIMIT 1`,
    [m.plate, new Date(m.trip_start).toISOString(), new Date(m.trip_end).toISOString()]);
    if (!s || s.verdict !== 'unauthorized') {
      await q(`UPDATE sms_outbox SET hold_reason = 'no_longer_unauthorized' WHERE id = $1 AND status = 'held'`, [m.id]);
      res.explained += 1; continue;
    }
    const d = await judgeTrip(q, s, { pb, dual, now });
    if (d.hold === 'booking_channel_down') continue;
    /* Judged again since every channel it depends on delivered the day? The
       reconcile after a run re-judges that run's window and nothing else, so
       the runs that count are the ones whose window covers the journey's
       day; a later half-hourly run over the last 3 days says nothing about a
       journey 5 days old, and counting it would hold that journey for ever. */
    const pairs = d.used.map((u) => `${u}:${s.fleet_id}`);
    const [{ last }] = pairs.length ? await q(
      `SELECT max(finished_at) AS last FROM collection_run
        WHERE source || ':' || fleet_id = ANY($1::text[]) AND status IN ('ok', 'partial')
          AND ${TRIP_RUN_SQL}
          AND window_start <= $2::date AND window_end >= $2::date AND finished_at >= $3`,
      [pairs, d.day, d.end.toISOString()]) : [{ last: null }];
    if (last && !(new Date(s.ingested_at) > new Date(last))) continue;
    const text = d.from_ && d.to_ ? tripText(d.from_, d.to_, d.km, d.day) : null;
    if (d.hold) {
      await q(`UPDATE sms_outbox SET hold_reason = $2, person_id = $3 WHERE id = $1 AND status = 'held'`,
        [m.id, d.hold, d.person ? Number(d.person) : null]);
      continue;
    }
    const [claim] = await q(
      `UPDATE sms_outbox SET status = 'queued', hold_reason = NULL, person_id = $2, destination = $3,
              message_text = $4, not_before = $5,
              detail = coalesce(detail, '{}'::jsonb) || $6::jsonb
        WHERE id = $1 AND status = 'held' AND hold_reason = 'booking_channel_down' RETURNING id`,
    [m.id, Number(d.person), d.ph.phone, text, d.wait ? next7am(now).toISOString() : null,
      JSON.stringify({ rechecked_at: now.toISOString(), phone_source: d.ph.source || null })]);
    if (!claim) continue;
    res.released += 1;
    if (d.wait) continue;
    if (await deliver(q, m.id, { to: d.ph.phone, text, ref: `fm-trip-${m.id}`, send })) res.late_sent += 1;
    else res.late_failed += 1;
  }
  return res;
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
