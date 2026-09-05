/* Stop writing the credentials, and scrub the ones already written.
   ──────────────────────────────────────────────────────────────────────────
   MEASURED ON PRODUCTION 2026-09-05, with curl and NO credentials — this
   product has no user authentication, so every /api route answers a request
   with no cookie, no header and no token:

     /api/trip?platform=hotel&id=…  trip.raw.driver carried `password`
                                    ($2b$10$…, bcrypt cost 10), `emiratesId`
                                    784-1999-8885500-5 and `notificationToken`
                                    ExponentPushToken[…] — on 12 of 12 hotel
                                    trips sampled, 0 of 36 uber/bolt/yango.
     /api/probe/results             serves provider_probe.fields verbatim, and
                                    the sampler that fills it has returned
                                    bcrypt hashes and push tokens.

   api/trip_routes.js redacts on the way out. That fix is one edit away from
   not being there, and it does nothing about the 1,714 rows already on disk.
   Three changes cover the rest, and this file holds all three down:

     1. src/sources/hotel.js never writes the credential in the first place;
     2. src/probe.js never samples a secret-shaped key, keeping the count;
     3. sql/schema_v59.sql removes what is already stored, once, guarded.

   And the same rule everywhere: phone and email STAY (the operator asked for
   them and #drivers renders them), the row SAYS what was withheld, and nothing
   else in the record moves. */
import { PGlite } from '@electric-sql/pglite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { describe } from '../src/probe.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The literal values production was serving, so these tests fail if the real
   shapes ever get through again. */
const HASH = '$2b$10$8aVY3fEcseIj4yOojdvt7ea46DJZopAjK58x0p.YFca63NSrQctcq';
const EID = '784-1999-8885500-5';
const PUSH = 'ExponentPushToken[U_mydqA-q0vfNoQeecJiIJ]';

/* ── 1. the probe samples shape, and a narrow secret is not shape ───────── */
console.log('\nthe probe: a secret-shaped key is counted, never printed');
{
  /* Narrow cardinality is exactly what makes a credential cheap to guess: two
     default hashes across sixty drivers is well inside the sampler's cap, so
     the old code printed both outright into a table /api/probe/results serves
     anonymously. */
  const rows = Array.from({ length: 60 }, (_, i) => ({
    status: ['finished', 'cancelled'][i % 2],
    password: [HASH, '$2b$10$other'][i % 2],
    emiratesId: EID,
    phone: `97152381715${i % 3}`,
    email: `person${i}@example.com`,
    driver_ext_id: `d-${i % 4}`,
    driver: { notificationToken: PUSH, firstName: 'Mohammed' },
  }));
  const out = describe(rows);
  const f = Object.fromEntries(out.map((x) => [x.key, x]));
  const wire = JSON.stringify(out);

  check('no bcrypt hash survives into what would be stored', !wire.includes('$2b$10$'), wire.slice(0, 200));
  check('no Emirates ID either', !wire.includes(EID));
  check('and no push token, however deep the key sits', !wire.includes('ExponentPushToken'));
  check('the withheld field says it was withheld rather than looking empty',
    f.password.values_withheld === true && /credential or an identity document/.test(f.password.values[0]),
    JSON.stringify(f.password));
  check('…and says why, naming the file that holds the rule',
    /api\/redact\.js/.test(f.password.values_withheld_reason || ''));
  check('the COUNT survives — it is what answers "dimension or identifier?"',
    f.password.distinct_seen === 2 && f.emiratesId.distinct_seen === 1,
    JSON.stringify([f.password.distinct_seen, f.emiratesId.distinct_seen]));
  check('and so does the fill rate', f.password.fill_pct === 100);
  check('a nested secret is judged on its own key name, at any depth',
    f['driver.notificationToken'].values_withheld === true);

  /* The other half of the rule. A redaction that ate these would be breaking
     three pages on purpose and calling it a security fix. */
  check('phone is still sampled — the operator asked for driver phone numbers',
    f.phone.values.some((v) => v.startsWith('9715')) && !f.phone.values_withheld,
    JSON.stringify(f.phone.values));
  check('email is still sampled where it is narrow enough to be one',
    !f.email.values_withheld);
  check('driver_ext_id is not mistaken for a credential — it is the join key',
    !f.driver_ext_id.values_withheld && f.driver_ext_id.values.length === 4);
  check('an ordinary dimension is byte-identical to what the probe returned before',
    JSON.stringify(f.status) === JSON.stringify({ key: 'status', type: 'string', fill_pct: 100,
      distinct_seen: 2, distinct_capped: false, values: ['finished', 'cancelled'] }),
    JSON.stringify(f.status));
  check('a wide non-secret field still reports no values and is not marked withheld',
    f.email.values === null && f.email.distinct_seen === 60, JSON.stringify(f.email.values));
  check('the name of the secret field is still reported — the field exists, its values do not',
    !!f.password && f.password.type === 'string');
}

