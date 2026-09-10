/* ── the last ONLINE, and the four places that threw it away ───────────────
   Uber's driver timeline holds two status values and nothing else, ONLINE and
   OFFLINE, and it sends ONLINE as a repeated HEARTBEAT rather than as a
   transition — 132 rows for one driver in one day, 90,389 fleet-wide over
   thirty days. It also STOPS sending the heartbeat while a driver is on a job;
   job progress is a separate stream, kind='job', keyed by job_ext_id.

   A span is therefore ONLINE → the next status event, built with lead(). Four
   of the five places that built one then wrote `WHERE next_at IS NOT NULL`,
   which deletes the LAST ONLINE — the one whose successor has not arrived. And
   because the heartbeat stops when work starts, the deleted event is the one
   immediately before the work.

   Measured on production 2026-09-10: 60 of 89 drivers sat on a dangling
   ONLINE, 56 of them dated that day, and 7,518 minutes — 125 driver-hours —
   of availability disappeared from it. Driver
   369dd9c1-ae0a-4526-8d46-d91a8c217121 (Bashir Ahmad Amin):

     08:34:46 ONLINE   08:35:05 ONLINE   08:35:11 DJ_ASSIGNED
     09:11:55 DJ_COMPLETED
     09:59:15 ONLINE   ← last status event, no successor, DROPPED
     09:59:21 DJ_ASSIGNED   10:05:46 DJ_PICKUP

   He drove three Uber trips between 08:35 and 11:03. The day page drew him
   online 08:35→09:59 and printed "99% of online time", dividing job minutes
   taken from the WHOLE day into an 84-minute window that stopped before two of
   the three trips.

   api/online_routes.js:326 was the fifth place and already had it right: "A
   dangling ONLINE … still starts a span. Its start is a fact even when its end
   is not." api/online_span_sql.js is now that sentence, executable, and these
   assertions are what would have caught any of the four.

   Everything below is measured against a real database rather than by reading
   the SQL, because every one of these defects returns a plausible number. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshDriverDays } from '../src/rollup.js';
import { onlineShare } from '../api/public/driverday.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* Dates are derived from the clock rather than written down, because half of
   what is under test IS the clock: a dangling ONLINE is closed at the earlier
   of now() and the end of its own Dubai day, and a fixture pinned to a literal
   date would stop exercising the first of those the day after it was written. */
const dubaiDay = (ms) => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(ms));
const NOW = Date.now();
const PAST = dubaiDay(NOW - 7 * 86400000);
const NEXT = dubaiDay(NOW - 6 * 86400000);
const startOf = (day) => Date.parse(`${day}T00:00:00+04:00`);

let evn = 0;
const ev = (id, at, status) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber','ecosine',$1,$2::timestamptz,'status',$3,'')`, [id, at, status]);
const job = (id, at, state, jid) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state,
     job_ext_id)
   VALUES ('uber','ecosine',$1,$2::timestamptz,'job','',$3,$4)`, [id, at, state, jid]);
const trip = (id, name, from, to, o = {}) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, status, distance_km, price, currency)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6::timestamptz,$7::timestamptz,'completed',10,40,'AED')`,
  [o.platform || 'uber', `dg${evn++}`, o.plate || 'L900', id, name, from, to]);

/* ── the production shape, on a day that has finished ──────────────────── */
const D = (hhmmss) => `${PAST}T${hhmmss}+04:00`;
await ev('dang', D('08:34:46'), 'ONLINE');
await ev('dang', D('08:35:05'), 'ONLINE');
await job('dang', D('08:35:11'), 'DJ_ASSIGNED', 'j1');
await job('dang', D('09:11:55'), 'DJ_COMPLETED', 'j1');
await ev('dang', D('09:59:15'), 'ONLINE');            // the dangling one
await job('dang', D('09:59:21'), 'DJ_ASSIGNED', 'j2');
await job('dang', D('10:05:46'), 'DJ_PICKUP', 'j2');
await trip('dang', 'Dangling Driver', D('08:35:00'), D('09:12:00'));
await trip('dang', 'Dangling Driver', D('09:59:00'), D('10:44:00'));
await trip('dang', 'Dangling Driver', D('10:44:00'), D('11:03:00'));

