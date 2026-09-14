/* "Online" has to mean online, and a stale answer has to say it is stale.
   ──────────────────────────────────────────────────────────────────────────
   Three ways a live status page lies, all of them quietly:

   1. It counts ONLINE and forgets ONTRIP. Uber moves a driver out of ONLINE
      the moment they accept a job, so a page counting only `online` reports
      the drivers who are actually earning as not working — the opposite of the
      truth, and the easiest mistake in this whole feature.

   2. It prints the last status it holds without saying when it heard it.
      "Online since 06:14" off a feed that stopped answering at noon looks
      exactly like a live answer and is a claim about the morning.

   3. It counts a night shift from the wrong end. A driver online across
      midnight has no status CHANGE after midnight until they stop — so a day
      that reads only its own events finds their first event is the moment they
      went offline, and reports that as the time they came online. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { STALE_AFTER_MIN, WORKING } from '../api/status_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* The day under test is YESTERDAY, so every span is closed and the arithmetic
   is not a moving target — `now()` clamps an open span, and a test whose
   expected minutes depend on the clock is a test that fails at midnight. */
const day = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const prev = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
/* DUBAI WALL-CLOCK IN, UTC OUT — and the helper takes the Dubai time because
   the first version of this fixture did the conversion by hand and got it
   backwards. Dubai is UTC+4 all year, so 03:00 Dubai is 23:00Z on the day
   BEFORE, and a row written as `${day}T23:00Z` lands at three in the morning
   on the day AFTER the one under test. That is the same off-by-one-timezone
   the product itself has paid for repeatedly (sql/schema_v18.sql), and a test
   that reproduces it proves nothing. */
const at = (dubaiDay, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(...dubaiDay.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)),
    h, m) - 4 * 3600e3).toISOString();
};

const ev = (id, dubaiDay, hhmm, status) => q(
  `INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
   VALUES ('uber',$1,$2,$3,$4,'ecosine') ON CONFLICT DO NOTHING`,
  [id, at(dubaiDay, hhmm), status, `DRIVER_STATUS_${status.toUpperCase()}`]);
