// Unauthorized-trip detection.
// Builds "occupancy segments" from 5-minute CABMAN seat-sensor telemetry, then matches each against
// bookings from every revenue channel (hotel/uber/yango/bolt/fms). Segments with real movement and no
// matching booking are revenue leakage. See docs/unauthorized-trips.md for the model and the
// hardware-failure handling this implements.
import { pool, upsertMany } from './db.js';
import { log } from './log.js';

export const RULES = {
  pollMinutes: 5,
  bridgeGapMin: 10,      // seat flicker: merge runs separated by <= 2 polls
  gapBreakMin: 15,       // telemetry hole bigger than this -> segment is 'partial'
  minDurationMin: 5,     // shorter than this is not a trip
  minDistanceKm: 1.0,    // must actually go somewhere
  minTopSpeed: 5,        // km/h — must actually move
  maxDurationHr: 8,      // longer than this => stuck sensor suspected
  matchToleranceMin: 15, // booking/segment clock drift tolerance
};

const R = 6371; // km
function haversine(a, b) {
  if ([a?.lat, a?.lng, b?.lat, b?.lng].some((v) => v == null)) return 0;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Group consecutive seat-occupied fixes into segments, bridging brief sensor flicker. */
export function buildSegments(fixes, rules = RULES) {
  const segs = [];
  let cur = null;
  for (const f of fixes) {
    const t = new Date(f.captured_at).getTime();
    const gapMin = cur ? (t - cur.lastT) / 60000 : Infinity;
    if (f.seat_occupied) {
      // Bridge brief sensor flicker (<= bridgeGapMin). A telemetry hole larger than that but still
      // within gapBreakMin keeps the segment together and marks it — we must not silently split a
      // trip across an outage and then report the halves as separate (possibly unauthorized) trips.
      if (cur && gapMin <= rules.gapBreakMin) {
        cur.fixes.push(f); cur.lastT = t;
      } else {
        if (cur) { cur.gapAfter = gapMin; segs.push(cur); }
        // a hole larger than gapBreakMin before this fix means we were blind right before it
        cur = { plate: f.plate, fleet_id: f.fleet_id, fixes: [f], lastT: t, gapBefore: gapMin };
      }
    } else if (cur && gapMin > rules.bridgeGapMin) {
      segs.push(cur); cur = null;
    }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => summarize(s, rules));
}

function summarize(seg, rules) {
  const f = seg.fixes;
  const start = new Date(f[0].captured_at), end = new Date(f[f.length - 1].captured_at);
  const durationMin = (end - start) / 60000;
  let dist = 0, topSpeed = 0, ignitionOn = 0, maxGap = 0;
  for (let i = 0; i < f.length; i++) {
    topSpeed = Math.max(topSpeed, +f[i].speed || 0);
    if (f[i].ignition) ignitionOn++;
    if (i) {
      dist += haversine(f[i - 1], f[i]);
      maxGap = Math.max(maxGap, (new Date(f[i].captured_at) - new Date(f[i - 1].captured_at)) / 60000);
    }
  }
  // odometer delta is more reliable than GPS displacement when available
  const odoDelta = (+f[f.length - 1].odometer || 0) - (+f[0].odometer || 0);
  const distanceKm = odoDelta > 0 && odoDelta < 500 ? odoDelta : dist;
  const boundaryGap = Math.max(
    Number.isFinite(seg.gapBefore) ? seg.gapBefore : 0,
    Number.isFinite(seg.gapAfter) ? seg.gapAfter : 0);
  return {
    plate: seg.plate, fleet_id: seg.fleet_id, boundary_gap_min: Math.round(boundaryGap),
    started_at: start.toISOString(), ended_at: end.toISOString(),
    duration_min: Math.round(durationMin), distance_km: +distanceKm.toFixed(2),
    top_speed: topSpeed, fixes: f.length,
    ignition_ratio: f.length ? ignitionOn / f.length : 0,
    max_gap_min: Math.round(Math.max(maxGap, boundaryGap)),
    start_lat: f[0].lat, start_lng: f[0].lng,
    end_lat: f[f.length - 1].lat, end_lng: f[f.length - 1].lng,
  };
}

/** Apply movement + hardware-plausibility rules. Returns a verdict before booking matching. */
export function classifySegment(s, rulesArg) {
  // Defensive: callers sometimes pass this straight to Array.map, which supplies an index as the
  // second argument — fall back to the defaults unless a real rules object was given.
  const rules = (rulesArg && typeof rulesArg === 'object') ? { ...RULES, ...rulesArg } : RULES;
  if (s.duration_min > rules.maxDurationHr * 60) return 'sensor_suspect';
  // occupied for a long time with ignition mostly off => weight left on the seat / stuck pad
  if (s.duration_min >= 30 && s.ignition_ratio < 0.2 && s.top_speed < rules.minTopSpeed) return 'sensor_suspect';
  if (s.max_gap_min > rules.gapBreakMin) return 'partial';
  if (s.duration_min < rules.minDurationMin) return 'stationary';
  if (s.distance_km < rules.minDistanceKm || s.top_speed < rules.minTopSpeed) return 'stationary';
  return 'candidate';   // real movement — now needs a booking match
}

/** Does any booking overlap this segment (same plate, +/- tolerance)? */
export function findMatch(seg, bookings, rules = RULES) {
  const tol = rules.matchToleranceMin * 60000;
  const s0 = new Date(seg.started_at).getTime() - tol;
  const s1 = new Date(seg.ended_at).getTime() + tol;
  return bookings.find((b) => {
    if (b.plate !== seg.plate) return false;
    const b0 = new Date(b.requested_at).getTime();
    const b1 = b.ended_at ? new Date(b.ended_at).getTime() : b0 + 30 * 60000;
    return b0 <= s1 && b1 >= s0;      // interval overlap
  }) || null;
}

/** Full pass over a window: build, classify, match, persist. */
export async function reconcile({ from, to }) {
  const { rows: fixes } = await pool.query(
    `SELECT plate, fleet_id, captured_at, seat_occupied, speed, ignition, lat, lng, odometer
     FROM telemetry_snapshot WHERE source='cabman' AND captured_at BETWEEN $1 AND $2
     ORDER BY plate, captured_at`, [from, to]);
  if (!fixes.length) { log.info('reconcile', 'no cabman telemetry in window'); return { segments: 0 }; }

  const { rows: bookings } = await pool.query(
    `SELECT platform, external_id, plate, requested_at, ended_at, driver_name
     FROM trip WHERE requested_at BETWEEN $1 AND $2 AND plate IS NOT NULL`,
    [new Date(new Date(from).getTime() - 3600e3), new Date(new Date(to).getTime() + 3600e3)]);

  // which revenue channels actually reported OK for this window (confidence signal)
  const { rows: health } = await pool.query(
    `SELECT DISTINCT ON (source) source, status FROM collection_run
     WHERE source IN ('uber','yango','bolt','hotel') ORDER BY source, finished_at DESC`);
  const unhealthy = health.filter((h) => h.status !== 'ok').map((h) => h.source);

  const byPlate = {};
  for (const f of fixes) (byPlate[f.plate] ||= []).push(f);

  const out = [];
  for (const [plate, list] of Object.entries(byPlate)) {
    for (const seg of buildSegments(list)) {
      let verdict = classifySegment(seg);
      let match = null;
      if (verdict === 'candidate') {
        match = findMatch(seg, bookings);
        verdict = match ? 'authorized' : 'unauthorized';
      }
      out.push({
        plate, fleet_id: seg.fleet_id,
        started_at: seg.started_at, ended_at: seg.ended_at,
        duration_min: seg.duration_min, distance_km: seg.distance_km,
        top_speed: seg.top_speed, fixes: seg.fixes, max_gap_min: seg.max_gap_min,
        ignition_ratio: +seg.ignition_ratio.toFixed(2),
        start_lat: seg.start_lat, start_lng: seg.start_lng, end_lat: seg.end_lat, end_lng: seg.end_lng,
        verdict,
        matched_platform: match?.platform || null,
        matched_trip_id: match?.external_id || null,
        low_confidence: verdict === 'unauthorized' && unhealthy.length > 0,
        unavailable_sources: unhealthy.length ? unhealthy.join(',') : null,
      });
    }
  }
  if (out.length) await upsertMany('occupancy_segment', out, ['plate', 'started_at']);
  const tally = out.reduce((a, s) => (a[s.verdict] = (a[s.verdict] || 0) + 1, a), {});
  log.info('reconcile', 'done', { segments: out.length, ...tally, unhealthy: unhealthy.join(',') || 'none' });
  return { segments: out.length, ...tally };
}
