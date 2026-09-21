/* THE PROOF, AND THE FOUR WAYS SERVING IT COULD MISLEAD.
   ──────────────────────────────────────────────────────────────────────────
   Every disbursement and repayment carries a photograph, by the operator's
   instruction. Four things about that are not obvious and each has a failure
   that matters:

   1. IT CANNOT ARRIVE AS JSON. api/server.js sets a 256kb limit for every
      route in the process and base64 inflates by a third, so the largest image
      that could reach a JSON route is about 190KB against a phone camera's two
      to five megabytes. Raising the shared limit raises it for every route —
      it is the DoS budget for the whole API — so the upload takes a per-route
      raw parser at 1MB and everything else keeps its 256kb.

   2. A SILENT DEDUPE IS A LIE ABOUT COVERAGE. The digest is the key, so the
      same bytes uploaded twice store once. That is right, and it must be
      SAID: the same photograph attached to five handovers turns "every entry
      carries proof" into a claim about bytes rather than about events, and a
      reviewer has to be able to see it.

   3. THE ENTRY OUTLIVES ITS PROOF. Retention is twelve months and the ledger
      row is permanent. An expired receipt must say it was held until a date
      and has since gone — never look like an entry that never had one. 410
      and not 404, because those are different facts.

   4. THE ADDRESS IS THE ACCESS. There is no user authentication in this
      product, so a 64-character digest that appears only on the entry it
      belongs to is the whole control. That is weaker than a bank slip
      deserves and the route says so in its own comment rather than glossing
      it; the assertion here pins the parts that ARE enforceable. */
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { port } = await mountAll(db);

/* A minimal but genuine JPEG: SOI, APP0/JFIF, EOI. Real bytes rather than a
   string, because the route reads Content-Type and stores what it was given
   and a fixture that is not an image would not exercise either. */
const jpeg = Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF\0'),
  Buffer.alloc(200, 0x7F), Buffer.from([0xFF, 0xD9]),
]);
const sha = createHash('sha256').update(jpeg).digest('hex');

const up = async (body, { by = 'ahsan', type = 'image/jpeg' } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ledger/receipt?by=${by}`, {
    method: 'POST', headers: { 'content-type': type }, body,
  });
  return { status: r.status, body: await r.json() };
};

/* ── THE MOUNT ITSELF, because getting this wrong kills the whole API ────
   The body parser was a DEPENDENCY, and a mount that did not supply it threw
   `Route.post() requires a callback function but got a [object Undefined]` at
   registration — which does not fail one route, it fails the app and the API
   never binds a port. It surfaced while the harness and the server were
   momentarily out of step, which is exactly the shape the real accident takes:
   a route file and its mount edited in different commits.

   So the parser is built beside the route and the mount takes no middleware at
   all. This asserts the signature, because the failure is at REGISTRATION and
   no request-level test can reach it. */
const routeSrc = (await import('node:fs'))
  .readFileSync(new URL('../api/ledger_routes.js', import.meta.url), 'utf8');
check('the receipt mount takes no injected middleware',
  /export function ledgerReceiptRoutes\(app, \{ q, wrap \}\)/.test(routeSrc));
check('and builds its own parser, at its own limit, beside the route',
  /const receiptBody = express\.raw\(\{ type: RECEIPT_TYPES, limit: '1mb' \}\)/.test(routeSrc));
check('the process-wide JSON limit is untouched at 256kb',
  /express\.json\(\{ limit: '256kb' \}\)/.test((await import('node:fs'))
    .readFileSync(new URL('../api/server.js', import.meta.url), 'utf8')));

/* ── the upload ──────────────────────────────────────────────────────────── */
const first = await up(jpeg);
check('an image uploads and comes back keyed by its digest',
  first.body.sha256 === sha, JSON.stringify(first.body).slice(0, 160));
check('the byte length is the real one', first.body.byte_len === jpeg.length);
check('it is not already held the first time', first.body.already_held === false);
check('and it carries a twelve-month expiry',
  /^\d{4}-\d{2}-\d{2}$/.test(first.body.expires_on || ''), first.body.expires_on);
check('the row holds the bytes, not a path to them',
  (await q(`SELECT octet_length(bytes) n FROM driver_ledger_receipt WHERE sha256=$1`, [sha]))[0].n
    === jpeg.length);

/* ── 2. dedupe, said out loud ────────────────────────────────────────────── */
const again = await up(jpeg);
check('the same bytes are not stored twice', (await q(
  `SELECT count(*)::int n FROM driver_ledger_receipt`))[0].n === 1);
check('and the repeat upload SAYS it was already held', again.body.already_held === true);
check('naming how many entries already point at it',
  again.body.used_by_entries === 0 && /already uploaded/i.test(again.body.note || ''),
  again.body.note);

/* Attach it to an entry, then upload the same bytes again: the count must move,
   because that is the case a reviewer needs to see. */
await q(`INSERT INTO driver (id, full_name) VALUES (500,'Receipt Subject')`);
await q(`INSERT INTO driver_ledger
   (person_id, person_name, resolved_from, type_code, direction, book, amount,
    effective_on, entered_by, note, receipt_sha)
   VALUES (500,'Receipt Subject','human:ahsan','cash_advance',1,'advance',1000,
           '2026-09-15','ahsan','advance against September',$1)`, [sha]);
const third = await up(jpeg);
check('once an entry points at it, the repeat upload says how many do',
  third.body.used_by_entries === 1 && /already attached to 1 entry/i.test(third.body.note || ''),
  third.body.note);
check('and explains why that is worth saying rather than just refusing',
  /claim about bytes rather than about events/i.test(third.body.note || ''), third.body.note);

/* ── the refusals ────────────────────────────────────────────────────────── */
check('an unlisted supervisor cannot upload',
  (await up(jpeg, { by: 'nobody' })).status === 400);
check('a non-image content type is refused as unsupported media, not as a size',
  (await up(jpeg, { type: 'application/pdf' })).status === 415);
check('an empty body is refused', (await up(Buffer.alloc(0))).status === 400);

/* 1. THE SIZE PATH. Two megabytes against a one-megabyte route limit. This is
      the refusal that used to reach the operator as "the server took too long
      — try again", which is a retry that can only fail the same way. */
const big = await fetch(`http://127.0.0.1:${port}/api/ledger/receipt?by=ahsan`, {
  method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: Buffer.alloc(2 * 1024 * 1024),
});
const bigText = await big.text();
check('an oversized image is refused 413', big.status === 413, String(big.status));
check('as JSON, not the html the client rewrites into a timeout',
  !/^\s*<(!doctype|html)/i.test(bigText), bigText.slice(0, 80));
