// Bolt collector.
//  FI API (client_credentials)  : Egari roster only — getDrivers / getVehicles. No trips/earnings.
//                                 "Egari only" is not a design choice, it is a measured refusal:
//                                 this OAuth client is not entitled to Ecosine's company_id 142868.
//                                 See the fiRefusal comment below for the probe that shows it.
//  Fleet Owner Portal (refresh) : trips + earnings for BOTH fleets — GUARDED on BOLT_REFRESH_TOKEN.
//                                 Refresh tokens last ~7 days; when expired the portal path is skipped
//                                 and the supervisor must re-capture one.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { unixS, iso, jwtPayload, jwtExpiry } from '../util.js';
import { log } from '../log.js';
import { stateRow } from '../roster.js';
import { get, setSetting } from '../settings.js';
import { noteCredential } from '../auth_state.js';

const SRC = 'bolt';

// Exported so the provider probe can describe the FI gateway's shape without
// duplicating the OAuth dance.
export async function fiToken() {
  const body = new URLSearchParams({
    client_id: config.bolt.clientId, client_secret: config.bolt.clientSecret,
    grant_type: 'client_credentials', scope: 'fleet-integration:api',
  }).toString();
  const { data } = await http(config.bolt.oidc, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (!data.access_token) throw new Error('bolt fi token failed');
  return data.access_token;
}

// FI roster → driver_performance (roster snapshot) + vehicle dim. company_id is per-fleet.
/* The FI gateway refuses a range longer than 31 days — "code=498806
   INVALID_DATE_RANGE, maximum allowed date range is 31 days" — and a backfill
   asks for a year. So every backfill run has failed at this call since backfill
   existed, with the roster for one fleet never collected and the run recorded
   as an error whose message named a date range nobody read as a limit.

   Clamped to the last 31 days of whatever was asked for, which is the right
   window regardless: getDrivers returns the roster as it stands, and a roster
   is a snapshot. Asking about a year of it does not return a year of history,
   it returns the same list — when it returns anything at all. */
const FI_MAX_DAYS = 31;
export function rosterWindow(from, to) {
  const end = new Date(to);
  const start = new Date(from);
  const earliest = new Date(end);
  earliest.setUTCDate(earliest.getUTCDate() - (FI_MAX_DAYS - 1));
  return [start > earliest ? start : earliest, end];
}

/* ── the FI gateway refuses a COMPANY, not a credential ───────────────────
   `code: 503, message: NOT_AUTHORIZED, error_hint: COMPANIES_NOT_ALLOWED` is a
   strange-looking triple, and the strangeness is the answer. The 503 is not an
   HTTP status: the HTTP status is 200 and 503 is the number Bolt puts in its
   own JSON `code` field. So it is not an outage, and there is nothing to wait
   out or retry.

   Which credential and which company was measured rather than guessed.
   Production /api/probe/results, one pass at 2026-09-02T10:52:23Z, with ONE
   set of client credentials minted by one call to fiToken():

     egari:getDrivers    company_id 142897 → http 200, code 0, 50 driver rows
     ecosine:getDrivers  company_id 142868 → http 200, code 503,
                                             NOT_AUTHORIZED,
                                             COMPANIES_NOT_ALLOWED

   Two calls 200ms apart carrying the same bearer token. The token therefore
   authenticates, the gateway is up, and the only thing that differs between
   the answer and the refusal is the company id — so the client credentials are
   being asked for a company they are not entitled to. The id is not a typo
   either: the portal half of this same collector authenticates company_id
   142868 for user 173999 on every run, and "portal ecosine" is not among the
   failures /api/status lists.

   None of that reached the operator. The run said

     "FI roster ecosine: code=503 NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED"

   which names neither the credential that was refused nor the company it was
   refused for, so it reads like Bolt having a bad minute — and the obvious
   remedy it suggests, re-pasting BOLT_CLIENT_SECRET, cannot change the
   answer. */
const FI_CREDENTIAL = 'BOLT_CLIENT_ID';
const FI_SURFACE = 'fleet-integration getDrivers';
const NOT_ENTITLED = /COMPANIES?_NOT_ALLOWED/i;

/* One refusal, read. `allowed` is the companies that ANSWERED in the same
   pass on the same token — the evidence that separates "this credential is
   broken" from "this credential does not cover this company", which is the
   distinction the whole message turns on.

   Exported so the reading can be checked against Bolt's real payloads without
   standing up the gateway. */
export function fiRefusal(company, data, allowed = []) {
  const why = [data?.message, data?.error_hint && `hint=${data.error_hint}`]
    .filter(Boolean).join(' ') || 'no message';
  if (!NOT_ENTITLED.test(`${data?.error_hint ?? ''} ${data?.message ?? ''}`)) {
    /* Anything else — the 498806 INVALID_DATE_RANGE this file already carries a
       fix for, a validation error, a genuine outage — is not an authorization
       verdict, so it names no credential and writes no credential row. A panel
       that goes red for a bad date range is a panel nobody believes. The
       company id is still named, because a refusal that does not say what was
       asked for cannot be reproduced. */
    return { fail: `FI roster ${company.fleet} (company_id ${company.companyId}): code=${data?.code} ${why}`,
      credential: null };
  }
  const others = allowed.filter((c) => c.companyId !== company.companyId);
  // Kept short on purpose: credential_state.detail is truncated at 240 chars by
  // noteCredential, and a remedy past the cut is a remedy nobody reads.
  const proof = others.length
    ? ` The same token read ${others.map((c) => `${c.companyId} (${c.fleet})`).join(', ')}, so the secret is fine.`
    : '';
  return {
    credential: FI_CREDENTIAL,
    state: 'invalid',
    fail: `FI roster ${company.fleet}: ${FI_CREDENTIAL} is not entitled to company_id ${company.companyId}`
      + ` — code=${data?.code} ${why}`,
    detail: `${FI_CREDENTIAL} is not entitled to company_id ${company.companyId} (${company.fleet}): ${why}.`
      + `${proof} Add ${company.companyId} to this fleet-integration app in the Bolt portal.`,
  };
}

async function pullFiRoster(from, to, fails) {
  const token = await fiToken();
  let total = 0;
  const [rFrom, rTo] = rosterWindow(from, to);
  /* Gathered, then reported — so a refusal can be described using what the
     OTHER company did in the same pass. Reporting inside the loop could only
     ever say that about companies earlier in config order, and the config
     order is not something a message should depend on. */
  const allowed = [];
  const refused = [];
  for (const c of config.bolt.companies) {
    const body = JSON.stringify({ company_id: c.companyId, offset: 0, limit: 200, start_ts: Number(unixS(rFrom)), end_ts: Number(unixS(rTo)) });
    const { data } = await http(`${config.bolt.fiGateway}/getDrivers`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    /* This logged a bare code — 498806 for one fleet, 503 for the other — and
       called both "not authorized", which is our guess rather than the
       gateway's. Two different codes are two different problems, and the
       message beside them is what says which. */
    if (data?.code !== 0) {
      refused.push({ c, data });
      continue;
    }
    allowed.push(c);
    const rows = (data.data?.drivers || []).map((d) => ({
      platform: SRC, fleet_id: c.fleet, driver_ext_id: d.driver_uuid,
      driver_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
      /* The window actually asked for, not the run's. Stamping a backfill's
         whole year on a roster snapshot made one row per driver spanning 365
         days, which sql/schema_v23.sql then expands to a row per day. */
      plate: normPlate(d.active_vehicle?.reg_number), period_start: iso(rFrom), period_end: iso(rTo),
      rating: d.driver_rating, raw: d,
    })).filter((r) => r.driver_ext_id);
    if (rows.length) total += await upsertMany('driver_performance', rows, ['platform', 'driver_ext_id', 'period_start', 'period_end']);

    /* Bolt is the only channel that reports WHY a driver is stopped, and it
       reports the vehicle they still hold while stopped. A suspended driver
       with a car attached is an asset earning nothing, which no page could see
       while this sat inside a raw payload. */
    const roster = (data.data?.drivers || []).map((d) => stateRow({
      platform: SRC, driverExtId: d.driver_uuid, fleetId: c.fleet,
      name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
      rawState: d.state, reason: d.suspension_reason,
      plate: d.active_vehicle?.reg_number ? normPlate(d.active_vehicle.reg_number) : null,
      vehicleExtId: d.active_vehicle?.uuid || (d.active_vehicle?.id != null ? String(d.active_vehicle.id) : null),
      score: d.driver_score,
      raw: { state: d.state, categories: d.active_categories, inactive: d.inactive_categories,
        has_cash_payment: d.has_cash_payment, eligible_for_scheduled_ride: d.eligible_for_scheduled_ride },
    })).filter((r) => r.driver_ext_id && r.driver_ext_id !== 'undefined');
    if (roster.length) await upsertMany('driver_platform_state', roster, ['platform', 'driver_ext_id']);
  }

  for (const { c, data } of refused) {
    const r = fiRefusal(c, data, allowed);
    log.warn(SRC, `FI getDrivers rejected for ${c.fleet} — ${data?.message || 'no message'}`
      + `${data?.error_hint ? ` hint=${data.error_hint}` : ''}`,
      { code: data?.code, company_id: c.companyId,
        credential: r.credential || 'none — this is not an authorization verdict',
        // The comparison that makes the refusal readable: the companies this
        // same bearer token DID read, in this same pass.
        companies_this_credential_did_read: allowed.map((a) => a.companyId) });
    fails.push(r.fail);
    if (r.credential) {
      await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: r.credential,
        state: r.state, surface: FI_SURFACE, detail: r.detail });
    }
  }
  /* And the fleets that DID answer, recorded green. auth_state.js's own note:
     "a banner that can only ever go red never goes green again" — and without
     this the panel could never say that the FI client works for Egari, which
     is half of what makes the Ecosine refusal legible. */
  for (const c of allowed) {
    await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: FI_CREDENTIAL,
      state: 'ok', surface: FI_SURFACE, detail: null });
  }
  return total;
}

