/* A bcrypt hash, a national identity number and a push token on the open web.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production 2026-09-05 with curl and NO credentials — no cookie,
   no header, no token, because this product has no user authentication at all:

     /api/trip?platform=hotel&id=…      driver.password  $2b$10$8aVY3fEcseIj4…
                                        driver.emiratesId 784-1999-8885500-5
                                        driver.notificationToken
                                          ExponentPushToken[U_mydqA-q0vfNo…]
                                        on 12 of 12 hotel trips sampled,
                                        0 of 36 uber/bolt/yango
     /api/schema/raw-values             key=driverInfo, 60 provider records
     /api/compliance/drivers            289 rows: emirates_id 123, licence 94
     /api/export/trips.csv              265,739 rows in one GET, with pickup
                                        and drop-off addresses

   api/redact.js is the one place that decides what leaves. This file holds
   down the two halves of that decision that are easy to get wrong in opposite
   directions — redacting too little, and redacting a feature. */
import { redactRaw, secretField, redactSampleValue, SECRET_KEY } from '../api/redact.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The literal shapes production was serving, so this test fails if the real
   payload ever gets past the matcher again. */
const HOTEL = {
  _id: '6a95b3691698f7d77013df68',
  driver: {
    firstName: 'Mohammed', lastName: 'Alsous',
    phone: '971523817157', email: 'd@example.com',
    password: '$2b$10$8aVY3fEcseIj4yOojdvt7ea46',
    emiratesId: '784-1999-8885500-5',
    notificationToken: 'ExponentPushToken[U_mydqA-q0vfNo]',
    licenseNumber: 'DXB-4482910',
  },
  driver_ext_id: '67483c64055e070d791000ee',
  authorization: { status: 'pending', approver: null },
  price: 90,
};

console.log('\nwhat must not leave');

const r = redactRaw(HOTEL);
check('the bcrypt hash is gone', !JSON.stringify(r.value).includes('$2b$10$'));
check('the Emirates ID is gone', !JSON.stringify(r.value).includes('784-1999'));
check('the push token is gone', !JSON.stringify(r.value).includes('ExponentPushToken'));
check('the licence number is gone', !JSON.stringify(r.value).includes('DXB-4482910'));
check('…and every one of them is NAMED as withheld',
  ['driver.password', 'driver.emiratesId', 'driver.notificationToken', 'driver.licenseNumber']
    .every((p) => r.removed.includes(p)),
  JSON.stringify(r.removed));

console.log('\nwhat must stay — these are features, not leaks');

/* The operator asked for these in as many words: "let's have uber drivers phone
   numbers email address and pictures if possible". Removing them here would
   break #drivers, #roster and every driver page on purpose while calling it a
   security fix. */
check('the phone number stays', r.value.driver.phone === '971523817157');
check('the email stays', r.value.driver.email === 'd@example.com');
check('the name stays', r.value.driver.firstName === 'Mohammed');
/* driver_ext_id is the join key every page is built on, and `authorization` on
   a corporate booking is an approval object — #corporate's whole leakage tab
   reads it — not an HTTP header. */
check('driver_ext_id stays, though it ends in _id',
  r.value.driver_ext_id === '67483c64055e070d791000ee');
check('the corporate authorization object stays, though it is called auth-something',
  r.value.authorization && r.value.authorization.status === 'pending');
check('the ride itself is untouched', r.value.price === 90 && r.value._id === HOTEL._id);

console.log('\nit never mutates what it was given');
check('the caller’s object still has its secrets',
  HOTEL.driver.password === '$2b$10$8aVY3fEcseIj4yOojdvt7ea46',
  'the stored raw is the audit trail; only the copy that LEAVES is stripped');

console.log('\ndepth and arrays');
const nested = redactRaw({ a: [{ token: 'x', keep: 1 }, { b: { apiKey: 'y', ok: 2 } }] });
check('a secret inside an array inside an object is found',
  !JSON.stringify(nested.value).includes('"x"') && !JSON.stringify(nested.value).includes('"y"'));
check('…and its path is reported with the index',
  nested.removed.some((p) => p.includes('[0]')) && nested.removed.some((p) => p.includes('[1]')),
  JSON.stringify(nested.removed));
check('the neighbours survive',
  nested.value.a[0].keep === 1 && nested.value.a[1].b.ok === 2);

console.log('\nthe field sampler');
/* /api/schema/raw-values exists to say whether a field is a dimension worth
   charting. For a secret it can answer that from the count alone. */
check('a secret-shaped field name refuses to be sampled', secretField('password') && secretField('otp'));
check('…and a join key does not', !secretField('driver_ext_id') && !secretField('external_id'));
/* driverInfo is an OBJECT that `raw ->> key` serialises into the value column,
   so refusing the key is not enough — the value has to be cleaned too. */
const sampled = redactSampleValue(JSON.stringify(
  { driverUuid: 'u', email: 'e@x', firstName: 'A', phone: '9715', password: 'p' }));
check('an object arriving as a scalar sample is redacted inside',
  !sampled.includes('password') && sampled.includes('driverUuid') && sampled.includes('9715'),
  sampled);
check('a plain scalar sample is passed through untouched',
  redactSampleValue('completed') === 'completed');
check('null survives', redactSampleValue(null) === null);

console.log('\nthe matcher is a SHAPE, not a list of today’s four keys');
/* A provider adds a field whenever it likes and nobody re-reads this file when
   they do. The cost of a false positive is one withheld value on a diagnostic
   page, named as withheld; the cost of a false negative is a national identity
   number on the open web. */
check('it catches names this feed has never sent',
  ['nationalId', 'passportNo', 'ibanNumber', 'cardNumber', 'sessionCookie', 'refresh_token']
    .every((k) => SECRET_KEY.test(k)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
