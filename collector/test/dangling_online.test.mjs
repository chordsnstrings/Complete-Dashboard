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
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'), ('egari','Egari')
         ON CONFLICT DO NOTHING`);

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
/* A day BEFORE the last successful collection, so the collection ceiling sits
   above it and cannot bind — the residual case the ceiling deliberately does
   not close. */
const EARLIER = dubaiDay(NOW - 8 * 86400000);
const startOf = (day) => Date.parse(`${day}T00:00:00+04:00`);

let evn = 0;
const ev = (id, at, status, fleet = 'ecosine') => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber',$4,$1,$2::timestamptz,'status',$3,'')`, [id, at, status, fleet]);
const job = (id, at, state, jid, fleet = 'ecosine') => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state,
     job_ext_id)
   VALUES ('uber',$5,$1,$2::timestamptz,'job','',$3,$4)`, [id, at, state, jid, fleet]);
const trip = (id, name, from, to, o = {}) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, status, distance_km, price, currency)
   VALUES ($1,$2,$8,$3,$4,$5,$6::timestamptz,$7::timestamptz,'completed',10,40,'AED')`,
  [o.platform || 'uber', `dg${evn++}`, o.plate || 'L900', id, name, from, to, o.fleet || 'ecosine']);

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

/* ── a long morning that only the ceiling can bound ────────────────────
      Two heartbeats and then silence. Under the deleted-dangling rule this
      driver contributed FIVE minutes; run to midnight it would contribute
      eighteen hours; bounded by the collection it contributes the 4h 17m we
      actually asked about. The three answers are far enough apart that the
      fleet-wide assertion below can tell them apart through rounding. */
await ev('long', D('06:00:00'), 'ONLINE');
await ev('long', D('06:05:00'), 'ONLINE');
await trip('long', 'Long Driver', D('06:30:00'), D('07:00:00'), { plate: 'L905' });

/* ── the residual the ceiling deliberately does NOT close ──────────────
      A dangling ONLINE on a day the collector has since covered many times
      over. The ceiling sits above that whole day, so it cannot bind, and the
      span still runs to midnight — 4 of the 60 drivers measured on production
      are in this state. It is a claim, not a measurement, which is why
      closed_by says 'day' and open_ended stays true. */
await ev('oldday', `${EARLIER}T14:00:00+04:00`, 'ONLINE');
await trip('oldday', 'Old Day', `${EARLIER}T14:30:00+04:00`,
  `${EARLIER}T15:00:00+04:00`, { plate: 'L906' });

/* ── the same shape, still running, on whichever Dubai day now falls in ──
      On EGARI, which has no successful timeline run at all in this fixture —
      so there is no collection ceiling for it and the span falls back to the
      earlier of now and the end of the day. Borrowing ecosine's collection
      clock would be a claim about a collection that never happened. */
const ANCHOR = NOW - 90 * 60000;
const LIVE_DAY = dubaiDay(ANCHOR);
const LIVE_END = Math.min(NOW, startOf(LIVE_DAY) + 86400000);
await ev('live', new Date(ANCHOR).toISOString(), 'ONLINE', 'egari');
await trip('live', 'Live Driver', new Date(ANCHOR + 5 * 60000).toISOString(),
  new Date(ANCHOR + 35 * 60000).toISOString(), { plate: 'L904', fleet: 'egari' });

/* The feed's own clock: one ecosine pass that finished at 10:17 Dubai on the
   finished day, which is both what makes that day "still being collected" and
   the ceiling every ecosine dangling span above is closed at.
   status <> 'error' rather than = 'ok', because a partial run did reach the
   provider — so a 'partial' row would count and the 'error' row below must
   not. Without that exclusion the ceiling would move to 23:00 on the evidence
   of a run that collected nothing. */
