/* ── Bolt's trips from the fleet-integration API, beside the portal ────────
   THE NEED. Every Bolt trip this product holds came from one surface: the
   fleet-owner portal's orderHistory/getTable, read with a portal refresh
   token. That token is a signed-in human session — its JWT's exp - iat is
   exactly 7.00 days, and a newer portal sign-in supersedes it early
   (docs/COVERAGE.md, "BOLT IS TWO CREDENTIALS, AND ONLY ONE OF THEM CAN EVER
   BE LONG-LIVED"). So every lapse is a hole in Bolt's trips until somebody
   pastes a fresh capture, and the next one is scheduled: both live tokens
   expire 2026-11-14 15:06Z.

   The other Bolt credential, the fleet-integration OAuth client
   (BOLT_CLIENT_ID / BOLT_CLIENT_SECRET), has no expiry and mints its own
   600 s access token per call (fiToken() in src/sources/bolt.js). Its
   getFleetOrders route answered the nightly probe — measured on production,
   /api/probe/results, 2026-11-11 22:20Z:

     egari:getFleetOrders    http 200, code 0, 24 orders in three days
     ecosine:getFleetOrders  http 200, code 503 NOT_AUTHORIZED
                             error_hint COMPANIES_NOT_ALLOWED

   and no collector read them. That is the whole of this file: read them, for
   every company the client is entitled to, over the same windows the portal
   harvest walks, and put them on the SAME trip rows — so the trips keep
   flowing when the portal token is dead, and the two feeds never count one
   ride twice.

   WHAT BOLT'S OWN SPEC SAYS, read 2026-11-12 from
   https://apidocs.bolt.eu/fleetIntegration/fleetIntegrationGatewayAuth/open-api.json
   (public, no credential): POST /fleetIntegration/v1/getFleetOrders takes
   {company_ids: [int] (required), company_id, offset, limit (1..1000),
   start_ts, end_ts (unix s), time_range_filter_type 'created' (default) |
   'price_review'} and answers {code, message, data: {company_id,
   company_name, total_orders, orders: FleetOrder[]}}, sorted by creation
   time. It names four refusals of its own — 498805 INVALID_START_DATE (older
   than Bolt keeps), 498806 INVALID_DATE_RANGE (window too long; getDrivers
   words it "maximum allowed date range is 31 days"), 498809
   COMPANY_NOT_ACTIVE, 498810 COMPANY_NOT_ALLOWED — and production adds a
   fifth, measured above: 503 NOT_AUTHORIZED / COMPANIES_NOT_ALLOWED for a
   company the client is not entitled to. Each one is read by name below,
   because each needs a different answer. A FleetOrder carries
   order_reference (Bolt's order id — the portal has none), timestamps in
   unix seconds (the probe's narrow sample shows order_cancelled_timestamp
   1794370437, which is 2026-11-10), order_stops with coordinates (the
   portal sends no coordinate at all: 0 of 48,346 Bolt rows), and
   order_price with commission and net_earnings per ride.

   ONE ROW PER ORDER, WHOEVER WROTE IT. The trip table's key is (platform,
   external_id). The portal's external_id is synthesised — `${driver.id}|
   ${created}`, its numeric driver id and the order's creation second
   (portalRow in src/sources/bolt.js) — because the portal sends no order id.
   This feed sends Bolt's order id but a different driver id (the uuid the
   fleet-integration roster uses). So the two cannot share a key by
   construction, and the dedupe is done by what both DO share:

     the same fleet, the same creation second, and the same car (the plate's
     digits — the portal drops the letter code) or the same driver (the
     portal's partner_identifier against this feed's partner_uuid or
     driver_uuid, or a driver id pair learned from an earlier match).

   A car cannot begin two orders in the same second. The rule is exact-second
   on purpose: a missed match costs an empty column, a wrong match writes one
   ride's coordinates onto another, so where the two trade off this declines.
   Whether Bolt's two APIs stamp the same second is not something this
   sandbox can measure — no credential reaches Bolt from here — so every pass
   counts how many orders the portal had answered for and how many of those
   matched, and says so loudly when the rule stops holding.

   WHO MAY WRITE A ROW OF ITS OWN, and why nothing is counted twice:

   1. An order that matches a portal row FILLS that row — only columns the
      portal left empty, or the plate where the portal sent digits only and
      this feed sends the same digits with the letter code. The portal's
      values are never replaced by this feed's.
   2. An order that matches nothing becomes a trip row of its own ONLY if it
      was created after the moment the portal last answered for this fleet
      ("answered through", kept in source_state and advanced by the portal
      harvest itself). If the portal answered for that moment and returned
      no such row, the order is HELD: the portal's answer for a day it served
      is the record, and an order that cannot be matched there is exactly the
      order that might be a duplicate.
   3. When the portal next answers for a day, it removes every stand-in row
      this feed wrote for that day before the moment it asked
      (supersedeFiRows, called by the portal harvest per window), and this
      feed's pass that follows re-attaches its orders to the portal's rows.
   4. Where a driver's portal id is already known, a stand-in row is keyed
      exactly as the portal will key it, so the portal's own row lands on the
      same row when it comes and nothing has to be removed at all.

   PROVENANCE. Every row this feed touched carries `raw.fleet_integration`:
   which order, whether the portal or this feed served the row, and which
   columns this feed filled. trip.raw merges on upsert (JSONB_MERGE in
   src/db.js), so the portal's next write keeps it; and the portal's write
   leaves a column this feed filled alone when the portal itself has nothing
   for it (keepFiFills), so a filled value does not flap back to NULL every
   half hour. Every order, whatever became of it, is in bolt_fi_order
   (sql/schema_v116.sql) with its disposition. */

import { config, reconcilePlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, pool } from '../db.js';
import { dubaiIso, iso } from '../util.js';
import { log } from '../log.js';

const SRC = 'bolt';

/* What a window is called on the run record. `kind` is the one per-window key
   logRun keeps (src/db.js) and /api/status now projects, so the status page
   can say which feed served which dates. */
export const FI_KIND = 'fleet-integration';
export const PORTAL_KIND = 'portal';
export const FI_SOURCE = 'getFleetOrders';
const NAME = 'fleet-integration orders';

/* Bolt's spec: "Must be a number between 1 and 1000". Stepped down if the
   gateway ever refuses the page size by name — the portal's own documented
   limit turned out to be 100 when asked (200 answers "Integer is not in
   range"), and a constant nobody can see refusing is a constant nobody fixes. */
