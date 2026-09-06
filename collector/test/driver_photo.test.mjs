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
/* THE OTHER HALF, and without it the assertion above is not about the digest.
   ─────────────────────────────────────────────────────────────────────────
   Asking for a 304 when the validator MATCHES pins "a conditional request can
   produce a 304", which is also true of `if (req.get('if-none-match'))` —
   304 to anybody who asks. Under that implementation every browser that has
   ever cached a driver's avatar is pinned to the first copy it saw: the
   collector stores new bytes under a new sha256, the reader sends its stale
   validator, gets an empty 304, and shows the old face for ever with nothing
   on screen to say so. The property is that the DIGEST is the validator, and
   only a non-matching one can tell. */
const stale = await raw('/api/driver/photo/uber/drv-photo',
  { 'if-none-match': `"${'f'.repeat(64)}"` });
check('…while a reader holding a different digest is given the bytes',
  stale.status === 200, String(stale.status));
const staleBody = Buffer.from(await stale.arrayBuffer());
check('…the real ones, in full', staleBody.equals(JPEG), `${staleBody.length} bytes`);
check('…and the ETag it gets back is the digest of what it was sent',
  String(stale.headers.get('etag') || '').includes(DIGEST), String(stale.headers.get('etag')));

/* Bytes from a host we do not run, served back on our own origin. An
   image/svg+xml or a text/html body would be a script with this site's cookies
   and this site's origin; sniffing gets to the same place from a file that is a
   valid JPEG and a valid HTML document at once. Both doors are checked. */
