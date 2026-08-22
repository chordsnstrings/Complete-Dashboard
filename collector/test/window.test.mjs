/* ── the request window ────────────────────────────────────────────────────
   Three copies of this helper lived in server.js, driver_routes.js and
   vehicle_routes.js, and a fourth in the test harness. All four read `from`
   and `to`, and only those.

   The URL a person actually sees says something else. The hash router carries
   `?days=30`, and the front end turns it into from/to before every fetch — so
   `days` never reached the server, and asking the API directly for
   `/api/vehicle/kpis?plate=L40965&days=30` was not rejected, not defaulted,
   but silently answered with every trip that vehicle has ever taken: 2,440
   trips and 316 "days worked", inside a thirty-day window. That one is caught
   by anyone who knows a month has thirty days. The same silence over revenue
   or utilisation would just look like a big number, and nobody would check.

   These pin the semantics in one place, so the four copies cannot drift apart
   again. */
import { win, winDays, daysWindow, dubaiDay } from '../api/window.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const req = (query) => ({ query });

// Fixed instant so these never depend on the clock: 2026-08-22 06:00 UTC,
// which is 10:00 the same day in Dubai.
const NOW = Date.parse('2026-08-22T06:00:00Z');

console.log('\nwindow: ?days= is honoured, not ignored');

check('days=30 is thirty calendar days ending today, not all of history',
  JSON.stringify(winDays(req({ days: '30' }), NOW)) === '["2026-07-24","2026-08-22"]');
check('days=1 is today alone',
  JSON.stringify(winDays(req({ days: '1' }), NOW)) === '["2026-08-22","2026-08-22"]');
check('days=7 spans seven distinct days, not eight',
  JSON.stringify(winDays(req({ days: '7' }), NOW)) === '["2026-08-16","2026-08-22"]');

/* The window the front end computes for the same number has to be the window
   the server computes, or a shared link and a hand-built API call disagree
   about what "last 30 days" means. */
check('and it matches what the front end computes for the same number',
  winDays(req({ days: '30' }), NOW)[0] === dubaiDay(new Date(NOW - 29 * 864e5)));

console.log('\nwindow: Dubai days, not the server\'s UTC ones');

/* 21:00 UTC is already the 23rd in Dubai. A UTC-derived "today" drops the
   shift in progress — on the one page an operator opens late at night to see
   what is happening now. */
const LATE = Date.parse('2026-08-22T21:00:00Z');
check('late evening UTC is already tomorrow in Dubai',
  winDays(req({ days: '1' }), LATE)[1] === '2026-08-23');
check('and the window start moves with it',
  winDays(req({ days: '7' }), LATE)[0] === '2026-08-17');

console.log('\nwindow: from/to still win, and are still widened');

check('an explicit from/to overrides days rather than being merged with it',
  JSON.stringify(winDays(req({ from: '2026-01-01', to: '2026-01-31', days: '7' }), NOW))
    === '["2026-01-01","2026-01-31"]');
/* A bare date binds as midnight, so an un-widened upper bound drops everything
   that happened on the window's last day — the day people most often look at. */
check('a date-only `to` is widened to the end of that day for timestamp queries',
  win(req({ from: '2026-01-01', to: '2026-01-31' }), NOW)[1] === '2026-01-31 23:59:59.999');
check('and winDays leaves it a plain date, for the queries that compare against local_day',
  winDays(req({ from: '2026-01-01', to: '2026-01-31' }), NOW)[1] === '2026-01-31');
check('an inverted range is read as a typo, not as an empty set',
  JSON.stringify(winDays(req({ from: '2026-01-31', to: '2026-01-01' }), NOW))
    === '["2026-01-01","2026-01-31"]');
check('one bound alone still leaves the other open',
  JSON.stringify(winDays(req({ from: '2026-01-01' }), NOW)) === '["2026-01-01","2100-01-01"]');

console.log('\nwindow: a duplicated parameter is not a missing one');

