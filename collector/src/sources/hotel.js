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


// Haversine, km. Used for the approach leg (driver start → passenger pickup).
const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversine(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(x));
}

// Straight-line distance from where the driver set off to where the passenger got in.
// It understates real road distance, so treat it as a floor on deadhead, not a measure.
function deadheadKm(t) {
  const a = [t.driverStartLat, t.driverStartLon], b = [t.startLat, t.startLon];
  if (a.some((v) => v == null) || b.some((v) => v == null)) return null;
  const km = haversine(Number(a[0]), Number(a[1]), Number(b[0]), Number(b[1]));
  return km > 200 || !isFinite(km) ? null : Math.round(km * 100) / 100;   // discard bad fixes
}

// Hotel licence dates arrive as "1/1/26" or "01/01/2026" — day-first, two- or four-digit year.
function parseLicenceDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) { const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = String(2000 + Number(yy));
  const d = new Date(`${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Property names, fetched once per run so partner trips carry a readable label.
const hotelNames = new Map();
async function loadHotels(c) {
  try {
    const { data } = await http(`${c.base}/api/operation-managers/hotels`, {
      timeoutMs: 30000, headers: { authorization: `Bearer ${c.token}`, 'x-domain': c.domain },
    });
    for (const h of (data?.data || data || [])) if (h?._id) hotelNames.set(h._id, h.name || null);
  } catch (e) { log.warn(SRC, 'hotel list failed', { err: String(e).slice(0, 80) }); }
}

export async function collect({ from, to, mode }) {
  const c = config.hotel;
  if (!c.token) { log.warn(SRC, 'no HOTEL_TOKEN — skipping'); return; }
  try {
    await loadHotels(c);          // property names, so partner trips carry a label
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
        // Hotel is the only source that records where the driver started FROM, so it is
        // the only place we can measure the unpaid approach leg honestly.
        deadhead_km: deadheadKm(t),
        /* `cost` on this report is the charge for the ride, not what the ride
           cost us to deliver — it is the same number as `price`, and storing it
           in both columns produced a gross margin of exactly zero on every
           property across a full year of live data. There is one money figure
           on this channel; it is recorded once. A real cost only exists where
           the API also returns computedPrice, which across 1,254 bookings it
           never has. */
        cost: (t.computedPrice != null && t.cost != null) ? Number(t.cost) : null,
        margin: (t.computedPrice != null && t.cost != null) ? Number(t.computedPrice) - Number(t.cost) : null,
        hours: t.hours ?? null,
        zone: t.tripZone || null,
        partner_id: t.hotel || null,
        partner_name: hotelNames.get(t.hotel) || null,
        is_scheduled: !!t.isScheduled,
        is_missing: !!t.isMissingTrip,
        driver_own: !!t.driverOwnTrip,
        authorized: t.operatorApproval != null ? String(t.operatorApproval) : (t.authorization != null ? String(t.authorization) : null),
        raw: t,
      })).filter((r) => r.external_id && r.requested_at);
      if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);

      // Driver licence expiry rides along on every trip record — the only place we get it.
      const seen = new Map();
      for (const t of trips) {
        const d = t.driver; if (!d?._id || seen.has(d._id)) continue;
        seen.set(d._id, {
          platform: SRC, driver_ext_id: d._id, fleet_id: c.fleet,
          full_name: [d.firstName, d.lastName].filter((x) => x && x !== '.').join(' ').trim() || null,
          phone: d.phone || null, emirates_id: d.emiratesId || null,
          licence_no: d.driverLicense || null, licence_expires: parseLicenceDate(d.licenseExpireDate),
          state: d.currentStatus || (d.active ? 'active' : 'inactive'),
          device_brand: d.device?.brand || null, device_model: d.device?.model || null,
          // `password` is a bcrypt hash the API returns unasked; never persist it.
          raw: { role: d.role, active: d.active },
        });
      }
      if (seen.size) await upsertMany('driver_compliance', [...seen.values()], ['platform', 'driver_ext_id']);
      log.info(SRC, `trips ${iso(s)}..${iso(e)}`, { rows: rows.length });
    }
    await logRun({ source: SRC, fleet_id: c.fleet, mode, window_start: from, window_end: to, status: 'ok', rows_written: total });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: c.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
