/* Yango's console 403: whose fault it is, and which credential the product is
   allowed to blame for it.
   ═══════════════════════════════════════════════════════════════════════════
   THE DEFECT, IN TWO HALVES.

   (a) The console request carried `X-API-Key`, and the 403 advice told the
       operator to go and check YANGO_API_KEY. The host does not read the
       header. Measured 2026-09-22 against the collector's own endpoint with a
       live session, three requests a second apart:

         with the real key            -> HTTP 200
         with 'junk-not-a-real-key'   -> HTTP 200, BYTE-IDENTICAL body
         with no X-API-Key at all     -> HTTP 200, BYTE-IDENTICAL body

       A credential a host ignores cannot be why it refused. src/sources/
       yango.js already carries two long comments about what naming the wrong
       credential costs — an operator spends the afternoon on an errand that
       could never work while the real cause goes unnamed — and then did it a
       third time.

   (b) The 403 itself was described as one of four possibilities ("entitlement,
       or the park id, or the API key, or the host"). It is now settled, with
       the strongest control available: THE SAME COOKIE BYTES.

         production /api/probe/yango reports its stored session as
           len 1605, head "pi=O", tail "dd=0", park a23a…478b
         the session the operator captured that morning is byte-for-byte that

       Same minute, same path, same method, same body:
         the deployed app -> HTTP 403, an HTML page from a Yandex CDN edge
         another network  -> HTTP 200, the fleet's real driver rows

       Nothing about the credential differs between those two calls. Only where
       the call comes from — and no paste changes a caller's address.

   AND THE HEADERS WERE NEVER THE PROBLEM. The browser sends seventeen and the
   collector sends four, which looked like the same species of defect as Bolt's
   `version=` mismatch. Bisected the same day against the collector's own
   endpoint: all seventeen -> 200; our four -> 200; ours + origin + referer ->
   200; ours + x-client-version -> 200; ours + the browser user-agent -> 200.
   Removing the COOKIE is the only change that breaks it (401). So
   x-client-version, origin and referer are not load-bearing on this host, and
   the correct fix was to send FEWER headers, not more.

   ── PROVED BY REVERT ──────────────────────────────────────────────────────
   Each fix was reverted in the working tree and this suite re-run. Recorded
   beside each group below.

   No credential is used here. The requests are made against a stub. */
import { readFileSync } from 'node:fs';
import { YANGO_SURFACES } from '../src/sources/yango.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the request the collector actually puts on the wire ─────────────────── */
/* Driven through collect() rather than read out of the source, because the
   header set is the thing under test and a regex over `headers()` would pass
   against a call site that overrode it. */
const { pool } = await import('../src/db.js');
pool.query = async () => ({ rows: [{ id: 1 }], rowCount: 1 });
pool.connect = async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release() {} });

process.env.YANGO_PARK_ID = 'park-under-test';
process.env.YANGO_API_KEY = 'api-key-under-test';
process.env.YANGO_COOKIE = 'Session_id=stub-session; yandex_login=stub-account; park_id=park-under-test';

