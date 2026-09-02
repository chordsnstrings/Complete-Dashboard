// Bolt collector.
//  FI API (client_credentials)  : Egari roster only — getDrivers / getVehicles. No trips/earnings.
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

async function pullFiRoster(from, to, fails) {
  const token = await fiToken();
  let total = 0;
  const [rFrom, rTo] = rosterWindow(from, to);
  for (const c of config.bolt.companies) {
    const body = JSON.stringify({ company_id: c.companyId, offset: 0, limit: 200, start_ts: Number(unixS(rFrom)), end_ts: Number(unixS(rTo)) });
    const { data } = await http(`${config.bolt.fiGateway}/getDrivers`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    /* This logged a bare code — 498806 for one fleet, 503 for the other — and
       called both "not authorized", which is our guess rather than the
       gateway's. Two different codes are two different problems, and the
       message beside them is what says which. */
    if (data?.code !== 0) {
      const why = [data?.message, data?.error_hint && `hint=${data.error_hint}`].filter(Boolean).join(' ')
        || 'no message';
      log.warn(SRC, `FI getDrivers rejected for ${c.fleet} — ${why}`, { code: data?.code, company_id: c.companyId });
      fails.push(`FI roster ${c.fleet}: code=${data?.code} ${why}`);
      continue;
    }
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

/* Exchange, and keep the successor. Returns { at, err } — never throws, because
   one fleet's dead token must not cost us the other fleet's trips. */
async function portalToken(fleet, companyId) {
  const rt = refreshTokenFor(fleet);
  if (!rt) return { at: null, err: 'no refresh token configured' };

  const meta = readRefreshToken(rt);
  if (meta?.expired) {
    return { at: null, err: `refresh token expired ${meta.expires_at} — re-capture from the portal` };
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

    const { at, err, meta } = await portalToken(c.fleet, c.companyId);
    if (!at) {
      const m = meta || readRefreshToken(rt);
      /* The owner the token was issued to, next to the fleet it is being used
         for: a token minted for one owner cannot read the other's company, and
         that mismatch is otherwise indistinguishable from an expired one. */
      log.warn(SRC, `portal token rejected for ${c.fleet} — ${err}`, {
        company_id: c.companyId,
        token_owner: m?.fleet_owner_id ?? 'unreadable',
        expected_owner: c.userId,
        owner_matches: m?.fleet_owner_id == null ? null : m.fleet_owner_id === c.userId,
        expires_at: m?.expires_at || 'unknown',
      });
      fails.push(`portal ${c.fleet}: ${err}`);
      /* Bolt refresh tokens last about seven days, so this is the routine
         end of one rather than a fault — but it is only routine to somebody
         who is told. It reached the operator as a source that had quietly
         stopped carrying trips. The owner mismatch is recorded separately
         because re-pasting cannot fix a token minted for the other fleet. */
      await noteCredential(pool, { provider: SRC, fleet: c.fleet, credential: 'BOLT_REFRESH_TOKEN',
        state: 'invalid', surface: 'orderHistory',
        detail: m?.fleet_owner_id != null && m.fleet_owner_id !== c.userId
          ? `the token belongs to owner ${m.fleet_owner_id}, not ${c.userId} — it is the wrong fleet's token, not an expired one`
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