export const FI_PAGE_STEPS = Object.freeze([1000, 200, 50]);
/* 498806 above 31 days (measured on getDrivers, same gateway). Thirty Dubai
   days is 30 × 86,400 − 1 s, inside it, and lines up with the portal's own
   30-day windows. A refusal anyway splits the window rather than losing it. */
export const FI_ORDER_MAX_DAYS = 30;
export const FI_CODES = Object.freeze({
  START_TOO_OLD: 498805, RANGE_TOO_LONG: 498806, COMPANY_NOT_ACTIVE: 498809, COMPANY_NOT_ALLOWED: 498810,
});
const NOT_ENTITLED = /COMPANIES?_NOT_ALLOWED/i;
/* The gateway's rate-limit answer is not measured. HTTP 429 is the standard
   one; 1005 is what Bolt's PORTAL answers (src/sources/bolt.js
   RATE_LIMIT_CODE); the words catch a JSON body that says so. A rate limit is
   the one refusal that is not an answer about the data, so it is waited out,
   never recorded as one. */
const RATE_LIMIT_WORDS = /RATE.?LIMIT|TOO.?MANY.?REQUESTS|THROTTL/i;
const PORTAL_RATE_LIMIT_CODE = 1005;
const RATE_LIMIT_TRIES = 5;
const backoffMs = (n) => 2000 * (2 ** n);   // 2s, 4s, 8s, 16s, 32s
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/* docs/fleet-tracking-api-reference.md §3a: token TTL 600 s. Re-minted two
   minutes early, and once on a 401/403, so a backfill that outlives one token
   does not read its own token's age as a refusal. */
const FI_TOKEN_MS = 600_000;
const FI_TOKEN_MARGIN_MS = 120_000;
/* source_state key the portal harvest advances: the latest instant up to
   which the portal has answered for this fleet. */
export const ANSWERED_KEY = 'portal_answered_through';
/* What the portal writes and this feed may only fill when it is empty. The
   portal never writes the coordinates, the duration or is_scheduled, so those
   persist on their own; the rest are protected from the portal's NULLs by
   keepFiFills. */
const PORTAL_WRITES = Object.freeze(['plate', 'driver_name', 'ended_at', 'pickup_addr', 'dropoff_addr',
  'distance_km', 'product', 'payment_type', 'price']);
const FILLABLE = Object.freeze([...PORTAL_WRITES, 'pickup_lat', 'pickup_lng', 'dropoff_lat',
  'dropoff_lng', 'duration_s', 'is_scheduled']);

const DAY = 864e5;
const dubaiMidnight = (d) => Date.parse(`${d}T00:00:00+04:00`);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/* A Date is an instant and is read on the fleet's clock; a 'YYYY-MM-DD'
   string is already a Dubai day. src/run.js hands Dates, a test or a queued
   job hands strings. */
const dayOf = (v) => (typeof v === 'string' ? v.slice(0, 10) : dubaiIso(v));
const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const sec = (v) => { const n = Math.floor(Number(v)); return n > 0 ? n : null; };
const isoOf = (s) => (s ? new Date(s * 1000).toISOString() : null);
const asNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/* ZERO IS ABSENCE for the two figures that decide a row's grade — the same
   rule portalRow applies (has_fare in sql/schema_v18.sql is `price IS NOT
   NULL`, and a 0 fare counted every cancellation as a priced ride). */
const positive = (v) => { const n = asNum(v); return n != null && n > 0 ? n : null; };
export const digits = (p) => (p ? String(p).replace(/\D/g, '') : '') || null;

/* ── the windows ─────────────────────────────────────────────────────────── */
/* Dubai days, at most `maxDays` per window, NEWEST FIRST — the order the
   portal harvest walks, so the first refusal of an old window is the
   retention boundary and nothing older is worth asking. The newest window
   ends NOW, not at the end of today: an end in the future is what the portal
   refuses (code 702), and nothing here needs it. */
export function fiWindow(fromDay, toDay, now) {
  const start = dubaiMidnight(fromDay);
  const end = Math.min(dubaiMidnight(plusDays(toDay, 1)) - 1000, now);
  return { from: fromDay, to: toDay, start_ts: Math.floor(start / 1000), end_ts: Math.floor(end / 1000) };
}

export function fiWindows(from, to, { maxDays = FI_ORDER_MAX_DAYS, now = Date.now() } = {}) {
  const today = dubaiIso(new Date(now));
  const first = dayOf(from);
  let last = dayOf(to);
  if (last > today) last = today;
  const wins = [];
  for (let s = first; s <= last;) {
    let e = plusDays(s, maxDays - 1);
    if (e > last) e = last;
    wins.push(fiWindow(s, e, now));
    s = plusDays(e, 1);
  }
  return wins.reverse();
}

/* Two halves, newest first — or null for a single day, which cannot be split.
   Used for a window the gateway calls too long, and to find the retention
   boundary to the day rather than losing a whole window to it. */