check('…and the browser is told not to guess the type for itself',
  String(hit.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
  String(hit.headers.get('x-content-type-options')));

await q(`INSERT INTO driver_photo (platform, driver_ext_id, bytes, content_type, byte_len, sha256)
         VALUES ('uber','drv-markup',$1,'image/svg+xml',$2,$3)`,
  [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 62, 'f'.repeat(64)]);
const markup = await raw('/api/driver/photo/uber/drv-markup');
check('a stored row whose type is not a raster image is refused, not served',
  markup.status === 415, String(markup.status));
/* THE BODY, not the content-type header. This assertion is named "refused
   before the body is written" and it used to read a header — which is
   satisfied by `res.status(415).send(row.bytes)`, an implementation that
   writes the markup to this origin under a type that merely does not contain
   the substring "svg". The bytes are what must not arrive, so the bytes are
   what is read. */
const markupBody = await markup.text();
check('…and it is refused before the body is written',
  !/<svg|<script/i.test(markupBody) && markupBody.length < 500, markupBody.slice(0, 120));
/* And the refusal itself carries nosniff. The header was set after the 415
   returned, so the one response most likely to be sniffed was the one response
   that did not say not to. */
check('…and the refusal still tells the browser not to guess',
  String(markup.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
  String(markup.headers.get('x-content-type-options')));

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

/* And that they carry the address we DO serve — on EVERY route, not one.
   ─────────────────────────────────────────────────────────────────────────
   This positive check used to run against /api/compliance/drivers alone, while
   the loop above asked the directory only whether it emitted an absolute URL.
   null satisfies that. So the directory shipped building its address out of
   r.platform — a column its select does not have — and handed every one of 434
   people a null, with this file green: 21 passed, 0 failed, against a driver
   list showing no faces at all. That is the exact shape of a non-biting
   assertion: the absence of the wrong answer asserted where the presence of
   the right one was needed.

   Both halves, on both routes. The negative alone cannot tell a fixed route
   from an empty one. */
for (const [name, path, key] of [
  ['the compliance list', '/api/compliance/drivers', 'driver_ext_id'],
  ['the driver directory', '/api/drivers/directory?days=30', 'driver_ext_id'],
]) {
  const r = await get(path);
  const rows = (r.body?.drivers || r.body?.rows || (Array.isArray(r.body) ? r.body : []));
  /* The directory FOLDS accounts into people and carries the account ids in
     `ids`, so a person is found by either. */
  const has = (x, id) => x[key] === id || (Array.isArray(x.ids) && x.ids.includes(id));
  const shot = rows.find((x) => has(x, 'drv-photo'));
  const bare = rows.find((x) => has(x, 'drv-nopic'));
  check(`${name}: a driver whose photograph we hold gets this origin’s address for it`,
    !!shot && shot.picture_url === '/api/driver/photo/uber/drv-photo',
    `${rows.length} rows, ${JSON.stringify(shot?.picture_url)}`);
  /* The other half, and the reason the first is not enough: a driver whose
     compliance row carries a dead CloudFront URL and whose bytes we do NOT
     hold must get null — not the dead URL, and not somebody else's photo. */
  check(`${name}: …and a driver whose photograph we do not hold gets nothing at all`,
    !!bare && bare.picture_url === null, JSON.stringify(bare?.picture_url));
}

/* The address must name the row the BYTES are under, not the row the reader
   came in on. A person with a hotel compliance record and an Uber photograph
   is the case that separates the two: the id is the same, the platform is not,
   and building the address from the compliance row sends the browser to
   /api/driver/photo/hotel/<id>, which this product 404s by construction. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name)
         VALUES ('hotel','drv-crossed','Two Records One Face')`);
await q(`INSERT INTO driver_photo (platform, driver_ext_id, bytes, content_type, byte_len, sha256)
         VALUES ('uber','drv-crossed',$1,'image/jpeg',$2,$3)`,
  [JPEG, JPEG.length, 'a'.repeat(64)]);
{
  const r = await get('/api/compliance/drivers');
  const rows = (r.body?.drivers || r.body?.rows || []);
  const crossed = rows.find((x) => x.driver_ext_id === 'drv-crossed');
  check('the address names the channel the bytes are filed under, not the record’s',
    !!crossed && crossed.picture_url === '/api/driver/photo/uber/drv-crossed',
    JSON.stringify(crossed?.picture_url));
  const live = await raw('/api/driver/photo/uber/drv-crossed');
  check('…and that address actually serves the image',
    live.status === 200, String(live.status));
  const wrong = await raw('/api/driver/photo/hotel/drv-crossed');
  check('…while the record’s own channel is a 404, which is why it must not be used',
    wrong.status === 404, String(wrong.status));
}

/* A PHOTOGRAPH FILED UNDER ONE ACCOUNT BELONGS TO THE WHOLE PERSON, and
   decorating a row must never change what the row counts.
   ─────────────────────────────────────────────────────────────────────────
   Both of these are properties of the JOIN, and both were wrong in the
   opposite direction from each other.

   The leaderboard groups a person's several platform accounts onto one row and
   addresses them by `(array_agg(DISTINCT driver_ext_id))[1]` — which, because
   array_agg(DISTINCT …) sorts, is the ALPHABETICALLY SMALLEST of their ids. It
   then looked for their photograph under that id alone, so anybody whose Uber
   account sorts second had no face on the fleet's most-read table while their
   photograph sat in the database.

   The directory had the reverse fault: a plain LEFT JOIN on driver_ext_id,
   against a table keyed (platform, driver_ext_id). A second photo row for one
   id returns the person's WORK row twice, and the fold adds trips up. Nothing
   writes a second row today, because Uber is the only channel that files a
   picture — so this is a bug that waits. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name)
         VALUES ('uber','zz-second-account','Sorts Last')`);
/* THREE TRIPS, and the number is the point. The directory folds a person's
   accounts into one row, so a join that returns their work row twice does not
   show up as two rows — it shows up as six trips where there are three, on the
   page an operator reads to decide who is working. An assertion that only
   counted rows would have passed against the bug; this one counts the trips. */
for (const [i, day] of ['2026-09-02', '2026-09-03', '2026-09-04'].entries()) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, ended_at, status, distance_km)
           VALUES ('uber',$1,'ecosine','L777','zz-second-account','Sorts Last',
                   $2::timestamptz, $2::timestamptz + interval '20 minutes', 'completed', 10)`,
  [`zz-trip-${i}`, `${day}T09:00:00+04:00`]);
}
await q(`INSERT INTO driver_photo (platform, driver_ext_id, bytes, content_type, byte_len, sha256)
         VALUES ('uber','zz-second-account',$1,'image/jpeg',$2,$3),
                ('hotel','zz-second-account',$1,$4,$2,$5)`,
  [JPEG, JPEG.length, 'b'.repeat(64), 'image/png', 'c'.repeat(64)]);
{
  const r = await get('/api/compliance/drivers');
  const rows = (r.body?.drivers || r.body?.rows || []);
  const two = rows.filter((x) => x.driver_ext_id === 'zz-second-account');
  check('a driver with two photo rows appears once, not twice',
    two.length === 1, `${two.length} rows`);
  check('…and is offered an address for the photograph',
    two[0]?.picture_url === '/api/driver/photo/uber/zz-second-account'
      || two[0]?.picture_url === '/api/driver/photo/hotel/zz-second-account',
    JSON.stringify(two[0]?.picture_url));
}
{
  /* THE LEADERBOARD, where the person is addressed by the smallest of their
     account ids. The photograph here is filed under 'zz-second-account', which
     sorts after 'aa-first-account' — so a lookup that used the addressing id
     alone finds nothing, while the fleet's most-read table shows two letters
     for somebody whose face is in the database. */
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, ended_at, status, distance_km)
           VALUES ('bolt','aa-trip-1','ecosine','L777','aa-first-account','Sorts Last',
                   '2026-09-05T09:00:00+04:00','2026-09-05T09:20:00+04:00','completed',10)`);
  const r = await get('/api/drivers/leaderboard?days=30');
  const rows = (r.body?.rows || []);
  const who = rows.find((x) => /Sorts Last/.test(x.driver_name || ''));
  check('a photograph filed under a person’s OTHER account still reaches them',
    !!who && /^\/api\/driver\/photo\//.test(who.picture_url || ''),
    `${rows.length} rows · ${JSON.stringify(who && { n: who.driver_name, a: who.accounts, p: who.picture_url })}`);
  check('…and they are still one row, not one per account',
    rows.filter((x) => /Sorts Last/.test(x.driver_name || '')).length === 1,
    String(rows.filter((x) => /Sorts Last/.test(x.driver_name || '')).length));
}
{
  const r = await get('/api/drivers/directory?days=30');
  const rows = (r.body?.drivers || r.body?.rows || (Array.isArray(r.body) ? r.body : []));
  const hit = rows.filter((x) => x.driver_ext_id === 'zz-second-account'
    || (Array.isArray(x.ids) && x.ids.includes('zz-second-account')));
  check('the directory does not list them twice either', hit.length <= 1, `${hit.length} rows`);
  /* FOUR: three on the Uber account that carries the photograph and one on the
     Bolt account seeded for the leaderboard case above, folded into the one
     person they both belong to. The photo row count must not touch it. */
  check('…and their trip count is not inflated by having a photograph',
    hit.length === 1 && Number(hit[0].trips) === 4,
    `trips ${JSON.stringify(hit[0]?.trips)} — four were seeded`);
}