/* Express turns ?from=A&from=B into ['A','B'], and a value this helper rejects
   falls through to the open window — every trip ever collected, under a
   thirty-day label. Found by an audit check whose own URL had appended the
   window twice: it reported 167,168 trips for the first 28 days of August and
   looked, for a moment, like a serious data bug. */
check('a duplicated from/to takes the first value rather than falling back to all time',
  JSON.stringify(winDays(req({ from: ['2026-08-01', '2026-07-23'], to: ['2026-08-28', '2026-08-22'] }), NOW))
    === '["2026-08-01","2026-08-28"]');
check('a duplicated days does too',
  JSON.stringify(winDays(req({ days: ['7', '90'] }), NOW))
    === JSON.stringify(winDays(req({ days: '7' }), NOW)));
check('a duplicated day does too',
  JSON.stringify(winDays(req({ day: ['2026-08-14', '2026-01-01'] }), NOW))
    === '["2026-08-14","2026-08-14"]');
check('and a duplicated but invalid value is still refused',
  JSON.stringify(winDays(req({ from: ['nope', '2026-08-01'] }), NOW)) === '["2000-01-01","2100-01-01"]');

console.log('\nwindow: a single day is a day');

/* Several routes already take `day` by that name — /api/day, /api/map/journey.
   /api/track did not, and answered a request for one day with every fix it has
   ever held: the same trap `days` had, one letter apart, on the endpoint right
   beside one where the parameter works. */
check('day=2026-08-14 is that day and no other',
  JSON.stringify(winDays(req({ day: '2026-08-14' }), NOW)) === '["2026-08-14","2026-08-14"]');
check('and as a timestamp window it covers that whole day',
  JSON.stringify(win(req({ day: '2026-08-14' }), NOW))
    === '["2026-08-14","2026-08-14 23:59:59.999"]');
check('an explicit from/to still wins over it',
  JSON.stringify(winDays(req({ day: '2026-08-14', from: '2026-01-01', to: '2026-01-31' }), NOW))
    === '["2026-01-01","2026-01-31"]');
check('and it wins over days, being the more specific of the two',
  JSON.stringify(winDays(req({ day: '2026-08-14', days: '30' }), NOW))
    === '["2026-08-14","2026-08-14"]');
check('a malformed day is ignored rather than passed into SQL',
  JSON.stringify(winDays(req({ day: '2026-13-45' }), NOW)) === '["2000-01-01","2100-01-01"]');

console.log('\nwindow: nonsense is ignored, never invented');

/* A caller who asks for something unparseable gets the default window. The
   failure that must not happen is a silently invented one — the reason this
   file exists. */
for (const bad of ['abc', '0', '-5', '3.5', '', null, undefined, '99999', 'Infinity', '1e3']) {
  check(`days=${JSON.stringify(bad)} falls back to the open window rather than a made-up one`,
    JSON.stringify(winDays(req({ days: bad }), NOW)) === '["2000-01-01","2100-01-01"]');
}
check('no query at all is the open window',
  JSON.stringify(winDays(req({}), NOW)) === '["2000-01-01","2100-01-01"]');
// A route can be called with no query object at all in a test or an internal call.
check('a missing query object does not throw',
  JSON.stringify(winDays({}, NOW)) === '["2000-01-01","2100-01-01"]');
check('a malformed from is ignored rather than passed into SQL',
  JSON.stringify(winDays(req({ from: '2026-13-45' }), NOW)) === '["2000-01-01","2100-01-01"]');
check('and a from that is not a date at all is too',
  JSON.stringify(winDays(req({ from: "2026-01-01'; DROP TABLE trip;--" }), NOW))
    === '["2000-01-01","2100-01-01"]');
// The largest window the UI offers is a year; the cap is well past that and
// exists only so `days=999999999` cannot walk the date off the calendar.
check('an absurd days value is refused rather than clamped to something arbitrary',
  JSON.stringify(winDays(req({ days: '3661' }), NOW)) === '["2000-01-01","2100-01-01"]');
check('but a year, which the UI does offer, is accepted',
  winDays(req({ days: '365' }), NOW)[0] === '2025-08-23');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