/* ── the refresh token is single-use, and we were throwing away its successor ──
   The portal's getAccessToken does not merely mint an access token: it rotates
   the refresh token and invalidates the one presented. We read
   `data.data.access_token` and discarded the rest, so a freshly captured token
   worked for the first company in the loop, was spent, and every later call —
   the second fleet in the same run, and every run after it — got
   REFRESH_TOKEN_INVALID. The dashboard read that as "the supervisor pasted a
   stale token" and asked for another, which was then spent the same way.

   Two responses tell the two failures apart, and only a side-by-side probe
   makes it visible:

     signature broken  → error_hint "Invalid refresh token"
     already rotated   → error_hint "<a uuid that is not this token's jti>"

   The second is the portal naming the token that superseded ours. That is why
   the hint is logged verbatim now rather than being flattened to "invalid". */

// A portal refresh token is issued to one fleet owner, and the two fleets have
// different owners (userId 174036 / 173999), so each fleet gets its own key and
// falls back to the shared one for a single-fleet setup.
const RT_KEY = (fleet) => `BOLT_REFRESH_TOKEN_${String(fleet).toUpperCase()}`;
const refreshTokenFor = (fleet) => get(RT_KEY(fleet)) || config.bolt.refreshToken || null;

// Payload of a portal refresh token, or null if it is not a JWT we can read.
// Never throws: an unreadable token still gets attempted, it just cannot be
// pre-screened for expiry.
export function readRefreshToken(tok) {
  const p = jwtPayload(tok);
  if (!p) return null;
  return {
    ...(jwtExpiry(tok) || { expires_at: null, days_left: null, expired: false }),
    fleet_owner_id: p.data?.fleet_owner_id ?? null,
    jti: p.data?.jti ?? null,
  };
}

