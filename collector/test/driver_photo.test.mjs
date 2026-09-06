/* A photograph, not a twelve-hour pass to one.
   ─────────────────────────────────────────────────────────────────────────
   driver_compliance.picture_url holds what Uber's GraphQL returns for
   pictureUrl, verbatim — a CloudFront URL carrying Expires, Key-Pair-Id and
   Signature, valid for exactly twelve hours. Measured on production
   2026-09-06: two profile runs finished at 02:01:58.698Z and 02:03:05.617Z on
   4 September; the 156 URLs they wrote expired between 13:59:00Z and
   14:03:04Z — 11.999528 h and 11.999551 h after their own runs, two
   independent batches agreeing to a tenth of a second. Every one of them
   answered 403 AccessDenied, and the collector that refreshes them is
   scheduled weekly, so the best possible steady state was twelve working hours
   in every hundred and sixty-eight.

   These tests assert the PROPERTIES that make that impossible to repeat, not
   the shape of any particular fix:

     1. no route hands a reader a URL on somebody else's host
     2. the bytes are served from this origin, by digest, and 304 on a repeat
     3. a driver with no photograph is a 404 with a reason, not an empty 200
     4. an unchanged photograph is not rewritten
     5. the page can tell "no photograph on file" from "could not fetch it" */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* A real one-pixel JPEG, so content-type and length are not invented. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const sha = (b) => import('node:crypto').then((c) => c.createHash('sha256').update(b).digest('hex'));
const DIGEST = await sha(JPEG);

await q(`INSERT INTO driver_photo (platform, driver_ext_id, bytes, content_type, byte_len, sha256, source_url)
         VALUES ('uber','drv-photo',$1,'image/jpeg',$2,$3,'https://d1w2poirtb3as9.cloudfront.net/x.jpeg?Expires=1&Signature=y')`,
  [JPEG, JPEG.length, DIGEST]);

const { get, port } = await mountAll(db, { serverRoutes: true });
/* The harness's get() parses JSON and drops the headers, and this route's whole
   contract is in the headers and the bytes. So the image is fetched raw. */
const raw = (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers });

console.log('\nthe bytes come from this origin, and only from here');

const hit = await raw('/api/driver/photo/uber/drv-photo');
check('a stored photograph is served', hit.status === 200, String(hit.status));
check('…as an image, with the type it was stored under',
  /^image\/jpeg/.test(String(hit.headers.get('content-type') || '')),
  String(hit.headers.get('content-type')));
/* The BYTES, not a redirect. A redirect would send the reader back to the
   CloudFront URL that authorises for twelve hours, which is the whole defect. */
const got = Buffer.from(await hit.arrayBuffer());
check('…and the bytes are the ones that were stored, to the byte',
  got.equals(JPEG), `${got.length} bytes against ${JPEG.length}`);

/* The digest IS the validator. A photograph changes when Uber's does, which is
   approximately never, so a repeat visit must cost a 304 rather than 4kb. */
const etag = hit.headers.get('etag');
check('it carries an ETag, and the ETag is the digest',
  typeof etag === 'string' && etag.includes(DIGEST), String(etag));
const again = await raw('/api/driver/photo/uber/drv-photo', { 'if-none-match': etag });
check('…and a reader who already has it gets 304, not the bytes again',
  again.status === 304, String(again.status));

console.log('\na driver with no photograph is an absence with a reason');

const none = await get('/api/driver/photo/uber/nobody');
check('no row is a 404, not an empty 200', none.status === 404, String(none.status));
check('…and it says which of the two things is true',
  /no photo on file/i.test(JSON.stringify(none.body || {})), JSON.stringify(none.body));

console.log('\nno route hands a reader a URL on somebody else’s host');

/* THE ASSERTION THIS FILE EXISTS FOR. It is not about CloudFront by name: any
   absolute URL is a promise this product cannot keep, because it did not mint
   the credential and cannot renew it. A relative path on this origin is the
   only kind of photo address that survives its own storage. */
const CDN = 'https://d1w2poirtb3as9.cloudfront.net/expired.jpeg?Expires=1&Key-Pair-Id=K&Signature=S';
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, picture_url)
         VALUES ('uber','drv-photo','Photographed Person',$1),
                ('uber','drv-nopic','Unphotographed Person',$2)`, [CDN, CDN]);

for (const [name, path] of [
  ['the compliance list', '/api/compliance/drivers'],
  ['the driver directory', '/api/drivers/directory?days=30'],
]) {
  const r = await get(path);
  const body = JSON.stringify(r.body ?? {});
  check(`${name} emits no absolute photo URL`,
    !/d1w2poirtb3as9|cloudfront/i.test(body), body.slice(0, 200));
  check(`…and none of its picture_url values leaves this origin`,
    !/"picture_url"\s*:\s*"https?:/i.test(body),
    (body.match(/"picture_url"\s*:\s*"[^"]{0,60}/) || [''])[0]);
}

/* And the one that carries the address we DO serve. */
{
  const r = await get('/api/compliance/drivers');
  const rows = (r.body?.drivers || r.body?.rows || []);
  const shot = rows.find((x) => x.driver_ext_id === 'drv-photo');
  const bare = rows.find((x) => x.driver_ext_id === 'drv-nopic');
  check('a driver whose photograph we hold gets this origin’s address for it',
    !!shot && shot.picture_url === '/api/driver/photo/uber/drv-photo',
    JSON.stringify(shot?.picture_url));
  /* The other half, and the reason the first is not enough: a driver whose
     compliance row carries a dead CloudFront URL and whose bytes we do NOT
     hold must get null — not the dead URL, and not somebody else's photo. */
  check('…and a driver whose photograph we do not hold gets nothing at all',
    !!bare && bare.picture_url === null, JSON.stringify(bare?.picture_url));
}

console.log('\nthe page can tell the two absences apart');

/* onerror="this.remove()" deleted the img and revealed the initials already
   painted underneath — so a driver with no photograph and a photograph that
   403s rendered identically, which is how 156 dead images looked like a normal
   page for two days. */
const uiJs = readFileSync(new URL('../api/public/ui.js', import.meta.url), 'utf8');
const mUiJs = readFileSync(new URL('../api/public/m/ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../api/public/app.css', import.meta.url), 'utf8');
check('a failed photograph marks itself on the desktop', /av-lost/.test(uiJs));
check('…and on the phone', /av-lost/.test(mUiJs));
check('…and the mark is styled, not merely applied', /\.av-lost\{/.test(css));
check('…and it says which absence it is, in words',
  /could not be loaded/i.test(uiJs) && /could not be loaded/i.test(mUiJs));

console.log('\nan unchanged photograph is not rewritten');

/* A weekly pass over 157 drivers that rewrote every row would put 3MB through
   the WAL to store what is already there. The collector compares digests. */
const src = readFileSync(new URL('../src/sources/uber_profile.js', import.meta.url), 'utf8');
check('the collector reads the digests it already holds',
  /SELECT driver_ext_id, sha256 FROM driver_photo/.test(src));
check('…and skips a photograph whose bytes have not changed',
  /known\.get\([^)]*\) === sha/.test(src));
check('and it fetches the image while the signed url still works',
  /await fetch\(c\.picture_url/.test(src) && /fetchPhotos\(real\)/.test(src));
/* A CDN that refuses one image must not fail a run that has just written 157
   compliance rows. */
check('…without failing the run when one image refuses',
  /catch \{ failed\+\+; \}/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
