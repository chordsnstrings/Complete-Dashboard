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
  // Platform trip exports lag. A journey that ended within this many minutes of
  // the window edge has not had time to acquire a booking, so judging it
  // convicts the collector's latency rather than the driver.
  bookingLagMin: 120,
  // How many consecutive fixes reporting an empty seat end a journey. One can
  // be a sensor blink; two in a row is the passenger having got out.
  emptyFixesToClose: 2,
};

const R = 6371; // km
function haversine(a, b) {
  if ([a?.lat, a?.lng, b?.lat, b?.lng].some((v) => v == null)) return 0;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* Group consecutive seat-occupied fixes into journeys.

   The rule that matters: a journey ends when the telemetry POSITIVELY REPORTS
   an empty seat, not merely when fixes stop arriving. Previously the empty
   branch only closed a segment if the gap since the last OCCUPIED fix exceeded
   bridgeGapMin — so a fix showing seat empty and ignition off, followed 11
   minutes later by a new pickup, was appended to the previous journey. Two
   separate rides became one 25-minute "unauthorized" segment whose distance and
   top speed spanned the dead time between them.

   Bridging is for HOLES IN THE DATA — fixes we never received — and never over
   fixes that positively say the seat was empty. */
export function buildSegments(fixes, rules = RULES) {
  const segs = [];
  let cur = null;
  let emptyRun = 0;
  let prevT = null;

  const close = (gapAfter) => { if (cur) { cur.gapAfter = gapAfter; segs.push(cur); } cur = null; };

  for (const f of fixes) {
    const t = new Date(f.captured_at).getTime();
    if (!Number.isFinite(t)) continue;
    // Gap since the PREVIOUS FIX of any kind — the real measure of blindness.
    const gapMin = prevT == null ? Infinity : (t - prevT) / 60000;

    if (f.seat_occupied) {
      emptyRun = 0;
      // Only bridge across an actual data hole, and only a short one.
      if (cur && gapMin <= rules.bridgeGapMin) {
        cur.fixes.push(f);
      } else {
        close(gapMin);
        cur = { plate: f.plate, fleet_id: f.fleet_id, fixes: [f], gapBefore: gapMin };
      }
    } else {
      emptyRun++;
      // The passenger got out. Close on the configured run of empty fixes.
      if (cur && emptyRun >= rules.emptyFixesToClose) close(gapMin);
    }
    prevT = t;
  }
  // A segment still open at the end of the window has no observed end: its
  // gapAfter is unknown, NOT zero. summarize() and reconcile() both depend on
  // that distinction to avoid convicting a truncated journey.
  if (cur) { cur.gapAfter = Infinity; segs.push(cur); }
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
  /* An unknown boundary is NOT a gap of zero. `gapBefore` is Infinity for the
     first fix a plate ever produced and `gapAfter` is Infinity for a journey
     still open at the window edge — coercing either to 0 told the classifier we
     had perfect coverage right up to the instant we started looking, which is
     how journeys truncated by the start of available telemetry became
     confident accusations. The flags are carried through so the caller can
     refuse to judge. */
  const knownBefore = Number.isFinite(seg.gapBefore);
  const knownAfter = Number.isFinite(seg.gapAfter);
  const boundaryGap = Math.max(knownBefore ? seg.gapBefore : 0, knownAfter ? seg.gapAfter : 0);
  return {
    plate: seg.plate, fleet_id: seg.fleet_id, boundary_gap_min: Math.round(boundaryGap),
    gapBefore: seg.gapBefore, gapAfter: seg.gapAfter,
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

/* Which booking, if any, covers this segment — and if none, the nearest one, so
   the verdict can be argued with rather than merely asserted.

   A cancelled booking is not authorisation: a driver who cancels every ride
   would otherwise be free to drive the car anywhere. Only a completed (or
   still-running) booking authorises movement.

   A booking with no drop-off time used to be given an invented 30-minute
   window. That over-covered cancellations and under-covered long trips — a
   71-minute airport run with a missing drop-off authorised only its first half
   and the rest became "unauthorized". Now the window comes from the trip's own
   duration or distance when either is present. */
export function bookingWindow(b) {
  const b0 = new Date(b.requested_at).getTime();
  if (b.ended_at) return [b0, new Date(b.ended_at).getTime(), 'ended_at'];
  if (b.duration_s > 0) return [b0, b0 + b.duration_s * 1000, 'duration'];
  // ~2 minutes per km is a slow-city estimate; deliberately generous, since the
  // cost of over-covering is a missed flag and the cost of under-covering is a
  // false accusation.
  if (b.distance_km > 0) return [b0, b0 + Math.min(b.distance_km * 2 * 60000, 3 * 3600e3), 'distance'];
  return [b0, b0 + 30 * 60000, 'assumed'];
}

export function findMatch(seg, bookings, rules = RULES) {
  const tol = rules.matchToleranceMin * 60000;
  const s0 = new Date(seg.started_at).getTime();
  const s1 = new Date(seg.ended_at).getTime();
  const mine = bookings.filter((b) => b.plate === seg.plate);

  const completed = mine.filter((b) => b.outcome === 'completed' || b.outcome == null);
  const overlap = completed.find((b) => {
    const [b0, b1] = bookingWindow(b);
    return b0 <= s1 + tol && b1 >= s0 - tol;
  }) || null;

  // The nearest booking regardless of outcome, with how far away it is. This is
  // the evidence that makes a verdict falsifiable — a systematic clock skew
  // shows up immediately as every segment's nearest booking sitting the same
  // number of minutes away.
  let nearest = null, nearestMin = null;
  for (const b of mine) {
    const [b0, b1] = bookingWindow(b);
    const gap = b1 < s0 ? (s0 - b1) : b0 > s1 ? (b0 - s1) : 0;
    if (nearestMin === null || gap < nearestMin) { nearestMin = gap; nearest = b; }
  }
  return { match: overlap, nearest, nearest_gap_min: nearestMin == null ? null : Math.round(nearestMin / 60000) };
}

/** Full pass over a window: build, classify, match, persist. */
/* The three verdicts that never reach the booking-matching branch still need a
   reason. Written with NULL they are indistinguishable from a verdict issued
   before the reason column existed — which is precisely the test the v8
   retraction used to decide what to delete. */
const NON_CANDIDATE_REASON = {
  stationary: 'the vehicle did not travel far or fast enough for this to be a trip',
  sensor_suspect: 'the seat reading is not physically plausible — treated as a hardware fault, not a journey',
  partial: 'the journey is cut off by the edge of available telemetry',
};

/* The two guards that decide whether a verdict may be issued at all.
   ─────────────────────────────────────────────────────────────────────────
   Pure and exported, because both were wrong in production for months and
   neither was testable in place: reconcile() needs a database, so the only
   way to check "can this branch ever be reached" was to read it. Both bugs
   were of the same kind — a plausible expression measuring the wrong thing —
   and both produced an empty page rather than an error.

   test/verdict_guards.test.mjs pins them. */

/* Channels a verdict may be reached WITHOUT.
   `everSeen` is every platform that has produced a booking on this fleet at
   any time; `inWindow` is those that produced one in the range being judged. A
   channel in the first set and not the second genuinely might hold the booking
   that explains a journey, so no unauthorized verdict is safe. A channel in
   NEITHER is not part of this fleet's booking surface and must not block one —
   bolt has produced zero bookings here, ever, and blocking on it made the
   unauthorized verdict unreachable. `fms` is telematics, not a channel. */
export function blockingChannels(everSeen, inWindow) {
  const seen = inWindow instanceof Set ? inWindow : new Set(inWindow || []);
  return (everSeen || []).filter((c) => c && c !== 'fms' && !seen.has(c));
}

/* How far the trackers' clocks are from ours, in minutes.
   The gap between what the device says the time was (captured_at) and when we
   asked for it (polled_at). NOT `now - captured_at`, which is how OLD a fix
   is: every fix in a thirty-day window is days old by construction, so that
   measurement declared the fleet's clock suspect on every window ending today
   and refused to judge anything it had not already matched. A row with no
   polled_at cannot be judged either way and is left out of the median. */
export function clockSkewMin(fixes) {
  const lags = (fixes || []).map((f) => (f && f.polled_at && f.captured_at
    ? (new Date(f.polled_at).getTime() - new Date(f.captured_at).getTime()) / 60000 : null))
    .filter((v) => v != null && Number.isFinite(v) && v > -60)
    .sort((a, b) => a - b);
  return lags.length ? lags[Math.floor(lags.length / 2)] : 0;
}

export async function reconcile({ from, to }) {
  const { rows: fixes } = await pool.query(
    /* polled_at as well as captured_at. The clock check below needs the gap
       BETWEEN THEM — the device's clock against ours at the moment we fetched
       — and was measuring `now - captured_at` instead, which is the age of the
       data and grows without bound as the window recedes. See there. */
    `SELECT plate, fleet_id, captured_at, polled_at, seat_occupied, speed, ignition, lat, lng, odometer
     FROM telemetry_snapshot WHERE source='cabman' AND captured_at BETWEEN $1 AND $2
     ORDER BY plate, captured_at`, [from, to]);
  if (!fixes.length) { log.info('reconcile', 'no cabman telemetry in window'); return { segments: 0 }; }

  /* Bookings only. The FMS feed is DERIVED FROM THE SAME TELEMETRY as these
     segments, so matching a movement segment against an FMS "booking" is
     circular — every real journey has an FMS row, so everything matched and the
     detector reported nothing. It is the whole reason this feature exists, and
     it was switched off by a platform list. */
  const { rows: bookings } = await pool.query(
    `SELECT platform, external_id, plate, requested_at, ended_at, duration_s, distance_km,
            driver_name, driver_ext_id, outcome
     FROM trip_norm
     WHERE requested_at BETWEEN $1 AND $2 AND plate IS NOT NULL AND plate <> ''
       AND is_booking`,
    [new Date(new Date(from).getTime() - 4 * 3600e3), new Date(new Date(to).getTime() + 4 * 3600e3)]);

  /* Which channels could actually have explained a trip in this window.
     `collection_run.status` is not the signal: a collector whose credentials
     expired returns rows_written from its roster and reports "ok". The honest
     test is whether the channel produced any BOOKING at all in a window where
     it normally does. Bolt and Yango currently have zero trip rows in the
     entire database while reporting ok, and every segment was being marked
     `low_confidence: false` on that basis. */
  const { rows: seen } = await pool.query(
    `SELECT platform, count(*)::int n FROM trip_norm
     WHERE is_booking AND requested_at BETWEEN $1 AND $2 GROUP BY platform`, [from, to]);
  const { rows: ever } = await pool.query(
    `SELECT platform, count(*)::int n FROM trip_norm WHERE is_booking GROUP BY platform`);
  const inWindow = new Set(seen.map((r) => r.platform));
  const configured = ever.filter((r) => r.n > 0).map((r) => r.platform);
  // A channel we have never seen at all is not configured; one we have seen but
  // that produced nothing here is unavailable for this window.
  // See blockingChannels() above for why this is not a hardcoded list.
  const unavailable = blockingChannels(configured, inWindow);

  /* Telemetry whose clock disagrees with wall time cannot be compared against
     bookings at all. A 4-hour skew in the CABMAN feed once made every segment
     miss its own booking by 240 minutes against a 15-minute tolerance, and the
     dashboard named nine drivers for trips they had genuinely run. Refuse to
     judge rather than accuse. */
  // See clockSkewMin() above: the gap between the device's clock and ours,
  // not the age of the data.
  const medianLag = clockSkewMin(fixes);
  const clockSuspect = medianLag > 60;
  if (clockSuspect) {
    log.error('reconcile', 'telemetry clock looks skewed — refusing to issue verdicts', {
      median_lag_min: Math.round(medianLag),
    });
  }

  // A journey still in progress, or one whose booking has not been collected
  // yet, must not be judged. Platform trip exports lag.
  const judgeBefore = new Date(to).getTime() - RULES.bookingLagMin * 60000;

  const byPlate = {};
  for (const f of fixes) (byPlate[f.plate] ||= []).push(f);

  const out = [];
  for (const [plate, list] of Object.entries(byPlate)) {
    for (const seg of buildSegments(list)) {
      let verdict = classifySegment(seg);
      let found = { match: null, nearest: null, nearest_gap_min: null };
      let reason = null;

      if (verdict === 'candidate') {
        found = findMatch(seg, bookings);
        if (found.match) {
          verdict = 'authorized';
          reason = `matched ${found.match.platform} trip ${found.match.external_id}`;
        } else if (clockSuspect) {
          verdict = 'unverifiable';
          reason = `telemetry clock is ${Math.round(medianLag)} min behind wall time — bookings cannot be matched reliably`;
        } else if (new Date(seg.ended_at).getTime() > judgeBefore) {
          verdict = 'pending';
          reason = `journey ended within ${RULES.bookingLagMin} min of the window edge; platform bookings may not have arrived yet`;
        } else if (!Number.isFinite(seg.gapBefore) || !Number.isFinite(seg.gapAfter)) {
          verdict = 'unverifiable';
          reason = 'the journey runs past the edge of available telemetry, so its true extent is unknown';
        } else if (unavailable.length) {
          verdict = 'unverifiable';
          reason = `no bookings collected from ${unavailable.join(', ')} in this window, so a booking there cannot be ruled out`;
        } else {
          verdict = 'unauthorized';
          reason = found.nearest
            ? `no completed booking overlaps; nearest is a ${found.nearest.platform} trip ${found.nearest_gap_min} min away`
            : `no booking of any kind on this plate in the window, across ${configured.join(', ') || 'no channels'}`;
        }
      }

      // Every verdict carries a reason, including the three that never reach
      // the branch above. They were being written with a NULL reason, which is
      // indistinguishable from "issued before this code existed" — and the v8
      // retraction used exactly that test to decide what to delete.
      if (!reason) reason = NON_CANDIDATE_REASON[verdict]
        || `classified ${verdict} from telemetry alone; no booking match was attempted`;

      out.push({
        plate, fleet_id: seg.fleet_id,
        started_at: seg.started_at, ended_at: seg.ended_at,
        duration_min: seg.duration_min, distance_km: seg.distance_km,
        top_speed: seg.top_speed, fixes: seg.fixes, max_gap_min: seg.max_gap_min,
        ignition_ratio: +seg.ignition_ratio.toFixed(2),
        /* HOW FAR THE OBSERVED RECORD REACHES EITHER SIDE.
           ──────────────────────────────────────────────────────────────
           segmentise() computes this (reconcile.js:112) and it was dropped
           right here on the way to the database, so occupancy_segment.
           boundary_gap_min — declared in sql/schema_v8.sql, selected by
           api/segment_routes.js, and rendered by api/public/segments.js as
           "Nearest telemetry boundary" — was null on all 300 segments in every
           window. Three layers reading a field nothing wrote.

           It is the evidence for the condition schema_v8's own comment puts on
           an accusation: `unauthorized` may only be issued when "the journey is
           bounded on both sides by observed fixes". The classifier above tests
           exactly that, on gapBefore/gapAfter, and then discarded the number a
           reader would need to check it — on the one page in this product that
           accuses a named driver of taking a car out unbooked. */
        boundary_gap_min: seg.boundary_gap_min,
        start_lat: seg.start_lat, start_lng: seg.start_lng, end_lat: seg.end_lat, end_lng: seg.end_lng,
        verdict,
        matched_platform: found.match?.platform || null,
        matched_trip_id: found.match?.external_id || null,
        nearest_platform: found.nearest?.platform || null,
        nearest_trip_id: found.nearest?.external_id || null,
        nearest_gap_min: found.nearest_gap_min,
        verdict_reason: reason,
        /* What was actually checked, which is the same set the verdict was
           reached against. Reading a hardcoded list here claimed bolt had been
           consulted on a fleet that has never had a bolt booking. */
        channels_checked: configured.filter((c) => c !== 'fms' && inWindow.has(c)).join(',') || null,
        low_confidence: verdict === 'unverifiable' || verdict === 'pending',
        unavailable_sources: unavailable.length ? unavailable.join(',') : null,
      });
    }
  }
  if (out.length) await upsertMany('occupancy_segment', out, ['plate', 'started_at']);
  const tally = out.reduce((a, s) => (a[s.verdict] = (a[s.verdict] || 0) + 1, a), {});
  log.info('reconcile', 'done', {
    segments: out.length, ...tally,
    unavailable: unavailable.join(',') || 'none',
    clock_skew_min: Math.round(medianLag),
  });
  return { segments: out.length, ...tally };
}