const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url);
  const h = Object.fromEntries(Object.entries(opt.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  seen.push({ url: u, host: new URL(u).host, path: new URL(u).pathname, headers: h });
  /* The console refuses the way production's edge refuses — an HTML page,
     which is the tell that it is not the API answering. With the cookie
     removed it is the API, in JSON, with a 401. That asymmetry is the whole
     experiment the collector runs. */
  if (u.includes('fleet.yango.com')) {
    return h.cookie
      ? new Response('<!DOCTYPE html><html><head><title>403</title></head></html>',
        { status: 403, headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify({ code: 'unauthorized', message: 'Unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json' } });
  }
  // The keyed host answers, which is what makes the console's failure legible.
  return new Response(JSON.stringify({ driver_profiles: [], cars: [], orders: [], transactions: [], total: 0 }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

const { collect } = await import('../src/sources/yango.js');
await collect({ from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-09-21T00:00:00Z'), mode: 'incremental' });
globalThis.fetch = realFetch;

const console_ = seen.filter((s) => s.host === 'fleet.yango.com');
const keyHost = seen.filter((s) => s.host !== 'fleet.yango.com');
const withCookie = console_.filter((s) => s.headers.cookie);
const withoutCookie = console_.filter((s) => !s.headers.cookie);

/* ── 1. the console is not sent a credential it ignores ──────────────────── */
/* REVERT A: `'X-API-Key': config.yango.apiKey` put back into headers() and
   into the cookie-free comparison probe
   -> 19 passed, 2 FAILED: "the console request carries no X-API-Key" and
      "…not even on the cookie-free comparison probe", each printing the whole
      header set that reached fetch, with x-api-key in it. */
console.log('\nthe console is asked with what the console actually reads');

check('the collector did reach the console at all, so the rest of this means something',
  withCookie.length > 0, JSON.stringify(console_.map((s) => s.path)));
check('the console request carries no X-API-Key',
  withCookie.every((s) => !('x-api-key' in s.headers)),
  JSON.stringify(withCookie[0]?.headers || {}));
check('…not even on the cookie-free comparison probe',
  withoutCookie.length > 0 && withoutCookie.every((s) => !('x-api-key' in s.headers)),
  JSON.stringify(withoutCookie[0]?.headers || {}));
/* The comparison is only evidence if the cookie is the only thing that moved.
   A header on one side and not the other makes the 401-vs-403 unreadable. */
check('the two requests differ ONLY by the cookie, which is what makes the comparison evidence',
  (() => {
    const a = { ...withCookie[0]?.headers }; const b = { ...withoutCookie[0]?.headers };
    delete a.cookie; delete b.cookie;
    return JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
  })(), JSON.stringify([Object.keys(withCookie[0]?.headers || {}), Object.keys(withoutCookie[0]?.headers || {})]));
check('the console still sends the park id, which it does read',
  withCookie.every((s) => s.headers['x-park-id'] === 'park-under-test'));
/* And the key host keeps it, because there it is load-bearing and proven on
   every run — removing it there would take trips, roster, cars and the ledger
   with it. */
check('the key host still sends X-API-Key, where it is the whole credential',
  keyHost.length > 0 && keyHost.every((s) => s.headers['x-api-key'] === 'api-key-under-test'),
  JSON.stringify(keyHost[0]?.headers || {}));

/* ── 2. the headers the browser sends and we do not are NOT added ────────── */
/* The temptation after the Bolt pass was to copy the browser's seventeen
   headers over. Measured: our four already return 200. Adding headers nobody
   reads is how a request becomes impossible to reason about later. */
console.log('\nthe headers measured irrelevant were not added "just in case"');
for (const h of ['x-client-version', 'origin', 'referer', 'sec-ch-ua', 'priority']) {
  check(`the console request does not carry ${h}, which was measured not to matter`,
    withCookie.every((s) => !(h in s.headers)), JSON.stringify(withCookie[0]?.headers || {}));
}

/* ── 3. the refusal blames the right thing ───────────────────────────────── */
/* REVERT B: the cookie-is-not-it advice reverted to "check YANGO_PARK_ID (…)
   and YANGO_API_KEY"
   -> 19 passed, 2 FAILED: "the advice does not name YANGO_API_KEY as something
      to go and check" and "…and says outright that this host does not read
      it". Nothing else moved, which is the point — the request can be right
      and the sentence still send somebody on the wrong errand.

   REVERT D: the 403-after-authenticating branch reverted to the four-suspects
   text ("either this account is not on park …, or YANGO_PARK_ID or
   YANGO_API_KEY names a park it cannot see, or the refusal is of this HOST …")
   -> 18 passed, 3 FAILED: "the 403-after-authenticating branch states the
      address finding rather than four maybes", "…and says what WOULD change
      it" and "…and still says plainly that re-capturing the cookie cannot
      help". The old text was not wrong, it was UNRESOLVED — it listed the
      right answer fourth, among three an operator can act on and would. */
console.log('\nthe refusal names what can be acted on, and nothing that cannot');

const yango = readFileSync('src/sources/yango.js', 'utf8');
const advice = yango.slice(yango.indexOf('hint = cookieIsNotIt'), yango.indexOf('if (bare && !cookieIsNotIt)'));

check('the advice does not name YANGO_API_KEY as something to go and check',
  !/YANGO_API_KEY names a park|check YANGO_PARK_ID \(\$\{config\.yango\.parkId\}\) and YANGO_API_KEY/.test(advice));
check('…and says outright that this host does not read it',
  /does not read YANGO_API_KEY/.test(advice));
check('the 403-after-authenticating branch states the address finding rather than four maybes',
  /SAME COOKIE BYTES/.test(advice), advice.slice(0, 120));
check('…and says what WOULD change it, since a reason with no remedy is half a message',
  /egressing this app from an address/.test(advice));
check('…and still says plainly that re-capturing the cookie cannot help',
  /[Rr]e-capturing this cookie cannot help/.test(advice));

/* ── 4. the probe asks what the collector asks ───────────────────────────── */
/* REVERT C: api/probe.js pointed back at '/api/reports-api/v1/orders/list'
   -> 19 passed, 2 FAILED: "the Yango probe asks the collector's own console
      surface" and "…by reading YANGO_SURFACES rather than spelling a path
      again".

   Not academic. Measured 2026-09-22 from a network the edge does not refuse,
   with a live session: the v1 path answers 400 REQUEST_VALIDATION_ERROR while
   the collector's v2 path answers 200 with the fleet's driver rows. So on the
   day the block lifts, the old probe would STILL have reported a failure, and
   an operator would have read it as "the console is still broken". */
console.log('\nthe probe an operator opens asks the endpoint the collector reads');

const probe = readFileSync('api/probe.js', 'utf8');
const route = probe.slice(probe.indexOf("app.get('/api/probe/yango'"), probe.indexOf("app.get('/api/probe/yango/keyapi'"));

/* Comments stripped first — the route now names YANGO_SURFACES in its own
   explanation too, and an explanation is not a call. House-style block comments
   have no leading `*` on continuation lines, so the whole comment goes rather
   than a line-by-line filter. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the Yango probe asks the collector\'s own console surface',
  code(route).includes('YANGO_SURFACES.console.summary'), 'the probe still spells its own path');
/* And the old path is gone from the code, not merely outvoted by the new one. */
check('…by reading YANGO_SURFACES rather than spelling a path again',
  !/reports-api\/v1\/orders\/list/.test(code(route)),
  code(route).split('\n').filter((l) => /reports-api\/v1/.test(l)).join(' | '));
check('…and does not send the key to a host that ignores it',
  !/'X-API-Key': key/.test(route));
check('…while still showing the operator that a key is set, labelled as not sent',
  /api_key_not_sent_to_this_host/.test(route));
/* YANGO_SURFACES is the object the whole no-two-copies rule hangs on. */
check('and the console surface is still the one path that has no key-host equivalent',
  Object.keys(YANGO_SURFACES.console).length === 1
  && YANGO_SURFACES.console.summary === '/api/reports-api/v2/summary/drivers/list',
  JSON.stringify(YANGO_SURFACES.console));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
