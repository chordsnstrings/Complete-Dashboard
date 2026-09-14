/* The status was already here, twice a minute, and we were binning it.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked why a driver Uber shows online for 5.16 hours does not
   read as online on this product. The answer looked like a cadence problem —
   our online times came from supplier.uber.com/chronicle, one request per
   driver, three-hourly — and it was not. /v1/vehicle-suppliers/drivers/actions
   has been answering every LIVE_STATUS_SECONDS since the live map was built,
   and every response carries, per driver:

     statusEntries   [{status: DRIVER_STATUS_ONLINE|OFFLINE|ONTRIP,
                       timestamp: 2026-09-04T17:07:17.859Z}]
     driverInfo      {email, phone, driverUuid}

   All of it was discarded. The only row written was telemetry_snapshot keyed
   on PLATE and filtered `plate !== 'UNKNOWN'` — so the driver's status
   survived attached to a car, and only for the drivers who had one. Measured
   on production 2026-09-14 through /api/live: 11 rows carried an Uber status
   out of a roster of 152.

   Four things have to hold, and three of them are the ways this goes wrong
   quietly rather than loudly. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { driverStatusFrom } from '../src/sources/uber.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* A driver with a car, a driver without one, a driver whose entries arrive in
   the wrong order, and one the provider names but tells us nothing about. */
const OVERVIEWS = [
  { driverInfo: { driverUuid: 'with-car', phone: '+971500000001', email: 'a@example.test',
      firstName: 'Ahmed', lastName: 'Tarig' },
    onboardingStatus: 'ONBOARDING_STATUS_ACTIVE',
    vehicleInfo: { licensePlate: 'L 45232' },
    statusEntries: [
      { status: 'DRIVER_STATUS_OFFLINE', timestamp: '2026-09-14T02:00:00.000Z' },
      { status: 'DRIVER_STATUS_ONLINE', timestamp: '2026-09-14T05:19:57.572Z' }] },
  /* NO VEHICLE. This is the driver the old filter removed, and the one an
     operator is actually hunting: online, in nobody's car, taking nothing. */
  /* A first name and no surname, because the roster has those and
     [first, last].filter(Boolean).join(' ') must not produce a trailing space. */
  { driverInfo: { driverUuid: 'no-car', phone: '+971500000002', email: 'b@example.test',
      firstName: 'Bilal' },
    onboardingStatus: 'ONBOARDING_STATUS_ACTIVE',
    statusEntries: [{ status: 'DRIVER_STATUS_ONLINE', timestamp: '2026-09-14T06:00:00.000Z' }] },
  /* NEWEST FIRST, which is the opposite order of the first driver's. The
     provider's array order is its own business and this must read it as a set. */
  { driverInfo: { driverUuid: 'reversed' },
    statusEntries: [
      { status: 'DRIVER_STATUS_ONTRIP', timestamp: '2026-09-14T08:00:00.000Z' },
      { status: 'DRIVER_STATUS_ONLINE', timestamp: '2026-09-14T07:00:00.000Z' }] },
  { driverInfo: { driverUuid: 'silent' }, statusEntries: [] },
  { driverInfo: {}, statusEntries: [{ status: 'DRIVER_STATUS_ONLINE', timestamp: '2026-09-14T09:00:00.000Z' }] },
];

const r = driverStatusFrom(OVERVIEWS, 'ecosine', '2026-09-14T10:00:00.000Z');
const now = (id) => r.nowRows.find((x) => x.driver_ext_id === id);

console.log('\nevery driver is kept, with or without a car');
check('the driver with no vehicle attached is on the list',
  !!now('no-car') && now('no-car').status === 'online', JSON.stringify(now('no-car')));
check('…and their plate is null rather than the string UNKNOWN',
  now('no-car').plate === null, String(now('no-car').plate));
check('a driver the provider names but says nothing about is still a row',
  !!now('silent') && now('silent').status === null, JSON.stringify(now('silent')));
check('a record with no driver uuid is dropped, not keyed on undefined',
  !r.nowRows.some((x) => !x.driver_ext_id || x.driver_ext_id === 'undefined'),
  JSON.stringify(r.nowRows.map((x) => x.driver_ext_id)));

console.log('\nthe current status is the latest one, not the first in the array');
check('entries oldest-first resolve to the newest',
  now('with-car').status === 'online' && now('with-car').status_at === '2026-09-14T05:19:57.572Z',
  JSON.stringify(now('with-car')));
