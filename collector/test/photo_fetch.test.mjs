/* What the photo collector actually does when a CDN misbehaves.
   ─────────────────────────────────────────────────────────────────────────
   Every guarantee in fetchPhotos was asserted by grepping uber_profile.js for
   the line that implements it:

     /await fetch\(c\.picture_url/          — that a fetch happens
     /catch \{ failed\+\+; \}/               — that a failure is swallowed
     /SELECT driver_ext_id, sha256 FROM/    — that digests are read

   All three pass whether or not the function works, and none of them can see a
   bound that is missing: the 512KB limit, the content-type allowlist and — the
   one that was genuinely absent — a timeout could each have been deleted with
   the suite staying green. This was the ONLY bare fetch() in src/; every other
   outbound call goes through src/http.js and gets an AbortController, and Node's
   stock 300s timeouts meant one CDN object refusing to finish could hold the
   per-driver loop for five minutes, ahead of the checkpoint, with the job's
   heartbeat frozen and nothing marked done.

   So the function is run, against a server that answers the way a CDN can:
   with an image, with a web page, with something enormous, with a lie about
   its own size, and with nothing at all. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* src/db.js's pool, pointed at PGlite before uber_profile is loaded. The digest
   read goes through pool.query and upsertMany writes through pool.connect(), so
   both have to be redirected — the same pair test/cabman.test.mjs replaces, and
   for the same reason. */
const { pool } = await import('../src/db.js');
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const app = express();
app.get('/good.jpg', (_, res) => res.type('image/jpeg').send(JPEG));
/* A CDN that has forgotten what it holds and serves a sign-in page with a 200.
   Stored, this becomes markup on our own origin. */
app.get('/page.html', (_, res) => res.type('text/html').send('<html>sign in</html>'));
/* Bigger than the bound, and honest about it — refused before the body is read.
   `connection: close`, and the socket ended by hand, because this response
   DELIBERATELY promises 64MB it will never send: left keep-alive, the client
   reuses that half-spoken socket for the next request and reads a body that is
   not the one it asked for. That made this file fail about one run in three,
   on an assertion two blocks away — a fixture bug wearing a product bug's
   clothes. */
app.get('/huge-declared.jpg', (_, res) => {
  res.set({ 'content-type': 'image/jpeg', 'content-length': String(64 * 1024 * 1024),
    connection: 'close' });
  res.flushHeaders();
  res.socket.end();
});
/* Bigger than the bound and silent about it: chunked, so only what arrives can
   settle it. */
app.get('/huge-chunked.jpg', (_, res) => { res.type('image/jpeg'); res.end(Buffer.alloc(700 * 1024)); });
/* The one that used to be unbounded: a connection that is accepted and then
   never answered. */
app.get('/hangs.jpg', () => { /* deliberately no response, ever */ });
app.get('/gone.jpg', (_, res) => res.status(403).send('AccessDenied'));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const { fetchPhotos } = await import('../src/sources/uber_profile.js');
const contact = (id, path) => ({ driver_ext_id: id, picture_url: `${base}${path}` });

console.log('\nwhat is stored, and what is refused');

const t0 = Date.now();
const r1 = await fetchPhotos([
  contact('ok-1', '/good.jpg'),
  contact('markup', '/page.html'),
  contact('huge-declared', '/huge-declared.jpg'),
  contact('huge-chunked', '/huge-chunked.jpg'),
  contact('dead', '/gone.jpg'),
]);
check('the real image is stored', r1.stored === 1, JSON.stringify(r1));
check('…and the other four are refused', r1.failed === 4, JSON.stringify(r1));

const stored = await q('SELECT driver_ext_id, content_type, byte_len FROM driver_photo ORDER BY driver_ext_id');
check('exactly one row reached the database', stored.length === 1, JSON.stringify(stored));
check('…and it is the image', stored[0]?.driver_ext_id === 'ok-1'
  && stored[0]?.content_type === 'image/jpeg', JSON.stringify(stored[0]));
/* The whole point of the allowlist: markup served from our own origin is a
   script with our cookies. It must not be in the table at all. */
check('nothing that was served as a web page is in the table',
  !stored.some((r) => /html|svg/.test(r.content_type)), JSON.stringify(stored));
