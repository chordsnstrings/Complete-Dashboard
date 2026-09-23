// Unauthorized-trip detection.
// Builds "occupancy segments" from two seat-sensor providers, then matches each against bookings
// from every revenue channel (hotel/uber/yango/bolt). Segments with real movement and no matching
// booking are revenue leakage. See docs/unauthorized-trips.md for the model and the hardware-failure
// handling this implements.
//
// THREE SOURCES OF SEGMENTS, since the operator's rulings of 2026-09-23 ("FMS and CABMAN is two
// separate providers … add FMS as well"; FMS's Seat Count counts passengers, 1 or more is aboard):
//   cabman    CABMAN DT's seat pad, 5-minute fixes — built by buildSegments, unchanged.
//   fms_live  FMS's live Seatcount (telemetry_snapshot.seat_count, schema_v84), occupied when >= 1,
//             built through the same buildSegments/classifySegment path.
//   fms_trip  each FMS journey (trip.seat_count >= 1, GetTripPassenger) is itself a segment,
//             classified by classifyJourney() on what a journey carries.
// FMS is only ever what is JUDGED, never what AUTHORIZES: bookings are read through is_booking,
// which is false for FMS (sql/schema_v18.sql), and blockingChannels/channels_checked exclude it.
// Each source is written by its own writeWindow() call scoped to (source, plate), so one provider
// can never delete another's segments (sql/schema_v85.sql puts `source` in the key).
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

/* ── FMS's live seat count, as occupied/empty ──────────────────────────────
   Ruling 2 (2026-09-23): FMS's Seat Count counts PASSENGERS, so a count of 1
   or more means somebody was aboard and 0 means nobody was. That is the whole
   translation, and it is made HERE, in memory, on the way into the same
   buildSegments()/classifySegment() path CABMAN's fixes take. It is never
   written back: telemetry_snapshot.seat_occupied stays CABMAN's pressure-pad
   reading and nothing that reads it changes meaning.

   A fix with no seat count is not a fix with an empty seat. The query that
   feeds this reads only rows where seat_count IS NOT NULL, and this refuses
   anything else again, so an absent reading can never close or open a ride.

   THE THRESHOLDS, AND WHY NONE OF THEM MOVES FOR FMS. The poller asks FMS
   every two minutes, but a row is keyed on FMS's own tracktime
   (UNIQUE (source, plate, captured_at)), and FMS advances that about every
   six minutes. Measured on production 2026-09-23 over ten FMS plates and
   three days: 4,422 gaps between stored fixes, median 6.2 min; 884 gaps
   while moving, median 6.1 min, p90 6.6 min, 22 over 10 min and 11 over 15.
   So the stored FMS live series is a ~6-minute series, not a 2-minute one —
   within a minute of CABMAN's five — and every rule reads the same way on it:
     bridgeGapMin 10       bridges a gap of one CABMAN poll-pair; on FMS one
                           dropped fix (~12 min) splits a ride instead of
                           bridging it. 11 of 884 moving gaps are in (10, 15]
                           minutes. Both halves are still judged, and the
                           fms_trip segment of the same ride is unaffected.
     gapBreakMin 15        a hole of two dropped FMS fixes marks 'partial',
                           as two dropped CABMAN fixes nearly do.
     emptyFixesToClose 2   two consecutive zero counts, ~12 minutes of an
                           empty seat, against ~10 on CABMAN.
     minDurationMin, minDistanceKm, minTopSpeed, maxDurationHr: stated in
                           minutes, km and km/h, not in polls — unaffected.
   The seat COUNT has been collected only since 2026-09-23, so there is less
   than a day of it to test the rules against. Nothing is adjusted: the data
   does not show that anything must be, and the operator asked for a change
   only where it does. What each stored row carries is the count from the
   LAST poll that saw that tracktime — up to three polls overwrite one row —
   so a count that changed between two FMS fixes shows the later value. */
export function fmsLiveFixes(rows) {
  return (rows || [])
    .filter((f) => f && f.seat_count != null && Number.isFinite(Number(f.seat_count)))
    .map((f) => ({ ...f, seat_occupied: Number(f.seat_count) >= 1 }));
}