/* THREE STATES, AND THE THIRD ONE IS OURS.
   ─────────────────────────────────────────────────────────────────────────
   picture_url null meant both "this person has no photograph anywhere" and
   "Uber holds one and we could not fetch it", and the page drew the second as
   the first — a plain initials tile, indistinguishable, saying something false
   about the fleet's records without a word of warning. The collector already
   knew: it counted four separate failure modes and put the number in a log
   line. sql/schema_v64.sql keeps the reason where the boundary can read it. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name)
         VALUES ('uber','drv-403','Photograph We Could Not Get')`);
await q(`INSERT INTO driver_photo_miss (platform, driver_ext_id, reason, source_host)
         VALUES ('uber','drv-403',
                 'the host answered 403 — a signed url that has expired reads exactly like this',
                 'd1w2poirtb3as9.cloudfront.net')`);
for (const [name, path] of [
  ['the compliance list', '/api/compliance/drivers'],
  ['the driver directory', '/api/drivers/directory?days=30'],
]) {
  const r = await get(path);
  const rows = (r.body?.drivers || r.body?.rows || (Array.isArray(r.body) ? r.body : []));
  const has = (x, id) => x.driver_ext_id === id || (Array.isArray(x.ids) && x.ids.includes(id));
  const failed = rows.find((x) => has(x, 'drv-403'));
  const none = rows.find((x) => has(x, 'drv-nopic'));
  check(`${name}: a photograph we could not fetch still has no address`,
    !!failed && failed.picture_url === null, JSON.stringify(failed?.picture_url));
  check(`${name}: …but it says why, in words an operator can act on`,
    /403/.test(failed?.photo_absent_reason || ''), JSON.stringify(failed?.photo_absent_reason));
  /* The half that makes it worth having: a driver Uber genuinely has no
     picture for must NOT carry a reason, or "we could not fetch it" becomes
     the caption on every faceless row in the fleet. */
  check(`${name}: …and a driver with no photograph anywhere says nothing`,
    !!none && none.photo_absent_reason === undefined,
    JSON.stringify(none?.photo_absent_reason));
}