export function splitWindow(w, now = Date.now()) {
  const days = Math.round((Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / DAY) + 1;
  if (!(days > 1)) return null;
  const midEnd = plusDays(w.from, Math.floor(days / 2) - 1);
  return [fiWindow(plusDays(midEnd, 1), w.to, now), fiWindow(w.from, midEnd, now)];
}

/* ── one answer, read ────────────────────────────────────────────────────── */
/* SUCCESS IS EXPLICIT, not the absence of a failure — the lesson the portal
   reader paid for (an HTML page from a CDN edge has no code and no rows, and
   was read as a quiet window). A page counts only when Bolt said code 0 AND
   sent `orders` as an array BY NAME. Not "the first array in the body":
   that is exactly how the probe counted `validation_errors` as one row of
   data for months (docs/COVERAGE.md, "A GATEWAY THAT REJECTS THE REQUEST IN A
   200"). Exported so every branch can be driven without the gateway. */
export function readFiOrders(res) {
  const status = Number(res?.status) || 200;
  const data = res?.data;
  const code = Number(data?.code);
  const words = `${data?.message ?? ''} ${data?.error_hint ?? ''}`;
  if (status === 429 || code === PORTAL_RATE_LIMIT_CODE || RATE_LIMIT_WORDS.test(words)) {
    return { kind: 'rate-limited', says: status === 429 ? 'HTTP 429' : `${data?.message || 'rate limited'} (code ${data?.code})` };
  }
  if (status >= 200 && status < 300 && code === 0 && Array.isArray(data?.data?.orders)) {
    const total = asNum(data.data.total_orders);
    return { kind: 'ok', orders: data.data.orders, total };
  }
  const hint = data?.error_hint ? ` hint=${data.error_hint}` : '';
  const says = Number.isFinite(code)
    ? `${data?.message || 'refused'} (code ${code}${hint})`
    : (status >= 300 ? `HTTP ${status}` : `unrecognisable response (${typeof data}`
      + `${data && typeof data === 'object' ? `, keys ${Object.keys(data).slice(0, 4).join()}` : ''})`);
  if (code === FI_CODES.COMPANY_NOT_ALLOWED || NOT_ENTITLED.test(words)) return { kind: 'not-entitled', code, says };
  if (code === FI_CODES.START_TOO_OLD || /INVALID_START_DATE/i.test(words)) return { kind: 'too-old', code, says };
  if (code === FI_CODES.RANGE_TOO_LONG || /INVALID_DATE_RANGE/i.test(words)) return { kind: 'range-too-long', code, says };
  if (code === FI_CODES.COMPANY_NOT_ACTIVE || /COMPANY_NOT_ACTIVE/i.test(words)) return { kind: 'inactive', code, says };
  const v = Array.isArray(data?.validation_errors) ? data.validation_errors : [];
  if (v.length) {
    return { kind: v.some((e) => e?.property === 'limit') ? 'page-size' : 'invalid', code,
      says: `${data?.message || 'INVALID_REQUEST'}: ${v.map((e) => `${e?.property} ${e?.error}`).join(', ')}` };
  }
  if (status === 401 || status === 403) return { kind: 'unauthorised', status, says: `HTTP ${status}` };
  return { kind: 'refused', code: Number.isFinite(code) ? code : null, status, says };
}

/* ── the walk ────────────────────────────────────────────────────────────── */
/* Windows newest first, pages within each, a rate limit waited out, and a
   refusal on one window never a refusal of the run. `ask(win, offset, limit)`
   returns { status, data } — injected, like `sleep`, so every branch can be
   driven in a test without the gateway or a minute of real waiting. `sink`
   gets each window's orders as soon as the window is complete, so a throw
   costs the window in flight and not the windows behind it.

   Returns the run's share of the record:
     chunks    one {from, to, rows, error} per window attempted — the shape
               logRun stores; `rows` is how many orders Bolt returned for it
     stop      the company itself was refused (not entitled / not active):
               nothing more is asked and no window is recorded as failed,
               because no window failed — the company was refused
     tooOld    the oldest day Bolt refused as before its retention (a fact
               about the provider, never a fault) */
export async function harvestFiOrders({ from, to, ask, sink = null, warn = () => {}, sleep = realSleep,
  now = Date.now(), maxDays = FI_ORDER_MAX_DAYS, pageSteps = FI_PAGE_STEPS }) {
  const queue = fiWindows(from, to, { maxDays, now });
  const steps = [...pageSteps];
  const chunks = [];
  const refusals = [];
  let stop = null, tooOld = null;
  let asked = 0, limited = 0, dropped = 0, short = 0, orders = 0;
  while (queue.length) {
    const win = queue.shift();
    const seen = new Map();
    let offset = 0, declared = null, err = null, guard = 0, replaced = false, boundary = false;
    pages: for (;;) {
      let reading;
      try {
        for (let tryN = 0; ; tryN++) {
          reading = readFiOrders(await ask(win, offset, steps[0]));
          asked++;
          if (reading.kind !== 'rate-limited' || tryN >= RATE_LIMIT_TRIES - 1) break;
          limited++;
          warn('rate limited, waiting', { win: win.from, offset, wait_ms: backoffMs(tryN) });
          await sleep(backoffMs(tryN));
        }
      } catch (e) {
        /* A THROWN REQUEST IS A WINDOW THAT DID NOT ANSWER, NOT A RUN THAT
           FAILED — src/http.js re-throws after its own retries, and one reset
           connection must not take every window already collected with it. */
        err = `${String(e?.message || e).slice(0, 200)} on ${win.from}..${win.to}`;
        break;
      }
      switch (reading.kind) {
        case 'ok': break;
        case 'page-size':
          if (steps.length > 1) {
            warn('page size refused, stepping down', { from: steps[0], to: steps[1], says: reading.says });
            steps.shift();
            offset = 0; seen.clear();
            continue pages;
          }
          err = `${reading.says} on ${win.from}..${win.to}`;
          break pages;
        case 'range-too-long': {
          const halves = splitWindow(win, now);
          if (halves) { queue.unshift(...halves); replaced = true; break pages; }
          err = `${reading.says} on ${win.from}..${win.to}`;
          break pages;
        }
        case 'too-old': {
          /* The retention boundary, found to the DAY: a window straddling it
             is split and its newer half asked again, rather than losing the
             days Bolt does keep to the ones it does not. */
          const halves = splitWindow(win, now);
          if (halves) { queue.unshift(...halves); replaced = true; break pages; }
          tooOld = win; boundary = true;
          break pages;
        }
        case 'not-entitled': case 'inactive':
          stop = reading;
          break pages;
        default:
          err = `${reading.says} on ${win.from}..${win.to}`;
          break pages;
      }
      declared = reading.total;
      for (const o of reading.orders) {
        const ref = str(o?.order_reference);
        if (!ref) { dropped++; continue; }
        seen.set(ref, o);
      }
      offset += steps[0];
      /* total_orders is the WINDOW's count, so the loop stops on it as well
         as on a short page. */
      if (reading.orders.length < steps[0] || (declared != null && offset >= declared)) break;
      if (++guard > 400) { warn('page guard hit', { win: win.from }); break; }
    }
    if (replaced) continue;
    if (stop) break;
    if (boundary) {
      /* Everything still queued is older than the boundary day. */
      queue.length = 0;
      break;
    }
    /* Offset paging over a creation-time sort can lose a row where a tie
       straddles a page edge, and no error says so. Bolt declares the
       window's total, so the shortfall is arithmetic: said, not hidden. */
    let error = err;
    if (!err && declared != null && seen.size < declared) {
      short += declared - seen.size;
      error = `collected ${seen.size} of ${declared} declared`;
      warn('window short of the count Bolt declared', { win: win.from, collected: seen.size, declared });
    }
    if (err) refusals.push({ window: win.from, says: err });
    if (!err && sink && seen.size) {
      try {
        await sink([...seen.values()], win);
      } catch (e) {
        /* Read, and not stored: a window that answered and could not be
           written is not a window Bolt refused, and must not read like one. */
        error = `read ${seen.size} orders, stored none: ${String(e?.message || e).slice(0, 160)}`;
        refusals.push({ window: win.from, says: error });
      }
    }
    orders += seen.size;
    chunks.push({ from: win.from, to: win.to, rows: seen.size, error: error || null });
  }
  return { chunks, refusals, stop, tooOld, asked, limited, dropped, short, orders };
}

/* ── one order, in this product's words ──────────────────────────────────── */
/* A coordinate pair, or null. (0, 0) is a sentinel, not the Gulf of Guinea. */
const coord = (lat, lng) => {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null;
  return { lat: a, lng: b };
};
/* real_lat/real_lng where Bolt sent them, else the stop as requested. The
   spec makes real_* nullable and lat/lng required; the reading that real_* is
   where the stop actually happened is the field names', not measured, so
   which one was used is written on the row (`pickup_basis`). */
const stopPoint = (s) => {
  if (!s) return { lat: null, lng: null, basis: null };
  const real = coord(s.real_lat, s.real_lng);
  if (real) return { ...real, basis: 'real' };
  const asked = coord(s.lat, s.lng);
  return asked ? { ...asked, basis: 'requested' } : { lat: null, lng: null, basis: null };
};

export function orderFacts(o, plates = null) {
  const ref = str(o?.order_reference);
  const createdS = sec(o?.order_created_timestamp);
  if (!ref || !createdS) return null;
  const stops = Array.isArray(o.order_stops) ? o.order_stops : [];
  const pick = stops.find((s) => s?.type === 'pickup') || null;
  const drops = stops.filter((s) => s?.type === 'dropoff');
  const pickupS = sec(o.order_pickup_timestamp);
  const dropS = sec(o.order_drop_off_timestamp);
  const plate = reconcilePlate(o.vehicle_license_plate, plates);
  const price = o.order_price || {};
  return {
    ref, createdS,
    requestedAt: isoOf(createdS),
    status: str(o.order_status),
    driverUuid: str(o.driver_uuid),
    partnerUuid: str(o.partner_uuid),
    driverName: str(o.driver_name),
    plate,
    plateDigits: digits(plate),
    pickup: { ...stopPoint(pick), addr: str(o.pickup_address) ?? str(pick?.address) },
    dropoff: { ...stopPoint(drops[drops.length - 1]),
      addr: str(o.destination_address) ?? str(drops[drops.length - 1]?.address) },
    /* The drop-off, else the moment the fare was finished — the same pair
       portalRow reads (last arrival, else fare_finalised). A cancellation's
       timestamp is NOT an end: a ride that never ran has no end. */
    endedAt: isoOf(dropS || sec(o.order_finished_timestamp)),
    /* With the rider: pick-up to drop-off. Bounded to a day, because a pair
       of stamps that disagree by more is a fault, not a ride. */
    durationS: pickupS && dropS && dropS > pickupS && dropS - pickupS < 86400 ? dropS - pickupS : null,
    distanceRaw: positive(o.ride_distance),
    price: positive(price.ride_price),
    money: {
      ride_price: asNum(price.ride_price), commission: asNum(price.commission),
      net_earnings: asNum(price.net_earnings),
    },
    product: str(o.category_info?.name),
    paymentType: str(o.payment_method),
    isScheduled: typeof o.is_scheduled === 'boolean' ? o.is_scheduled : null,
  };
}

/* The order as stored: Bolt's own payload, minus the driver's phone, which
   nothing reads and which is personal data. */
export function keptOrder(o) {
  const { driver_phone: _dropped, ...kept } = o || {};
  return kept;
}

/* ── the unit of ride_distance, measured rather than assumed ─────────────── */
/* Bolt's spec types ride_distance as a bare number and names no unit; the
   portal's `distance` is kilometres (10.7 on a 48-dirham ride in
   test/fixtures/bolt_order_table.json). A factor of a thousand is not a
   thing to guess, so it is decided per batch: against the portal's own
   kilometres where the same rides are matched (the authority), else from the
   magnitude of the finished rides — a fleet whose median ride is 12,000 is
   counting metres, one whose median is 12 is counting kilometres, and
   nothing in Dubai sits between the two bands. Undecided is NULL distance
   with the value kept in raw, never a guess. */
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export function distanceUnit(facts, pairs = []) {
  const ratios = pairs.filter(([f, p]) => f.distanceRaw > 0 && Number(p.distance_km) > 0)
    .map(([f, p]) => f.distanceRaw / Number(p.distance_km));
  if (ratios.length >= 3) {
    const r = median(ratios);
    if (r >= 800 && r <= 1250) return { unit: 'm', basis: 'portal', n: ratios.length, median: r };
    if (r >= 0.8 && r <= 1.25) return { unit: 'km', basis: 'portal', n: ratios.length, median: r };
    return { unit: null, basis: 'portal', n: ratios.length, median: r,
      says: `ride_distance is ${r.toFixed(2)}× the portal's kilometres on ${ratios.length} matched rides` };
  }
  const vals = facts.filter((f) => f.status === 'finished' && f.distanceRaw > 0).map((f) => f.distanceRaw);
  if (vals.length >= 5) {
    const m = median(vals);
    if (m >= 500 && m <= 200000) return { unit: 'm', basis: 'magnitude', n: vals.length, median: m };
    if (m >= 0.5 && m <= 200) return { unit: 'km', basis: 'magnitude', n: vals.length, median: m };
  }
  return { unit: null, basis: null, n: vals.length };
}
const kmOf = (raw, unit) => (raw == null || !unit ? null
  : Math.round((unit === 'm' ? raw / 1000 : raw) * 100) / 100);

/* ride_price against the portal's price on the same rides. The concept is the
   same by name — what the rider paid for the ride — but not measured; where
   five or more matched rides disagree, the batch fills no price from this
   feed rather than a figure that means something else. With no portal rides
   to compare (the portal token dead, which is when this feed matters), Bolt's
   own ride_price is used as Bolt states it. */
export function priceAgreement(pairs = []) {
  const both = pairs.filter(([f, p]) => f.price > 0 && Number(p.price) > 0);
  const agree = both.filter(([f, p]) => Math.abs(f.price - Number(p.price)) <= 0.01).length;
  return { n: both.length, agree, ok: both.length < 5 || agree / both.length >= 0.8 };
}

/* ── the match ───────────────────────────────────────────────────────────── */
export function sameOrder(f, p, xref = new Map()) {
  const pd = digits(p?.plate);
  if (f.plateDigits && pd && f.plateDigits === pd) return true;
  /* Selected out of raw by the pass's query; read from raw directly for a row
     as portalRow builds it. */
  const pid = str(p?.partner_identifier ?? p?.raw?.partner_identifier);
  if (pid && (pid === f.partnerUuid || pid === f.driverUuid)) return true;
  const mapped = f.driverUuid ? xref.get(f.driverUuid) : null;
  return !!(mapped && p?.driver_ext_id != null && String(mapped) === String(p.driver_ext_id));
}

/* Each order to at most ONE portal row and each portal row to at most ONE
   order. Two candidates, or two orders on one row, is ambiguous and touches
   nothing. */
export function matchOrders(facts, portalRows, xref = new Map()) {
  const bySecond = new Map();
  for (const p of portalRows || []) {
    const t = p?.requested_at == null ? NaN : new Date(p.requested_at).getTime();
    if (!Number.isFinite(t) || !p.external_id) continue;
    const s = Math.floor(t / 1000);
    if (!bySecond.has(s)) bySecond.set(s, []);
    bySecond.get(s).push(p);
  }
  const out = new Map();
  const claims = new Map();
  for (const f of facts) {
    const cands = (bySecond.get(f.createdS) || []).filter((p) => sameOrder(f, p, xref));
    if (cands.length === 1) {
      out.set(f.ref, { row: cands[0] });
      const k = cands[0].external_id;
      if (!claims.has(k)) claims.set(k, []);
      claims.get(k).push(f.ref);
    } else if (cands.length > 1) {
      out.set(f.ref, { ambiguous: cands.length });
    }
  }
  for (const refs of claims.values()) {
    if (refs.length > 1) for (const r of refs) out.set(r, { ambiguous: refs.length });
  }
  return out;
}

/* ── what an order may fill on a portal row ──────────────────────────────── */
const same = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date || /^\d{4}-\d\d-\d\dT/.test(String(a))) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 1e-6;
  return String(a) === String(b);
};
/* The values this feed would give each column. */
export function fiValues(f, { unit = null, priceOk = true } = {}) {
  return {
    plate: f.plate, driver_name: f.driverName, ended_at: f.endedAt,
    pickup_addr: f.pickup.addr, dropoff_addr: f.dropoff.addr,
    distance_km: kmOf(f.distanceRaw, unit), product: f.product, payment_type: f.paymentType,
    price: priceOk ? f.price : null,
    pickup_lat: f.pickup.lat, pickup_lng: f.pickup.lng,
    dropoff_lat: f.dropoff.lat, dropoff_lng: f.dropoff.lng,
    duration_s: f.durationS, is_scheduled: f.isScheduled,
  };
}