check('…and the stored length is the length of what arrived',
  Number(stored[0]?.byte_len) === JPEG.length, `${stored[0]?.byte_len} against ${JPEG.length}`);

console.log('\nand every refusal is written down with its reason');

/* The count used to go into a log line and nowhere else, so the page said
   "this driver has no photograph" about somebody whose photograph Uber holds.
   A reason an operator can act on — "the host answered 403" is a signed url
   that expired, "served as text/html" is a CDN serving a sign-in page — is the
   difference between a fact about the fleet and a fault in this product. */
const missed = await q('SELECT driver_ext_id, reason, source_host FROM driver_photo_miss ORDER BY driver_ext_id');
check('one row per refusal', missed.length === 4, JSON.stringify(missed.map((m) => m.driver_ext_id)));
check('a 403 says the host refused it',
  /403/.test(missed.find((m) => m.driver_ext_id === 'dead')?.reason || ''),
  JSON.stringify(missed.find((m) => m.driver_ext_id === 'dead')?.reason));
check('a web page says what it was served as',
  /text\/html/.test(missed.find((m) => m.driver_ext_id === 'markup')?.reason || ''),
  JSON.stringify(missed.find((m) => m.driver_ext_id === 'markup')?.reason));
check('an oversized body says so, with the bound',
  /bytes, past the/.test(missed.find((m) => m.driver_ext_id === 'huge-chunked')?.reason || ''),
  JSON.stringify(missed.find((m) => m.driver_ext_id === 'huge-chunked')?.reason));
/* The host, never the query string: the path is a uuid and the query is a
   signature, and a credential does not belong in a table an operator reads. */
check('the host is kept and neither the port nor the signature is',
  missed.every((m) => m.source_host === '127.0.0.1'),
  JSON.stringify(missed.map((m) => m.source_host)));
check('and the driver whose image arrived has no note against them',
  !missed.some((m) => m.driver_ext_id === 'ok-1'), JSON.stringify(missed.map((m) => m.driver_ext_id)));

console.log('\nan unchanged photograph is not written again');

const r2 = await fetchPhotos([contact('ok-1', '/good.jpg')]);
check('the second pass recognises the same bytes', r2.unchanged === 1, JSON.stringify(r2));
check('…and writes nothing', r2.stored === 0, JSON.stringify(r2));
const after = await q('SELECT count(*)::int n, max(fetched_at) t FROM driver_photo');
check('the row is still the one row', after[0].n === 1, JSON.stringify(after[0]));

console.log('\nand a request that never answers is not allowed to hold the pass');

/* THE ASSERTION THIS FILE EXISTS FOR. Without a signal this call sits on
   Node's stock 300s header timeout; the bound is 15s, so a few seconds of
   slack proves a bound exists without pinning the exact number. */
const t1 = Date.now();
const r3 = await fetchPhotos([contact('stalls', '/hangs.jpg')]);
const took = Date.now() - t1;
check('it gives up rather than waiting for ever', took < 60000, `${(took / 1000).toFixed(1)}s`);
check('…and counts it as a failure, not a store', r3.failed === 1 && r3.stored === 0, JSON.stringify(r3));
check('…and the run carries on', typeof r3.stored === 'number', JSON.stringify(r3));
check('nothing was written for it', (await q("SELECT * FROM driver_photo WHERE driver_ext_id='stalls'")).length === 0);

console.log('\nand a photograph that arrives clears the note that said it had not');

/* Otherwise the page goes on explaining a failure that has since been fixed —
   which is the same defect as the one this table exists to close, pointing the
   other way. */
await q(`INSERT INTO driver_photo_miss (platform, driver_ext_id, reason)
         VALUES ('uber','recovers','the host answered 403') ON CONFLICT DO NOTHING`);
const before = await q("SELECT count(*)::int n FROM driver_photo_miss WHERE driver_ext_id='recovers'");
const r4 = await fetchPhotos([contact('recovers', '/good.jpg')]);
const cleared = await q("SELECT count(*)::int n FROM driver_photo_miss WHERE driver_ext_id='recovers'");
check('the note was there to begin with', before[0].n === 1, JSON.stringify(before[0]));
check('the photograph is stored', r4.stored === 1, JSON.stringify(r4));
check('…and the note is gone', cleared[0].n === 0, JSON.stringify(cleared[0]));

console.log(`\n  (whole file ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