/* THE ONE THAT WOULD HAVE GONE WRONG SILENTLY. The discarded telemetry row
   used statusEntries[0], and on this driver that is the NEWER one — so a
   reader of that field is right half the time and has no way to tell which
   half. */
check('entries newest-first also resolve to the newest',
  now('reversed').status === 'ontrip' && now('reversed').status_at === '2026-09-14T08:00:00.000Z',
  JSON.stringify(now('reversed')));
check('…which is a DIFFERENT answer from entries[0] on one of the two',
  OVERVIEWS[0].statusEntries[0].status !== now('with-car').status_raw
    && OVERVIEWS[2].statusEntries[0].status === now('reversed').status_raw);

console.log('\nthe contact details, which are the other thing being discarded');
check('a phone and an email are carried for the drivers that have them',
  r.contacts.length === 2
    && r.contacts.every((c) => c.phone && c.email), JSON.stringify(r.contacts.map((c) => c.driver_ext_id)));
check('and a driver with neither writes no contact row at all',
  !r.contacts.some((c) => c.driver_ext_id === 'reversed'),
  'a record with nothing on it must not overwrite what is on file with nulls');
/* THE NAME GOES WITH THEM, built the way src/sources/uber_profile.js builds it.
   This feed meets an Uber account before the three-hourly profile pull does, so
   without the name the account lands on driver_compliance with contact details
   and nothing to call the person — a row src/identity_link.js cannot reason
   about (a nameless survivor yields canonical_key '') and one the roster pages
   would draw as a blank. */
check('the driver’s name is carried too, not just their contact details',
  r.contacts.find((c) => c.driver_ext_id === 'with-car')?.full_name === 'Ahmed Tarig',
  JSON.stringify(r.contacts.map((c) => [c.driver_ext_id, c.full_name])));
check('…a first name with no surname carries no trailing space',
  r.contacts.find((c) => c.driver_ext_id === 'no-car')?.full_name === 'Bilal',
  JSON.stringify(r.contacts.find((c) => c.driver_ext_id === 'no-car')?.full_name));

console.log('\nthe events, keyed on the provider’s own instant');
check('every timestamped entry becomes an event', r.events.length === 5, String(r.events.length));
check('an entry with no timestamp is not an event',
  !r.events.some((e) => !e.at), JSON.stringify(r.events.filter((e) => !e.at)));

/* ── and against a real schema ──────────────────────────────────────────── */
await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const cols = (t) => q(
  `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]);
check('schema v70 created driver_status_now', (await cols('driver_status_now')).length > 0);
check('schema v70 created driver_status_event', (await cols('driver_status_event')).length > 0);

for (const e of r.events) {
  await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [e.platform, e.driver_ext_id, e.at, e.status, e.status_raw, e.fleet_id]);
}
/* Written twice, because the feed re-reads the same entries every two minutes
   and an append-only table that grows on every poll is a table that fills a
   disk. The key is the provider's timestamp, so the second write is a no-op. */
for (const e of r.events) {
  await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [e.platform, e.driver_ext_id, e.at, e.status, e.status_raw, e.fleet_id]);
}
const [{ n }] = await q(`SELECT count(*)::int n FROM driver_status_event`);
check('re-reading the same entries writes them once, not twice', n === 5, `${n} rows`);

/* THE DUBAI DAY, generated. An ONLINE at 21:30 UTC is half past one the NEXT
   morning in Dubai, and a page binding on the UTC day reports that shift on
   the wrong date — the defect sql/schema_v18.sql exists to stop. */
await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, fleet_id)
         VALUES ('uber','midnight','2026-09-14T21:30:00.000Z','online','ecosine')`);
const [mid] = await q(`SELECT local_day::text AS d FROM driver_status_event WHERE driver_ext_id = 'midnight'`);
check('local_day is the Dubai calendar day, not the UTC one',
  mid.d === '2026-09-15', mid.d);

/* And the question the whole table exists to answer, asked the way the page
   will ask it: when did this person come online on this Dubai day? */
const [first] = await q(
  `SELECT min(at) AS came_online FROM driver_status_event
    WHERE driver_ext_id = 'with-car' AND status = 'online' AND local_day = '2026-09-14'`);
check('the first online event of a Dubai day is when they came online',
  new Date(first.came_online).toISOString() === '2026-09-14T05:19:57.572Z',
  String(first.came_online));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
