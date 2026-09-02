/* Bolt's two refusals, told apart.
   ─────────────────────────────────────────────────────────────────────────
   /api/status has carried the same sentence on every Bolt run for days:

     bolt  backfill/catchup/incremental  partial  rows 68-70
       "FI roster ecosine: code=503 NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED;
        portal egari: refresh token expired 2026-08-27T12:42:11.000Z
        — re-capture from the portal"

   Both halves are unactionable, and the second half is wrong.

   FI ROSTER. Production /api/probe/results, one pass at 2026-09-02T10:52:23Z,
   with ONE set of client credentials:
       egari:getDrivers    company_id 142897 → http 200, 50 driver records
       ecosine:getDrivers  company_id 142868 → http 200, code 503,
                                               NOT_AUTHORIZED,
                                               hint COMPANIES_NOT_ALLOWED
   Same token, same endpoint, 200ms apart. The credential authenticates; the
   COMPANY is what is refused. The run said neither which credential nor which
   company, so the message is indistinguishable from Bolt being briefly down.

   PORTAL TOKEN. The token the Egari path presents is the one
   test/credentials.test.mjs keeps as its REAL fixture: payload
   `data.fleet_owner_id: 173999`, `exp: 1787834531` = 2026-08-27T12:42:11Z —
   the exact instant production prints. 173999 is ECOSINE's owner in
   config.bolt.companies; Egari's is 174036. So Egari is being handed Ecosine's
   token through the `|| config.bolt.refreshToken` fallback, and the advice it
   is given — "re-capture from the portal" — produces another 173999 token that
   fails identically. Worse, while such a token is still inside its week the
   collector spends a request on it every cycle to be told no.

   These tests drive the real collect() against a stubbed fetch, so what they
   read is the request that was actually sent and the row that was actually
   written. */
import { config } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Both things a refusal has to reach — the credential panel and the run record
   — go through pool.query, so capturing there reads what the collector passed
   rather than a stub standing in for it. */
const notes = [];
const runs = [];
const { pool } = await import('../src/db.js');
pool.query = async (text, params = []) => {
  const t = String(text);
  if (/INSERT INTO credential_state/i.test(t)) {
    notes.push({ provider: params[0], fleet: params[1], credential: params[2],
      state: params[3], detail: params[4], surface: params[5] });
  } else if (/INSERT INTO collection_run/i.test(t)) {
    runs.push({ source: params[0], status: params[5], rows: params[6], error: params[7] });
  }
  return { rows: [{ id: 1 }], rowCount: 1 };
};
// upsertMany takes a client of its own for the BEGIN/COMMIT, so stubbing
// pool.query alone still leaves the roster write reaching for a real database.
pool.connect = async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release() {} });

/* ── tokens ──────────────────────────────────────────────────────────────
   Unsigned on purpose: readRefreshToken reads the payload without verifying,
   which is the whole point — a claim you can read for free should not cost a
   request to discover. */
const jwt = (payload) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

// The supervisor's real pasted token, dead since 2026-08-27, owner 173999.
const REAL_ECOSINE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7InR5cGUiOiJiYXNlIiwiZmxlZXRfb3duZXJfaWQiOjE3Mzk5OSwianRpIjoiYjllMGI4NmQtMmYwYi00OGFjLWIyYjItMmU2N2MzNjQwMjg1In0sImlhdCI6MTc4NzIyOTczMSwiZXhwIjoxNzg3ODM0NTMxfQ.1e5eCq-Nwtd1dS_GYusNoIrRLWwDxvjJ0qKiQId4TT8';
const soon = Math.floor(Date.now() / 1000) + 5 * 86400;
// Same owner, but alive: what an operator produces by acting on "re-capture
// from the portal" while signed in as the wrong fleet owner.
const FRESH_ECOSINE = jwt({ data: { type: 'base', fleet_owner_id: 173999, jti: 'fresh-eco' }, iat: 1, exp: soon });

const EGARI = config.bolt.companies.find((c) => c.fleet === 'egari');
const ECOSINE = config.bolt.companies.find((c) => c.fleet === 'ecosine');

/* ── the gateway and the portal, in the shapes production answers in ─────── */
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url);
  const body = opt.body ? (typeof opt.body === 'string' ? opt.body : String(opt.body)) : '';
  let json = {};
  try { json = JSON.parse(body); } catch { /* the OIDC grant is form-encoded */ }
  sent.push({ url: u.split('?')[0], company_id: json.company_id ?? json.company?.company_id ?? null });
  const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

  if (u.includes('oidc.bolt.eu')) return reply({ access_token: 'fi-access-token' });
  if (u.includes('/getDrivers')) {
    // Measured shapes: Egari answers, Ecosine is refused by company.
    return json.company_id === EGARI.companyId
      ? reply({ code: 0, message: 'OK', data: { drivers: [
        { driver_uuid: 'd1', first_name: 'A', last_name: 'B', state: 'active',
          active_vehicle: { uuid: 'v1', reg_number: 'A 12345' } }] } })
      : reply({ code: 503, message: 'NOT_AUTHORIZED', error_hint: 'COMPANIES_NOT_ALLOWED' });
  }
  if (u.includes('/getAccessToken')) return reply({ data: { access_token: 'portal-at' } });
  if (u.includes('/orderHistory/getTable')) return reply({ data: { orders: [] } });
  return reply({});
};

