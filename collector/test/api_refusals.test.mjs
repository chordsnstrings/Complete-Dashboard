/* A REFUSAL THE OPERATOR CAN ACT ON, RATHER THAN ONE THE CLIENT RENDERS AS A
   TIMEOUT — and the client address the audit trail is about to depend on.
   ──────────────────────────────────────────────────────────────────────────
   Two things this application has never had, both of which the driver ledger
   makes load-bearing.

   1. AN ERROR HANDLER. There was none, so anything body-parser rejected fell
      through to Express's default, which emits an HTML page.
      api/public/data.js:176-186 matches /^\s*<(!doctype|html)/i on ANY error
      body and rewrites it to "the server took too long to answer. It is
      usually still computing this; try again in a moment."

      For a receipt upload that is the worst available answer: a supervisor
      photographs a cash handover, the image exceeds the route's limit, and the
      screen tells them to retry — which fails identically, forever, naming a
      cause that is not the true one. That is the house principle inverted, on
      the one screen where money is being recorded.

   2. `trust proxy`. Express reports whatever connected to it, and on
      DigitalOcean App Platform that is always the load balancer — so `req.ip`
      has been one constant address for every request this app has ever served.
      Nothing read it, so nothing noticed. The ledger attributes a money entry
      by supervisor name plus IP plus timestamp until ULM exists, and an IP
      that is identical on every row looks populated and proves nothing, which
      is worse than leaving it null.

   The setting is `1`, not `true`: `true` trusts the whole X-Forwarded-For
   chain, so a client sending its own header prepends any address it likes and
   Express believes it. The assertion below is what stops somebody "fixing" it
   to true — a forgeable address recorded as fact is not an improvement. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');

/* ── trust proxy, asserted on the source because the harness is not behind a
      proxy and cannot exercise it ────────────────────────────────────────── */
check('the app trusts exactly one proxy hop', /app\.set\('trust proxy',\s*1\)/.test(src));
check('and not the whole forwarded chain, which is forgeable',
  !/app\.set\('trust proxy',\s*(true|'.*')\)/.test(src));
check('it is set BEFORE the routes, or no route sees it',
  src.indexOf("app.set('trust proxy'") < src.indexOf("app.get('/api"),
  `${src.indexOf("app.set('trust proxy'")} vs ${src.indexOf("app.get('/api")}`);

/* ── the error handler ───────────────────────────────────────────────────── */
const db = new PGlite();
await applySchema(db);
const { port } = await mountAll(db);

/* A body-parser refusal, provoked for real rather than stubbed: the limit is
   256kb and this is a megabyte of it. */
const big = await fetch(`http://127.0.0.1:${port}/api/same-person/decide`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ alias_ext_id: 'x', verdict: 'same', pad: 'x'.repeat(1024 * 1024) }),
});
const bigText = await big.text();
check('an oversized body is refused with 413, not 500 and not a hang', big.status === 413,
  String(big.status));
check('and the body is JSON, not the HTML page the client reads as a timeout',
  /^\s*[{[]/.test(bigText) && !/^\s*<(!doctype|html)/i.test(bigText), bigText.slice(0, 120));
const bigJson = JSON.parse(bigText);
check('it says the request was too LARGE, in those terms',
  /larger than this route accepts/i.test(bigJson.error || ''), bigJson.error);
check('it names the limit, so the caller can compress to fit it',
  bigJson.limit != null, JSON.stringify(bigJson.limit));
check('and says plainly that retrying the same bytes cannot work',
  /size refusal, not a timeout/i.test(bigJson.detail || ''), bigJson.detail);

/* THE ASSERTION THIS FILE EXISTS FOR. The old behaviour was not a 500 — it was
   an HTML body that api/public/data.js turns into a timeout sentence. Assert
   against that rewrite rule directly, so the guard is about what the OPERATOR
   would have been told and not about a status code. */
const clientSrc = readFileSync(new URL('../api/public/data.js', import.meta.url), 'utf8');
const rewritesHtml = /\/\^\\s\*<\(!doctype\|html\)\/i/.test(clientSrc.replace(/\s+/g, ' '))
  || /!doctype\|html/.test(clientSrc);
check('the client still rewrites html error bodies to a timeout sentence', rewritesHtml);
check('so the refusal above would NOT be rewritten, because it is not html',
  rewritesHtml && !/^\s*<(!doctype|html)/i.test(bigText));

/* Malformed JSON is a different refusal and must not be reported as a size. */
const bad = await fetch(`http://127.0.0.1:${port}/api/same-person/decide`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
});
const badJson = await bad.json();
check('malformed JSON is 400, not 413', bad.status === 400, String(bad.status));
check('and is named as invalid JSON rather than as a size',
  /not valid json/i.test(badJson.error || ''), badJson.error);

/* The handler must sit BEFORE the /api 404, or every error becomes "no such
   endpoint" — which is the shadowing bug the 404 guard itself was written for,
   introduced at the other end. */
check('the error handler is registered before the /api 404 guard',
  src.indexOf('entity.too.large') < src.indexOf("error: 'no such endpoint'"),
  `${src.indexOf('entity.too.large')} vs ${src.indexOf("error: 'no such endpoint'")}`);

console.log(`\n${fail ? '✗' : '✓'} api_refusals: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
