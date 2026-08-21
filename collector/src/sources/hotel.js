// Hotel (ecosine.ae) trips collector — the corporate/hotel booking channel.
// GET /api/operation-managers/report/get-trip-report?startDate=&endDate=
//   Authorization: Bearer <token>, x-domain: hotel.ecosine.ae
// Verified: returns {data:{totalTrips, trips:[...]}} with car.licenseNumber ("L-46185"),
// driver, pick/drop locations + lat/lon, totalDistance, cost, paymentMethod, status, tripZone.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { dateChunks, iso } from '../util.js';
import { log } from '../log.js';

const SRC = 'hotel';

export async function collect({ from, to, mode }) {
  const c = config.hotel;
  if (!c.token) { log.warn(SRC, 'no HOTEL_TOKEN — skipping'); return; }
  try {
    let total = 0;
    for (const [s, e] of dateChunks(from, to, 31)) {
      const url = `${c.base}/api/operation-managers/report/get-trip-report?startDate=${iso(s)}&endDate=${iso(e)}`;
      const { data } = await http(url, {
        timeoutMs: 120000,
        headers: { authorization: `Bearer ${c.token}`, 'x-domain': c.domain },
      });
      const trips = data?.data?.trips || [];
      const rows = trips.map((t) => ({
        platform: SRC, external_id: t._id, fleet_id: c.fleet,
        plate: normPlate(t.car?.licenseNumber),
        driver_ext_id: t.driver?._id,
        driver_name: [t.driver?.firstName, t.driver?.lastName].filter((x) => x && x !== '.').join(' ').trim() || null,
        requested_at: t.startTime, ended_at: t.endTime,
        pickup_addr: t.pickLocation, pickup_lat: t.startLat, pickup_lng: t.startLon,
        dropoff_addr: t.dropOffLocation, dropoff_lat: t.endLat, dropoff_lng: t.endLon,
        distance_km: t.totalDistance,
        status: t.status === 'finished' ? 'completed' : t.status,
        product: t.type || 'hotel', payment_type: t.paymentMethod,
        price: t.cost ?? t.computedPrice ?? null, currency: 'AED',
        raw: t,
      })).filter((r) => r.external_id && r.requested_at);
      if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
      log.info(SRC, `trips ${iso(s)}..${iso(e)}`, { rows: rows.length });
    }
    await logRun({ source: SRC, fleet_id: c.fleet, mode, window_start: from, window_end: to, status: 'ok', rows_written: total });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: c.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
