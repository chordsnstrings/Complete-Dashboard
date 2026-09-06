/* One person's papers, on the route that hands out ONE PERSON.
   ─────────────────────────────────────────────────────────────────────────
   /api/compliance/drivers stopped serving emirates_id and licence_no to a
   caller with no token. /api/driver/profile did not, and it is the sharper of
   the two: the roster returns a list somebody has to sift, this returns the
   documents of a NAMED individual, which is the shape an attacker actually
   wants. It lives in api/driver_routes.js rather than api/server.js, so the
   change to the roster could not touch it and the redaction test written
   against api/server.js could not see it.

   Measured on production 2026-09-05, with curl and no credentials, AFTER the
   roster fix was written:

     GET /api/driver/profile?id=67483c64055e070d791000fa
       → compliance[0] = {platform:'hotel', emirates_id:'784-1977-5137316-4',
                          licence_no:'123456', …}

   That is a UAE national identity number, complete, from an endpoint anyone
   can reach. The id itself came from /api/compliance/drivers in the same
   breath, so no guessing was involved.

   ── what this file pins ─────────────────────────────────────────────────
   Both directions, because a redaction that also removes the phone number
   would be a broken page dressed as a security fix, and one that leaves the
   Emirates ID is not a fix at all:

     · with no token   the two identity documents are gone, `identity_withheld`
                       names them, and a reason is given;
     · with the token  they are present and nothing claims to be withheld;
     · either way      name, phone, email, picture, rating, state, the licence
                       EXPIRY and every other column survive — the operator
                       asked for the contact details in as many words and four
                       pages render them.

   And one thing that is not about the payload: `identity_held`, which is
   counted on the server BEFORE the values are dropped. The card renders a
   value only when it is truthy, so without it a withheld number would just
   vanish from the page — indistinguishable from a channel that never filed
   one, which is the single confusion this product exists to prevent. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet } from './fixture.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const EMIRATES = '784-1977-5137316-4';
const LICENCE = 'AE-REAL-88214';
const PHONE = '+971500000001';
const EMAIL = 'khalid@example.com';
const TOKEN = 'test-admin-token';

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await db.query(
  `UPDATE driver_compliance
      SET emirates_id = $1, licence_no = $2, phone = $3, email = $4,
          picture_url = 'https://example.invalid/p.jpg'
    WHERE driver_ext_id = 'u-khalid'`, [EMIRATES, LICENCE, PHONE, EMAIL]);
/* The PHOTOGRAPH, which since sql/schema_v63.sql is the bytes rather than the
   address. driver_compliance.picture_url above still holds what Uber returned —
   a link signed for twelve hours — and that string is deliberately never
   emitted; what a reader is offered is this origin's address for the copy on
   file. Both are seeded here so the assertion below tests the right thing: not
   that some URL survives redaction, but that the photograph does. */
await db.query(
  `INSERT INTO driver_photo (platform, driver_ext_id, bytes, content_type, byte_len, sha256)
   VALUES ('uber','u-khalid', $1, 'image/jpeg', 3, 'deadbeef')`,
  [Buffer.from([0xff, 0xd8, 0xff])]);

const { port, server } = await mountAll(db);
const get = async (p, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text), text }; }
  catch { return { status: r.status, body: null, text }; }
};

/* The gate reads process.env at request time, which is what lets one process
   drive both states. Restored at the foot so nothing after this file inherits
   an admin token it did not set. */
const hadToken = process.env.ADMIN_TOKEN;
process.env.ADMIN_TOKEN = TOKEN;

const anon = await get('/api/driver/profile?id=u-khalid');
const admin = await get('/api/driver/profile?id=u-khalid', { 'x-admin-token': TOKEN });

console.log('\n── with no token ──');
check('the route answers at all', anon.status === 200, `${anon.status} ${anon.text.slice(0, 120)}`);
/* By id, not [0]. This person holds an Uber account and a Yango one, so
   `compliance` carries a row per platform and which lands first is an ORDER BY
   nobody wrote — the assertions below would otherwise be checking a row this
   test never seeded. */
const rowFor = (b) => (b?.compliance || []).find((r) => r.driver_ext_id === 'u-khalid') || {};
const ac = rowFor(anon.body);
check('the Emirates ID is not in the payload', !/784-1977-5137316-4/.test(anon.text), anon.text.slice(0, 200));
check('…and not on the compliance row either', !('emirates_id' in ac), JSON.stringify(Object.keys(ac)));
check('the licence number is not in the payload', !new RegExp(LICENCE).test(anon.text));
check('…and not on the compliance row either', !('licence_no' in ac), JSON.stringify(Object.keys(ac)));

