/* ── the report pipeline could not tell a door from an answer ──────────────
   Production, uber/catchup, both fleets, run finished 2026-09-01T21:05:47Z
   (ecosine) and 21:06:51Z (egari): 44 of 44 windows failed and 0 rows were
   written. Read from /api/status on 2026-09-02, the 44 split two ways:

     37 earner windows   web session: redirected to auth.uber.com —
                         the session is no longer signed in
      7 report windows   generate: "Not Found"
                         (the one trip window 2026-08-02..2026-09-01 and all
                          six REPORT_TYPE_DRIVER_QUALITY weeks)

   ONE event, described twice. Both went to the same host with the same cookie.
   supplier.uber.com had begun answering 301 to fleethub.uber.com; a POST does
   not survive a 301, it degrades to a GET, and the GET lands on the login
   page. `"Not Found"` is JSON.stringify of that page's body — src/auth/uber.js
   carries the measurement and fixed the host at 2026-09-02T05:28Z.

   earnerCall has classified its responses since 2026-08-26. generateReport and
   downloadReport never did: they read `data.status === 'success'` and call
   everything else a report the provider declined to generate. So a third of
   this run's failures named no surface, no session and no host, and a reader
   could only get there from the OTHER windows.

   What actually identifies a moved endpoint is the URL the request was SENT
   to. A bounce that lands on a login host reads as an expired session whether
   the session is dead or the URL has moved — that reading is what sent people
   to re-capture perfectly good cookies for days — and only "asked
   supplier.uber.com" separates the two. So both ends of the hop are in the
   message.

   Measured against production the same day, so this pins a real distinction
   and not a guess: with the host now correct, GenerateReport answers a real
   provider refusal as JSON —
     /api/probe/uber/report-columns?type=REPORT_TYPE_TRIP_ACTIVITY
       &from=2026-09-01&to=2026-09-06
     → "Code: invalid-argument, Message: endDate is too late"
   and that must keep arriving verbatim. A refusal is the provider talking; a
   bounce is the provider never having been asked. */

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* config.js reads process.env through get(), so the environment is the
   fixture. One org, because the subject is one request's failure. */
process.env.UBER_ORG_UUID = 'eco-uuid';
process.env.UBER_ORG_ENCRYPTED = 'eco-org';
process.env.UBER_WEB_COOKIE = 'eco-cookie';
delete process.env.UBER_ORG_UUID_EGARI;
delete process.env.UBER_WEB_COOKIE_EGARI;

/* Nothing may reach a database: the failures under test all happen before the
   first query, and a test that needs one would be testing the wrong thing. */
const { pool } = await import('../src/db.js');
pool.query = async () => { throw new Error('the database was asked, which this test never should'); };

const { auditTripWindow } = await import('../src/sources/uber.js');

/* What fetch actually hands http(): status, ok, text(), and the final URL,
   which is the only surviving evidence that a redirect happened. */
const sent = [];
const stubFetch = ({ status = 200, body = '', url }) => {
  globalThis.fetch = async (u, opts = {}) => {
    sent.push({ url: String(u), method: opts.method || 'GET' });
    return { status, ok: status >= 200 && status < 300, url: url || String(u),
      redirected: !!url && url !== String(u), headers: new Map(),
      text: async () => body };
  };
};
const realFetch = globalThis.fetch;

const askOneWindow = async () => {
  sent.length = 0;
  const [entry] = await auditTripWindow({
    from: new Date('2026-08-02T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z'),
    fleet: 'ecosine',
  });
  return entry;
};

console.log('\na report request that came back from the login page');

/* Exactly the production shape: the POST is followed to a login page and the
   body is the two words the catch-up recorded as its whole explanation. */
stubFetch({ status: 404, body: 'Not Found', url: 'https://auth.uber.com/login' });
const bounced = await askOneWindow();

check('the window still fails, because nothing was collected either way',
  !!bounced.error, JSON.stringify(bounced).slice(0, 200));
check('and it is not filed as a window Uber no longer serves',
  bounced.past_retention === false,
  'a bounce says nothing about retention, and a backfill skips what it is told is gone');
check('the failure names where the answer came from',
  /auth\.uber\.com/.test(bounced.error || ''), bounced.error);
check('and where the request was SENT — the half that identifies a moved host',
  /fleethub\.uber\.com/.test(bounced.error || ''), bounced.error);
check('so it no longer reads as the provider declining to generate a report',
  !/^generate: "Not Found"$/.test(bounced.error || ''), bounced.error);

