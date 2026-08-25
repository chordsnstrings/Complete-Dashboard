/* ── the Unauthorized-trips page could never have found anything ───────────
   Live, over thirty days: 149 authorized, 232 partial, 61 stationary, 41
   unverifiable, and exactly ZERO unauthorized — on the page whose entire
   subject is unauthorized trips. That zero reads as "no leakage". It was not.
   The verdict was unreachable, and it was unreachable twice over.

   1. THE CHANNEL GUARD. A journey may only be called unauthorized if every
      booking channel has been consulted, so `unavailable` — channels that
      reported nothing in this window — blocks the verdict. It was computed
      against a hardcoded ['uber','yango','bolt','hotel'], and this fleet has
      never had a single bolt booking. So 'bolt' was permanently unavailable,
      the guard fired on every segment, and the branch below it never ran.

   2. THE CLOCK GUARD. Telemetry whose clock disagrees with wall time cannot be
      matched against bookings, so a skewed feed refuses to judge. It measured
      `now - captured_at` — which is how OLD a fix is, and every fix in a
      thirty-day window is days old by construction. The median came out around
      a fortnight, sailed past the sixty-minute threshold, and the other half
      of the test ("the window ends near now") is true of every window ending
      today.

   Both are plausible expressions measuring the wrong thing, and both fail the
   same way: an empty page rather than an error. Neither was testable in place
   — reconcile() needs a database — so they are pure functions now, and these
   assertions are what would have caught either one. */
import { blockingChannels, clockSkewMin } from '../src/reconcile.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe channel guard: only a channel this fleet uses can block a verdict');

/* The live shape: uber and hotel and yango have produced bookings; bolt never
   has; fms is telematics and is not a booking channel at all. */
const EVER = ['uber', 'hotel', 'yango', 'fms'];

check('a channel that produced bookings in the window does not block',
  blockingChannels(EVER, new Set(['uber', 'hotel', 'yango'])).length === 0,
  JSON.stringify(blockingChannels(EVER, new Set(['uber', 'hotel', 'yango']))));

check('a channel this fleet has NEVER booked on cannot block — bolt is not in '
  + 'the ever-seen set, so it is not a channel here',
  !blockingChannels(EVER, new Set(['uber', 'hotel', 'yango'])).includes('bolt'));

check('a channel that HAS produced bookings but none in this window still '
  + 'blocks — that is the case this guard was written for',
  blockingChannels(EVER, new Set(['uber', 'hotel'])).includes('yango'),
  JSON.stringify(blockingChannels(EVER, new Set(['uber', 'hotel']))));

check('fms never blocks: it is the telematics feed, not a booking channel, and '
  + 'it is the source of the journeys being judged',
  !blockingChannels(EVER, new Set(['uber'])).includes('fms'),
  JSON.stringify(blockingChannels(EVER, new Set(['uber']))));

check('a fleet with no bookings anywhere blocks on everything it has ever used',
  blockingChannels(EVER, new Set()).sort().join(',') === 'hotel,uber,yango');

check('an array works as well as a Set, so a caller cannot get it subtly wrong',
  blockingChannels(EVER, ['uber', 'hotel', 'yango']).length === 0);
check('and neither argument being present is not a crash',
  blockingChannels(null, null).length === 0);

console.log('\nthe clock guard: skew between the device and us, not the age of the data');

const at = (iso) => new Date(iso).toISOString();
/* A month-old fix whose device clock agreed with ours when we polled it. Under
   the old test this was a fortnight of "lag" and condemned the whole window. */
const old = Array.from({ length: 9 }, (_, i) => ({
  captured_at: at(`2026-07-${String(10 + i).padStart(2, '0')}T08:00:00Z`),
  polled_at: at(`2026-07-${String(10 + i).padStart(2, '0')}T08:02:00Z`),
}));
check('a fix from last month with a healthy clock reads as two minutes, not a '
  + 'fortnight', clockSkewMin(old) === 2, String(clockSkewMin(old)));
check('so a thirty-day window is judgeable', clockSkewMin(old) <= 60);

/* The failure this guard exists for: CABMAN four hours behind. */
const skewed = Array.from({ length: 9 }, (_, i) => ({
  captured_at: at(`2026-08-${String(10 + i).padStart(2, '0')}T04:00:00Z`),
  polled_at: at(`2026-08-${String(10 + i).padStart(2, '0')}T08:00:00Z`),
}));
check('a tracker four hours behind is still caught — 240 minutes of skew',
  clockSkewMin(skewed) === 240, String(clockSkewMin(skewed)));
check('and it is over the threshold, so verdicts are refused',
  clockSkewMin(skewed) > 60);

console.log('\nthe clock guard: what it must survive');

check('a row with no polled_at is left out rather than counted as zero',
  clockSkewMin([{ captured_at: at('2026-08-01T00:00:00Z') },
    ...skewed]) === 240, String(clockSkewMin([{ captured_at: at('2026-08-01T00:00:00Z') }, ...skewed])));
check('no fixes at all is zero skew, not NaN', clockSkewMin([]) === 0);
check('and neither is undefined', clockSkewMin(undefined) === 0);
check('the MEDIAN, not the worst — one tracker with a broken clock must not '
  + 'stop the whole fleet being judged',
  clockSkewMin([...old, { captured_at: at('2026-08-01T00:00:00Z'),
    polled_at: at('2026-08-01T20:00:00Z') }]) <= 60);

console.log('\nno hardcoded channel list survives in the detector');

const { readFileSync } = await import('node:fs');
const src = readFileSync('src/reconcile.js', 'utf8');
check('the four-channel literal is gone from the verdict path',
  !/\['uber',\s*'yango',\s*'bolt',\s*'hotel'\]/.test(src));
check('and what the row reports as checked is what the verdict was reached '
  + 'against, rather than a list written by hand',
  /channels_checked: configured\.filter/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