console.log('\nthe page can tell the two absences apart');

/* THESE ASSERTIONS USED TO BE GREPS OVER THE SOURCE, AND THEY LIED.
   ─────────────────────────────────────────────────────────────────────────
   They read ui.js as text and asked whether 'av-lost' and 'could not be
   loaded' appear in it. Both did — inside

       onerror="this.remove(); this.parentNode.classList.add('av-lost'); …"

   where remove() detaches the img, `this.parentNode` is null one statement
   later, and the handler dies with a TypeError before it marks anything. The
   desktop went on doing precisely what plain onerror="this.remove()" did, and
   this file reported 29 passed, 0 failed about it. A string in a statement
   that cannot run is not a behaviour.

   The behaviour is asserted where it can be observed, in test/avatar_lost.test
   .mjs: a real browser, a real 404, and a question put to the element that
   ends up on screen. What stays here is the stylesheet — whether the mark has
   a rendering at all is a fact about the CSS file, and the CSS file is the
   right place to ask it. */
const css = readFileSync(new URL('../api/public/app.css', import.meta.url), 'utf8');
const mCss = readFileSync(new URL('../api/public/m/m.css', import.meta.url), 'utf8');
check('the mark has a rendering on the desktop', /\.av-lost\{/.test(css));
check('…and on the phone', /\.av-lost\{/.test(mCss));

/* THE COLLECTOR'S OWN GUARANTEES ARE ASSERTED IN test/photo_fetch.test.mjs,
   BY RUNNING IT.
   ─────────────────────────────────────────────────────────────────────────
   Four checks used to live here, and all four were regexes over
   src/sources/uber_profile.js — /await fetch\(c\.picture_url/,
   /catch \{ failed\+\+; \}/ and two more. They pass for as long as the line is
   present and say nothing whatever about whether it works, and they cannot see
   a bound that is MISSING: the timeout this collector did not have was
   invisible to every one of them, and so were the 512KB limit and the
   content-type allowlist, either of which could have been deleted with this
   file still green.

   fetchPhotos is exported now and run against a local server that answers the
   way a CDN can misbehave — with an image, with a web page, with something
   enormous, with a lie about its own size, and with nothing at all. Deleting
   the allowlist puts text/html in the table; deleting the timeout hangs the
   run past ninety seconds. Neither is a thing a grep can notice. */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