console.log('\na provider that actually refused still speaks for itself');

/* The live answer measured on 2026-09-02 for an endDate past today. Same
   host, proper envelope, a reason worth reading. */
stubFetch({ status: 200, url: 'https://fleethub.uber.com/api/vs-sp-reports-management/GenerateReport',
  body: JSON.stringify({ status: 'error', data: { meta: { details:
    'Code: invalid-argument, Message: endDate is too late, Cause: endDate is too late' } } }) });
const refused = await askOneWindow();

check('the provider’s own words survive', /endDate is too late/.test(refused.error || ''), refused.error);
check('and a refusal is not dressed up as a redirect',
  !/redirected|auth\.uber\.com/.test(refused.error || ''), refused.error);

/* A refusal can arrive as a 4xx and still be a refusal. Measured on
   2026-08-27 (test/uber_per_fleet_oauth.test.mjs' header): the Egari session
   generating a report for the Ecosine org is answered `permission-denied`.
   Reading that as "the credential was refused" would replace the one sentence
   that says WHICH org the session may not see. */
stubFetch({ status: 403, url: 'https://fleethub.uber.com/api/vs-sp-reports-management/GenerateReport',
  body: JSON.stringify({ status: 'error', data: { meta: { details: 'permission-denied' } } }) });
const denied = await askOneWindow();
check('a refusal that arrives as a 403 keeps the words that name the org',
  /permission-denied/.test(denied.error || ''), denied.error);

console.log('\nthe polling loop does not wait ten minutes for a login page');

/* DownloadReport is polled for up to 600s. A login page carries no signedUrl
   and no status, so before this it was indistinguishable from a report still
   generating: one bounced window cost the run ten minutes of nothing. */
let call = 0;
globalThis.fetch = async (u, opts = {}) => {
  call++;
  sent.push({ url: String(u), method: opts.method || 'GET' });
  const generated = JSON.stringify({ status: 'success', data: { reportId: { uuid: { value: 'r1' } } } });
  return call === 1
    ? { status: 200, ok: true, url: String(u), redirected: false, headers: new Map(), text: async () => generated }
    : { status: 404, ok: false, url: 'https://auth.uber.com/login', redirected: true,
        headers: new Map(), text: async () => 'Not Found' };
};
/* Raced against a clock rather than simply awaited: before this fix a bounced
   DownloadReport was indistinguishable from a report still generating, so the
   loop ran its whole 600s budget. A test that takes ten minutes to fail is a
   test nobody runs. */
const started = Date.now();
const stalled = await Promise.race([
  askOneWindow(),
  new Promise((r) => setTimeout(() => r({ error: 'still polling after 20s' }), 20000)),
]);
check('a bounced download fails at once instead of polling out the budget',
  Date.now() - started < 20000, `${Date.now() - started}ms: ${stalled.error}`);
check('and says so as a download, not as a report that never finished',
  /auth\.uber\.com/.test(stalled.error || '') && !/timed out|still polling/.test(stalled.error || ''),
  stalled.error);

console.log('\nthe rule the report path now shares with the earnings path');

/* Classification answers a FAILURE; it must never be able to invent one.
   A report that generated and a signed URL that came back are the envelope
   the caller asked for, and where the 200 was served from is then not this
   code's business — a CDN hop or a regional host must not throw away a report
   that is sitting there ready to download. So the envelope is read first and
   the host only when it is missing. */
pool.query = async () => ({ rows: [] });
let step = 0;
globalThis.fetch = async (u, opts = {}) => {
  step++;
  const from = (url, text) => ({ status: 200, ok: true, url, redirected: true,
    headers: new Map(), text: async () => text });
  if (step === 1) {
    return from('https://fleethub-edge.uber.com/api/vs-sp-reports-management/GenerateReport',
      JSON.stringify({ status: 'success', data: { reportId: { uuid: { value: 'r1' } } } }));
  }
  if (step === 2) {
    return from('https://fleethub-edge.uber.com/api/vs-sp-reports-management/DownloadReport',
      JSON.stringify({ status: 'success', data: { signedUrl: { value: 'https://files.example/r1.csv' } } }));
  }
  return from('https://files.example/r1.csv', 'Trip UUID,Driver UUID,Number plate\n');
};
const served = await askOneWindow();
check('a report that generated is not thrown away over where its 200 came from',
  !served.error, served.error);
check('and the window is measured, which is the whole point of not throwing it away',
  served.uber_rows_in_window === 0 && typeof served.took_ms === 'number',
  JSON.stringify(served).slice(0, 200));

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