const trip = (id, name) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status)
   VALUES ('uber',$1,'ecosine',$2,$3,$4,'completed')`,
  [`x-${id}`, id, name, at(day, '09:00')]);

/* DAYSHIFT: online 06:00 Dubai, on a trip 08:00–10:00, offline 14:00. */
await trip('dayshift', 'Day Shift');
await ev('dayshift', day, '06:00', 'online');
await ev('dayshift', day, '08:00', 'ontrip');
await ev('dayshift', day, '10:00', 'online');
await ev('dayshift', day, '14:00', 'offline');

/* NIGHTSHIFT: came online 22:00 Dubai the day BEFORE and went offline at
   03:00 Dubai on the day under test. Their only event inside the day is the
   one that ends the shift. */
await trip('nightshift', 'Night Shift');
await ev('nightshift', prev, '22:00', 'online');
await ev('nightshift', day, '03:00', 'offline');

const { server, get } = await mountAll(db);
const J = async (u) => (await get(u)).body;

console.log('\nontrip is working, and the arithmetic says so');
check('ontrip is counted as working', WORKING.includes('ontrip') && WORKING.includes('online'),
  JSON.stringify(WORKING));
const d = await J(`/api/status/driver?id=dayshift&day=${day}`);
check('online minutes span the whole shift, trip time included',
  d.today.online_minutes === 480, `${d.today.online_minutes} min (expected 06:00–14:00 = 480)`);
check('on-trip minutes are the trip alone',
  d.today.on_trip_minutes === 120, `${d.today.on_trip_minutes} min`);
check('waiting is the difference, and it is the idle supply figure',
  d.today.waiting_minutes === 360, `${d.today.waiting_minutes} min`);
check('they came online at 06:00 Dubai, not at the first ontrip',
  d.today.online_since_local === '06:00', String(d.today.online_since_local));

console.log('\na shift that began before midnight is counted from midnight');
const n = await J(`/api/status/driver?id=nightshift&day=${day}`);
check('the day opens in the state it was left in, so the night shift is seen at all',
  n.today.online_minutes === 180, `${n.today.online_minutes} min (expected 00:00–03:00 = 180)`);
check('…and the start is midnight, not the moment they went OFFLINE',
  n.today.online_since_local === '00:00', String(n.today.online_since_local));

console.log('\na status nobody has reported is absent, with the reason');
const q2 = await J(`/api/status/driver?id=dayshift&day=${day}`);
check('no driver_status_now row means status null, not "offline"',
  q2.status === null, String(q2.status));
check('…and the reason names the channel that publishes one',
  /Only Uber publishes one/.test(q2.absent || ''), String(q2.absent).slice(0, 80));

console.log('\nthe two clocks');
await q(`INSERT INTO driver_status_now
           (platform, driver_ext_id, fleet_id, status, status_raw, status_at, observed_at)
         VALUES ('uber','dayshift','ecosine','online','DRIVER_STATUS_ONLINE',$1,$2)`,
[at(day, '06:00'), new Date(Date.now() - 45 * 60000).toISOString()]);
const stale = await J(`/api/status/driver?id=dayshift&day=${day}`);
check('a feed that answered 45 minutes ago is marked stale',
  stale.stale === true && stale.observed_age_min >= 44, JSON.stringify([stale.stale, stale.observed_age_min]));
check('…and says so in words rather than only in a flag',
  /last answered 4\d minutes ago/.test(stale.stale_why || ''), String(stale.stale_why).slice(0, 90));
check('the threshold is published, not hidden in a constant',
  STALE_AFTER_MIN > 0 && STALE_AFTER_MIN < 60, String(STALE_AFTER_MIN));

await q(`UPDATE driver_status_now SET observed_at = now() WHERE driver_ext_id = 'dayshift'`);
const fresh = await J(`/api/status/driver?id=dayshift&day=${day}`);
check('a feed that answered just now is not stale',
  fresh.stale === false && fresh.stale_why === null, JSON.stringify([fresh.stale, fresh.observed_age_min]));
check('and the status reads in words as well as as a token',
  fresh.status === 'online' && /waiting for a job/.test(fresh.status_word || ''),
  String(fresh.status_word));

/* ── A ROW THAT EXISTS AND SAYS NOTHING ──────────────────────────────────
   Found on production the hour this shipped, and not by any fixture here: the
   live feed writes a row for every driver Uber lists, whether or not it
   reports a status for them. On 2026-09-14, 66 of 158 rows came back with no
   statusEntries at all — a row PRESENT, status null.

   `absent` was set only when there was NO row, so those 66 answered status
   null and absent null, and the strip's word ladder — whose last rung is
   "Offline" — reported sixty-six drivers Uber had said nothing about as
   offline. The distinction this file exists to hold is exactly that one. */
console.log('\na row that exists and carries no status is still absent');
await q(`INSERT INTO driver_status_now
           (platform, driver_ext_id, fleet_id, status, status_raw, status_at, observed_at)
         VALUES ('uber','listed-silent','ecosine',NULL,NULL,NULL,now())`);
const sil = await J(`/api/status/driver?id=listed-silent&day=${day}`);
check('a row with a null status answers absent, not "offline"',
  sil.status === null && !!sil.absent, JSON.stringify([sil.status, sil.absent]));
check('…with the TRUE reason: Uber lists them and reports nothing',
  /lists this driver but has reported no status/.test(sil.absent || ''),
  String(sil.absent).slice(0, 90));
check('…which is a DIFFERENT sentence from having no row at all',
  sil.absent !== (await J(`/api/status/driver?id=nobody-at-all&day=${day}`)).absent);
/* A driver we know nothing about cannot be stale — staleness is a claim about
   a status, and there is none to be stale. */
check('…and it is not dressed up as a stale reading of something',
  sil.stale_why === null, String(sil.stale_why));

/* ── A DAY OUR RECORD ONLY PART-COVERS ───────────────────────────────────
   driver_status_event begins when the collector began writing it. On that
   first day the driver page printed "1h 40m online today" from this endpoint
   directly beside the availability feed's "online 4h 48m of it", for the same
   driver and the same day — two figures for one thing, three hours apart,
   neither saying what it was measured over. The shorter one is not wrong; it
   is measured over a shorter record, and it has to say so. */
console.log('\na day whose history starts part-way through it');
const partial = await J(`/api/status/driver?id=dayshift&day=${day}`);
check('a day whose first event is its own start of record is flagged partial',
  partial.today.partial === true, JSON.stringify(partial.today.partial));
check('…and says the time is missing from the record, not from the shift',
  /missing from our record/.test(partial.today.partial_why || ''),
  String(partial.today.partial_why).slice(0, 80));
check('…and reports when the record begins, so the claim is checkable',
  !!partial.today.history_from, String(partial.today.history_from));
/* The control: an event BEFORE the day means the day is fully covered, and the
   flag must go off — otherwise "partial" is just always true and says nothing. */
await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
         VALUES ('uber','dayshift',$1,'offline','DRIVER_STATUS_OFFLINE','ecosine')
         ON CONFLICT DO NOTHING`, [at(prev, '22:00')]);
const full = await J(`/api/status/driver?id=dayshift&day=${day}`);
check('…while a day our record reaches back before is not flagged',
  full.today.partial === false && full.today.partial_why === null,
  JSON.stringify([full.today.partial, full.today.partial_why]));

console.log('\nthe fleet view');
const f = await J('/api/status/fleet');
check('the fleet totals count ontrip as working',
  f.totals.working === f.totals.online + f.totals.ontrip, JSON.stringify(f.totals));
check('and the response says which channel this is about',
  /only channel that reports a live driver status/.test(f.basis || ''));
/* THE TOTALS MUST NOT INVITE THE SUBTRACTION. online + ontrip + offline does
   not equal drivers, and a reader who assumes it does reads the difference as
   offline — the same wrong answer one level up. */
check('the unknowns are counted, not folded into offline',
  f.totals.unknown === 1 && f.totals.with_status === f.totals.drivers - f.totals.unknown,
  JSON.stringify(f.totals));
check('…and the three statuses account for exactly the rows that have one',
  f.totals.online + f.totals.ontrip + f.totals.offline === f.totals.with_status,
  JSON.stringify(f.totals));
check('…and it is said in words as well as counted',
  /carry no status at all/.test(f.unknown_note || ''), String(f.unknown_note).slice(0, 90));
/* The list must open with the people who are working, not with the rows that
   say nothing — `status = 'ontrip'` is NULL for those, and NULL sorts FIRST
   under a bare DESC. */
check('the fleet list does not open with the rows that say nothing',
  !!f.rows[0].status, JSON.stringify(f.rows.map((r) => r.status)));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