check('and the limit is named so the phone can compress to fit it',
  JSON.parse(bigText).limit != null, bigText.slice(0, 140));

/* ── serving it back ─────────────────────────────────────────────────────── */
const get = await fetch(`http://127.0.0.1:${port}/api/ledger/receipt/${sha}`);
check('the bytes come back with the type they were stored as',
  get.status === 200 && get.headers.get('content-type') === 'image/jpeg', String(get.status));
check('byte-identical to what was uploaded',
  Buffer.from(await get.arrayBuffer()).equals(jpeg));
check('with the digest as the ETag', get.headers.get('etag') === `"${sha}"`);
check('and immutable, because here the address IS the content',
  /immutable/.test(get.headers.get('cache-control') || ''), get.headers.get('cache-control'));
const notMod = await fetch(`http://127.0.0.1:${port}/api/ledger/receipt/${sha}`,
  { headers: { 'if-none-match': `"${sha}"` } });
check('a repeat visit costs a 304', notMod.status === 304, String(notMod.status));
check('a digest nobody holds is 404 with the reason in a header an <img> can reach',
  (await fetch(`http://127.0.0.1:${port}/api/ledger/receipt/${'b'.repeat(64)}`)).status === 404);
check('and something that is not a digest is refused before any lookup',
  (await fetch(`http://127.0.0.1:${port}/api/ledger/receipt/not-a-digest`)).status === 400);

/* 3. EXPIRY IS 410, NOT 404 ─────────────────────────────────────────────── */
await q(`UPDATE driver_ledger_receipt SET expires_on = '2020-01-01' WHERE sha256 = $1`, [sha]);
const gone = await fetch(`http://127.0.0.1:${port}/api/ledger/receipt/${sha}`);
check('a receipt past its retention answers 410, not 404', gone.status === 410, String(gone.status));
const goneBody = await gone.json();
check('and says the entry is permanent and still records that one was held',
  /entry it belongs to is permanent/i.test(goneBody.detail || ''), goneBody.detail);
check('the header carries the expiry, for a caller that cannot read a body',
  /expired 2020-01-01/.test(gone.headers.get('x-receipt') || ''), gone.headers.get('x-receipt'));

console.log(`\n${fail ? '✗' : '✓'} ledger_receipt: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
