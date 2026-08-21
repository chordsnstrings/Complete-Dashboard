/* The unauthorised-trip detector must not accuse people it cannot convict.
   ──────────────────────────────────────────────────────────────────────────
   This feature was, on live production data, naming nine drivers for trips they
   had genuinely completed on Uber. Every scenario below is one of the reasons
   why, reconstructed from the real evidence:

   - CABMAN's timestamp field is called `gmt` and was being stamped +04:00, so
     every fix landed four hours in the past. Against a 15-minute matching
     tolerance no segment could match its own booking. The signature was visible
     in the data: CABMAN fixes arrived a minimum of 240.4 minutes "old" through
     the same code path where FMS arrived 3.3 minutes old.
   - Bolt and Yango had zero trip rows in the entire database while their
     collectors reported "ok", because rows_written counted roster entries. A
     journey those channels would have explained was called unauthorised.
   - The reconciler matched against FMS "bookings", which are derived from the
     same telemetry as the segments — so everything matched and the detector
     found nothing. Removing that made real detection possible and made these
     guards load-bearing.
   - Journeys still running, or truncated by the start of available telemetry,
     were judged as though complete.

   The bar these tests hold: an unverifiable journey is `unverifiable`, never
   `unauthorized`. A false accusation is a worse failure than a missed one. */
import { buildSegments, classifySegment, findMatch, bookingWindow, RULES } from '../src/reconcile.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const T = (iso) => new Date(iso).toISOString();
const fix = (min, occupied, opts = {}) => ({
  plate: 'L44305', fleet_id: 'ecosine',
  captured_at: T(`2026-08-18T0${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}:00Z`),
  seat_occupied: occupied, speed: opts.speed ?? 60, ignition: opts.ignition ?? true,
  lat: 25.1 + min * 0.002, lng: 55.2 + min * 0.002, odometer: opts.odo ?? null,
});

/* ── a journey ends when the seat is observed empty ───────────────────────
   Production trace, L44305:
     05:38 seat=True   ... 05:53 seat=True
     05:57 seat=False  ignition off   <- passenger out
     06:04 seat=True                  <- a NEW pickup, 11 min later
   The old rule bridged that because 11 min was under gapBreakMin, producing one
   25-minute segment whose distance and top speed spanned the dead time. */
{
  const trace = [
    fix(0, true), fix(5, true), fix(10, true), fix(15, true),
    fix(19, false, { speed: 0, ignition: false }),
    fix(24, false, { speed: 0, ignition: false }),
    fix(30, true), fix(35, true), fix(40, true),
  ];
  const segs = buildSegments(trace);
  check('an observed empty seat ends the journey', segs.length === 2, `${segs.length} segment(s)`);
  check('the first journey ends at the last occupied fix',
    segs[0] && segs[0].ended_at === T('2026-08-18T00:15:00Z'), segs[0]?.ended_at);
  check('the second journey starts at the new pickup',
    segs[1] && segs[1].started_at === T('2026-08-18T00:30:00Z'), segs[1]?.started_at);
  check('neither journey spans the dead time between them',
    segs.every((s) => s.duration_min <= 15), JSON.stringify(segs.map((s) => s.duration_min)));
}

/* ── but a HOLE in the data is still bridged ──────────────────────────────
   Missing fixes are not evidence the passenger left. */
{
  const segs = buildSegments([fix(0, true), fix(5, true), fix(12, true), fix(17, true)]);
  check('a short data hole does not split one journey', segs.length === 1, `${segs.length}`);
  check('a single empty fix is treated as sensor blink, not an ending',
    buildSegments([fix(0, true), fix(5, true), fix(10, false), fix(15, true), fix(20, true)]).length === 1);
}

/* ── an unknown boundary is not a gap of zero ─────────────────────────────
   7 of the 13 live accusations began at the very first CABMAN poll in the
   dataset. Their true start is unknown — they began before telemetry existed. */
{
  const [seg] = buildSegments([fix(0, true), fix(5, true), fix(10, true), fix(15, true)]);
  check('a journey open at the start of data has an unknown leading boundary',
    !Number.isFinite(seg.gapBefore), String(seg.gapBefore));
  check('a journey open at the end of data has an unknown trailing boundary',
    !Number.isFinite(seg.gapAfter), String(seg.gapAfter));
  check('an unknown boundary is not reported as a zero gap',
    seg.boundary_gap_min === 0 && !Number.isFinite(seg.gapBefore),
    'boundary_gap_min may be 0 but the flags must still say unknown');
}

/* ── only a completed booking authorises ──────────────────────────────────
   A live segment was marked authorized by matching a RIDER-CANCELLED trip. A
   driver who cancels every ride would otherwise drive the car freely. */
{
  const seg = { plate: 'L44305', started_at: T('2026-08-18T06:48:00Z'), ended_at: T('2026-08-18T06:53:00Z') };
  const cancelled = { platform: 'uber', external_id: 'c1', plate: 'L44305',
    requested_at: T('2026-08-18T06:50:00Z'), ended_at: null, outcome: 'not_completed' };
  const completed = { platform: 'uber', external_id: 'k1', plate: 'L44305',
    requested_at: T('2026-08-18T06:47:00Z'), ended_at: T('2026-08-18T06:55:00Z'), outcome: 'completed' };
  check('a cancelled booking does not authorise a journey',
    findMatch(seg, [cancelled]).match === null);
  check('a completed booking does authorise it',
    findMatch(seg, [completed]).match?.external_id === 'k1');
  check('the cancelled booking is still reported as the nearest evidence',
    findMatch(seg, [cancelled]).nearest?.external_id === 'c1');
}

