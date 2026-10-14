/* A cancelled booking is a moment, not a ride.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-10-14: "a lot of trips show bolt trips as 0 minute away
   which means it's not unauthorized, it's bolt trip". Measured that day over
   the newest 300 unbooked journeys: 17 said "0 min away", and 16 of those
   bookings were ones the channel reports CANCELLED — no end time, and for Bolt
   ride_duration 0 and fare_finalised 0. bookingWindow() gave each an invented
   ride (≈2 min a km, up to three hours), and that invented ride is what touched
   the journey. Held here, on synthetic rows shaped like the production one:

     · a cancelled booking's window is its request instant, so its distance is
       how far the REQUEST was from the journey;
     · a completed booking without an end keeps the generous estimate — the
       side that protects a driver from a false accusation;
     · no verdict moves: a cancelled booking never authorized anything, and
       still does not; both matchers agree;
     · the reason says what the booking was and who cancelled it, and never
       uses the clock guard's "min behind". */
import { bookingWindow, findMatch, findMatchIndexed, indexBookings, withWindows, judgeSegment, nearestWords } from '../src/reconcile.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const seg = { plate: 'TST9', fleet_id: 'ecosine', started_at: '2026-10-14T07:30:44Z', ended_at: '2026-10-14T07:55:07Z',
  gapBefore: 30, gapAfter: 30 };
const cancelledBolt = { platform: 'bolt', external_id: 'b-1', plate: 'TST9', requested_at: '2026-10-14T07:19:12Z',
  ended_at: null, distance_km: 8.6, outcome: 'not_completed', status: 'driver_cancelled_after_accept' };
const longCancel = { platform: 'bolt', external_id: 'b-2', plate: 'TST9', requested_at: '2026-10-14T06:20:00Z',
  ended_at: null, distance_km: 120, outcome: 'not_completed', status: 'client_cancelled' };
const completedNoEnd = { platform: 'uber', external_id: 'u-1', plate: 'TST9', requested_at: '2026-10-14T07:10:00Z',
  ended_at: null, distance_km: 8.6, outcome: 'completed', status: 'completed' };

console.log('\nthe window');
{
  const w = bookingWindow(cancelledBolt);
  check('a cancelled booking with no end is its request instant', w[0] === w[1] && w[2] === 'cancelled', JSON.stringify(w));
  const c = bookingWindow(completedNoEnd);
  check('a completed booking with no end keeps the generous distance estimate', c[2] === 'distance' && c[1] - c[0] === 8.6 * 2 * 60000, JSON.stringify(c));
}

console.log('\nthe nearest booking, and what it says');
{
  const f = findMatch(seg, [cancelledBolt]);
  check('the order cancelled at 11:19 is 12 min before an 11:30 journey — not "0 min away"', f.match === null && f.nearest_gap_min === 12, JSON.stringify(f.nearest_gap_min));
  const g = findMatch(seg, [longCancel]);
  check('a 120 km order cancelled 71 min before is 71 min away, not stretched over the journey', g.nearest_gap_min === 71, String(g.nearest_gap_min));
  const ctx = { bookingsByPlate: new Map([['TST9', [cancelledBolt]]]), unavailable: [], configured: ['uber', 'bolt'],
    judgeBefore: Date.parse('2026-10-15T00:00:00Z'), clockSuspect: false, uncollected: new Map() };
  const j = judgeSegment(seg, 'candidate', ctx);
  check('the verdict does not move: a cancelled booking authorizes nothing', j.verdict === 'unauthorized', j.verdict);
  check('…and the reason says the booking never ran, who cancelled it, and when it was requested',
    /nearest is a bolt booking that never ran — the driver cancelled after accepting it; requested 12 min before the journey began/.test(j.reason), j.reason);
  check('…never the clock guard’s phrase', !/min behind/.test(j.reason), j.reason);
  const k = judgeSegment(seg, 'candidate', { ...ctx, bookingsByPlate: new Map([['TST9', [{ ...completedNoEnd, requested_at: '2026-10-14T05:00:00Z' }]]]) });
  check('a completed booking nearby keeps the old shape: "a uber trip N min away"', /nearest is a uber trip \d+ min away$/.test(k.reason), k.reason);
  check('an unknown cancellation status is said as such, not guessed',
    /it did not complete \(status weird_state\)/.test(nearestWords({ ...cancelledBolt, status: 'weird_state' }, 5, seg)));
  check('Yango’s bare "cancelled" does not name a canceller',
    /the channel does not say by whom/.test(nearestWords({ ...cancelledBolt, platform: 'yango', status: 'cancelled' }, 5, seg)));
}

console.log('\nthe indexed matcher agrees');
{
  const all = withWindows([cancelledBolt, longCancel, completedNoEnd].map((b) => ({ ...b })));
  const idx = indexBookings(new Map([['TST9', all]])).get('TST9');
  let same = true;
  for (let m = -300; m <= 300; m += 7) {
    const s = { ...seg, started_at: new Date(Date.parse(seg.started_at) + m * 60000).toISOString(),
      ended_at: new Date(Date.parse(seg.ended_at) + m * 60000).toISOString() };
    const a = findMatch(s, all); const b = findMatchIndexed(s, idx);
    if (a.match !== b.match || a.nearest !== b.nearest || a.nearest_gap_min !== b.nearest_gap_min) { same = false; break; }
  }
  check('findMatchIndexed gives findMatch’s answer with point windows, at every offset', same);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