check('both columns are NAMED as withheld',
  ['licence_no', 'emirates_id'].every((c) => (anon.body?.identity_withheld || []).includes(c)),
  JSON.stringify(anon.body?.identity_withheld));
check('and a reason is given in words a reader can act on',
  /x-admin-token/.test(anon.body?.identity_withheld_reason || ''),
  anon.body?.identity_withheld_reason);
/* Counted before the values were dropped. Both are on file for this person, so
   the card must print "withheld" for both rather than nothing at all. */
check('what the record HOLDS is reported separately from what was sent',
  ['licence_no', 'emirates_id'].every((c) => (anon.body?.identity_held || []).includes(c)),
  JSON.stringify(anon.body?.identity_held));

console.log('\n── the features the operator asked for survive it ──');
check('the phone number is still there', ac.phone === PHONE, ac.phone);
check('the email is still there', ac.email === EMAIL, ac.email);
/* Pinned to the PHOTOGRAPH, not to the string. This read
   /example\.invalid/.test(ac.picture_url) — asserting that whatever Uber's own
   column happened to hold came back out — so it would have passed for as long
   as the product kept handing readers a twelve-hour signed CloudFront URL that
   was 403 by the time anybody clicked it, and it failed the moment that stopped.
   What the operator asked for is a face on the page. The property is that an
   anonymous caller is still offered one. */
check('the picture is still there', ac.picture_url === '/api/driver/photo/uber/u-khalid',
  ac.picture_url);
check('…and it is this origin’s address, not a link this product cannot re-sign',
  typeof ac.picture_url === 'string' && ac.picture_url.startsWith('/'),
  ac.picture_url);
check('…while Uber’s own expiring url never leaves',
  !/example\.invalid/.test(anon.text), (anon.text.match(/example\.invalid[^"]{0,40}/) || [''])[0]);
check('the name is still there', /Khalid/.test(ac.full_name || ''), ac.full_name);
/* The EXPIRY is the whole point of the compliance page and is not a document
   number. Redacting it would answer a security finding by deleting the
   product's most consequential sentence. */
check('the licence expiry survives', Boolean(ac.licence_expires), ac.licence_expires);
check('so does the days-left figure derived from it', ac.licence_days_left != null, ac.licence_days_left);
check('and the platform state', Boolean(ac.state), ac.state);
check('the rest of the profile is untouched',
  anon.body?.span != null && Array.isArray(anon.body?.vehicles) && Array.isArray(anon.body?.accounts));

console.log('\n── with the token ──');
check('the route answers', admin.status === 200, `${admin.status}`);
const dc = rowFor(admin.body);
check('the Emirates ID is returned', dc.emirates_id === EMIRATES, dc.emirates_id);
check('the licence number is returned', dc.licence_no === LICENCE, dc.licence_no);
check('and nothing claims to have been withheld',
  Array.isArray(admin.body?.identity_withheld) && admin.body.identity_withheld.length === 0
  && admin.body?.identity_withheld_reason == null,
  JSON.stringify(admin.body?.identity_withheld));

console.log('\n── a wrong token is not an admin ──');
const wrong = await get('/api/driver/profile?id=u-khalid', { 'x-admin-token': 'nope' });
check('the identity documents stay withheld', !/784-1977-5137316-4/.test(wrong.text));

/* With no ADMIN_TOKEN configured — the state this instance is actually in —
   isAdmin() is false for everybody, so the documents are withheld from
   everybody. That is the correct failure mode: an instance with no way to
   authenticate an administrator has no administrator. */
console.log('\n── and on an instance with no ADMIN_TOKEN set ──');
delete process.env.ADMIN_TOKEN;
const unconfigured = await get('/api/driver/profile?id=u-khalid', { 'x-admin-token': TOKEN });
check('nobody is an administrator, so the documents stay withheld',
  !/784-1977-5137316-4/.test(unconfigured.text));
check('and the withholding is still explained rather than silent',
  (unconfigured.body?.identity_withheld || []).length === 2
  && Boolean(unconfigured.body?.identity_withheld_reason));

if (hadToken === undefined) delete process.env.ADMIN_TOKEN;
else process.env.ADMIN_TOKEN = hadToken;

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