/* ── an OFFLINE still closes a span ────────────────────────────────────── */
await ev('off', D('06:00:00'), 'ONLINE');
await ev('off', D('07:00:00'), 'OFFLINE');
await trip('off', 'Offline Driver', D('06:10:00'), D('06:40:00'), { plate: 'L901' });

/* ── a job with no heartbeat around it at all ──────────────────────────── */
await job('jobonly', D('12:00:00'), 'DJ_ASSIGNED', 'j3');
await job('jobonly', D('12:40:00'), 'DJ_COMPLETED', 'j3');
await trip('jobonly', 'Job Only', D('12:00:00'), D('12:40:00'), { plate: 'L902' });

/* ── a heartbeat span and the job it brackets: ONE interval, not two ───── */
await ev('both', D('09:00:00'), 'ONLINE');
await job('both', D('09:10:00'), 'DJ_ASSIGNED', 'j4');
await ev('both', D('09:30:00'), 'ONLINE');
await job('both', D('09:50:00'), 'DJ_COMPLETED', 'j4');
await ev('both', D('10:00:00'), 'OFFLINE');
await trip('both', 'Both Driver', D('09:10:00'), D('09:50:00'), { plate: 'L903' });

/* ── the same shape, still running, on whichever Dubai day now falls in ── */
const ANCHOR = NOW - 90 * 60000;
const LIVE_DAY = dubaiDay(ANCHOR);
const LIVE_END = Math.min(NOW, startOf(LIVE_DAY) + 86400000);
await ev('live', new Date(ANCHOR).toISOString(), 'ONLINE');
await trip('live', 'Live Driver', new Date(ANCHOR + 5 * 60000).toISOString(),
  new Date(ANCHOR + 35 * 60000).toISOString(), { plate: 'L904' });

/* The feed's own clock: one pass that finished at 10:17 Dubai on the finished
   day, which is what makes that day "still being collected" rather than over.
   status <> 'error', because a partial run did reach the day. */
await q(`INSERT INTO collection_run (source, fleet_id, mode, started_at, finished_at, status)
         VALUES ('uber_timeline','ecosine','incremental',$1::timestamptz,$1::timestamptz,'ok')`,
[D('10:17:00')]);

const { get, server } = await mountAll(db, { serverRoutes: false });
const day = async (id, d) => (await get(`/api/driver/day?id=${id}&day=${d}`)).body;
const mins = (rows) => rows.reduce((a, o) => a + Math.max(0, o.e - o.s), 0);

console.log('\nthe dangling ONLINE is kept, and closed at the end of the day it belongs to');
{
  const r = await day('dang', PAST);
  check('the day answers at all', r && Array.isArray(r.online), JSON.stringify(r).slice(0, 160));
  const on = r.online || [];
  /* Minute 515, not 514: the endpoint reports whole minutes of the Dubai day
     and 08:34:46 is nearer 08:35 than 08:34. */
  check('the driver is online from the first heartbeat', on.length && on[0].s === 515,
    JSON.stringify(on));
  /* The whole defect, in one number. 08:35 to 09:59 is 84 minutes; 08:35 to
     midnight is 925. The old query answered the first. */
  check('and the last ONLINE runs to the end of the day rather than being deleted',
    mins(on) === 1440 - 515, `${mins(on)} minutes: ${JSON.stringify(on)}`);
  check('it is one merged span, not one per heartbeat', on.length === 1, JSON.stringify(on));
  check('and it is marked open-ended, so a caller can tell it from a closed one',
    on[on.length - 1].open_ended === true, JSON.stringify(on));
  /* The measurement that made this worth fixing: his last two trips are inside
     the window now, and were outside it before. */
  const last = (r.trips || []).reduce((m, t) => Math.max(m, t.e ?? t.s), 0);
  check('every one of the day’s jobs now falls inside the online record',
    last <= on[on.length - 1].e, `last job ends ${last}, online ends ${on[on.length - 1].e}`);
}

console.log('\nan OFFLINE still closes a span');
{
  const on = (await day('off', PAST)).online || [];
  check('the span is the hour between the two events, not the rest of the day',
    mins(on) === 60, JSON.stringify(on));
  check('and it is not open-ended, because its closing event arrived',
    on.every((o) => o.open_ended === false), JSON.stringify(on));
}