// Which fleet a portal owner id belongs to, by the same table the collector
// collects against — so a message cannot name a fleet the config does not have.
const fleetOfOwner = (id) =>
  (config.bolt.companies || []).find((c) => String(c.userId) === String(id))?.fleet || null;

/* ── a refresh token belongs to ONE owner, and cannot be lent to the other ──
   Measured, not inferred. The token the Egari path has been presenting is the
   one test/credentials.test.mjs keeps as its REAL fixture, and its payload
   reads `data.fleet_owner_id: 173999`, `exp: 1787834531`. 1787834531 is
   2026-08-27T12:42:11Z — the exact instant /api/status has been printing in
   "portal egari: refresh token expired 2026-08-27T12:42:11.000Z". 173999 is
   ECOSINE's owner in config.bolt.companies; Egari's is 174036. So Egari has
   been handed Ecosine's token, by the `|| config.bolt.refreshToken` fallback
   above, because BOLT_REFRESH_TOKEN_EGARI has never been set.

   The owner is checked BEFORE the expiry, and the order is the fix rather than
   a detail of it. Both facts are true of this token, only one of them is
   actionable, and the run has been printing the wrong one: "re-capture from
   the portal" sends an operator to a portal session signed in as 173999, which
   produces another Ecosine token that Egari refuses identically. An operator
   acts on the first sentence they are given, so it has to be the sentence that
   can work.

   And a token this function can already read as the wrong fleet's is not sent
   anywhere. Today's is also expired, so the expiry guard happens to spare the
   request — but for the whole week before 2026-08-27 it did not, and every
   cycle spent one getAccessToken call on company_id 142897 to be told no. That
   is measured: with the same token given a live `exp`, test/bolt_refusals
   recorded getAccessToken sent for 142897 before this guard existed. Nothing
   about an owner claim needs the network to read.

   (Whether the portal ROTATES a refresh token it then refuses is not something
   this deployment can observe from outside, so it is not claimed here — but if
   it does, the successor would have been written to BOLT_REFRESH_TOKEN_EGARI
   and Ecosine's live credential spent to fill the wrong slot. Not making the
   call removes the question.) */