/* Only what the portal row lacks — or the plate, where the portal sent the
   digits alone and this feed sends the same digits with the letter code
   (Dubai plates are a code and a number, L36397; src/config.js
   reconcilePlate explains the 36397/L36397 split). Coordinates go in pairs.
   `filled` is every column whose stored value is this feed's — what it fills
   now, plus what it filled before and still holds — and is what keepFiFills
   protects from the portal's next NULL. */
export function fillPlan(p, f, opts = {}) {
  const v = fiValues(f, opts);
  const set = {};
  const empty = (c) => p[c] == null;
  for (const c of ['driver_name', 'ended_at', 'pickup_addr', 'dropoff_addr', 'distance_km',
    'product', 'payment_type', 'price', 'duration_s', 'is_scheduled']) {
    if (v[c] != null && empty(c)) set[c] = v[c];
  }
  for (const [a, b] of [['pickup_lat', 'pickup_lng'], ['dropoff_lat', 'dropoff_lng']]) {
    if (v[a] != null && v[b] != null && empty(a) && empty(b)) { set[a] = v[a]; set[b] = v[b]; }
  }
  if (v.plate) {
    if (empty('plate')) set.plate = v.plate;
    else if (/^\d+$/.test(String(p.plate)) && /^[A-Z]+\d+$/.test(v.plate) && v.plate.endsWith(String(p.plate))) {
      set.plate = v.plate;
    }
  }
  const before = Array.isArray(p.fi?.filled) ? p.fi.filled : [];
  const still = before.filter((c) => FILLABLE.includes(c) && !(c in set) && p[c] != null && same(p[c], v[c]));
  const filled = [...new Set([...Object.keys(set), ...still])].sort();
  return { set, filled };
}