console.log('\na job is proof of being online, even with no heartbeat anywhere near it');
{
  const on = (await day('jobonly', PAST)).online || [];
  /* Uber does not dispatch an offline driver, and it stops sending the
     heartbeat for the length of the booking — so the job stream is the only
     evidence that exists for exactly the stretches the status stream omits. */
  check('the job interval alone puts the driver online', mins(on) === 40, JSON.stringify(on));
  check('as one span from the first job event to the last', on.length === 1, JSON.stringify(on));
}

console.log('\na heartbeat and the job inside it are one interval, not two');
{
  const on = (await day('both', PAST)).online || [];
  check('the overlap is merged rather than summed', mins(on) === 60, JSON.stringify(on));
  check('into a single span', on.length === 1, JSON.stringify(on));
}

console.log('\na still-running ONLINE is closed at now(), not at midnight ahead of it');
{
  const on = (await day('live', LIVE_DAY)).online || [];
  const want = Math.round((LIVE_END - startOf(LIVE_DAY)) / 60000);
  const got = on.length ? on[on.length - 1].e : null;
  check('the span reaches the earlier of now and the end of the day',
    got != null && Math.abs(got - want) <= 2, `ended at minute ${got}, expected about ${want}`);
  check('and says it is still open', on.length && on[on.length - 1].open_ended === true,
    JSON.stringify(on));
}

console.log('\nthe page is told the day is still being collected');
{
  const r = await day('dang', PAST);
  const c = r.collection || null;
  check('the response carries the collection state', c != null && c.source === 'uber_timeline',
    JSON.stringify(c));
  check('it reports the last pass, in minutes of the day it reached',
    c && c.collected_to_min === 10 * 60 + 17, JSON.stringify(c && c.collected_to_min));
  check('so the day is not complete', c && c.complete === false, JSON.stringify(c && c.complete));
  check('and it says so in words a reader can act on, naming what is missing',
    c && /still being collected/.test(c.why || '') && /has not been fetched/.test(c.why || ''),
    JSON.stringify(c && c.why));
  check('the cadence is read from the setting rather than written into the sentence',
    c && c.every_hours === 3, JSON.stringify(c && c.every_hours));
  check('and which channels file an availability record at all is read off the rows',
    c && Array.isArray(c.platforms) && c.platforms.join() === 'uber', JSON.stringify(c && c.platforms));
}

console.log('\nthe kept per-day record is written from the same definition');
{
  await refreshDriverDays(db);
  const [row] = await q(
    `SELECT online_min, idle_online_min FROM driver_day
      WHERE driver_ext_id = 'dang' AND day = $1::date`, [PAST]);
  check('driver_day.online_min holds the dangling span too',
    row && row.online_min === 1440 - 515, JSON.stringify(row));
  const [only] = await q(
    `SELECT online_min FROM driver_day WHERE driver_ext_id = 'jobonly' AND day = $1::date`, [PAST]);
  check('and a day known only from the job stream is a row with availability on it',
    only && only.online_min === 40, JSON.stringify(only));
  const [b] = await q(
    `SELECT online_min FROM driver_day WHERE driver_ext_id = 'both' AND day = $1::date`, [PAST]);
  check('with nothing double-counted', b && b.online_min === 60, JSON.stringify(b));
}

console.log('\nthe fleet-wide supply heatmap counts the same minutes');
{
  /* The window has to reach past the day's events: the endpoint bounds the
     feed on raw timestamptz instants, and a `to` of the day itself is that
     day's UTC midnight, which is 04:00 Dubai. */
  const bal = (await get(`/api/supply/balance?from=${PAST}&to=${NEXT}`)).body;
  /* 925 + 60 + 40 + 60 minutes on the finished day = 1,085 = 18.1 hours.
     Before the fix the first of those four contributed 84 minutes and the
     third contributed nothing at all — 2.4 hours between them. */
  const want = Math.round((925 + 60 + 40 + 60) / 60);
  check('online hours include every dangling span and every job-only one',
    bal && bal.totals && Math.abs(bal.totals.online_h - want) <= 1,
    JSON.stringify(bal && bal.totals));
}

/* ── THE RATIO ─────────────────────────────────────────────────────────────
   Once the window is right the two halves line up, but the guard has to exist
   regardless: a share of online time is uncomputable in four ordinary
   situations and printing one anyway is how "99% of online time" got onto a
   page about a driver who was online all day. */
