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
    const url = `${config.bolt.portalBase}/orderHistory/getTable?language=en-us&version=FO.3.856&company_id=${c.companyId}&user_id=${c.userId}&brand=bolt`;
    const { data } = await http(url, {
      method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ start_date: iso(from), end_date: iso(to),
        order_states: ['finished', 'client_cancelled', 'driver_did_not_respond', 'driver_rejected', 'client_did_not_show', 'driver_cancelled_after_accept'] }),
    });
    const orders = data?.data?.orders || data?.orders || [];
    // An authenticated call that comes back with no orders is worth a line: it
    // separates "the token works and the window is empty" from "the token works
    // and we are reading the wrong field", which otherwise both read as zero.
    if (!orders.length) log.info(SRC, `portal ${c.fleet}: authenticated, no orders in window`, { from: iso(from), to: iso(to) });
    const rows = orders.map((o) => ({
      platform: SRC, external_id: String(o.order_id || o.id), fleet_id: c.fleet,
      plate: normPlate(o.car_reg_number || o.license_plate), driver_name: o.driver_name,
      requested_at: o.order_created || o.created_at, status: o.order_state || o.state,
      price: o.ride_price || o.price, currency: 'AED', raw: o,
    })).filter((r) => r.external_id && r.external_id !== 'undefined');
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