/* Key-order-free JSON, for comparing what is stored with what would be
   written. jsonb hands keys back in ITS order (shorter keys first), not the
   order they were written in, so a plain JSON.stringify comparison reads every
   stored provenance as changed and rewrites every row on every pass — the
   dead-tuple cost src/db.js's changed-guard exists to prevent. */
export const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null));

/* The provenance a row carries. Stable on purpose — no per-pass timestamp —
   so a pass that changes nothing writes nothing. */
export function provenance(f, servedBy, filled, order = null) {
  const out = { source: FI_SOURCE, order_reference: f.ref, served_by: servedBy, filled };
  if (filled.includes('pickup_lat') && f.pickup.basis) out.pickup_basis = f.pickup.basis;
  if (filled.includes('dropoff_lat') && f.dropoff.basis) out.dropoff_basis = f.dropoff.basis;
  if (order) out.order = order;
  return out;
}

/* A trip row of this feed's own, for an order the portal has not answered for. */
export function orderTripRow(f, o, c, { key, driverExtId, unit = null, priceOk = true } = {}) {
  const v = fiValues(f, { unit, priceOk });
  const filled = FILLABLE.filter((col) => v[col] != null).sort();
  return {
    platform: SRC, external_id: key, fleet_id: c.fleet,
    plate: v.plate, driver_ext_id: driverExtId ?? f.driverUuid, driver_name: v.driver_name,
    requested_at: f.requestedAt, ended_at: v.ended_at,
    pickup_addr: v.pickup_addr, pickup_lat: v.pickup_lat, pickup_lng: v.pickup_lng,
    dropoff_addr: v.dropoff_addr, dropoff_lat: v.dropoff_lat, dropoff_lng: v.dropoff_lng,
    distance_km: v.distance_km, duration_s: v.duration_s,
    status: f.status, product: v.product, payment_type: v.payment_type,
    price: v.price, currency: 'AED', is_scheduled: v.is_scheduled,
    /* JSON.stringify'd at the write: node-postgres encodes a JS array as a
       Postgres array literal, and a JSONB column refuses it (docs/COVERAGE.md
       trap, 2026-09-23). An object would survive; a string survives always. */
    raw: JSON.stringify({ fleet_integration: provenance(f, FI_KIND, filled, keptOrder(o)) }),
  };
}