console.log('\nthe share refuses to compute when the two halves are not the same day');
{
  /* The production shape as the page received it BEFORE the fix: the online
     record stops at 09:59 and the jobs run to 11:03. */
  const broken = onlineShare({
    online: [{ s: 515, e: 599 }],
    trips: [{ s: 515, e: 552, platform: 'uber' }, { s: 599, e: 625, platform: 'uber' },
      { s: 644, e: 664, platform: 'uber' }],
    collection: { platforms: ['uber'], complete: true },
  });
  check('it refuses rather than printing a ratio', broken.basis === 'refused', JSON.stringify(broken));
  check('and the ratio it refused to print was the one production showed',
    Math.round((broken.onJobMin / broken.onlineMin) * 100) === 99,
    `${broken.onJobMin} / ${broken.onlineMin}`);
  check('the reason names the contradiction rather than the collector',
    /outside every ONLINE span/.test(broken.reason || ''), broken.reason);
}
{
  /* A hotel booking. Only Uber files a driver timeline, so those minutes
     belong to no online window at all — a different true reason. */
  const mixed = onlineShare({
    online: [{ s: 480, e: 600 }],
    trips: [{ s: 500, e: 540, platform: 'uber' }, { s: 720, e: 780, platform: 'hotel' }],
    collection: { platforms: ['uber'], complete: true },
  });
  check('a job on a channel with no availability feed refuses too',
    mixed.basis === 'refused', JSON.stringify(mixed));
  check('and names that channel, not a contradiction that did not happen',
    /hotel/.test(mixed.reason || '') && /no availability record/.test(mixed.reason || ''),
    mixed.reason);
}
{
  const filling = onlineShare({
    online: [{ s: 480, e: 600 }],
    trips: [{ s: 500, e: 540, platform: 'uber' }, { s: 700, e: 740, platform: 'uber' }],
    collection: { platforms: ['uber'], complete: false, why: 'This day is still being collected.' },
  });
  check('a day still being collected refuses with THAT reason',
    filling.basis === 'refused' && /still being collected/.test(filling.reason || ''),
    JSON.stringify(filling));
}
{
  /* Overlapping dispatches are real on this fleet — the next rider is assigned
     before the last is dropped — so summed job minutes can outrun any clock
     even when every one of them is inside the online window. */
  const over = onlineShare({
    online: [{ s: 480, e: 540 }],
    trips: [{ s: 480, e: 540, platform: 'uber' }, { s: 490, e: 530, platform: 'uber' }],
    collection: { platforms: ['uber'], complete: true },
  });
  check('overlapping dispatches refuse rather than printing over 100%',
    over.basis === 'refused' && /overlap/.test(over.reason || ''), JSON.stringify(over));
  check('and the figure it would have printed really was over 100%',
    over.onJobMin > over.onlineMin, `${over.onJobMin} / ${over.onlineMin}`);
}
{
  const good = onlineShare({
    online: [{ s: 480, e: 600 }],
    trips: [{ s: 500, e: 530, platform: 'uber' }],
    collection: { platforms: ['uber'], complete: true },
  });
  check('a day whose halves do agree still prints its share',
    good.basis === 'online' && good.pct === 25, JSON.stringify(good));
  check('and the idle figure is the subtraction, not a second derivation',
    good.idleMin === 90, String(good.idleMin));
}
{
  const none = onlineShare({ online: [], trips: [{ s: 500, e: 530, platform: 'uber' }] });
  check('a day with no availability at all falls back to the trip span, as it always did',
    none.basis === 'span' && none.pct === null, JSON.stringify(none));
}

/* The page's own use of it: the refusal must reach the reader as an absence
   with a reason, never as a number. */
console.log('\nthe page renders the refusal rather than a figure');
{
  const src = (await import('node:fs')).readFileSync('api/public/driverday.js', 'utf8');
  check('the verdict draws an em dash when the share was refused',
    /refused \? '—'/.test(src), 'the refused branch must not reach the percentage');
  check('and carries the reason into the sentence beneath it',
    /refused \? ` \$\{share\.reason\}`/.test(src), 'the reason has to be on the same screen');
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