/* Exchange, and keep the successor. Returns { at, err } — never throws, because
   one fleet's dead token must not cost us the other fleet's trips. */
async function portalToken(company) {
  const { fleet, companyId, userId } = company;
  const rt = refreshTokenFor(fleet);
  if (!rt) return { at: null, err: 'no refresh token configured' };

  const meta = readRefreshToken(rt);
  /* String-compared: a settings value that arrives as "174036" and a JWT claim
     that arrives as 174036 are the same owner, and a strict !== here would
     switch off a fleet that is working. */
  if (meta && meta.fleet_owner_id != null && userId != null
      && String(meta.fleet_owner_id) !== String(userId)) {
    const theirs = fleetOfOwner(meta.fleet_owner_id);
    return { at: null, meta, wrongOwner: true,
      err: `refresh token is owner ${meta.fleet_owner_id}'s${theirs ? ` (${theirs})` : ''},`
        + ` not owner ${userId}'s — not asked, it cannot work;`
        + ` set ${RT_KEY(fleet)} from a portal session signed in as ${userId}` };
  }
  if (meta?.expired) {
    return { at: null, meta, err: `refresh token expired ${meta.expires_at} — re-capture from the portal` };
  }

  const { data } = await http(`${config.bolt.portalBase}/getAccessToken?language=en-us&version=FO.3.856&brand=bolt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt, company: { company_id: companyId, company_type: 'fleet_company' } }),
  });

  const at = data?.data?.access_token || data?.access_token || null;

  /* Persist the successor before returning the access token. Written even when
     the exchange failed, in case the portal hands back a usable token alongside
     an error — and written per fleet, so one fleet's rotation cannot overwrite
     the other's credential. */
  const next = data?.data?.refresh_token || data?.refresh_token || null;
  if (next && next !== rt) {
    try {
      await setSetting(RT_KEY(fleet), next);
      const m = readRefreshToken(next);
      log.info(SRC, `portal refresh token rotated for ${fleet}`,
        { expires_at: m?.expires_at || 'unknown', days_left: m?.days_left ?? null });
    } catch (e) {
      // Losing the successor means the next run fails, so say so loudly rather
      // than letting it surface a week later as "the supervisor pasted a stale token".
      log.error(SRC, `could not store rotated refresh token for ${fleet} — next run will fail`,
        { err: String(e).slice(0, 200) });
    }
  }

  if (at) return { at, err: null };
  return {
    at: null,
    err: [data?.message, data?.error_hint && `hint=${data.error_hint}`, data?.code != null && `code=${data.code}`]
      .filter(Boolean).join(' ') || 'no access_token in response',
    meta,
  };
}

// Portal trips (orderHistory) — the only Bolt surface carrying trips and fares;
// the FI gateway is roster-only.
/* ── the order table, as the portal actually serves it ────────────────────
   Measured against the live endpoint on 2026-09-03 with verified tokens for
   both fleets. Every constant here is a refusal boundary found by asking. */
const PORTAL_PAGE = 100;      // 200 answers "limit: Integer is not in range"
const PORTAL_MAX_DAYS = 30;   // 31 answers DATE_RANGE_TOO_BIG
/* EVERY state, which is what an empty list means here — measured, not assumed.
   Over 2026-08-06..2026-09-03 the six-state list returned 401 orders and [] 
   returned 402; the extra was a `driving_with_client`, a ride still in
   progress. The list also silently omitted `offer_rejected` and all three
   `optional_ride_*` variants, which the portal serves and which are real
   orders with a driver, a plate and a route. A state list is a filter nobody
   revisits, and the portal's vocabulary is the portal's to change. */
const PORTAL_STATES = [];
/* "You asked for a day older than we keep." A fact about the provider's
   retention, not about this fleet, this token or this run. */
const RETENTION_CODE = 25809;
/* "Slow down." Found by doing exactly that: a two-year harvest is 25 windows
   but ~210 requests once paging is counted — January 2026 alone is 3,932
   orders, forty pages — and the portal answered code 1005 partway through.
   A rate limit is the one refusal that is not an answer about the data: the
   same request will succeed later, so skipping the window loses a month of
   trips for no reason. It is waited out, not recorded. */
const RATE_LIMIT_CODE = 1005;
const RATE_LIMIT_TRIES = 5;
const backoffMs = (n) => 2000 * (2 ** n);   // 2s, 4s, 8s, 16s, 32s
/* Injectable, so the tests can drive five retries without waiting a minute. */
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/* The only codes that are about the CREDENTIAL. Everything else is about the
   request, and filing it against the token sends somebody to re-paste a
   credential that was never the problem. */
const AUTH_CODES = new Set([700, 701, 703, 50003]);

const url = (c) => `${config.bolt.portalBase}/orderHistory/getTable`
  + `?language=en-us&version=FO.3.856&company_id=${c.companyId}&user_id=${c.userId}&brand=bolt`;

/* Half-open windows of at most n days, so a backfill of any length is asked
   for in pieces the endpoint will accept. */
/* A Date or a 'YYYY-MM-DD' string, both to the same UTC midnight. The
   collector hands these a Date and a queued job row hands them a string, and a
   window boundary is not the place to find out which. */
const midnight = (v) => new Date(`${typeof v === 'string' ? v.slice(0, 10) : iso(v)}T00:00:00Z`).getTime();

function* dayChunks(from, to, n) {
  const DAY = 864e5;
  let s = midnight(from);
  const end = midnight(to);
  while (s <= end) {
    const e = Math.min(s + (n - 1) * DAY, end);
    yield { start: new Date(s), end: new Date(e) };
    s = e + DAY;
  }
}

/* COLUMN-oriented to row-oriented. The portal returns one object per column
   carrying every value for it — data.columns[i].cells[n] is field i of row n —
   which is why a reader looking for data.orders found nothing and reported an
   empty window. Keyed on the column's own `key`, so a column added or moved
   changes nothing here. */
export function pivot(data) {
  const cols = data?.columns;
  if (!Array.isArray(cols) || !cols.length) return [];
  const n = cols.reduce((m, c) => Math.max(m, c.cells?.length || 0), 0);
  return Array.from({ length: n }, (_, i) =>
    Object.fromEntries(cols.map((c) => [c.key || c.id || c.title, c.cells?.[i]])));
}

/* One order, in this product's words.
   `created` and the other timestamps are unix SECONDS, and 0 is the portal's
   way of writing "did not happen" — a cancelled ride has fare_finalised 0 —
   so 0 becomes null rather than 1970. */
const at = (v) => (Number(v) > 0 ? new Date(Number(v) * 1000).toISOString() : null);
/* ZERO IS ABSENCE ON THIS FEED, NOT A MEASUREMENT.
   ─────────────────────────────────────────────────────────────────────────
   The portal writes 0 for a fare that was never charged and a distance never
   driven, and 0 is not NULL: has_fare in sql/schema_v18.sql is `price IS NOT
   NULL`, so every cancelled ride counted as a priced one. Measured on
   production over 365 days: Bolt's average fare read AED 23.60 where its
   completed rides average AED 60.67 — 61% low — because 16,846 of 27,440 rows
   were cancellations at price 0 sitting in the denominator.

   Safe because the feed is consistent about it, which I checked rather than
   assumed: of 51 `finished` rows in a live window, none carries price 0 and
   none carries distance 0, while every one of the 48 non-completions carries
   both. A no-show is the interesting case and it works — client_did_not_show
   comes back with a real price and a cancellation fee, so nulling only the
   zeros keeps the money the rider was actually charged. */
const money = (v) => (Number(v) > 0 ? Number(v) : null);

export function portalRow(o, c) {
  const route = Array.isArray(o.route) ? o.route : [];
  const arrived = Array.isArray(o.arrived_to_destinations) ? o.arrived_to_destinations : [];
  return {
    platform: SRC,
    /* THERE IS NO ORDER ID IN THIS RESPONSE. partner_identifier looks like one
       — it is a uuid, one per row — and it is the DRIVER's: 50 rows carried 18
       of them, 18 drivers, one uuid each, ten rides sharing the busiest. Using
       it as the key would have collapsed 547 trips into 71 and called the rest
       duplicates.

       So the key is synthesised, the way the alert table already synthesises
       one (sql/schema.sql: "alertId or synthetic"). A driver cannot begin two
       rides in the same second, and `created` is second-granular: verified
       unique over all 547 orders on both fleets, 2026-08-06..2026-09-03.
       The plate is deliberately NOT in it — it adds no uniqueness there, and a
       key holding a correctable field duplicates the row when it is
       corrected. */
    external_id: o.driver?.id != null && Number(o.created) > 0
      ? `${o.driver.id}|${o.created}` : null,
    fleet_id: c.fleet,
    plate: normPlate(o.car_reg_number),
    driver_ext_id: o.driver?.id != null ? String(o.driver.id) : null,
    driver_name: o.driver?.name || null,
    requested_at: at(o.created),
    ended_at: at(arrived[arrived.length - 1]) || at(o.fare_finalised),
    /* route is the full stop list, so the last entry is where the ride ended
       however many stops it had. A cancelled ride can carry a route and no
       arrival, which is why the two are read separately. */
    pickup_addr: route[0] || null,
    dropoff_addr: route.length > 1 ? route[route.length - 1] : null,
    distance_km: money(o.distance),
    status: o.status || null,
    product: o.category || null,
    payment_type: o.payment_method || null,
    /* What the rider paid for the ride. The fees Bolt itemises beside it are
       kept in raw rather than folded in: a booking fee added to the fare would
       silently change what every per-trip figure in this product means. */
    price: money(o.price),
    currency: 'AED',
    raw: o,
  };
}

/* ── the window-and-page walk, extracted so it can be tested ──────────────
   NEWEST WINDOW FIRST, and a refusal on one window is not a refusal of the run.

   The first shape of this loop lived inline, kept a single error variable, and
   discarded EVERY row it had collected the moment any window refused. That is
   not hypothetical. The two-year backfill queued on 2026-09-03 began at
   2024-09-03, the portal answered

     {"code":25809,"message":"START_DATE_TOO_FAR_IN_THE_PAST"}

   on the very first chunk, and the whole fleet's harvest went in the bin — 70
   rows written over two years while a three-day incremental beside it wrote
   182. It then filed that against BOLT_REFRESH_TOKEN as `invalid`, which is
   the mistake this codebase has already made twice and written essays about:
   blaming a credential for a refusal that has nothing to do with it. The token
   was fine. The DATE was too old.

   It is a function now, taking its request as an argument, because the defect
   survived a green test suite for exactly one reason — nothing could reach the
   loop to drive a refusal through it.

   The portal keeps a ROLLING window: binary-searched against the live endpoint
   on 2026-09-03, 2024-11-26 answers and 2024-11-25 does not, so about 645 days.
   That boundary MOVES, which is why it is not a constant here — it is found by
   asking, and asking newest-first means the first refusal IS the boundary and
   every older window would be refused too, so we stop rather than spend twenty
   more requests being told the same thing. */
export async function harvestPortal({ from, to, ask, row, warn = () => {},
  page = PORTAL_PAGE, maxDays = PORTAL_MAX_DAYS, sleep = realSleep }) {
  const rows = [];
  /* Every refusal, not the first one. A single `refused` reported one window
     and hid the rest, which on a long backfill is the difference between "one
     window failed" and "a third of the history is missing". */
  const refusals = [];
  let tooOld = null, asked = 0, limited = 0;
  const chunks = [...dayChunks(from, to, maxDays)].reverse();
  for (const win of chunks) {
    let offset = 0, guard = 0, stop = false;
    for (;;) {
      /* Ask, and wait out a rate limit rather than treating it as an answer.
         The same request succeeds later; abandoning the window because the
         provider asked us to slow down loses a month of trips to a delay. */
      let data = null;
      for (let tryN = 0; ; tryN++) {
        data = await ask(win, offset);
        asked++;
        if (Number(data?.code) !== RATE_LIMIT_CODE) break;
        if (tryN >= RATE_LIMIT_TRIES - 1) break;
        limited++;
        warn('rate limited, waiting', { win: iso(win.start), offset, wait_ms: backoffMs(tryN) });
        await sleep(backoffMs(tryN));
      }
      /* code 0 IS success — the portal says {"code":0,"message":"OK"} — so this
         tests for a code that is PRESENT AND NON-ZERO, never for truthiness of
         the field. `if (data.code)` on a falsy success code is how a working
         response gets read as an error. */
      if (data?.code != null && data.code !== 0) {
        if (data.code === RETENTION_CODE) { tooOld = win; stop = true; break; }
        refusals.push({ code: Number(data.code), window: iso(win.start),
          says: `${data.message || 'refused'} (code ${data.code}) on ${iso(win.start)}..${iso(win.end)}` });
        break;
      }
      const got = pivot(data?.data);
      rows.push(...got.map(row).filter((r) => r && r.external_id));
      offset += page;
      /* total_rows is the count for the WHOLE window, not the page, so the loop
         stops on it as well as on a short page — a short page is also what the
         last page looks like, and the two only coincide when the total does not
         divide exactly. */
      if (got.length < page || offset >= (data?.data?.total_rows || 0)) break;
      if (++guard > 200) { warn('page guard hit', { win: iso(win.start) }); break; }
    }
    if (stop) break;
  }
  /* The first refusal is what the operator is shown, with a count beside it so
     a single bad window and fifteen bad windows do not read identically. */
  const refused = refusals.length
    ? { ...refusals[0], count: refusals.length,
        says: refusals[0].says + (refusals.length > 1 ? ` (and ${refusals.length - 1} more window${refusals.length > 2 ? 's' : ''})` : '') }
    : null;
  return { rows, refused, refusals, tooOld, asked, limited, windows: chunks.length };
}

async function pullPortalTrips(from, to, fails) {
  let total = 0;
  for (const c of config.bolt.companies) {
    const rt = refreshTokenFor(c.fleet);
    if (!rt) {
      log.warn(SRC, `portal skipped for ${c.fleet} — no refresh token (trips/earnings unavailable)`);
      fails.push(`portal ${c.fleet}: no refresh token configured`);
      /* A credential that was never supplied is a different problem from one
         that stopped working, and the panel an operator opens to find out what
         to re-paste has to be able to say which. Both were silence before. */
      await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: 'BOLT_REFRESH_TOKEN',
        state: 'missing', surface: 'orderHistory',
        detail: 'no refresh token configured, so trips and earnings are not collected for this fleet' });
      continue;
    }

    const { at, err, meta, wrongOwner } = await portalToken(c);
    if (!at) {
      const m = meta || readRefreshToken(rt);
      /* The owner the token was issued to, next to the fleet it is being used
         for: a token minted for one owner cannot read the other's company, and
         that mismatch is otherwise indistinguishable from an expired one. */
      log.warn(SRC, `portal token rejected for ${c.fleet} — ${err}`, {
        company_id: c.companyId,
        token_owner: m?.fleet_owner_id ?? 'unreadable',
        expected_owner: c.userId,
        // String-compared, like the guard in portalToken: a strict === between
        // a settings string and a JWT number would report a working token as
        // the wrong fleet's.
        owner_matches: m?.fleet_owner_id == null ? null : String(m.fleet_owner_id) === String(c.userId),
        expires_at: m?.expires_at || 'unknown',
        // So the log says outright that no request was spent, rather than
        // leaving a reader to infer it from the absence of a response line.
        asked: !wrongOwner,
      });
      fails.push(`portal ${c.fleet}: ${err}`);
      /* Bolt refresh tokens last about seven days, so this is the routine
         end of one rather than a fault — but it is only routine to somebody
         who is told. It reached the operator as a source that had quietly
         stopped carrying trips. The owner mismatch is recorded separately
         because re-pasting cannot fix a token minted for the other fleet. */
      await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: 'BOLT_REFRESH_TOKEN',
        state: 'invalid', surface: 'orderHistory',
        /* The remedy is part of the sentence now. "It is the wrong fleet's
           token" told an operator what NOT to do and left them without
           anything to do instead — and the thing to do is not guessable: it is
           a different portal login, and a differently-named setting. */
        detail: m?.fleet_owner_id != null && String(m.fleet_owner_id) !== String(c.userId)
          ? `the token belongs to owner ${m.fleet_owner_id}${fleetOfOwner(m.fleet_owner_id) ? ` (${fleetOfOwner(m.fleet_owner_id)})` : ''},`
            + ` not ${c.userId} — it is the wrong fleet's token, not an expired one.`
            + ` Capture ${RT_KEY(c.fleet)} from a Bolt portal session signed in as owner ${c.userId}.`
          : `${String(err).slice(0, 150)}${m?.expires_at ? ` (expired ${m.expires_at})` : ''}` });
      continue;
    }
    /* The token was good; the request never was.
       ─────────────────────────────────────────────────────────────────────
       This call has been made since the portal path was written and has never
       once returned a row, and the reason was not the credential. Asked on
       2026-09-03 with two freshly-minted, verified access tokens, the endpoint
       answers, verbatim:

         {"code":702,"message":"INVALID_REQUEST","validation_errors":[
            {"error":"Is required","property":"limit"},
            {"error":"Is required","property":"offset"}]}

       It was telling us exactly what was missing, in a body nothing read. Fix
       that and the next refusal is DATE_RANGE_TOO_BIG, and the one after that
       is the real one: the response has no `orders` array at all. It is
       COLUMN-oriented — data.columns[i].cells[n] is field i of row n, with
       data.total_rows for the count — so `data?.data?.orders || []` could only
       ever be empty, and the "authenticated, no orders in window" line below
       reported a healthy empty window over 547 real trips.

       Measured bounds, each by asking until it refused: limit max 100
       (200 gives "Integer is not in range"), window max 30 days (31 gives
       DATE_RANGE_TOO_BIG). Both are encoded as constants rather than as a
       comment, because a limit nobody can see is a limit somebody raises. */
    const { rows, refused, tooOld } = await harvestPortal({
      from,
      to,
      row: (o) => portalRow(o, c),
      ask: (win, offset) => http(url(c), {
        method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({ start_date: iso(win.start), end_date: iso(win.end),
          order_states: PORTAL_STATES, limit: PORTAL_PAGE, offset }),
      }).then((r) => r.data),
      warn: (m, x) => log.warn(SRC, `portal ${c.fleet}: ${m}`, x),
    });
    /* Reaching the end of what the portal keeps is not a fault, and must not be
       reported as one — a backfill that asks for more history than exists will
       hit this every single time it runs. Said once, as a fact about the
       provider's retention, and the rows collected before it are kept. */
    if (tooOld) {
      log.info(SRC, `portal ${c.fleet}: reached the end of the portal's history`,
        { refused_from: iso(tooOld.start), collected: rows.length });
    }
    /* A refusal that is NOT the retention boundary is worth reporting — but it
       still does not throw away the windows that answered, and it only touches
       the credential when it is the credential being refused. A malformed
       request and a rejected token are different problems with different
       remedies, and reading the first as the second is what cost this source a
       year of empty tables. */
    if (refused) {
      fails.push(`portal ${c.fleet}: ${refused.says}`);
      if (AUTH_CODES.has(refused.code)) {
        await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: 'BOLT_REFRESH_TOKEN',
          state: 'invalid', surface: 'orderHistory', detail: refused.says });
        if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
        continue;
      }
    }
    /* The token demonstrably worked, so say so. A credential that can only
       ever be written 'invalid' or 'missing' keeps the last red row it was
       given for ever — the same defect this codebase has already fixed twice,
       in src/sources/fms.js and src/sources/yango.js. Production carried
       "BOLT_REFRESH_TOKEN invalid — the token belongs to owner 173999" for
       hours after a valid Egari token was in place, because nothing in this
       function could clear it. */
    await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: 'BOLT_REFRESH_TOKEN',
      state: 'ok', surface: 'orderHistory', detail: null });
    // An authenticated call that comes back with nothing is worth a line: it
    // separates "the token works and the window is empty" from "the token works
    // and we are reading the wrong field", which otherwise both read as zero.
    if (!rows.length) log.info(SRC, `portal ${c.fleet}: authenticated, no orders in window`, { from: iso(from), to: iso(to) });
    if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
  }
  return total;
}
export async function collect({ from, to, mode }) {
  /* Every one of the four surfaces here — two fleets on the FI roster, two on
     the portal — could fail while this recorded status 'ok' with rows_written
     0, because only a thrown exception ever reached the catch. That is the
     same "the run reported success and wrote nothing" that hid a 299-day hole
     in the Uber trip history, and it is why Bolt has read as a healthy source
     for the life of the project while writing nothing at all.

     A surface that failed is named in the run now, so /api/status can say
     which half of Bolt is dark instead of showing a green tick over an empty
     table. */
  const fails = [];
  try {
    const roster = await pullFiRoster(from, to, fails);
    const trips = await pullPortalTrips(from, to, fails);
    const status = fails.length === 0 ? 'ok' : (roster + trips > 0 ? 'partial' : 'error');
    await logRun({ source: SRC, fleet_id: null, mode, window_start: from, window_end: to,
      status, rows_written: roster + trips,
      error: fails.length ? fails.join('; ').slice(0, 500) : null });
    log[status === 'ok' ? 'info' : 'warn'](SRC, `done (${status})`, { roster, trips, failed: fails.length || undefined });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, window_start: from, window_end: to, status: 'error',
      error: [String(e), ...fails].join('; ').slice(0, 500) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