/* ── FMS journeys, each one a segment ──────────────────────────────────────
   An FMS journey (GetTripPassenger, trip.platform = 'fms') is the tracker's
   own record of one trip: start, end, distance and a Seat Count. Ruling 2
   makes a Seat Count of 1 or more a journey with passengers aboard, so each
   such journey IS an occupancy segment — nothing is built from samples.

   ONE RIDE, TWO FMS RECORDS — MEASURED 2026-09-23, AND WHY A GROUP OF
   OVERLAPPING JOURNEYS IS ONE SEGMENT. The collector keys an FMS journey on
   plate|start (src/sources/fms.js fmsTripRows), and FMS files a PROVISIONAL
   record of a journey within minutes of it — a whole-number distance and a
   start a few minutes late — then re-files the same ride hours later with its
   true start and a decimal distance. Both keys are kept, so both rows stay.
   Measured on production:
     - onset: 0 overlapping journeys on any day to 2026-08-20; from
       2026-08-21, the day live collection began, about a third of each day's
       records overlap another on the same car (151 of 457 that day, 365 of
       955 on 2026-09-22), and the day's whole-km records track that count
       almost exactly (147, 366). The 200 journeys of 2026-09-23 read so far
       are all whole-km: their finals have not arrived yet.
     - in windows before 2026-08-21: 1 overlapping pair in 2,110 journeys. A
       car's distinct FMS journeys do not overlap.
     - of 2,058 overlapping pairs over 2026-09-14..21, 2,032 are one whole-km
       record against one decimal record, 26 are two whole-km records, and
       NONE is two decimal records — including the 57 pairs that overlap by
       under half of the shorter journey.
     - of 79 pairs checked record by record, the record first stored LATER is
       the decimal one in 74 (whole-km in 0), starts earlier in 64 and is
       longer in 59; first seen a median 13.6 hours after the provisional one.
   Turning every row into a segment would count those rides twice in FMS's own
   figures and list them twice. So journeys on one plate that overlap in time
   are one ride, and its segment is built from the record FMS filed LAST —
   the latest first-stored (trip.ingested_at, which an upsert does not move),
   then the longer, then the longer distance. The others stay in `trip`,
   untouched; they are simply not a second ride.

   A group can straddle the window's left edge — the final record starting
   just before `from`, the provisional just after it — so the caller loads a
   day of margin before `from` and this emits only segments whose
   representative STARTS inside the window. A representative before `from`
   belongs to the pass that covered that time; and any row this window holds
   for a member is deleted by writeWindow() and not written back.

   Every field a journey carries is the provider's; every field it does not
   carry is NULL rather than invented: no fixes, no gap, no ignition ratio, no
   top speed. `gapBefore`/`gapAfter` are 0 because a journey is a complete
   record — its ends are FMS's, not the edge of what we happened to poll. */
export function journeySegments(journeys, { from = null, to = null } = {}) {
  const t = (x) => (x == null ? NaN : new Date(x).getTime());
  const lo = from == null ? -Infinity : t(from);
  const hi = to == null ? Infinity : t(to);
  const byPlate = new Map();
  for (const j of journeys || []) {
    if (!j || !j.plate || !(Number(j.seat_count) >= 1) || !Number.isFinite(t(j.requested_at))) continue;
    if (!byPlate.has(j.plate)) byPlate.set(j.plate, []);
    byPlate.get(j.plate).push(j);
  }
  const end = (j) => (Number.isFinite(t(j.ended_at)) ? t(j.ended_at) : t(j.requested_at));
  const later = (a, b) => {           // true when a is the better representative
    const ia = t(a.ingested_at), ib = t(b.ingested_at);
    if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia > ib;
    const la = end(a) - t(a.requested_at), lb = end(b) - t(b.requested_at);
    if (la !== lb) return la > lb;
    const da = Number(a.distance_km) || 0, db = Number(b.distance_km) || 0;
    if (da !== db) return da > db;
    return t(a.requested_at) > t(b.requested_at);
  };
  const segs = [];
  for (const list of byPlate.values()) {
    list.sort((a, b) => t(a.requested_at) - t(b.requested_at) || end(a) - end(b));
    let group = [], reach = -Infinity;
    const flush = () => {
      if (!group.length) return;
      const rep = group.reduce((best, j) => (later(j, best) ? j : best));
      const s0 = t(rep.requested_at);
      if (s0 >= lo && s0 <= hi) segs.push(journeySegment(rep, group.length - 1));
      group = [];
    };
    for (const j of list) {
      // Overlap, strictly: a journey starting at the instant another ends is the next ride.
      if (group.length && t(j.requested_at) < reach) group.push(j);
      else { flush(); group = [j]; reach = -Infinity; }
      reach = Math.max(reach, end(j));
    }
    flush();
  }
  return segs;
}

