/* ── /api/trip was serving a driver's login credential to anyone ───────────
   Measured on production 2026-09-05, with curl and no credentials:
   /api/trip?platform=hotel&id=6a95b3691698f7d77013df68 answered 200 and
   trip.raw.driver carried `password` ($2b$10$… bcrypt cost 10), `emiratesId`
   784-1999-8885500-5 and `notificationToken` ExponentPushToken[…] — on 12 of
   12 hotel trips sampled, 0 of 36 uber/bolt/yango ones. The hotel channel is a
   document store whose booking EMBEDS the driver record, so every booking this
   route can address carried that driver's password hash.

   Three things have to be true at once for the fix to be a fix, and this file
   asserts all three:

     1. the credential does not leave;
     2. phone and email DO leave, because they are a feature the operator asked
        for and #drivers renders them — a redaction that quietly took them out
        would be breaking a page and calling it security;
     3. the response SAYS what it withheld. A field silently missing from `raw`
        is indistinguishable from a field the provider never sent, and telling
        those two apart is this product's central claim.

   And one thing that must NOT be true: the strip must not have happened at
   ingest. `raw` is the audit trail every "what did the provider actually send"
   answer is read from, so the stored row keeps everything and the boundary
   decides what leaves. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { tripRoutes } from '../api/trip_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* The hotel booking, shaped like the production record above: the driver row
   embedded whole, secrets and all, and `licenseNumber` on the car holding the
   PLATE rather than a driving licence. */
const HOTEL_RAW = {
  _id: '6a95b3691698f7d77013df68',
  cost: 100,
  type: 'drop_off',
  tripZone: 'inside-dubai',
  pickLocation: 'Airport Rd - Al Garhoud - Dubai',
  car: {
    carModel: 'Toyota Highlander',
    color: 'White',
    licenseNumber: 'L46706',
  },
  driver: {
    _id: '68f744f88c482942eaaba18b',
    firstName: 'Abusaad Siddiqui',
    lastName: 'Akhlaque Ahmad',
    phone: '971523817157',
    email: 'abusaad@example.ae',
    password: '$2b$10$8aVY3fEcseIj4yOojdvt7ea46DJZopAjK58x0p.YFca63NSrQctcq',
    emiratesId: '784-1999-8885500-5',
    notificationToken: 'ExponentPushToken[U_mydqA-q0vfNoQeecJiIJ]',
    device: { brand: 'OPPO', model: 'A302OP' },
  },
  attachments: [{ note: 'signed', passportNumber: 'P1234567' }],
  authorization: null,
};
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
     requested_at,ended_at,distance_km,status,price,currency,raw)
   VALUES ('hotel','h-1','ecosine','L46706','68f744f88c482942eaaba18b','Abusaad Siddiqui Akhlaque Ahmad',
     '2026-08-31T21:02:40+04','2026-08-31T21:38:02+04',24.86,'completed',100,'AED',$1)`,
  [JSON.stringify(HOTEL_RAW)]);

/* An Uber trip: nothing secret in its raw, and the payments components the
   money panel is built from. Both halves matter — the empty removal list is a
   statement, and the money must survive the redaction that walks over it. */
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
     requested_at,status,distance_km,raw)
   VALUES ('uber','u-1','ecosine','L100','d-1','Ali Khan','2026-08-20T06:00:00+04','completed',18.2,$1)`,
  [JSON.stringify({
    tier: 'comfort',
    uber_payments: {
      fare: 40, fare_base: 30, earnings: 34, service_fee: -6,
      cash_collected: 12, tip: 3, adjustment: 0, transactions: 2,
    },
  })]);

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
tripRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

const h = (await get('/api/trip?platform=hotel&id=h-1')).body;
/* The whole response, because a secret that moved to another key on the way
   out is still served. The key NAMES are expected to survive — in
   raw_redacted, which is the point of the fix — so the values are what these
   assertions hunt for. */
const hWire = JSON.stringify(h);
const rawWire = JSON.stringify(h.trip.raw);

console.log('\nthe credential does not leave the boundary');

check('no bcrypt hash anywhere in the response',
  !hWire.includes('$2b$10$') && !hWire.includes('YFca63NSrQctcq'));
check('no Emirates ID anywhere in the response, and no key to hang one on',
  !hWire.includes('784-1999-8885500-5') && !rawWire.includes('emiratesId'));