export function fiOrderRow(c, f, o, { disposition, tripKey = null, portalDriver = null }) {
  return {
    fleet_id: c.fleet, order_reference: f.ref, created_at: f.requestedAt, status: f.status,
    driver_uuid: f.driverUuid, partner_uuid: f.partnerUuid, plate: f.plate,
    ride_price: f.money.ride_price, commission: f.money.commission, net_earnings: f.money.net_earnings,
    disposition, trip_external_id: tripKey, portal_driver_id: portalDriver,
    raw: JSON.stringify(keptOrder(o)),
  };
}

/* ── the portal's side: what it may not undo ─────────────────────────────── */
/* A portal row about to be written, minus the columns where this feed's
   stored value must stand: the portal sends NULL for a column this feed
   filled (it never had one), or the portal's digits-only plate where this
   feed filled the same plate with its letter code. Everything the portal
   DOES know still wins — this only stops a NULL erasing a measured value
   every half hour. `stored` is {plate, filled} for the existing row. */
export function keepFiFills(row, stored) {
  const filled = Array.isArray(stored?.filled) ? stored.filled : [];
  if (!filled.length) return row;
  const out = { ...row };
  for (const c of filled) {
    if (!PORTAL_WRITES.includes(c) || !(c in out)) continue;
    if (out[c] == null) delete out[c];
  }
  if (filled.includes('plate') && 'plate' in out && out.plate != null && stored?.plate
      && /^\d+$/.test(String(out.plate)) && String(stored.plate).endsWith(String(out.plate))
      && String(stored.plate) !== String(out.plate)) {
    delete out.plate;
  }
  return out;
}

/* Applied to a batch the portal harvest is about to upsert. One read per
   window; if it fails the batch is written as it always was — this is a
   refinement and must never cost the portal its write. */
export async function protectFiFills(batch) {
  const keys = batch.map((r) => r.external_id).filter(Boolean);
  if (!keys.length) return batch;
  try {
    const { rows } = await pool.query(
      `SELECT external_id, plate, raw->'fleet_integration'->'filled' AS filled
         FROM trip
        WHERE platform = 'bolt' AND external_id = ANY($1) AND raw ? 'fleet_integration'`, [keys]);
    const by = new Map((rows || []).filter((r) => r?.external_id).map((r) => [r.external_id, r]));
    if (!by.size) return batch;
    return batch.map((r) => (by.has(r.external_id) ? keepFiFills(r, by.get(r.external_id)) : r));
  } catch (e) {
    log.warn(SRC, 'could not read fleet-integration fills; the portal batch is written as it came',
      { err: String(e?.message || e).slice(0, 160) });
    return batch;
  }
}

/* ── what the portal has answered for ────────────────────────────────────── */
/* The instant up to which the portal has answered for this fleet. Kept by the
   portal harvest (supersedeFiRows); before its first pass under this code,
   the newest row the portal ever wrote stands in — a floor, because the
   portal answered at least that far. NULL when the portal never has. */