/* ── 2. the collector never writes it ──────────────────────────────────────
   Drives collect() against a stub of the corporate API and reads the row it
   would have written to `trip`, the same way test/hotel_licence_date.test.mjs
   does. The unit under test is what lands in the database, not a helper. */
console.log('\nthe collector: the credential is never written at all');
{
  const MOD = new URL('../src/sources/hotel.js', import.meta.url).href;
  const DB = new URL('../src/db.js', import.meta.url).href;
  const E2E = `
    import { createServer } from 'node:http';
    const db = await import(process.argv[2]);
    const wrote = [];
    db.pool.query = async () => ({ rows: [{ id: 1 }], rowCount: 0 });
    db.pool.connect = async () => ({
      query: async (text, params = []) => {
        const m = /INSERT INTO (\\w+) \\(([^)]+)\\)/.exec(String(text));
        if (m) wrote.push({ table: m[1], cols: m[2].split(','), params });
        return { rows: [], rowCount: 0 };
      },
      release() {},
    });
    const trip = {
      _id: 't1', startTime: '2026-08-20T10:00:00.000Z', endTime: '2026-08-20T10:30:00.000Z',
      cost: 100, totalDistance: 12, status: 'finished', tripZone: 'inside-dubai',
      pickLocation: 'Airport Rd - Al Garhoud - Dubai', paymentMethod: 'cash',
      car: { carModel: 'Toyota Highlander', color: 'White', licenseNumber: 'L-46185' },
      driver: {
        _id: 'd1', firstName: 'Abusaad Siddiqui', lastName: 'Akhlaque Ahmad',
        phone: '971523817157', email: 'abusaad@example.ae',
        password: ${JSON.stringify(HASH)},
        emiratesId: ${JSON.stringify(EID)},
        notificationToken: ${JSON.stringify(PUSH)},
        driverLicense: '123456', licenseExpireDate: '1/1/26',
        role: 'driver', active: true, device: { brand: 'OPPO', model: 'A302OP' },
      },
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(/get-trip-report/.test(req.url)
        ? { data: { totalTrips: 1, trips: [trip] } } : { data: [] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.HOTEL_BASE = \`http://127.0.0.1:\${server.address().port}\`;
    process.env.HOTEL_TOKEN = 'x';
    const hotel = await import(process.argv[1]);
    await hotel.collect({ mode: 'incremental', from: '2026-08-20', to: '2026-08-21' });
    server.close();
    const pick = (t) => { const w = wrote.find((x) => x.table === t); return w
      ? Object.fromEntries(w.cols.map((c, i) => [c, w.params[i]])) : null; };
    console.log(JSON.stringify({ trip: pick('trip'), driver: pick('driver_compliance') }));
  `;
  const out = JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', E2E, MOD, DB],
    { env: { ...process.env, TZ: 'Asia/Dubai' }, encoding: 'utf8' }).trim().split('\n').pop());
  const raw = out.trip?.raw;
  const wire = JSON.stringify(raw);

  check('a trip row was written at all', !!raw, JSON.stringify(out).slice(0, 300));
  check('the stored booking carries no bcrypt hash', !wire.includes('$2b$10$'), wire.slice(0, 300));
  check('no Emirates ID', !wire.includes(EID));
  check('no push token — it is a capability, not a fact about a ride',
    !wire.includes('ExponentPushToken'));
  check('and no key left behind to hang one on later',
    !('password' in raw.driver) && !('emiratesId' in raw.driver)
    && !('notificationToken' in raw.driver));

  check('the row NAMES what it refused to store',
    JSON.stringify([...(raw._redacted || [])].sort())
      === JSON.stringify(['car.licenseNumber', 'driver.emiratesId',
        'driver.notificationToken', 'driver.password']),
    JSON.stringify(raw._redacted));

  /* Everything else is the audit trail and none of it moves. */
  check('phone survives — the operator asked for it in as many words',
    raw.driver.phone === '971523817157');
  check('email survives — #drivers renders it', raw.driver.email === 'abusaad@example.ae');
  check('the driver is still named', raw.driver.firstName === 'Abusaad Siddiqui');
  check('the licence number stays: it is not matched by the rule, and compliance prints it',
    raw.driver.driverLicense === '123456' && raw.driver.licenseExpireDate === '1/1/26');
  check('and every ordinary field of the booking is untouched',
    raw.cost === 100 && raw.tripZone === 'inside-dubai'
    && raw.pickLocation === 'Airport Rd - Al Garhoud - Dubai'
    && raw.car.carModel === 'Toyota Highlander' && raw.car.color === 'White');

  /* The one path the rule takes that is not a secret is the PLATE, and it
     costs no fact: the column beside it holds the same value. */
  check('the plate the redaction removed from raw is still a column on the row',
    out.trip.plate === 'L46185', String(out.trip.plate));
  check('the mapped columns are all unaffected',
    Number(out.trip.price) === 100 && out.trip.driver_ext_id === 'd1'
    && out.trip.driver_name === 'Abusaad Siddiqui Akhlaque Ahmad');
  check('and the compliance columns still get the documents the page prints',
    out.driver.emirates_id === EID && out.driver.licence_no === '123456',
    JSON.stringify(out.driver));
  check('while the credential is not in driver_compliance either',
    !JSON.stringify(out.driver).includes('$2b$10$'));
}

