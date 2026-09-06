// Unauthorized-trip detection.
// Builds "occupancy segments" from 5-minute CABMAN seat-sensor telemetry, then matches each against
// bookings from every revenue channel (hotel/uber/yango/bolt/fms). Segments with real movement and no
// matching booking are revenue leakage. See docs/unauthorized-trips.md for the model and the
// hardware-failure handling this implements.
import { pool } from './db.js';
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

/* ONE PASS, ONE ANSWER — a pass owns the window it judged.
   ─────────────────────────────────────────────────────────────────────────
   This write was an upsert keyed on (plate, started_at) and nothing else, so
   occupancy_segment did not hold the current reading of the fleet: it held the
   UNION of every reconcile pass that has ever run. Two passes that disagree
   about where a journey begins do not collide on that key — they both survive,
   as two rows describing one journey.

   Measured on production on 2026-09-05, every day of 2026-08-20..2026-09-05
   pulled through /api/segments: 3,511 rows, of which 2,102 are intervals lying
   strictly inside a LONGER segment on the same plate — 59.9 percent of the
   rows and 51,401 of the 82,639 km. The 30-day tile says 3,512 rather than
   3,511; the extra one is a journey that had just started on the 6th in Dubai.
   De-duplicated, the same period is 1,409 segments and 31,238 km. All 2,102 have one shape: the same end as the row that
   contains them and a LATER start. That is the signature of the cause. `from`
   here is always a clock offset back from now (src/run.js:114 and the callers
   above it), so a pass whose window happens to open in the middle of a journey
   sees only the tail of it, and writes that tail as a journey of its own beside
   the whole one a wider pass already recorded. L44251 on 2026-08-22 carries
   both: 16:13:41 → 16:44:56 judged `unauthorized` against bolt,hotel,uber,yango
   and 16:38:42 → 16:44:56 judged `unverifiable` against hotel,uber,yango.

   The proof that these are different passes rather than different journeys is
   channels_checked, which is written once per pass from what the window could
   read. Five distinct values coexist inside this one period today, six when the audit measured it — the count moves as passes age out of the window, which is itself the point, and they coexist
   on single days — 2026-08-23 alone holds 139 rows reading hotel,uber,yango and
   56 reading bolt,hotel,uber,yango. One day cannot have been judged against six
   different channel sets by one authoritative pass.

   What a reader was being shown: 3,511 occupancy intervals where 1,409
   journeys happened, 1,632 partial against 572, 1,178 authorized against 521,
   483 stationary against 239, and a daily count for 2026-09-01 of 302 falling
   to 247 the next day, which reads as a fleet going quiet — de-duplicated it is
   113 then 96, so the step is duplicates stopping. The accusation count is the
   one figure this barely moves: exactly 1 of the 59 `unauthorized` rows is a
   superseded fragment, so that column is inflated by one, not by the 2.5x the
   segment, km, partial, authorized and stationary totals carry. It is the one
   row that matters most, though, because it names a person for a journey the
   current reconciler judges differently.

   THE SCOPE OF THE DELETE, which is the whole risk here.
   It reaches rows for the plates this pass actually re-derived — the keys of
   byPlate, which is built from the cabman fixes the window returned — and only
   rows whose start lies inside the window. Every journey starting in that range
   on one of those plates was rebuilt from the same telemetry a moment ago, so
   whatever is there is this pass's own previous answer or an older pass's, and
   in both cases this pass has just replaced it. It CANNOT reach a plate that
   produced no fix in the window: a device that was offline leaves no evidence,
   and evidence we did not look at is not evidence we may retract. It CANNOT
   reach a row that starts before `from`, which is the journey straddling the
   left edge — this pass saw only its tail and must not overwrite the fuller
   reading of it with a shorter one.

   That second exemption is exactly why the DELETE alone does not establish the
   property this exists for. The straddling row survives, and this pass then
   writes its own truncated tail beside it, which is the 2,102 rows all over
   again. So after the insert, one more statement drops rows in the window that
   a longer row on the same plate already covers end to end. The row that starts
   earlier and ends no sooner was built where this one was built from a subset
   of the same fixes, so it is the better-informed of the two and the shorter
   one is a fragment of it. Rows that merely OVERLAP without one containing the
   other are left alone: every window here ends at now and reaches a whole
   number of days back (src/run.js:339-363), so a journey truncated by the right
   edge is re-derived whole by the next pass rather than left beside itself, and
   no ordering of these passes produces that shape. Deleting on a guess would be
   discarding evidence rather than a duplicate.

   The three statements are one transaction because the first is destructive:
   a delete that commits and an insert that then fails would leave the window
   empty, which on this page reads as a fleet with nothing to answer for. */
async function writeWindow(out, { from, to, plates }) {
  const KEY = ['plate', 'started_at'];
  if (!plates.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM occupancy_segment
        WHERE plate = ANY($1::text[]) AND started_at BETWEEN $2 AND $3`, [plates, from, to]);

    /* Batched the way upsertMany batches, and for the same reason — Postgres
       stops at 65535 bound parameters — but inline, because the delete and the
       insert have to share one client to share one transaction and upsertMany
       takes its own out of the pool. ON CONFLICT is kept even though the delete
       above has just cleared the keys: two passes overlapping in time is
       exactly what this function exists to survive. */
    if (out.length) {
      const cols = Object.keys(out[0]);
      const updates = cols.filter((c) => !KEY.includes(c)).map((c) => `${c}=EXCLUDED.${c}`);
      const perBatch = Math.max(1, Math.min(200, Math.floor(60000 / cols.length)));
      for (let i = 0; i < out.length; i += perBatch) {
        const params = [];
        const tuples = out.slice(i, i + perBatch).map((r) => `(${cols.map((c) => {
          params.push(r[c] === undefined ? null : r[c]);
          return `$${params.length}`;
        }).join(',')})`);
        await client.query(
          `INSERT INTO occupancy_segment (${cols.join(',')}) VALUES ${tuples.join(',')}`
          + ` ON CONFLICT (${KEY.join(',')}) DO UPDATE SET ${updates.join(', ')}`, params);
      }
    }

    // The left-edge sweep described above. coalesce() because ended_at is
    // nullable in the schema: a row with no end is a point in time, not a
    // journey reaching forever, and treating it as the latter would let it
    // swallow the rows around it.
    const swept = await client.query(
      `DELETE FROM occupancy_segment d
        WHERE d.plate = ANY($1::text[]) AND d.started_at BETWEEN $2 AND $3
          AND EXISTS (SELECT 1 FROM occupancy_segment o
                       WHERE o.plate = d.plate
                         AND o.started_at < d.started_at
                         AND coalesce(o.ended_at, o.started_at) >= coalesce(d.ended_at, d.started_at))`,
      [plates, from, to]);
    await client.query('COMMIT');
    return swept?.rowCount ?? swept?.affectedRows ?? 0;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
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
  const plates = Object.keys(byPlate);
  const superseded = await writeWindow(out, { from, to, plates });
  const tally = out.reduce((a, s) => (a[s.verdict] = (a[s.verdict] || 0) + 1, a), {});
  log.info('reconcile', 'done', {
    segments: out.length, ...tally,
    plates: plates.length, superseded,
    unavailable: unavailable.join(',') || 'none',
    clock_skew_min: Math.round(medianLag),
  });
  return { segments: out.length, ...tally };
}
