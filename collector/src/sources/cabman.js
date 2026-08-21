// CABMAN DT collector — REALTIME ONLY (no history param). Poll GetIVDData and append
// snapshots; running it on a schedule is how we build CABMAN history ourselves.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { log } from '../log.js';

const SRC = 'cabman';

export async function pullLive() {
  let total = 0;
  for (const f of config.cabman.fleets) {
    if (!f.pass) { log.warn(SRC, `no password for ${f.fleet}, skipping`); continue; }
    const { data } = await http(config.cabman.url, {
      headers: { InterfaceUniqueId: f.interfaceId, InterfaceUserName: f.user, InterfacePassword: f.pass },
    });
    const now = new Date().toISOString();
    const rows = (data?.IVDDataResult || []).map((v) => ({
      source: SRC, fleet_id: f.fleet, plate: normPlate(v.VehicleID),
      captured_at: (v.gmt || '').replace(' ', 'T') + '+04:00',
      lat: v.lat, lng: v.lng, speed: v.speed, ignition: !!v.state,
      status: v.Status, seat_occupied: !!v.SeatSensorValue, odometer: v.odometer,
      polled_at: now, raw: v,
    })).filter((r) => r.captured_at && r.plate);
    if (rows.length) total += await upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']);
  }
  return total;
}

// CABMAN has no historical endpoint — "collect" just captures the current snapshot.
export async function collect({ mode = 'realtime' } = {}) {
  try {
    const n = await pullLive();
    await logRun({ source: SRC, fleet_id: null, mode, status: 'ok', rows_written: n });
    log.info(SRC, 'snapshot captured', { rows: n });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