check('no Expo push token anywhere in the response — it is a capability, not a fact',
  !hWire.includes('ExponentPushToken') && !rawWire.includes('notificationToken'));
check('and the rule reaches inside an array, not just the top level',
  !hWire.includes('P1234567'), hWire.slice(0, 200));

console.log('\nbut the record is still the record');

check('phone survives — the operator asked for driver phone numbers',
  h.trip.raw.driver.phone === '971523817157');
check('email survives — #drivers renders it',
  h.trip.raw.driver.email === 'abusaad@example.ae');
check('the driver is still named',
  h.trip.raw.driver.firstName === 'Abusaad Siddiqui'
  && h.trip.raw.driver.lastName === 'Akhlaque Ahmad');
check('and every non-secret field of the booking is untouched',
  h.trip.raw.cost === 100 && h.trip.raw.tripZone === 'inside-dubai'
  && h.trip.raw.pickLocation === 'Airport Rd - Al Garhoud - Dubai'
  && h.trip.raw.car.carModel === 'Toyota Highlander');
/* `authorization` on a booking is an approval object, not a header, and
   #corporate reads it. KEEP exists so a security fix does not eat it. */
check('authorization is kept — it is an approval, not a credential',
  'authorization' in h.trip.raw);
check('the mapped columns are unaffected',
  Number(h.trip.price) === 100 && h.trip.plate === 'L46706'
  && h.trip.driver_name === 'Abusaad Siddiqui Akhlaque Ahmad');

console.log('\nand it says what it withheld');

check('the removed paths come back on the response',
  Array.isArray(h.raw_redacted)
  && JSON.stringify([...h.raw_redacted].sort())
    === JSON.stringify(['attachments[0].passportNumber', 'car.licenseNumber',
      'driver.emiratesId', 'driver.notificationToken', 'driver.password']),
  JSON.stringify(h.raw_redacted));
/* The one false positive, and the reason it is affordable: the value it took
   is the plate, which this same response carries as a column and the page
   prints — and the path is named rather than leaving a hole. */
check('the false positive on car.licenseNumber costs no fact — the plate is a column',
  h.raw_redacted.includes('car.licenseNumber') && h.trip.plate === 'L46706');

const u = (await get('/api/trip?platform=uber&id=u-1')).body;
check('a record with nothing to withhold says so with an empty list, not a missing key',
  Array.isArray(u.raw_redacted) && u.raw_redacted.length === 0,
  JSON.stringify(u.raw_redacted));
check('and that record is served whole',
  u.trip.raw.tier === 'comfort');
/* The money panel is derived from raw. A redaction that blanked it would be a
   different bug wearing the same fix. */
check('the money the payments report states per trip survives redaction',
  Number(u.trip_money.fare) === 40 && Number(u.trip_money.earnings) === 34
  && Number(u.trip_money.cash_collected) === 12 && Number(u.trip_money.tip) === 3
  && Number(u.trip_money.transactions) === 2,
  JSON.stringify(u.trip_money));

console.log('\nredaction is at the boundary, not at ingest');

/* If this ever fails, the audit trail has been destroyed to fix the leak: the
   stored row is the only place "what did the provider actually send" can be
   answered from, and a cleaned row can never answer it again. */
const [stored] = await q(`SELECT raw FROM trip WHERE platform='hotel' AND external_id='h-1'`);
const raw = typeof stored.raw === 'string' ? JSON.parse(stored.raw) : stored.raw;
check('the stored row still holds everything the provider sent',
  raw.driver.password.startsWith('$2b$10$') && raw.driver.emiratesId === '784-1999-8885500-5'
  && raw.driver.notificationToken.startsWith('ExponentPushToken['));

console.log('\nthe page names what it is not being shown');

const page = readFileSync('api/public/trip.js', 'utf8');
const block = page.slice(page.indexOf("What the provider actually sent"));
check('it reads the withheld paths off the response',
  /d\.raw_redacted/.test(block));
check('it names them, and says why they are gone',
  /withheld/.test(block) && /identity documents and credentials are not served/.test(block));
check('it still renders the record it was given',
  /pre\.textContent = JSON\.stringify\(t\.raw/.test(block));
/* One line, in the caption idiom the block already uses — the operator asked
   for a fix, not a redesign. */
check('one line in the existing caption style, not a new component or panel',
  /el\('p', 'cap'/.test(block) && !/panel\(/.test(block));
check('and no line at all when the provider record had nothing withheld',
  /if \(withheld\.length\)/.test(block));

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