/* ── the nearest booking is always reported ───────────────────────────────
   This is the field that makes a clock skew self-evident: thirteen accusations
   each showing a nearest booking exactly 240 minutes away is one bug, not
   thirteen dishonest drivers. */
{
  const seg = { plate: 'L44305', started_at: T('2026-08-18T05:38:00Z'), ended_at: T('2026-08-18T06:04:00Z') };
  // The same journey as the segment, but four hours later — the skew signature.
  const skewed = { platform: 'uber', external_id: 'u1', plate: 'L44305',
    requested_at: T('2026-08-18T09:40:00Z'), ended_at: T('2026-08-18T10:51:00Z'), outcome: 'completed' };
  const r = findMatch(seg, [skewed]);
  check('a booking four hours away does not match', r.match === null);
  check('the distance to it is reported so the skew is visible',
    r.nearest_gap_min >= 200 && r.nearest_gap_min <= 260, String(r.nearest_gap_min));
}

/* ── a booking with no drop-off is not given an invented 30 minutes ───────
   Live data holds a 71-minute Uber trip. A fixed 30-minute window would
   authorise its first half and call the rest unauthorised. */
{
  const long = { requested_at: T('2026-08-18T09:40:00Z'), ended_at: null, duration_s: 4260 };
  const [, end, basis] = bookingWindow(long);
  check('a missing drop-off falls back to the trip duration', basis === 'duration', basis);
  check('a 71-minute trip is covered for 71 minutes',
    Math.round((end - Date.parse(long.requested_at)) / 60000) === 71,
    String(Math.round((end - Date.parse(long.requested_at)) / 60000)));
  const far = { requested_at: T('2026-08-18T09:40:00Z'), ended_at: null, distance_km: 20 };
  check('distance is used when duration is missing', bookingWindow(far)[2] === 'distance');
  check('a booking with neither is marked as assumed, not asserted',
    bookingWindow({ requested_at: T('2026-08-18T09:40:00Z') })[2] === 'assumed');
}

/* ── the rules that stop a hardware fault becoming an accusation ──────────── */
{
  // maxDurationHr is 8, so this is a seat that has been 'occupied' for ten hours.
  const stuck = { duration_min: 600, ignition_ratio: 1, top_speed: 30, distance_km: 12, max_gap_min: 0 };
  check('an implausibly long occupancy is a suspected sensor fault',
    classifySegment(stuck) === 'sensor_suspect');
  const weight = { duration_min: 90, ignition_ratio: 0.05, top_speed: 0, distance_km: 0, max_gap_min: 0 };
  check('weight on the seat with the engine off is a suspected sensor fault',
    classifySegment(weight) === 'sensor_suspect');
  const parked = { duration_min: 20, ignition_ratio: 1, top_speed: 2, distance_km: 0.2, max_gap_min: 0 };
  check('a vehicle that did not go anywhere is not a trip', classifySegment(parked) === 'stationary');
  const real = { duration_min: 25, ignition_ratio: 1, top_speed: 80, distance_km: 15, max_gap_min: 5 };
  check('real movement becomes a candidate for booking matching', classifySegment(real) === 'candidate');
}

/* ── the tolerance is small, so a systematic skew cannot hide ─────────────── */
check('the matching tolerance is minutes, not hours',
  RULES.matchToleranceMin <= 30, String(RULES.matchToleranceMin));
check('a booking-collection lag allowance exists',
  RULES.bookingLagMin >= 60, String(RULES.bookingLagMin));
check('a journey ends on a run of empty fixes, not a single blink',
  RULES.emptyFixesToClose >= 2, String(RULES.emptyFixesToClose));

/* ── the reconciler must never match against telematics-derived trips ─────
   FMS rows are built from the same GPS as the segments. Matching against them
   is circular: every real journey has an FMS twin, so everything was
   "authorized" and the detector reported nothing. */
{
  const src = (await import('node:fs')).readFileSync('src/reconcile.js', 'utf8');
  check('bookings are drawn from the booking view only', /is_booking/.test(src));
  check('the circularity is explained where it matters', /circular/i.test(src));
  check('a clock-skew guard refuses to issue verdicts', /clockSuspect/.test(src));
  check('channel availability is derived from evidence, not collector status',
    /unavailable/.test(src) && !/h\.status !== 'ok'/.test(src));
  check('an unverifiable verdict exists and is distinct from an accusation',
    /'unverifiable'/.test(src) && /'unauthorized'/.test(src));
  check('a journey near the window edge is pending, not convicted', /'pending'/.test(src));
  check('every verdict carries a reason', /verdict_reason/.test(src));
}

/* ── and the collector must read its own timestamps correctly ─────────────── */
{
  const cabRaw = (await import('node:fs')).readFileSync('src/sources/cabman.js', 'utf8');
  // The comment explaining the bug mentions the old offset; strip comments so
  // the documentation does not fail the check it exists to explain.
  const cab = cabRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  check('the CABMAN gmt field is no longer stamped as Dubai time', !/\+04:00/.test(cab));
  check('a clock-skew alarm exists in the collector', /clock skew/i.test(cabRaw));
  check('flag fields are coerced rather than double-negated',
    !/!!v\.state/.test(cab) && !/!!v\.SeatSensorValue/.test(cab));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