/* ── 3. and the rows already on disk ──────────────────────────────────────── */
console.log('\nthe migration: what is already stored comes out');
{
  const db = new PGlite();
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  await applySchema(db);
  const v59 = readFileSync(new URL('../sql/schema_v59.sql', import.meta.url), 'utf8');

  await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

  const LEGACY = {
    _id: 'h-1', cost: 100, tripZone: 'inside-dubai',
    pickLocation: 'Airport Rd - Al Garhoud - Dubai',
    car: { carModel: 'Toyota Highlander', licenseNumber: 'L46706' },
    driver: {
      _id: 'd1', firstName: 'Abusaad', lastName: 'Ahmad', phone: '971523817157',
      email: 'abusaad@example.ae', password: HASH, emiratesId: EID,
      notificationToken: PUSH, driverLicense: '123456',
      device: { brand: 'OPPO', model: 'A302OP' },
    },
  };
  const ins = (id, platform, raw) => q(
    `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,requested_at,status,raw)
     VALUES ($1,$2,'ecosine','L46706','d1','2026-08-31T21:02:40+04','completed',$3)`,
    [platform, id, raw == null ? null : JSON.stringify(raw)]);

  await ins('h-1', 'hotel', LEGACY);
  // A booking the fixed collector wrote: already clean, already declaring what
  // it withheld. The migration must not touch it or double its list.
  await ins('h-2', 'hotel', { _id: 'h-2', cost: 40, driver: { phone: '9715', firstName: 'Ali' },
    _redacted: ['driver.password'] });
  // Rows the statement has to step over rather than fail on.
  await ins('u-1', 'uber', { tier: 'comfort', uber_payments: { fare: 40 } });
  await ins('h-3', 'hotel', { _id: 'h-3', driver: 'just a name, not a record' });
  await ins('h-4', 'hotel', null);

  const FIELDS = (values) => JSON.stringify([
    { key: 'status', type: 'string', fill_pct: 100, distinct_seen: 2, distinct_capped: false,
      values: ['finished', 'cancelled'] },
    { key: 'driver.password', type: 'string', fill_pct: 100, distinct_seen: 2,
      distinct_capped: false, values },
    { key: 'driver_ext_id', type: 'string', fill_pct: 100, distinct_seen: 4,
      distinct_capped: false, values: ['d-1', 'd-2', 'd-3', 'd-4'] },
    { key: 'trip_uuid', type: 'string', fill_pct: 100, distinct_seen: 300,
      distinct_capped: true, values: null },
  ]);
  const probe = (provider, surface, fields) => q(
    `INSERT INTO provider_probe (provider,surface,ok,http_status,record_count,fields)
     VALUES ($1,$2,true,200,60,$3)`, [provider, surface, fields]);
  await probe('hotel', 'trip-report', FIELDS([HASH, '$2b$10$other']));
  await probe('uber', 'drivers', JSON.stringify([{ key: 'first_name', type: 'string',
    fill_pct: 100, distinct_seen: 3, distinct_capped: false, values: ['A', 'B', 'C'] }]));
  await probe('bolt', 'getDrivers', null);           // never described
  await probe('yango', 'orders/list', JSON.stringify(null));

  /* Read back through Postgres BEFORE the migration, not from the literals
     above: jsonb re-orders an object's keys on the way in, so "untouched" can
     only be tested against what the database was actually holding. */
  const before = await q(`SELECT platform, external_id, raw FROM trip ORDER BY external_id`);
  const probesBefore = Object.fromEntries((await q(
    `SELECT provider, fields FROM provider_probe`)).map((r) => [r.provider, JSON.stringify(r.fields)]));
  /* applySchema() above replayed every migration INCLUDING this one, so the
     schema_once guard has already fired and the rows seeded since would be
     stepped over. Clear it, so what runs below is the migration meeting the
     data it was written for — which is the whole point of the section. The
     guard's own behaviour is asserted further down, twice: that a second boot
     changes nothing, and that the statements are idempotent even with the row
     deleted by hand. */
  await q(`DELETE FROM schema_once WHERE name = 'v59_scrub_stored_credentials'`);
  await db.exec(v59);

  const rows = Object.fromEntries((await q(
    `SELECT external_id, raw FROM trip ORDER BY external_id`)).map((r) => [r.external_id, r.raw]));
  const h1 = JSON.stringify(rows['h-1']);

  check('the stored bcrypt hash is gone', !h1.includes('$2b$10$'), h1.slice(0, 200));
  check('the stored Emirates ID is gone', !h1.includes(EID));
  check('the stored push token is gone', !h1.includes('ExponentPushToken'));
  check('and the keys are gone with the values, not blanked',
    !('password' in rows['h-1'].driver) && !('emiratesId' in rows['h-1'].driver)
    && !('notificationToken' in rows['h-1'].driver));
  check('the scrubbed row NAMES the paths it no longer holds',
    JSON.stringify([...rows['h-1']._redacted].sort())
      === JSON.stringify(['driver.emiratesId', 'driver.notificationToken', 'driver.password']),
    JSON.stringify(rows['h-1']._redacted));

  /* The audit trail is the point of the column. Only the credentials come out. */
  check('every other field of the booking survives, to the byte',
    rows['h-1'].cost === 100 && rows['h-1'].tripZone === 'inside-dubai'
    && rows['h-1'].pickLocation === 'Airport Rd - Al Garhoud - Dubai'
    && rows['h-1'].car.licenseNumber === 'L46706'
    && rows['h-1'].car.carModel === 'Toyota Highlander');
  check('phone, email and name survive the scrub',
    rows['h-1'].driver.phone === '971523817157'
    && rows['h-1'].driver.email === 'abusaad@example.ae'
    && rows['h-1'].driver.firstName === 'Abusaad');
  check('so does the licence number the compliance page prints',
    rows['h-1'].driver.driverLicense === '123456'
    && rows['h-1'].driver.device.brand === 'OPPO');

  const same = (id) => JSON.stringify(rows[id])
    === JSON.stringify(before.find((b) => b.external_id === id).raw);
  check('a row the fixed collector wrote is left exactly as it was', same('h-2'),
    JSON.stringify(rows['h-2']));
  check('a row from another platform is not touched', same('u-1'));
  check('a booking whose driver is not a record does not fail the statement', same('h-3'));
  check('and a row with no raw at all is a no-op, not an error',
    rows['h-4'] === null, JSON.stringify(rows['h-4']));

  const probes = Object.fromEntries((await q(
    `SELECT provider, surface, fields FROM provider_probe`)).map((r) => [r.provider, r.fields]));
  const hotelFields = Object.fromEntries(probes.hotel.map((f) => [f.key, f]));

  check('the sampled hash is gone from the stored probe',
    !JSON.stringify(probes.hotel).includes('$2b$10$'), JSON.stringify(probes.hotel).slice(0, 200));
  check('the suppressed field says it was withheld, and why',
    hotelFields['driver.password'].values_withheld === true
    && /credential or an identity document/.test(hotelFields['driver.password'].values[0])
    && /api\/redact\.js/.test(hotelFields['driver.password'].values_withheld_reason),
    JSON.stringify(hotelFields['driver.password']));
  check('the placeholder is the one src/probe.js writes, so old and new rows read alike',
    hotelFields['driver.password'].values[0]
      === '(withheld — a credential or an identity document by name)');
  check('the counts are untouched — they are what the page reasons from',
    hotelFields['driver.password'].distinct_seen === 2
    && hotelFields['driver.password'].fill_pct === 100);
  check('an ordinary field of the same probe row is unchanged',
    JSON.stringify(hotelFields.status.values) === JSON.stringify(['finished', 'cancelled']));
  check('driver_ext_id keeps its values — the KEEP list survives the transcription',
    JSON.stringify(hotelFields.driver_ext_id.values) === JSON.stringify(['d-1', 'd-2', 'd-3', 'd-4']));
  check('a field already suppressed for width is left alone',
    hotelFields.trip_uuid.values === null && !hotelFields.trip_uuid.values_withheld);
  check('a probe row with nothing secret in it is untouched',
    JSON.stringify(probes.uber) === probesBefore.uber,
    `${JSON.stringify(probes.uber)} vs ${probesBefore.uber}`);
  check('a probe row that described nothing does not fail the statement',
    probes.bolt === null && probes.yango === null);

  /* It replays from the start on every boot. */
  const once = await q(`SELECT name FROM schema_once WHERE name = 'v59_scrub_stored_credentials'`);
  check('the one-time change is recorded so the next boot skips it', once.length === 1);

  const snapshot = JSON.stringify(await q(
    `SELECT external_id, raw FROM trip ORDER BY external_id`))
    + JSON.stringify(await q(`SELECT provider, fields FROM provider_probe ORDER BY provider`));
  await db.exec(v59);
  const afterGuarded = JSON.stringify(await q(
    `SELECT external_id, raw FROM trip ORDER BY external_id`))
    + JSON.stringify(await q(`SELECT provider, fields FROM provider_probe ORDER BY provider`));
  check('a second boot changes nothing', afterGuarded === snapshot);

  /* And with the guard row removed by hand — the shape a restore from backup,
     or a fresh database replaying an old dump, can produce — the statements
     still have to be no-ops on data that is already clean rather than
     appending a second `_redacted` entry or failing on an absent key. */
  await q(`DELETE FROM schema_once WHERE name = 'v59_scrub_stored_credentials'`);
  await db.exec(v59);
  const afterUnguarded = JSON.stringify(await q(
    `SELECT external_id, raw FROM trip ORDER BY external_id`))
    + JSON.stringify(await q(`SELECT provider, fields FROM provider_probe ORDER BY provider`));
  check('and the statements are idempotent on their own account, guard or no guard',
    afterUnguarded === snapshot, afterUnguarded.slice(0, 300));

  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
