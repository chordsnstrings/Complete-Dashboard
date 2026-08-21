// Bolt collector.
//  FI API (client_credentials)  : Egari roster only — getDrivers / getVehicles. No trips/earnings.
//  Fleet Owner Portal (refresh) : trips + earnings for BOTH fleets — GUARDED on BOLT_REFRESH_TOKEN.
//                                 Refresh tokens last ~7 days; when expired the portal path is skipped
//                                 and the supervisor must re-capture one.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { unixS, iso } from '../util.js';
import { log } from '../log.js';
import { stateRow } from '../roster.js';

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
async function pullFiRoster(from, to) {
  const token = await fiToken();
  let total = 0;
  for (const c of config.bolt.companies) {
    const body = JSON.stringify({ company_id: c.companyId, offset: 0, limit: 200, start_ts: Number(unixS(from)), end_ts: Number(unixS(to)) });
    const { data } = await http(`${config.bolt.fiGateway}/getDrivers`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    if (data?.code !== 0) { log.warn(SRC, `FI getDrivers ${c.fleet} not authorized`, { code: data?.code }); continue; }
    const rows = (data.data?.drivers || []).map((d) => ({
      platform: SRC, fleet_id: c.fleet, driver_ext_id: d.driver_uuid,
      driver_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
      plate: normPlate(d.active_vehicle?.reg_number), period_start: iso(from), period_end: iso(to),
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

// Portal access token (per company) — only if a refresh token is configured.
async function portalToken(companyId) {
  const { data } = await http(`${config.bolt.portalBase}/getAccessToken?language=en-us&version=FO.3.856&brand=bolt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: config.bolt.refreshToken, company: { company_id: companyId, company_type: 'fleet_company' } }),
  });
  return data?.data?.access_token || null;
}

// Portal trips (orderHistory) — placeholder wired to the verified endpoint; enabled once a token exists.
async function pullPortalTrips(from, to) {
  if (!config.bolt.refreshToken) { log.warn(SRC, 'portal skipped — no BOLT_REFRESH_TOKEN (trips/earnings unavailable)'); return 0; }
  let total = 0;
  for (const c of config.bolt.companies) {
    const at = await portalToken(c.companyId);
    if (!at) { log.warn(SRC, `portal token invalid for ${c.fleet} — refresh needed`); continue; }
    const url = `${config.bolt.portalBase}/orderHistory/getTable?language=en-us&version=FO.3.856&company_id=${c.companyId}&user_id=${c.userId}&brand=bolt`;
    const { data } = await http(url, {
      method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ start_date: iso(from), end_date: iso(to),
        order_states: ['finished', 'client_cancelled', 'driver_did_not_respond', 'driver_rejected', 'client_did_not_show', 'driver_cancelled_after_accept'] }),
    });
    const orders = data?.data?.orders || data?.orders || [];
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
  try {
    const roster = await pullFiRoster(from, to);
    const trips = await pullPortalTrips(from, to);
    await logRun({ source: SRC, fleet_id: null, mode, window_start: from, window_end: to, status: 'ok', rows_written: roster + trips });
    log.info(SRC, 'done', { roster, trips });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