await q(`INSERT INTO collection_run (source, fleet_id, mode, started_at, finished_at, status)
         VALUES ('uber_timeline','ecosine','incremental',$1::timestamptz,$1::timestamptz,'ok')`,
[D('10:17:00')]);
await q(`INSERT INTO collection_run (source, fleet_id, mode, started_at, finished_at, status,
           error)
         VALUES ('uber_timeline','ecosine','incremental',$1::timestamptz,$1::timestamptz,'error',
           'every driver-window request refused')`, [D('23:00:00')]);
/* And EGARI's own clock, twelve hours ahead of ecosine's. The collector runs
   per fleet and files a run row per fleet, so the two ceilings are independent
   — neither may leak onto the other's drivers, and the sentence the page
   prints about how far collection has reached has to be scoped the same way
   the band is or the page contradicts itself in two adjacent lines. */
await q(`INSERT INTO collection_run (source, fleet_id, mode, started_at, finished_at, status)
         VALUES ('uber_timeline','egari','incremental',$1::timestamptz,$1::timestamptz,'ok')`,
[D('22:00:00')]);
await ev('egdang', D('09:00:00'), 'ONLINE', 'egari');
await trip('egdang', 'Egari Dangling', D('09:30:00'), D('10:00:00'),
  { plate: 'L907', fleet: 'egari' });

const { get, server } = await mountAll(db, { serverRoutes: false });
const day = async (id, d) => (await get(`/api/driver/day?id=${id}&day=${d}`)).body;
const mins = (rows) => rows.reduce((a, o) => a + Math.max(0, o.e - o.s), 0);

console.log('\nthe dangling ONLINE is kept, and closed at the last moment we asked Uber');
{
  const r = await day('dang', PAST);
  check('the day answers at all', r && Array.isArray(r.online), JSON.stringify(r).slice(0, 160));
  const on = r.online || [];
  /* Minute 515, not 514: the endpoint reports whole minutes of the Dubai day
     and 08:34:46 is nearer 08:35 than 08:34. */
  check('the driver is online from the first heartbeat', on.length && on[0].s === 515,
    JSON.stringify(on));
  /* THE DEFECT, AND THE CEILING, IN ONE NUMBER.
     08:35→09:59 is 84 minutes — what the deleted-dangling rule answered.
     08:35→midnight is 925 — what closing at the end of the day alone would
     answer, 6h 43m of it after the last moment anybody asked Uber.
     08:35→10:17 is 102, and 10:17 is when the collector last ran. */
  check('the last ONLINE is kept, and stops where the collection stopped',
    mins(on) === 617 - 515, `${mins(on)} minutes: ${JSON.stringify(on)}`);
  check('it is one merged span, not one per heartbeat', on.length === 1, JSON.stringify(on));
  check('and it is marked open-ended, so a caller can tell it from a closed one',
    on[on.length - 1].open_ended === true, JSON.stringify(on));
  /* WHICH bound closed it. Without this a reader cannot tell "still online as
     far as we know" from "this is where we stopped asking", and those two
     produce opposite decisions about whether to phone somebody. */
  check('and it names the bound that closed it, which here is the collector',
    on[on.length - 1].closed_by === 'collection', JSON.stringify(on));
  /* The rest of his day is now honestly OUTSIDE the record — he took trips
     until 11:03 and we only asked Uber up to 10:17 — which is exactly the
     shape the ratio guard must refuse rather than divide. */
  const last = (r.trips || []).reduce((m, t) => Math.max(m, t.e ?? t.s), 0);
  check('his later jobs sit outside the record, because nobody has asked yet',
    last > on[on.length - 1].e, `last job ends ${last}, online ends ${on[on.length - 1].e}`);
  const sh = onlineShare({ online: r.online, trips: r.trips, collection: r.collection });
  check('so the endpoint’s own payload makes the page refuse the share',
    sh.basis === 'refused', JSON.stringify(sh));
  check('and blames the collector rather than the driver',
    /still being collected/.test(sh.reason || ''), sh.reason);
}

