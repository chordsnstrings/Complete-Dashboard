// FMS / InfoTrack telematics collector — BOTH fleets, deepest history (>=12 months).
// Verified endpoints (ItlService.svc, JSON over webHttp):
//   GetTripPassenger?username&Password&vehicleno=ALL&fromdate=YYYY.MM.DD&todate=YYYY.MM.DD   (max ~31 days)
//   GetAlertData     (same params)
//   Login            -> userid; GetVehicleStatus?UserId= ; GetVehicleCurrentDetails (live)
import { config, normPlate } from '../config.js';
import { http, qs } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { dateChunks, dotDate, parseFmsTime } from '../util.js';
import { log } from '../log.js';

const SRC = 'fms';

async function call(op, params) {
  const url = `${config.fms.base}/${op}?${qs(params)}`;
  const { status, data } = await http(url, { timeoutMs: 120000 });
  return { status, data };
}

// ---- historical trips ----
async function pullTrips(fleet, from, to) {
  let total = 0;
  for (const [s, e] of dateChunks(from, to, 31)) {
    const { data } = await call('GetTripPassenger', {
      username: fleet.username, Password: fleet.password, vehicleno: 'ALL',
      fromdate: dotDate(s), todate: dotDate(e),
    });
    const rows = (data?.Data || []).map((t) => {
      const plate = normPlate(t['Plate No']);
      const start = parseFmsTime(t['Start Time']);
      return {
        platform: SRC, external_id: `${plate}|${start}`, fleet_id: fleet.fleet, plate,
        requested_at: start, ended_at: parseFmsTime(t['End Time']),
        pickup_addr: t['Start Location'], pickup_lat: t.StartLat, pickup_lng: t.StartLon,
        dropoff_addr: t['End Location'], dropoff_lat: t.EndLat, dropoff_lng: t.EndLon,
        distance_km: t['Total Travel Distance'], seat_count: t['Seat Count'],
        status: 'completed', raw: t,
      };
    }).filter((r) => r.requested_at);
    if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
    log.info(SRC, `trips ${fleet.fleet} ${dotDate(s)}..${dotDate(e)}`, { rows: rows.length });
  }
  return total;
}

// ---- historical driver-behaviour alerts ----
async function pullAlerts(fleet, from, to) {
  let total = 0;
  for (const [s, e] of dateChunks(from, to, 31)) {
    const { data } = await call('GetAlertData', {
      username: fleet.username, Password: fleet.password, vehicleno: 'ALL',
      fromdate: dotDate(s), todate: dotDate(e),
    });
    const rows = (data?.Data || []).map((a) => {
      const plate = normPlate(a['Plate No']);
      const at = parseFmsTime(a['Alert Date Time']);
      return {
        platform: SRC, external_id: `${plate}|${a['Alert Name']}|${at}`, fleet_id: fleet.fleet,
        plate, alert_type: a['Alert Name'], occurred_at: at, location: a['Start Location'], raw: a,
      };
    }).filter((r) => r.occurred_at);
    if (rows.length) total += await upsertMany('alert', rows, ['platform', 'external_id']);
  }
  return total;
}

// ---- live snapshot (also usable as a realtime poller) ----
export async function pullLive(fleet) {
  const { data: login } = await call('Login', { username: fleet.username, password: fleet.password });
  const userid = login?.userid;
  if (!userid) return 0;
  const { data } = await call('GetVehicleStatus', { UserId: userid });
  const rows = (data?.data || []).map((v) => ({
    source: SRC, fleet_id: fleet.fleet, plate: normPlate(v.vehicleno),
    captured_at: parseFmsTime(v.tracktime) || new Date().toISOString(),
    lat: v.lat, lng: v.lon, speed: parseFloat(v.speed) || null,
    ignition: /on/i.test(v.ignition || ''), status: (v.vehiclestatus || '').split(' - ')[0],
    fuel_level: v.fuellevel, ac_on: /on/i.test(v.acstatus || ''), raw: v,
  }));
  return rows.length ? upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']) : 0;
}

// backfill/incremental entry point
export async function collect({ from, to, mode }) {
  for (const fleet of config.fms.fleets) {
    if (!fleet.password) { log.warn(SRC, `no password for ${fleet.fleet}, skipping`); continue; }
    try {
      const trips = await pullTrips(fleet, from, to);
      const alerts = await pullAlerts(fleet, from, to);
      await logRun({ source: SRC, fleet_id: fleet.fleet, mode, window_start: from, window_end: to, status: 'ok', rows_written: trips + alerts });
      log.info(SRC, `done ${fleet.fleet}`, { trips, alerts });
    } catch (e) {
      await logRun({ source: SRC, fleet_id: fleet.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
      log.error(SRC, `failed ${fleet.fleet}`, { err: String(e) });
    }
  }
}
