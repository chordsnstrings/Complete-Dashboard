// CABMAN DT collector — REALTIME ONLY (no history param). Poll GetIVDData and append
// snapshots; running it on a schedule is how we build CABMAN history ourselves.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { log } from '../log.js';

const SRC = 'cabman';

/* CABMAN's timestamp field is named `gmt`, and it is GMT.
   It used to be stamped `+04:00`, which moved every fix FOUR HOURS into the
   past. That is not a cosmetic error: the unauthorised-trip reconciler matches
   a movement segment against bookings within a 15-minute tolerance, so a
   240-minute systematic shift meant no CABMAN segment could ever match its own
   booking. Nine drivers were named on the live dashboard for trips they had
   genuinely run on Uber.

   The skew was measurable from the data alone — CABMAN fixes arrived a minimum
   of 240.4 minutes "old" while FMS arrived 3.3 minutes old and Uber 0.9 through
   the same code path. The guard at the end of pullLive watches for it
   returning. */
function parseGmt(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const iso = s.replace(' ', 'T');
  // Accept an explicit offset if the provider ever starts sending one.
  const stamped = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(stamped);
  return isNaN(d) ? null : d.toISOString();
}

// "0" is a string, and every non-empty string is truthy. Coerce properly.
const truthy = (v) => {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '' ) return null;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return Number.isFinite(Number(s)) ? Number(s) !== 0 : Boolean(v);
};

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
      captured_at: parseGmt(v.gmt),
      lat: v.lat, lng: v.lng, speed: v.speed,
      // These arrive as numbers or as the STRINGS "0"/"1". `!!"0"` is true, which
      // pinned ignition and seat-occupancy permanently on and made the
      // stuck-sensor guard in the reconciler unreachable.
      ignition: truthy(v.state),
      status: v.Status, seat_occupied: truthy(v.SeatSensorValue), odometer: v.odometer,
      polled_at: now, raw: v,
    })).filter((r) => r.captured_at && r.plate);
    if (rows.length) total += await upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']);

    // A fix that claims to be hours old on arrival is a clock problem, not a
    // stale vehicle, and it silently corrupts every downstream time comparison.
    // Say so loudly rather than letting the reconciler judge trips against it.
    const lags = rows.map((r) => (Date.parse(now) - Date.parse(r.captured_at)) / 60000)
      .filter(Number.isFinite).sort((a, b) => a - b);
    const median = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
    if (median > 20) {
      log.error(SRC, 'telemetry clock skew — fixes arrive far older than the poll', {
        median_lag_min: Math.round(median), fleet: f.fleet,
        hint: 'check whether the provider changed the timezone of the `gmt` field',
      });
    }
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