/* One FMS journey as a segment summary, in the shape summarize() returns. */
function journeySegment(j, superseded = 0) {
  const s0 = new Date(j.requested_at).getTime();
  const s1 = j.ended_at == null ? NaN : new Date(j.ended_at).getTime();
  const d = j.distance_km == null ? NaN : Number(j.distance_km);
  return {
    plate: j.plate, fleet_id: j.fleet_id,
    started_at: new Date(s0).toISOString(),
    ended_at: Number.isFinite(s1) ? new Date(s1).toISOString() : null,
    duration_min: Number.isFinite(s1) ? Math.round((s1 - s0) / 60000) : null,
    distance_km: Number.isFinite(d) ? +d.toFixed(2) : null,
    top_speed: null, fixes: null, max_gap_min: null, ignition_ratio: null, boundary_gap_min: null,
    gapBefore: 0, gapAfter: 0,
    start_lat: j.pickup_lat ?? null, start_lng: j.pickup_lng ?? null,
    end_lat: j.dropoff_lat ?? null, end_lng: j.dropoff_lng ?? null,
    passengers: Number(j.seat_count),
    superseded,
  };
}

/* Classify an FMS journey with what a journey carries: its duration and its
   distance. The same thresholds as classifySegment(), read against the
   journey's own figures:

     - longer than maxDurationHr (8 h) → sensor_suspect. The same eight-hour
       rule: one trip with a passenger aboard for longer than that is not
       physically plausible, and is treated as a fault, not a journey.
     - movement → stationary: shorter than minDurationMin, or covering less
       than minDistanceKm, or never shown to reach minTopSpeed. A journey
       carries no top speed; it carries a distance and a duration, and their
       ratio is its AVERAGE speed, which is a floor on the top speed. A
       journey that averaged 5 km/h certainly reached 5 km/h; one that did not
       carries no evidence it ever moved faster than walking pace, which is
       exactly what the top-speed rule refuses to call a trip. Measured over
       3,000 production journeys: 91 averaged under 5 km/h, 84 of them over
       1 km and 5 minutes.
     - 'partial' DOES NOT APPLY. It marks a segment whose telemetry has a hole
       inside it, so its extent is unknown. A journey is a complete record —
       its start and end are FMS's own, not the edge of what we polled — so it
       has no hole to have.
     - the ignition-off stuck-pad rule does not apply either: a journey
       carries no ignition samples to take a ratio of.

   What cannot be measured is not guessed. A journey FMS filed with no end
   time has no duration, and one with no distance — or one of 500 km or more,
   the has_distance bound sql/schema_v18.sql already applies to every trip
   distance — has none that can be used. Neither passes a movement rule and
   neither may be called stationary, which would be a reason that is not the
   true one; they are `unverifiable`, with the reason stated. Measured over
   3,000 production journeys: 0 without an end time, 0 without a distance,
   0 at 500 km or more. */
export function classifyJourney(s, rulesArg) {
  const rules = (rulesArg && typeof rulesArg === 'object') ? { ...RULES, ...rulesArg } : RULES;
  if (s.duration_min == null) return 'unverifiable';
  if (s.duration_min > rules.maxDurationHr * 60) return 'sensor_suspect';
  if (s.distance_km == null || s.distance_km < 0 || s.distance_km >= 500) return 'unverifiable';
  if (s.duration_min < rules.minDurationMin) return 'stationary';
  if (s.distance_km < rules.minDistanceKm) return 'stationary';
  const avgKmh = s.duration_min > 0 ? s.distance_km / (s.duration_min / 60) : Infinity;
  if (avgKmh < rules.minTopSpeed) return 'stationary';
  return 'candidate';
}

/* Why a journey could not be classified, when classifyJourney() said so
   before any booking was compared. */
