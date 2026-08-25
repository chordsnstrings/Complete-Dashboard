/* ── "the working window" was one colour, and the colour hid the day ───────
   The shift panel drew a single solid bar per day from the first trip to the
   last and captioned it "not paid hours, but the working window the trips
   describe". A span is not a working window. Eight trips spread across
   05:19–23:10 drew exactly the same bar as eight done back to back, and on
   this fleet that difference is most of the shift: measured live on six
   drivers for 25 August, the share of the span spent NOT carrying anyone ran
   from 51% to 92%.

   /api/driver/shift returns the day's jobs at their real positions so the page
   can draw what actually happened. These assertions pin the three things it
   must not get wrong, each of which would quietly overstate how hard somebody
   worked or how idle they were:

   1. A BOOKING WITH NO DROPOFF IS NOT IDLE TIME. Uber reports a dropoff on 86%
      of trips and none on the rest. Folding those into the gaps converts
      missing data into waiting that nobody can verify.
   2. A JOB THAT RUNS PAST MIDNIGHT MUST NOT BE DRAWN BACKWARDS. Minute-of-day
      wraps, so a 00:20 dropoff is minute 20 — before its own request.
   3. WAITING IS THE GAPS, and an overlapping dispatch is a real event on this
      fleet rather than dirty data, so it is counted and never allowed to make
      a wait negative. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const DRV = 'u-shift';
const DAY = '2026-08-20';
let n = 0;
/* Dubai local times, stated with the offset so the database does the
   conversion — the same way every source's payload arrives. */
const trip = (day, from, to, o = {}) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status)
   VALUES ($1,$2,'ecosine','L900',$3,'Shift Tester',$4,$5,8,'completed')`,
  [o.platform || 'uber', `s${n++}`, DRV, `${day}T${from}:00+04:00`,
    to == null ? null : `${o.endDay || day}T${to}:00+04:00`]);

/* 06:00–06:40, then a 50-minute gap, then 07:30–08:00. */
await trip(DAY, '06:00', '06:40');
await trip(DAY, '07:30', '08:00');
/* A booking whose dropoff the channel never sent. Placed AFTER the last known
   job so that, folded into the gaps, it would invent a wait. */
await trip(DAY, '09:00', null);
/* An overlapping dispatch: assigned before the previous job ended. */
await trip(DAY, '10:00', '11:00');
await trip(DAY, '10:40', '11:20');
/* And a job that runs past midnight into the next Dubai day. */
await trip(DAY, '23:40', '00:25', { endDay: '2026-08-21' });

const { server, get } = await mountAll(db, { serverRoutes: false });
const r = await get(`/api/driver/shift?id=${DRV}&days=365`);
check('the endpoint answers', r.status === 200, JSON.stringify(r.body).slice(0, 160));
const day = (r.body.days || []).find((d) => d.day === DAY) || {};

console.log('\nshift: minutes are Dubai minutes');
check('a 06:00 Dubai request is minute 360, not minute 120 from a UTC clock',
  (day.jobs || []).some((j) => j.s === 360), JSON.stringify((day.jobs || []).map((j) => j.s)));
check('every job on the day is returned, including the one with no dropoff',
  day.bookings === 6, String(day.bookings));

console.log('\nshift: a missing dropoff is not idleness');
const open = (day.jobs || []).find((j) => j.e === null);
check('the booking with no dropoff comes back with a null end, not a zero one',
  Boolean(open) && open.s === 540, JSON.stringify(open));
check('and is counted separately so the page can draw it as unknown',
  day.unknown_end === 1, String(day.unknown_end));
/* The gaps between the FOUR jobs that have an end: 06:40→07:30 is 50, and
   08:00→10:00 is 120. 11:00→10:40 is the overlap. 11:20→23:40 is 740.
   The 09:00 job with no dropoff contributes no gap of its own. */
check('waiting counts only the gaps between jobs that actually ended — 50 + 120 + 740',
  day.wait_min === 910, String(day.wait_min));
check('and the longest single gap is the one before the night job',
  day.longest_wait_min === 740, String(day.longest_wait_min));

console.log('\nshift: an overlap is counted, never clamped into a negative wait');
check('the dispatch that started before the previous dropoff is counted',
  day.overlaps === 1, String(day.overlaps));
check('and it does not push waiting below zero',
  day.wait_min >= 0);

console.log('\nshift: a job past midnight is clamped, not drawn backwards');
const night = (day.jobs || []).find((j) => j.s === 1420);
check('the 23:40 job is present at minute 1420',
  Boolean(night), JSON.stringify((day.jobs || []).map((j) => [j.s, j.e])));
check('its 00:25 dropoff is clamped to the end of the day rather than becoming minute 25',
  night && night.e === 1440, JSON.stringify(night));
check('and it is flagged, so the page can say the shift ran over',
  night && night.over === true);
check('the day therefore ends at midnight, not before it started',
  day.last_min === 1440 && day.last_min > day.first_min,
  JSON.stringify([day.first_min, day.last_min]));

console.log('\nshift: on-job time excludes what it cannot measure');
/* 40 + 30 + 60 + 40 + 20 = 190. The open-ended booking adds nothing. */
check('on-job minutes are summed over the jobs that report an end',
  day.on_job_min === 190, String(day.on_job_min));
check('the span is first request to last known dropoff',
  day.span_min === 1440 - 360, String(day.span_min));

console.log('\nshift: the page is told what it may not claim');
check('the response states, in words, that the ride cannot be separated from '
  + 'the approach — so no renderer invents a third band',
  /pickup time/i.test(r.body.basis || '') && /approach/i.test(r.body.basis || ''),
  r.body.basis);
check('and how many bookings across the window carry no dropoff at all',
  r.body.unknown_end === 1, String(r.body.unknown_end));

const none = await get('/api/driver/shift?id=nobody-at-all');
check('an unknown driver is a clean 404, not a 500',
  none.status === 404, JSON.stringify(none.body));

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