console.log('\nan error run is not a moment anybody was asked');
{
  /* The failed pass finished at 23:00 on the same day. If status <> 'error'
     were dropped the ceiling would move there on the strength of a run that
     collected nothing, and 6h 43m of unasked-for availability would come
     straight back. */
  const on = (await day('dang', PAST)).online || [];
  check('the ceiling ignores the failed 23:00 pass', mins(on) === 617 - 515,
    JSON.stringify(on));
}

console.log('\na day the collector has long since covered is bounded by the day');
{
  const on = (await day('oldday', EARLIER)).online || [];
  /* The ceiling sits above this whole day, so it cannot bind and the span runs
     to midnight — 14:00 to 24:00. This is the residual, pinned rather than
     described: 4 of the 60 drivers measured on production are in it. */
  check('the span runs from the last ONLINE to the end of that day',
    mins(on) === 1440 - 840, `${mins(on)} minutes: ${JSON.stringify(on)}`);
  check('and says so — the calendar closed it, not the collector and not an event',
    on.length && on[0].closed_by === 'day', JSON.stringify(on));
  check('while still being marked open-ended, so a surface can refuse it',
    on.length && on[0].open_ended === true, JSON.stringify(on));
}

console.log('\nan OFFLINE still closes a span');
{
  const on = (await day('off', PAST)).online || [];
  check('the span is the hour between the two events, not the rest of the day',
    mins(on) === 60, JSON.stringify(on));
  check('and it is not open-ended, because its closing event arrived',
    on.every((o) => o.open_ended === false), JSON.stringify(on));
  /* No bound to explain: an event closed it, so closed_by is not carried. */
  check('and carries no bound to explain, because none was needed',
    on.every((o) => o.closed_by == null), JSON.stringify(on));
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

console.log('\na fleet with no successful run of its own gets no ceiling, and falls back');
{
  /* This driver is on egari, which has never completed a timeline run here.
     There is no evidence of when egari was last asked, so there is no ceiling
     to apply — borrowing ecosine's would be a claim about a collection that
     never happened — and the span falls back to the earlier of now and the end
     of its own Dubai day. */
  const on = (await day('live', LIVE_DAY)).online || [];
  const want = Math.round((LIVE_END - startOf(LIVE_DAY)) / 60000);
  const got = on.length ? on[on.length - 1].e : null;
  check('the span reaches the earlier of now and the end of the day',
    got != null && Math.abs(got - want) <= 2, `ended at minute ${got}, expected about ${want}`);
  check('and says it is still open', on.length && on[on.length - 1].open_ended === true,
    JSON.stringify(on));
  /* 'now' while the day is still running, 'day' if the anchor fell on the far
     side of a Dubai midnight — never 'collection', because there is no
     collection of this fleet to point at. */
  check('and names a bound that is not a collection nobody ran',
    on.length && on[on.length - 1].closed_by === (NOW < startOf(LIVE_DAY) + 86400000 ? 'now' : 'day'),
    JSON.stringify(on.map((o) => o.closed_by)));
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
  check('driver_day.online_min holds the dangling span, bounded by the collection',
    row && row.online_min === 617 - 515, JSON.stringify(row));
  const [old] = await q(
    `SELECT online_min FROM driver_day WHERE driver_ext_id = 'oldday' AND day = $1::date`,
    [EARLIER]);
  check('and a day the ceiling cannot reach is still bounded by that day',
    old && old.online_min === 1440 - 840, JSON.stringify(old));
  const [only] = await q(
    `SELECT online_min FROM driver_day WHERE driver_ext_id = 'jobonly' AND day = $1::date`, [PAST]);
  check('and a day known only from the job stream is a row with availability on it',
    only && only.online_min === 40, JSON.stringify(only));
  const [b] = await q(
    `SELECT online_min FROM driver_day WHERE driver_ext_id = 'both' AND day = $1::date`, [PAST]);
  check('with nothing double-counted', b && b.online_min === 60, JSON.stringify(b));
}

console.log('\nthe ceiling is per fleet, and so is the sentence about it');
{
  const eg = await day('egdang', PAST);
  const on = eg.online || [];
  /* Egari was last asked at 22:00, ecosine at 10:17. If the ceiling were read
     globally this driver would stop at 10:17 — nearly thirteen hours of his
     own fleet's collected availability thrown away on another fleet's clock. */
  check('an egari driver is bounded by egari’s collection, not ecosine’s',
    mins(on) === 22 * 60 - 9 * 60, `${mins(on)} minutes: ${JSON.stringify(on)}`);
  check('and names the collector as the bound', on.length && on[0].closed_by === 'collection',
    JSON.stringify(on));
  check('the page’s sentence agrees with the band it sits under',
    eg.collection && eg.collection.collected_to_min === 22 * 60,
    JSON.stringify(eg.collection && eg.collection.collected_to_min));
  /* And the reverse, which is the one a global max() would get wrong: the
     ecosine driver must NOT inherit egari's later clock. */
  const ec = await day('dang', PAST);
  check('while the ecosine driver keeps his own, earlier clock',
    ec.collection && ec.collection.collected_to_min === 617,
    JSON.stringify(ec.collection && ec.collection.collected_to_min));
}

console.log('\nthe month-long shift panel draws the same spans');
{
  /* The same builder feeds four readers and they must not disagree. This one
     is here because it is the one that broke silently while this file was
     being written: the shift query clamps each span to the Dubai days it
     covers through its own `days` CTE, so a column added to the builder has to
     be carried through that CTE as well — and the failure is a 500, not a
     wrong number. A file that owns a defect should exercise every consumer of
     the fix, not the one endpoint the defect was measured on. */
  const r = (await get(`/api/driver/shift?id=dang&days=365`)).body;
  const d = (r.days || []).find((x) => x.day === PAST) || {};
  const on = d.online || [];
  check('the shift panel answers with a band for the day', on.length === 1,
    JSON.stringify(r).slice(0, 200));
  check('the same 08:35 to 10:17, to the minute', on.length && mins(on) === 617 - 515,
    JSON.stringify(on));
  check('carrying the same open-ended flag and the same bound',
    on.length && on[0].open_ended === true && on[0].closed_by === 'collection',
    JSON.stringify(on));
}

console.log('\nthe fleet-wide supply heatmap counts the same minutes');
{
  /* The window has to reach past the day's events: the endpoint bounds the
     feed on raw timestamptz instants, and a `to` of the day itself is that
     day's UTC midnight, which is 04:00 Dubai. */
  /* Chipped to one fleet, which also puts the chip predicate through the
     shared builder end to end: the chip is applied AFTER lead(), so an OFFLINE
     stamped with the other fleet still closes the span it closes. */
  const bal = (await get(`/api/supply/balance?from=${PAST}&to=${NEXT}&fleet=ecosine`)).body;
  /* On the finished day: dang 102 + long 257 + off 60 + jobonly 40 + both 60
     = 519 minutes = 8.65 hours. The two rules this replaces answer far enough
     away to be told apart through the per-cell rounding: deleting the dangling
     spans gives 84 + 5 + 60 + 0 + 60 = 209 minutes (3.5 h), and closing them at
     midnight instead of at the collection gives 925 + 1,080 + 160 = 2,165
     (36 h). Only the ceiling lands between 8 and 9. */
  const on = bal && bal.totals ? bal.totals.online_h : null;
  check('online hours are the ones we actually asked about — not the tail we did not',
    on != null && on >= 8 && on <= 9, JSON.stringify(bal && bal.totals));
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
  /* Named the way ui.js names a channel, not with the database key — the same
     rule SOURCE_LABEL exists for. */
  check('and names that channel, not a contradiction that did not happen',
    /\bHotel\b/.test(mixed.reason || '') && /no availability record/.test(mixed.reason || ''),
    mixed.reason);
  check('by its label rather than by its database key',
    !/\bhotel\b/.test(mixed.reason || ''), mixed.reason);
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