export async function portalAnsweredThrough(fleet) {
  const { rows } = await pool.query(
    'SELECT value FROM source_state WHERE source = $1 AND fleet_id = $2 AND key = $3',
    [SRC, fleet, ANSWERED_KEY]);
  const t = Date.parse(rows?.[0]?.value ?? '');
  if (Number.isFinite(t)) return t;
  const r = await pool.query(
    `SELECT max(requested_at) AS h FROM trip
      WHERE platform = 'bolt' AND fleet_id = $1 AND raw ? 'created'`, [fleet]);
  const h = r.rows?.[0]?.h;
  const ms = h == null ? NaN : new Date(h).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/* Only forward. An old backfill window answering must not pull the mark back. */
async function advanceAnswered(fleet, ms) {
  await pool.query(
    `INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE source_state.value IS NULL OR source_state.value::timestamptz < EXCLUDED.value::timestamptz`,
    [SRC, fleet, ANSWERED_KEY, new Date(ms).toISOString()]);
}

/* The instants a portal window covered: its Dubai days, and no later than the
   moment it was asked — an order created after the first page was fetched
   cannot be in the answer.

   DUBAI DAYS IS AN ASSUMPTION, AND IT IS CHECKED ON EVERY WINDOW. The portal
   is asked for start_date/end_date as dates and nothing documents their
   clock. This product reads every day on Dubai's, and the harvest clamps its
   end to Dubai's today. Measured on production /api/status (2026-11-12) the
   question cannot be settled from outside: between 20:00Z and 24:00Z the
   harvest asks for the UTC date, which is Dubai's yesterday, so the portal is
   never handed a date that is in the future on one clock and not the other.
   So the portal's own rows are the evidence: a window that returns an order
   created after its last Dubai day ended is counting UTC days, and that is
   reported (portalDayEvidence) rather than silently believed either way. */
export function portalCoverage(win, askedAt) {
  const a = iso(new Date(win.start));
  const b = iso(new Date(win.end));
  const lo = dubaiMidnight(a);
  const dayEnd = dubaiMidnight(plusDays(b, 1));
  return { lo, hi: Math.min(dayEnd, askedAt), dayEnd };
}
export function portalDayEvidence(win, first, last) {
  const a = iso(new Date(win.start));
  const b = iso(new Date(win.end));
  const f = first == null ? NaN : new Date(first).getTime();
  const l = last == null ? NaN : new Date(last).getTime();
  if (Number.isFinite(l) && l >= dubaiMidnight(plusDays(b, 1))) {
    return { basis: 'utc', at: new Date(l).toISOString(),
      says: `the portal answered ${a}..${b} with an order created at ${new Date(l).toISOString()}, after Dubai's ${b} ended`
        + ' — its dates are UTC days, and src/sources/bolt_orders.js portalCoverage assumes Dubai days' };
  }
  if (Number.isFinite(f) && f < Date.parse(`${a}T00:00:00Z`)) {
    return { basis: 'dubai', at: new Date(f).toISOString() };
  }
  return null;
}

/* Called by the portal harvest for every window it answered — a short one too
   (harvestPortal's `answered` note says why withholding that one would leave
   two rows for one ride): remove this feed's stand-in rows for the instants
   the portal has now answered for, and move the "answered through" mark.
   A stand-in row is one
   this feed wrote and the portal never has: `raw ? 'fleet_integration'` and
   NOT `raw ? 'created'` — every portal row carries `created`, the column its
   key is built from. Returns what was removed, by RETURNING (not rowCount —
   node-postgres and PGlite disagree on its name; COVERAGE trap). */
export async function supersedeFiRows(c, win, { askedAt, first = null, last = null } = {}) {
  const { lo, hi } = portalCoverage(win, askedAt ?? Date.now());
  const evidence = portalDayEvidence(win, first, last);
  if (!(hi > lo)) return { removed: 0, evidence };
  const { rows } = await pool.query(
    `DELETE FROM trip
      WHERE platform = 'bolt' AND fleet_id = $1 AND requested_at >= $2 AND requested_at < $3
        AND raw ? 'fleet_integration' AND NOT (raw ? 'created')
     RETURNING external_id`, [c.fleet, new Date(lo), new Date(hi)]);
  const gone = (rows || []).map((r) => r?.external_id).filter(Boolean);
  if (gone.length) {
    await pool.query(
      `UPDATE bolt_fi_order SET disposition = 'superseded', trip_external_id = NULL
        WHERE fleet_id = $1 AND trip_external_id = ANY($2)`, [c.fleet, gone]);
  }
  await advanceAnswered(c.fleet, hi);
  return { removed: gone.length, evidence };
}

/* ── this feed's pass ────────────────────────────────────────────────────── */
/* A driver's portal id, learned from orders that matched a portal row — only
   where every match agrees. */
async function loadXref(fleet) {
  const { rows } = await pool.query(
    `SELECT driver_uuid, min(portal_driver_id) AS pid, count(DISTINCT portal_driver_id)::int AS n
       FROM bolt_fi_order
      WHERE fleet_id = $1 AND driver_uuid IS NOT NULL AND portal_driver_id IS NOT NULL
      GROUP BY driver_uuid`, [fleet]);
  return new Map((rows || []).filter((r) => r?.driver_uuid && r.pid && Number(r.n) === 1)
    .map((r) => [r.driver_uuid, String(r.pid)]));
}

const PORTAL_ROWS = `SELECT external_id, requested_at, plate, driver_ext_id, driver_name, ended_at,
       pickup_addr, dropoff_addr, distance_km, price, product, payment_type,
       pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, duration_s, is_scheduled,
       raw->>'partner_identifier' AS partner_identifier, raw->'fleet_integration' AS fi
  FROM trip
 WHERE platform = 'bolt' AND fleet_id = $1 AND requested_at BETWEEN $2 AND $3 AND raw ? 'created'`;
/* What each order already had: its last trip row, and whether that row is
   still this feed's own stand-in (it may have been removed, or adopted by the
   portal's own write under the same key). */
const KNOWN = `SELECT o.order_reference, o.trip_external_id, t.external_id AS live
  FROM bolt_fi_order o
  LEFT JOIN trip t ON t.platform = 'bolt' AND t.external_id = o.trip_external_id
                  AND t.raw ? 'fleet_integration' AND NOT (t.raw ? 'created')
 WHERE o.fleet_id = $1 AND o.order_reference = ANY($2)`;

/* The UPDATE for one portal row this feed fills. Column names come from
   FILLABLE only, never from a payload. */
async function enrich(key, set, prov) {
  const cols = Object.keys(set).filter((c) => FILLABLE.includes(c));
  const params = [key, JSON.stringify({ fleet_integration: prov })];
  const assigns = cols.map((c) => { params.push(set[c]); return `${c} = $${params.length}`; });
  await pool.query(
    `UPDATE trip SET ${[...assigns, `raw = coalesce(raw, '{}'::jsonb) || $2::jsonb`].join(', ')}
      WHERE platform = 'bolt' AND external_id = $1`, params);
}

const blank = (fleet) => ({ fleet, orders: 0, enriched: 0, changed: 0, inserted: 0, refreshed: 0,
  held: 0, ambiguous: 0, removed: 0, dropped: 0, comparable: 0, comparableMatched: 0,
  unit: null, price: null });

/* One window's orders, decided and written. */
export async function applyFiOrders(c, orders, { answeredThrough = null, xref = new Map(), plates = null,
  st = blank(c.fleet) } = {}) {
  const facts = [];
  for (const o of orders || []) {
    const f = orderFacts(o, plates);
    if (f) facts.push({ f, o }); else st.dropped++;
  }
  if (!facts.length) return st;
  st.orders += facts.length;
  let loS = Infinity, hiS = -Infinity;
  for (const { f } of facts) { loS = Math.min(loS, f.createdS); hiS = Math.max(hiS, f.createdS); }
  const portal = (await pool.query(PORTAL_ROWS, [c.fleet, new Date(loS * 1000), new Date(hiS * 1000)])).rows || [];
  const known = (await pool.query(KNOWN, [c.fleet, facts.map(({ f }) => f.ref)])).rows || [];
  const knownBy = new Map(known.filter((k) => k?.order_reference).map((k) => [k.order_reference, k]));
  const matches = matchOrders(facts.map(({ f }) => f), portal, xref);
  const pairs = facts.filter(({ f }) => matches.get(f.ref)?.row).map(({ f }) => [f, matches.get(f.ref).row]);
  const unit = distanceUnit(facts.map(({ f }) => f), pairs);
  const price = priceAgreement(pairs);
  st.unit = unit; st.price = price;
  const H = answeredThrough == null ? -Infinity : Number(answeredThrough);
  const ledger = [], stand = [], removals = [];
  for (const { f, o } of facts) {
    const m = matches.get(f.ref);
    const live = knownBy.get(f.ref)?.live || null;
    const answered = f.createdS * 1000 <= H;
    if (answered) { st.comparable++; if (m?.row) st.comparableMatched++; }
    let disposition, tripKey = null, portalDriver = null;
    if (m?.row) {
      const p = m.row;
      const plan = fillPlan(p, f, { unit: unit.unit, priceOk: price.ok });
      const prov = provenance(f, PORTAL_KIND, plan.filled);
      const before = p.fi && typeof p.fi === 'object' ? p.fi : null;
      if (Object.keys(plan.set).length || canon(before) !== canon(prov)) {
        await enrich(p.external_id, plan.set, prov);
        st.changed++;
      }
      st.enriched++;
      disposition = 'enriched'; tripKey = p.external_id;
      portalDriver = p.driver_ext_id != null ? String(p.driver_ext_id) : null;
      /* The stand-in this order had, if the portal's row is a different one. */
      if (live && live !== p.external_id) removals.push(live);
    } else if (m?.ambiguous) {
      st.ambiguous++; disposition = 'ambiguous'; tripKey = live;
    } else if (live) {
      /* Still this feed's own row: refreshed under the key it already has —
         a key re-derived now could differ, and that is a second row. */
      const pid = f.driverUuid ? xref.get(f.driverUuid) : null;
      stand.push(orderTripRow(f, o, c, { key: live, driverExtId: pid || f.driverUuid,
        unit: unit.unit, priceOk: price.ok }));
      st.refreshed++; disposition = 'inserted'; tripKey = live;
    } else if (!answered) {
      const pid = f.driverUuid ? xref.get(f.driverUuid) : null;
      const key = pid ? `${pid}|${f.createdS}` : `fi:${f.ref}`;
      stand.push(orderTripRow(f, o, c, { key, driverExtId: pid || f.driverUuid,
        unit: unit.unit, priceOk: price.ok }));
      st.inserted++; disposition = 'inserted'; tripKey = key;
    } else {
      st.held++; disposition = 'held';
    }
    ledger.push(fiOrderRow(c, f, o, { disposition, tripKey, portalDriver }));
  }
  if (removals.length) {
    const { rows } = await pool.query(
      `DELETE FROM trip
        WHERE platform = 'bolt' AND fleet_id = $1 AND external_id = ANY($2)
          AND raw ? 'fleet_integration' AND NOT (raw ? 'created')
       RETURNING external_id`, [c.fleet, removals]);
    st.removed += (rows || []).filter((r) => r?.external_id).length;
  }
  if (stand.length) await upsertMany('trip', stand, ['platform', 'external_id']);
  await upsertMany('bolt_fi_order', ledger, ['fleet_id', 'order_reference']);
  return st;
}

/* Every entitled company, over the run's window. `mint` is fiToken() from
   src/sources/bolt.js, passed in so the two files do not import each other.
   Writes its failures to `fails` per fleet, its windows to `chunks` (kind
   'fleet-integration'), and what it wrote to `rowsByFleet` — the same three
   the rest of src/sources/bolt.js reports through. Returns per-fleet
   stats for the caller's run row. */
export async function pullFiOrders(from, to, { fails, chunks, rowsByFleet, mint, plates = null,
  sleep = realSleep, now = Date.now(), companies = config.bolt.companies } = {}) {
  const out = new Map();
  let token = null, mintedAt = 0;
  const fresh = async (force = false) => {
    if (!force && token && Date.now() - mintedAt < FI_TOKEN_MS - FI_TOKEN_MARGIN_MS) return token;
    token = await mint();
    mintedAt = Date.now();
    return token;
  };
  for (const c of companies) {
    const st = blank(c.fleet);
    out.set(c.fleet, st);
    try {
      const answeredThrough = await portalAnsweredThrough(c.fleet);
      const xref = await loadXref(c.fleet);
      const askOnce = async (win, offset, limit, t) => http(`${config.bolt.fiGateway}/getFleetOrders`, {
        method: 'POST', timeoutMs: 60000,
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        /* company_ids as an ARRAY is the field the gateway requires (it
           answered "Is not array" to the scalar for months); company_id is
           sent beside it exactly as the probe's working request does. */
        body: JSON.stringify({ company_id: c.companyId, company_ids: [c.companyId],
          offset, limit, start_ts: win.start_ts, end_ts: win.end_ts }),
      });
      const ask = async (win, offset, limit) => {
        const first = await askOnce(win, offset, limit, await fresh());
        if (first?.status !== 401 && first?.status !== 403) return first;
        return askOnce(win, offset, limit, await fresh(true));
      };
      const h = await harvestFiOrders({ from, to, ask, sleep, now,
        sink: (orders) => applyFiOrders(c, orders, { answeredThrough, xref, plates, st }),
        warn: (m, x) => log.warn(SRC, `${NAME} ${c.fleet}: ${m}`, x) });
      for (const ch of h.chunks) chunks.push({ ...ch, fleet: c.fleet, kind: FI_KIND });
      st.dropped += h.dropped;
      st.windows = h.chunks.length;
      st.stop = h.stop;
      if (h.stop?.kind === 'not-entitled') {
        /* NOT ENTITLED IS NOT ZERO TRIPS. The same refusal the roster gets
           for this company (fiRefusal in src/sources/bolt.js), on the surface
           that would have been this fleet's second trip source. */
        /* Short, because the run's error column is cut at 500 characters and
           the roster's refusal beside it already names the credential. */
        fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: not entitled to company_id ${c.companyId}`
          + ` (${h.stop.says}) — this fleet's Bolt trips have no second source` });
      } else if (h.stop) {
        fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: company_id ${c.companyId} refused — ${h.stop.says}` });
      }
      if (h.refusals.length) {
        fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: ${h.refusals[0].says}`
          + (h.refusals.length > 1 ? ` (and ${h.refusals.length - 1} more window${h.refusals.length > 2 ? 's' : ''})` : '') });
      }
      if (h.short) fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: ${h.short} orders short of the counts Bolt declared` });
      if (st.dropped) {
        fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: ${st.dropped} orders arrived without an`
          + ' order_reference or a creation time and could not be kept' });
      }
      /* THE MATCH RULE, CHECKED. Orders the portal had answered for should
         sit on a portal row. If most of them do not, the rule (same second,
         same car or driver) is not holding against this data and the portal
         rows are going unfilled — which nothing else would ever say. */
      if (st.comparable >= 10 && st.comparableMatched / st.comparable < 0.5) {
        fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: only ${st.comparableMatched} of ${st.comparable}`
          + ' orders the portal answered for matched a portal row (same second, same car or driver)'
          + ' — re-measure the rule in src/sources/bolt_orders.js' });
      }
      if (st.price && !st.price.ok) {
        fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: ride_price agreed with the portal's price on`
          + ` ${st.price.agree} of ${st.price.n} matched rides, so no price was taken from this feed` });
      }
      rowsByFleet.set(c.fleet, (rowsByFleet.get(c.fleet) || 0) + st.inserted + st.refreshed + st.changed);
      log[h.refusals.length || h.stop ? 'warn' : 'info'](SRC, `${NAME} ${c.fleet}`, {
        orders: st.orders, enriched: st.enriched, changed: st.changed, inserted: st.inserted,
        refreshed: st.refreshed, held: st.held, ambiguous: st.ambiguous, removed: st.removed,
        matched_of_answered: `${st.comparableMatched}/${st.comparable}`,
        distance_unit: st.unit?.unit ?? null, windows: h.chunks.length,
        failed_windows: h.chunks.filter((x) => x.error).length || undefined,
        limited: h.limited || undefined, too_old_from: h.tooOld?.from, stopped: h.stop?.says,
      });
    } catch (e) {
      const why = String(e?.message || e).slice(0, 200);
      log.error(SRC, `${NAME} ${c.fleet} failed`, { err: why });
      fails.push({ fleet: c.fleet, text: `${NAME} ${c.fleet}: ${why}` });
      st.failed = why;
    }
  }
  return out;
}
