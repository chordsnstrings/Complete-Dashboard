/* "not_completed" CONTAINS "completed", and the driver's day believed it.
   ═══════════════════════════════════════════════════════════════════════════
   Reported from production: Hammad Ahmad Ahmad, 14 September. The page showed
   thirteen jobs, every one of them badged COMPLETED. Five were.

   The other eight — 00:12, 00:19, 00:21, 00:28, 00:32, 01:07, 01:08, 01:18 —
   are `status: rider_cancelled, outcome: not_completed`, carry no distance and
   no drop-off time, and Uber echoed the pick-up address into the drop-off
   column. api/public/driverday.js decided the badge with

       const done = /completed/i.test(t.outcome || '')

   and `/completed/i.test('not_completed')` is TRUE. So a driver's day claimed
   eight jobs that never happened, on the page whose heading is "every job, and
   the gaps between them", with a green pill on each.

   Why it survived a suite and an audit: two lines above in the same file, the
   ROW COLOUR is decided by `/not_completed|cancel/i` — which tests the
   negative first and is correct. The row was therefore styled as a
   cancellation and badged as a success at the same time, and neither of them
   looked broken on its own.

   The three assertions below are the three separate lies that one regex told:
   the badge, the drop-off, and the word. */
import { jobCompleted, outcomeWord } from '../api/public/driverday.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The production rows, copied from /api/driver/day for that driver and day. */
const CANCELLED = {
  external_id: '8adbad34-f98f-4889-a8be-eb60dc70f379',
  status: 'rider_cancelled', outcome: 'not_completed',
  distance_km: null, price: null, ended_at: null,
  pickup_addr: '68WX+X2P - Al Garhoud - Dubai - United Arab Emirates',
  dropoff_addr: '68WX+X2P - Al Garhoud - Dubai - United Arab Emirates',
};
const COMPLETED = {
  status: 'completed', outcome: 'completed', distance_km: 11.01,
  pickup_addr: 'Al Rowaiyah First - Academic City - Dubai - United Arab Emirates',
  dropoff_addr: 'Al Warqa 1 - Al Warqa - Dubai - United Arab Emirates',
};

console.log('\nthe badge');
check('a rider cancellation is NOT a completed job',
  jobCompleted(CANCELLED) === false, String(jobCompleted(CANCELLED)));
check('…and a completed job still is',
  jobCompleted(COMPLETED) === true, String(jobCompleted(COMPLETED)));
/* The exact expression that was wrong, asserted as a property rather than as a
   string, so any future rewrite that reintroduces a substring test fails. */
check('the predicate is not a substring test — "not_completed" must not pass',
  jobCompleted({ outcome: 'not_completed' }) === false);
check('…nor any other value ending in the word',
  jobCompleted({ outcome: 'never_completed' }) === false
  && jobCompleted({ outcome: 'un-completed' }) === false);
check('case and surrounding space do not change the answer',
  jobCompleted({ outcome: ' COMPLETED ' }) === true);
check('a missing outcome is not a completed job',
  jobCompleted({}) === false && jobCompleted({ outcome: null }) === false
  && jobCompleted(null) === false);

console.log('\nthe word the badge prints');
/* 'not_completed' is machine-speak AND the least informative thing on the row:
   it says a job did not happen without saying who stopped it. */
check('a cancellation names WHO cancelled, in plain English',
  outcomeWord(CANCELLED) === 'rider cancelled', outcomeWord(CANCELLED));
check('…rather than the raw token the page used to print',
  !/not_completed|_/.test(outcomeWord(CANCELLED)), outcomeWord(CANCELLED));
check('a driver cancellation is a different sentence from a rider one',
  outcomeWord({ status: 'driver_cancelled', outcome: 'not_completed' }) === 'driver cancelled');
/* A provider adding a value it has never sent before must not read "unknown". */
check('a word nobody has seen before is tidied, not mapped to "unknown"',
  outcomeWord({ status: 'RIDER_NO_SHOW', outcome: 'not_completed' }) === 'rider no show');
check('…and nothing at all says so rather than inventing an outcome',
  outcomeWord({}) === 'outcome not reported');

console.log('\nthe drop-off that was never a drop-off');
/* Uber echoes the pick-up into the drop-off column when the trip never ran.
   The page printed it under a DROP-OFF heading, which reads as a claim about
   where somebody was taken — on a row with no drop-off time and no distance. */
const echoed = (t) => jobCompleted(t) || (t.dropoff_addr && t.dropoff_addr !== t.pickup_addr);
check('a cancelled job whose drop-off echoes its pick-up shows no drop-off',
  !echoed(CANCELLED));
check('…while a real journey keeps both ends',
  !!echoed(COMPLETED));
/* Guard the other direction: a genuine round trip that COMPLETED must keep its
   drop-off even though the two addresses match. */
check('a completed round trip still shows its drop-off',
  !!echoed({ outcome: 'completed', pickup_addr: 'A', dropoff_addr: 'A' }));

/* And the page actually uses these — a predicate nothing calls proves nothing.
   Comments are stripped first: the note at the call site QUOTES the old regex
   in order to explain it, and a guard that cannot tell a warning from the
   thing it warns about fires on its own documentation. */
const src = (await import('node:fs')).readFileSync('api/public/driverday.js', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the page decides the badge with the predicate, not with a regex',
  /const done = jobCompleted\(t\)/.test(code) && !/\/completed\/i\.test/.test(code),
  (code.match(/.*completed\/i.*/) || [''])[0].slice(0, 80));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
