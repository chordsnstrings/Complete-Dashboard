/* The days a reader looks at most had no fare, and the reason was ours.
   ─────────────────────────────────────────────────────────────────────────
   Every channel except Uber prices a booking on the trip row, the same day:
   measured on production 2026-09-04, Bolt and the hotel desk priced to that
   morning and Yango to the 2nd, while not one of the 400 newest Uber rows
   carried a price. Uber's fares come from a second report on a weekly grid,
   and pullTripFares walked closedWeeks() alone — so the week that began Monday
   31 August, holding 3,252 Uber bookings against 3,321 in the week before it,
   could not be priced until it closed on Sunday. A Monday trip waited seven
   days.

   The reason closedWeeks exists is real and is recorded in
   test/earner_horizon.test.mjs: an open week's chunk ENDS on the coming
   Sunday, and Uber refuses a range whose end is in the future — "endDate is
   too late", measured on production on every mid-week run. That is a refusal
   of a FUTURE date and not of a part week; pullTrips asks for windows ending
   today every half hour and Uber answers them.

   So the running week is asked for as Monday-to-`to`. This file holds down the
   properties that makes correct. The week LIST is now exported and asserted
   behaviourally in uber_fares_interleaved.test.mjs; what is checked here is
   the part of the walk that still cannot be called — every step of it is a
   report that costs minutes at Uber — so it is checked on the source.

   The behavioural half of the same rule, the one a fixture CAN reach, is the
   week arithmetic in src/util.js, which is asserted first. */
import { readFileSync } from 'node:fs';
import { closedWeeks, weekChunks, iso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Friday 4 September 2026, 09:00 UTC. The week began Monday the 31st and ends
   Sunday the 6th, so exactly one week the range touches is still running. */
const NOW = new Date('2026-09-04T09:00:00Z');
const FROM = new Date('2026-08-05T00:00:00Z');

console.log('\nthe week arithmetic this rests on');

const all = [...weekChunks(FROM, NOW)];
const closed = [...closedWeeks(FROM, NOW, NOW)];
check('weekChunks reaches the running week and closedWeeks does not',
  all.length === closed.length + 1, `${all.length} vs ${closed.length}`);

const done = new Set(closed.map((w) => +w.start));
const running = all.filter((w) => !done.has(+w.start));
check('and the one it drops is the week that contains today',
  running.length === 1 && iso(running[0].start) === '2026-08-31',
  JSON.stringify(running.map((w) => [iso(w.start), iso(w.end)])));

/* THE reason it was dropped, and the thing the clamp fixes. */
check('whose own end is in the FUTURE — which is what Uber refuses',
  running[0].end > NOW, `${iso(running[0].end)} against today ${iso(NOW)}`);

const end = new Date(NOW);
const clamped = running.map((w) => ({ ...w, end: w.end > end ? end : w.end }));
check('clamped to the window, it becomes an ordinary past range',
  clamped[0].end <= NOW && iso(clamped[0].end) === '2026-09-04',
  `${iso(clamped[0].start)}..${iso(clamped[0].end)}`);
check('…and the clamp leaves a CLOSED week alone',
  closed.every((w) => (w.end > end ? end : w.end).getTime() === w.end.getTime()),
  'a closed week already ends in the past and must not be shortened');

console.log('\nwhat the fare walk does with it');

/* fareWeeks, fareTasks, collectFareWeek and pullTripFaresAcross, which is
   every line of the fare walk and nothing else. */
const src = readFileSync('src/sources/uber.js', 'utf8');
const fn = src.slice(src.indexOf('export function fareWeeks('),
  src.indexOf('async function pullTrips('));
check('the fare walk is the part of this file being read',
  fn.length > 500 && /PAYMENTS_REPORT/.test(fn), `${fn.length} chars`);

check('it reaches the running week rather than only the closed ones',
  /weekChunks\(from, to\)/.test(fn),
  'closedWeeks alone leaves the current week unpriced until Sunday');
check('…clamped to the window rather than to the coming Sunday',
  /end: w\.end > end \? end : w\.end/.test(fn),
  'an unclamped chunk ends in the future and Uber answers "endDate is too late"');
check('…and asked FIRST, because it is the only week whose data does not exist yet',
  /return \[\.\.\.running, \.\.\.closed\.map/.test(fn),
  'a closed week missed tonight is already collected; this one is not');

/* The three that stop it doing harm. */
check('a running week is never skipped by a checkpoint',
  /if \(!isOpen && checkpoint\?\.has\(key\)\)/.test(fn),
  'it is not finished, so a previous pass must not stand in for this one');
check('…and never marked done',
  /if \(!isOpen && \(!chunk\.error \|\| chunk\.expected\)\) await checkpoint\?\.mark/.test(fn),
  'marking a part-week answer done would freeze it for the life of the job');
check('a throttle on it continues rather than abandoning the closed weeks',
  /if \(throttled && !isOpen\) \{\s*state\.stopped = true;/.test(fn),
  'the speculative ask must not cost the weeks that are actually collectable');
/* And the chunk is recorded before the break. `break` from inside the catch
   skipped the push at the foot of the loop, so a fares pass refused outright
   recorded nothing and the run reported itself ok — an operator saw a healthy
   Uber run with no fares in it and no reason given. */
check('…and a throttle that DOES stop the pass is still recorded as a chunk',
  /state\.stopped = true; state\.chunks\.push\(chunk\); return chunk;/.test(fn),
  'stopping without pushing makes a refused fares pass invisible on /api/status');
/* And it stops that FLEET rather than the walk: the two orgs hold separate
   supplier sessions, so a cap reached asking as one is not evidence about the
   other. Before the walk was interleaved there was nothing to distinguish. */
check('…and it stops that fleet rather than every fleet',
  !/\bbreak;/.test(fn) && /st\.stopped\) continue;/.test(fn),
  'a break here would abandon the other fleet\u2019s remaining weeks too');

console.log('\nand the week boundary is the fleet’s, not UTC’s');

/* w.end is a UTC midnight, so `w.end < now` called the week closed from
   Sunday 00:00 UTC — 04:00 Sunday in Dubai, twenty hours early. */
const WEEK = [new Date('2026-08-31'), new Date('2026-09-06')];   // one whole week
const onSunday = [...closedWeeks(...WEEK, new Date('2026-09-06T02:00:00Z'))];   // 06:00 Dubai
const onMonday = [...closedWeeks(...WEEK, new Date('2026-09-07T02:00:00Z'))];
check('a week is still running at 06:00 Dubai on its own Sunday',
  onSunday.length === 0,
  `closedWeeks yielded ${onSunday.length}; at Sunday 00:00 UTC it is 04:00 in Dubai`);
check('…and is closed by 06:00 Dubai on the Monday',
  onMonday.length === 1 && iso(onMonday[0].end) === '2026-09-06',
  JSON.stringify(onMonday.map((w) => [iso(w.start), iso(w.end)])));
check('and a refusal of it is classified expected, not a hole',
  /const expected = isOpen \|\|/.test(fn),
  'a week Uber has not settled is an answer, not a failed collection');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