process.env.BOLT_CLIENT_ID = 'bolt-client';
process.env.BOLT_CLIENT_SECRET = 'bolt-secret';
// Ecosine has its own, live, correctly-owned token: the fleet that works must
// keep working, so every assertion below is also a check that it does.
process.env.BOLT_REFRESH_TOKEN_ECOSINE = jwt({ data: { type: 'base', fleet_owner_id: 173999, jti: 'eco' }, iat: 1, exp: soon });
delete process.env.BOLT_REFRESH_TOKEN_EGARI;

const { collect } = await import('../src/sources/bolt.js');

const runOnce = async () => {
  notes.length = 0; runs.length = 0; sent.length = 0;
  // Dates, as src/run.js hands them over: iso() calls toISOString on them.
  await collect({ from: new Date('2026-08-30T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z'), mode: 'incremental' });
  return { error: runs[0]?.error || '', notes: notes.slice(), sent: sent.slice() };
};

/* ── 1. the FI gateway refuses a company, and the run has to say which ───── */
console.log('\nthe FI roster refusal names the credential and the company id');

process.env.BOLT_REFRESH_TOKEN = REAL_ECOSINE;
let r = await runOnce();

check('the run still records the refusal at all', /FI roster ecosine/.test(r.error), r.error);
check('…and names the company id the gateway refused',
  /\b142868\b/.test(r.error), r.error);
check('…and names the credential it was refused for, not just the fleet',
  /BOLT_CLIENT_ID/.test(r.error), r.error);
check('…while keeping Bolt\'s own words, which are what distinguish this from an outage',
  /COMPANIES_NOT_ALLOWED/.test(r.error), r.error);

{
  const fi = r.notes.filter((n) => n.provider === 'bolt' && n.credential === 'BOLT_CLIENT_ID');
  const refused = fi.filter((n) => n.fleet === 'ecosine');
  check('the credential panel learns that the FI client was refused',
    refused.length === 1 && refused[0].state === 'invalid', JSON.stringify(fi));
  check('…with the company id in the sentence an operator reads',
    /142868/.test(refused[0]?.detail || ''), refused[0]?.detail);
  check('…and the proof the secret is not what is wrong: the company that DID answer',
    /142897/.test(refused[0]?.detail || ''), refused[0]?.detail);
  /* noteCredential truncates at 240 characters, and `notes` captures what it
     passed to the INSERT — i.e. the already-truncated string. So this reads
     the sentence the panel will really show, and the remedy is the half that
     falls off the end when the detail runs long. */
  check('…short enough that the remedy survives the 240-character truncation',
    /Bolt portal\.$/.test(refused[0]?.detail || ''),
    `${(refused[0]?.detail || '').length} chars: ${refused[0]?.detail}`);
  check('…and the fleet whose roster DID arrive is recorded as working, not left blank',
    fi.some((n) => n.fleet === 'egari' && n.state === 'ok'), JSON.stringify(fi));
}

/* ── 2. the wrong owner is not an expiry, and must not be described as one ── */
console.log('\nthe portal refusal names the wrong owner rather than an expiry');

check('the run stops telling an operator to re-capture a token that can never work',
  !/re-capture from the portal/.test(r.error), r.error);
check('…and says whose token it actually is',
  /173999/.test(r.error) && /174036/.test(r.error), r.error);
check('…and names the setting that has to be filled instead',
  /BOLT_REFRESH_TOKEN_EGARI/.test(r.error), r.error);

{
  const n = r.notes.find((x) => x.credential === 'BOLT_REFRESH_TOKEN' && x.fleet === 'egari');
  check('the credential row still calls it the wrong fleet\'s token',
    /wrong fleet's token/.test(n?.detail || ''), n?.detail);
  check('…and now says where the right one comes from',
    /BOLT_REFRESH_TOKEN_EGARI/.test(n?.detail || ''), n?.detail);
}

/* ── 3. a credential that cannot work is not asked again every cycle ─────── */
console.log('\na token this collector can already read as the wrong fleet\'s is not spent on a request');

process.env.BOLT_REFRESH_TOKEN = FRESH_ECOSINE;
r = await runOnce();

const exchanges = r.sent.filter((s) => s.url.includes('/getAccessToken'));
check('Ecosine still exchanges its own token — the working fleet keeps working',
  exchanges.some((s) => s.company_id === ECOSINE.companyId), JSON.stringify(exchanges));
check('…and Egari does not, because the owner claim already answered the question',
  !exchanges.some((s) => s.company_id === EGARI.companyId), JSON.stringify(exchanges));
check('…and the run says why rather than going quiet about the fleet',
  /portal egari/.test(r.error) && /173999/.test(r.error), r.error);
check('…without calling a live token expired',
  !/expired/.test(r.error.split('portal egari')[1] || ''), r.error);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