export function journeyUnverifiableReason(s) {
  if (s.duration_min == null) return 'FMS filed this journey with no end time, so its duration cannot be measured';
  return 'FMS filed this journey with no usable distance, so whether it moved cannot be measured';
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

/* A booking's window, computed once per pass rather than once per segment.
   bookingWindow() is pure, so a window stored on the booking row by
   reconcile() (withWindows below) is exactly the one this would compute —
   the answer cannot change, only the cost. Measured on a synthetic twelve
   months at production volume (about 1,600 FMS journeys and 3,300 bookings
   per car): parsing every booking's two timestamps again for every segment
   was hundreds of millions of Date constructions in one synchronous loop,
   which would hold the collector's event loop — and with it the two-minute
   FMS poll and the five-minute CABMAN poll — for the whole weekly pass. */
const windowOf = (b) => b._window || bookingWindow(b);
export const withWindows = (bookings) => {
  for (const b of bookings) b._window = bookingWindow(b);
  return bookings;
};

export function findMatch(seg, bookings, rules = RULES) {
  const tol = rules.matchToleranceMin * 60000;
  const s0 = new Date(seg.started_at).getTime();
  const s1 = new Date(seg.ended_at).getTime();
  const mine = bookings.filter((b) => b.plate === seg.plate);

  const completed = mine.filter((b) => b.outcome === 'completed' || b.outcome == null);
  const overlap = completed.find((b) => {
    const [b0, b1] = windowOf(b);
    return b0 <= s1 + tol && b1 >= s0 - tol;
  }) || null;

  // The nearest booking regardless of outcome, with how far away it is. This is
  // the evidence that makes a verdict falsifiable — a systematic clock skew
  // shows up immediately as every segment's nearest booking sitting the same
  // number of minutes away.
  let nearest = null, nearestMin = null;
  for (const b of mine) {
    const [b0, b1] = windowOf(b);
    const gap = b1 < s0 ? (s0 - b1) : b0 > s1 ? (b0 - s1) : 0;
    if (nearestMin === null || gap < nearestMin) { nearestMin = gap; nearest = b; }
  }
  return { match: overlap, nearest, nearest_gap_min: nearestMin == null ? null : Math.round(nearestMin / 60000) };
}

/* findMatch(), answered from an index — the SAME answer, in a fraction of
   the work. ───────────────────────────────────────────────────────────────
   WHY IT EXISTS. findMatch() scans every booking on the plate for every
   segment. With FMS journeys that is ~1,600 segments against ~2,000–3,300
   bookings per car over a weekly backfill's twelve months, and it runs as one
   synchronous loop. Measured on a synthetic twelve months at production volume
   (130,722 journeys, 261,384 bookings, 130 cars): about 338 s with windows
   parsed per segment, still 106 s with them parsed once — five minutes and then
   nearly two in which the collector's event loop, and with it the two-minute
   FMS poll and the five-minute CABMAN poll, does nothing else.

   WHY THE ANSWER CANNOT CHANGE. Per plate the bookings are kept in their
   original order (`idx`) and also sorted by window start, with the plate's
   longest window (`maxDur`). Every booking a segment could OVERLAP, with the
   tolerance, starts in [s0 − tol − maxDur, s1 + tol]; findMatch() takes the
   first of those in original order, and so does this. For the NEAREST, any
   booking whose gap is no larger than a gap G already found starts in
   [s0 − maxDur − G, s1 + G]; scanning that whole range and keeping the
   smallest gap, then the smallest original position on a tie, is exactly
   findMatch()'s `gap < nearestMin` walk in original order. A plate with any
   window that is not a finite number, or that ends before it starts (which
   would break the bound above), falls back to findMatch() itself.
   test/occupancy_sources.test.mjs holds the two equal over thousands of
   random segments and bookings of every window shape, outcome and tie. */
export function indexBookings(bookingsByPlate) {
  const out = new Map();
  for (const [plate, list] of bookingsByPlate) {
    const rows = list.map((b, idx) => { const [b0, b1] = windowOf(b); return { b, b0, b1, idx }; });
    const finite = rows.every((r) => Number.isFinite(r.b0) && Number.isFinite(r.b1) && r.b1 >= r.b0);
    rows.sort((x, y) => x.b0 - y.b0 || x.idx - y.idx);
    const maxDur = rows.reduce((a, r) => Math.max(a, r.b1 - r.b0), 0);
    out.set(plate, { list, rows, maxDur, finite });
  }
  return out;
}
const firstAtOrAfter = (rows, t) => {           // first index with b0 >= t
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].b0 < t) lo = mid + 1; else hi = mid; }
  return lo;
};
export function findMatchIndexed(seg, plateIndex, rules = RULES) {
  if (!plateIndex) return { match: null, nearest: null, nearest_gap_min: null };
  const tol = rules.matchToleranceMin * 60000;
  const s0 = new Date(seg.started_at).getTime();
  const s1 = new Date(seg.ended_at).getTime();
  if (!plateIndex.finite || !Number.isFinite(s0) || !Number.isFinite(s1)) {
    return findMatch(seg, plateIndex.list, rules);
  }
  const { rows, maxDur } = plateIndex;
  if (!rows.length) return { match: null, nearest: null, nearest_gap_min: null };
  // Overlap: the first COMPLETED booking in original order whose window meets
  // the segment's, with the tolerance.
  let match = null;
  for (let i = firstAtOrAfter(rows, s0 - tol - maxDur); i < rows.length && rows[i].b0 <= s1 + tol; i++) {
    const r = rows[i];
    if (!(r.b.outcome === 'completed' || r.b.outcome == null)) continue;
    if (r.b0 <= s1 + tol && r.b1 >= s0 - tol && (!match || r.idx < match.idx)) match = r;
  }
  // Nearest: a first bound from the bookings either side of the segment's
  // start, then every booking that could be as near, scanned in full.
  const gapOf = (r) => (r.b1 < s0 ? (s0 - r.b1) : r.b0 > s1 ? (r.b0 - s1) : 0);
  const k = firstAtOrAfter(rows, s0);
  let G = Infinity;
  for (const i of [k - 1, k, k + 1]) if (i >= 0 && i < rows.length) G = Math.min(G, gapOf(rows[i]));
  let best = null, bestGap = null;
  for (let i = firstAtOrAfter(rows, s0 - maxDur - G); i < rows.length && rows[i].b0 <= s1 + G; i++) {
    const r = rows[i]; const g = gapOf(r);
    if (bestGap === null || g < bestGap || (g === bestGap && r.idx < best.idx)) { bestGap = g; best = r; }
  }
  return { match: match ? match.b : null, nearest: best ? best.b : null,
    nearest_gap_min: bestGap == null ? null : Math.round(bestGap / 60000) };
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
/* An FMS journey reaches two of those verdicts for reasons of its own, and
   the sentence has to be the true one: its "seat reading" is a Seat Count on
   a journey FMS filed, and it is stationary on the journey's own distance and
   average speed rather than on sampled fixes. */
const JOURNEY_REASON = {
  stationary: 'the journey FMS filed is too short, too near or too slow on average to be a trip',
  sensor_suspect: 'FMS filed this as one journey of more than eight hours with passengers aboard, which is '
    + 'not physically plausible — treated as a fault, not a journey',
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
   empty, which on this page reads as a fleet with nothing to answer for.

   PER PROVIDER — (source, plate), never plate alone. There are three sources
   of segments now (sql/schema_v85.sql), and two cars (L44251, L45243) carry
   both a CABMAN and an FMS tracker; from 2026-09-23 every FMS car carries two
   FMS sources. Scoped by plate alone, the FMS pass would delete the CABMAN
   rows it had not re-derived, and the sweep would call a short CABMAN segment
   a "fragment" of a longer FMS journey and remove it. Ruling 4 (2026-09-23):
   keep BOTH providers' segments, each with its own source and timestamps. So
   the DELETE, the ON CONFLICT key and the sweep all carry the source, and a
   provider can only ever retract what that same provider just re-derived.
   test/occupancy_sources.test.mjs puts two providers on one plate and proves
   neither pass removes the other's rows.

   `sweep` is off for FMS journeys. The containment sweep exists because a
   window that opens mid-ride re-derives only the tail of a ride built from
   samples. A journey is not built from samples — it is FMS's own record, read
   whole or not at all — and overlapping journeys are already resolved into
   one segment before they get here (journeySegments()), so there is no
   fragment for the sweep to find, and one that ever did appear would be a
   record FMS filed, which is not this function's to discard. */
async function writeWindow(out, { from, to, plates, source, sweep = true }) {
  const KEY = ['source', 'plate', 'started_at'];
  if (!plates.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM occupancy_segment
        WHERE source = $4 AND plate = ANY($1::text[]) AND started_at BETWEEN $2 AND $3`,
      [plates, from, to, source]);

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
    // swallow the rows around it. Same provider only — see the header.
    const swept = sweep ? await client.query(
      `DELETE FROM occupancy_segment d
        WHERE d.source = $4 AND d.plate = ANY($1::text[]) AND d.started_at BETWEEN $2 AND $3
          AND EXISTS (SELECT 1 FROM occupancy_segment o
                       WHERE o.source = d.source
                         AND o.plate = d.plate
                         AND o.started_at < d.started_at
                         AND coalesce(o.ended_at, o.started_at) >= coalesce(d.ended_at, d.started_at))`,
      [plates, from, to, source]) : null;
    await client.query('COMMIT');
    return swept?.rowCount ?? swept?.affectedRows ?? 0;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

/* The FMS tracker's clock against ours, as clockSkewMin() measures CABMAN's —
   the median of polled_at − captured_at, ignoring fixes more than an hour in
   the future — but computed in SQL over every FMS fix in the window, because
   it only needs one number and the weekly backfill's window holds a few
   hundred thousand FMS fixes. It is the clock BOTH FMS sources are stamped
   in: a live fix and a journey's start and end all come from the same
   provider, so a skew here makes an FMS journey miss its booking exactly as
   it would a live segment. The element picked is the same one clockSkewMin()
   picks (index floor(n/2) of the sorted list), so the two rules cannot
   disagree about what "median" means. */
async function fmsClockSkewMin(from, to) {
  const { rows } = await pool.query(
    `WITH l AS (
       SELECT extract(epoch FROM (polled_at - captured_at)) / 60.0 AS lag
         FROM telemetry_snapshot
        WHERE source = 'fms' AND captured_at BETWEEN $1 AND $2 AND polled_at IS NOT NULL),
     f AS (SELECT lag FROM l WHERE lag > -60)
     SELECT lag::float8 AS lag FROM f ORDER BY lag
     OFFSET (SELECT count(*) / 2 FROM f) LIMIT 1`, [from, to]);
  return rows.length ? Number(rows[0].lag) : 0;
}

/* The verdict of one segment, from whichever provider, against the bookings.
   ─────────────────────────────────────────────────────────────────────────
   Lifted out of reconcile() unchanged so that all three sources are judged by
   ONE copy of the rules — a second copy for FMS would be two definitions of
   "unauthorized" that drift. Matching is exactly what it always was:
   findMatch() over this plate's bookings, ±matchToleranceMin, completed only;
   then the clock guard, the booking-lag guard, the edge-of-telemetry guard
   and the unreadable-channel guard, in that order. The bookings arrive
   indexed by plate and by time (indexBookings/findMatchIndexed above), which
   changes nothing about the answer — the index returns exactly what
   findMatch() returns — and everything about the cost: one weekly backfill
   now judges ~130,000 FMS journeys, and scanning every booking on the car once
   per segment held the event loop for minutes.

   `classify` is the verdict before any booking was compared, from
   classifySegment() or classifyJourney(); `ctx` carries what the window
   established — the bookings, the channel sets, and THIS provider's clock. */
export function judgeSegment(seg, classify, ctx) {
  let verdict = classify;
  let found = { match: null, nearest: null, nearest_gap_min: null };
  let reason = null;
  if (verdict === 'candidate') {
    found = ctx.bookingIndex
      ? findMatchIndexed(seg, ctx.bookingIndex.get(seg.plate), ctx.rules || RULES)
      : findMatch(seg, ctx.bookingsByPlate.get(seg.plate) || [], ctx.rules || RULES);
    if (found.match) {
      verdict = 'authorized';
      reason = `matched ${found.match.platform} trip ${found.match.external_id}`;
    } else if (ctx.clockSuspect) {
      verdict = 'unverifiable';
      reason = `telemetry clock is ${Math.round(ctx.medianLag)} min behind wall time — bookings cannot be matched reliably`;
    } else if (new Date(seg.ended_at).getTime() > ctx.judgeBefore) {
      verdict = 'pending';
      reason = `journey ended within ${RULES.bookingLagMin} min of the window edge; platform bookings may not have arrived yet`;
    } else if (!Number.isFinite(seg.gapBefore) || !Number.isFinite(seg.gapAfter)) {
      verdict = 'unverifiable';
      reason = 'the journey runs past the edge of available telemetry, so its true extent is unknown';
    } else if (ctx.unavailable.length) {
      verdict = 'unverifiable';
      reason = `no bookings collected from ${ctx.unavailable.join(', ')} in this window, so a booking there cannot be ruled out`;
    } else {
      verdict = 'unauthorized';
      reason = found.nearest
        ? `no completed booking overlaps; nearest is a ${found.nearest.platform} trip ${found.nearest_gap_min} min away`
        : `no booking of any kind on this plate in the window, across ${ctx.configured.join(', ') || 'no channels'}`;
    }
  }
  return { verdict, reason, found };
}

/* One row of occupancy_segment, from a judged segment of any source. */
function segmentRow(seg, source, { verdict, reason, found }, { configured, inWindow, unavailable }) {
  // Every verdict carries a reason, including the three that never reach
  // the branch above. They were being written with a NULL reason, which is
  // indistinguishable from "issued before this code existed" — and the v8
  // retraction used exactly that test to decide what to delete.
  if (!reason && source === 'fms_trip') {
    reason = verdict === 'unverifiable' ? journeyUnverifiableReason(seg) : JOURNEY_REASON[verdict];
  }
  if (!reason) reason = NON_CANDIDATE_REASON[verdict]
    || `classified ${verdict} from telemetry alone; no booking match was attempted`;
  return {
    source,
    plate: seg.plate, fleet_id: seg.fleet_id,
    started_at: seg.started_at, ended_at: seg.ended_at,
    duration_min: seg.duration_min, distance_km: seg.distance_km,
    top_speed: seg.top_speed, fixes: seg.fixes, max_gap_min: seg.max_gap_min,
    ignition_ratio: seg.ignition_ratio == null ? null : +seg.ignition_ratio.toFixed(2),
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
       accuses a named driver of taking a car out unbooked.

       NULL on an FMS journey, which has no sampled boundary: its ends are
       the provider's own record, not the edge of what we polled. */
    boundary_gap_min: seg.boundary_gap_min,
    start_lat: seg.start_lat, start_lng: seg.start_lng, end_lat: seg.end_lat, end_lng: seg.end_lng,
    passengers: seg.passengers ?? null,
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
  };
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

  /* FMS's live seat count: only fixes that carry one. A fix FMS sent with no
     count says nothing about the seat and must not read as an empty one.
     Bounded by the window exactly as CABMAN's are. */
  const { rows: fmsRows } = await pool.query(
    `SELECT plate, fleet_id, captured_at, polled_at, seat_count, speed, ignition, lat, lng, odometer
     FROM telemetry_snapshot
     WHERE source='fms' AND seat_count IS NOT NULL AND captured_at BETWEEN $1 AND $2
     ORDER BY plate, captured_at`, [from, to]);
  const fmsFixes = fmsLiveFixes(fmsRows);

  /* FMS journeys with passengers aboard. A day of margin before `from` so
     that a ride whose FMS records straddle the window's left edge is grouped
     whole — see journeySegments(); only segments that START inside the window
     are written. Bounded above by `to`. trip_platform_requested_idx
     (platform, requested_at) serves it. */
  const { rows: journeys } = await pool.query(
    `SELECT plate, fleet_id, external_id, requested_at, ended_at, distance_km, seat_count,
            pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, ingested_at
     FROM trip
     WHERE platform = 'fms' AND seat_count >= 1 AND plate IS NOT NULL AND plate <> ''
       AND requested_at BETWEEN $1 AND $2
     ORDER BY plate, requested_at`,
    [new Date(new Date(from).getTime() - 24 * 3600e3), to]);

  if (!fixes.length && !fmsFixes.length && !journeys.length) {
    log.info('reconcile', 'no seat-sensor evidence in window from CABMAN or FMS');
    return { segments: 0 };
  }

  /* Bookings only. The FMS feed is DERIVED FROM THE SAME TELEMETRY as these
     segments, so matching a movement segment against an FMS "booking" is
     circular — every real journey has an FMS row, so everything matched and the
     detector reported nothing. It is the whole reason this feature exists, and
     it was switched off by a platform list. Now that FMS is also a source of
     segments, the same line is what keeps it from authorizing ITSELF: an FMS
     journey judged against an FMS "booking" would match on every row. */
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
  /* The one read here that is NOT bounded by the window, deliberately and as
     before: it answers "has this channel EVER produced a booking", which is
     what separates a channel that is down from one this fleet does not use.
     Asked once per pass, not once per provider. */
  const { rows: ever } = await pool.query(
    `SELECT platform, count(*)::int n FROM trip_norm WHERE is_booking GROUP BY platform`);
  const inWindow = new Set(seen.map((r) => r.platform));
  const configured = ever.filter((r) => r.n > 0).map((r) => r.platform);
  // A channel we have never seen at all is not configured; one we have seen but
  // that produced nothing here is unavailable for this window.
  // See blockingChannels() above for why this is not a hardcoded list.
  const unavailable = blockingChannels(configured, inWindow);

  const bookingsByPlate = new Map();
  for (const b of withWindows(bookings)) {
    if (!bookingsByPlate.has(b.plate)) bookingsByPlate.set(b.plate, []);
    bookingsByPlate.get(b.plate).push(b);
  }

  /* Telemetry whose clock disagrees with wall time cannot be compared against
     bookings at all. A 4-hour skew in the CABMAN feed once made every segment
     miss its own booking by 240 minutes against a 15-minute tolerance, and the
     dashboard named nine drivers for trips they had genuinely run. Refuse to
     judge rather than accuse. Measured PER PROVIDER: one provider's clock says
     nothing about the other's, and a skewed CABMAN must not stop FMS being
     judged, nor the reverse. */
  // See clockSkewMin() above: the gap between the device's clock and ours,
  // not the age of the data.
  const clockOf = (medianLag, provider) => {
    const clockSuspect = medianLag > 60;
    if (clockSuspect) {
      log.error('reconcile', `${provider} telemetry clock looks skewed — refusing to issue verdicts`, {
        median_lag_min: Math.round(medianLag),
      });
    }
    return { medianLag, clockSuspect };
  };
  const cabmanClock = clockOf(fixes.length ? clockSkewMin(fixes) : 0, 'cabman');
  const fmsClock = clockOf((fmsFixes.length || journeys.length) ? await fmsClockSkewMin(from, to) : 0, 'fms');

  // A journey still in progress, or one whose booking has not been collected
  // yet, must not be judged. Platform trip exports lag.
  const judgeBefore = new Date(to).getTime() - RULES.bookingLagMin * 60000;
  const base = { bookingsByPlate, bookingIndex: indexBookings(bookingsByPlate),
    judgeBefore, unavailable, configured, inWindow };

  const bySource = {};
  let segmentsTotal = 0;
  const tally = {};
  const run = async (source, segs, classify, clock, { sweep = true, plates: platesArg = null } = {}) => {
    const ctx = { ...base, ...clock };
    const out = segs.map((seg) => segmentRow(seg, source, judgeSegment(seg, classify(seg), ctx), ctx));
    const plates = platesArg || [...new Set(segs.map((s) => s.plate))];
    const superseded = await writeWindow(out, { from, to, plates, source, sweep });
    const t = out.reduce((a, s) => (a[s.verdict] = (a[s.verdict] || 0) + 1, a), {});
    for (const [k, v] of Object.entries(t)) tally[k] = (tally[k] || 0) + v;
    bySource[source] = { segments: out.length, ...t, plates: plates.length, superseded,
      clock_skew_min: Math.round(clock.medianLag) };
    segmentsTotal += out.length;
  };

  /* CABMAN, exactly as before: fixes grouped by plate, buildSegments(),
     classifySegment(), and the DELETE scoped to the plates that reported. */
  if (fixes.length) {
    const byPlate = {};
    for (const f of fixes) (byPlate[f.plate] ||= []).push(f);
    const segs = Object.values(byPlate).flatMap((list) => buildSegments(list));
    await run('cabman', segs, (s) => classifySegment(s), cabmanClock, { plates: Object.keys(byPlate) });
  }
  /* FMS live, through the same path. The plates are the ones whose FMS live
     fixes carried a seat count in the window — a plate FMS reported no count
     for leaves no evidence here, and evidence we did not look at is not
     evidence we may retract. */
  if (fmsFixes.length) {
    const byPlate = {};
    for (const f of fmsFixes) (byPlate[f.plate] ||= []).push(f);
    const segs = Object.values(byPlate).flatMap((list) => buildSegments(list));
    await run('fms_live', segs, (s) => classifySegment(s), fmsClock, { plates: Object.keys(byPlate) });
  }
  /* FMS journeys, each one a segment. The plates for the DELETE are every
     plate with a journey in the loaded range, so a member of a group whose
     representative now starts before `from` still has its old in-window row
     retracted. */
  if (journeys.length) {
    const segs = journeySegments(journeys, { from, to });
    await run('fms_trip', segs, (s) => classifyJourney(s), fmsClock, {
      sweep: false, plates: [...new Set(journeys.map((j) => j.plate))] });
  }

  log.info('reconcile', 'done', {
    segments: segmentsTotal, ...tally,
    by_source: bySource,
    unavailable: unavailable.join(',') || 'none',
    clock_skew_min: { cabman: Math.round(cabmanClock.medianLag), fms: Math.round(fmsClock.medianLag) },
  });
  return { segments: segmentsTotal, ...tally, by_source: bySource };
}
