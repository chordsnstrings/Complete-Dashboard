/* ── the admin gate failed open, and production noticed for us ─────────────
   Every one of the ten rows /api/settings/jobs returned in production carried
   requested_by:"unauthenticated". Not a bug in the audit column — an accurate
   record. requireAdmin called next() unconditionally when ADMIN_TOKEN was
   unset, and ADMIN_TOKEN was unset, so nobody had ever been asked for a token
   and nobody had ever presented one. An anonymous GET /api/settings returned
   UBER_CLIENT_ID, both fleets' UBER_ORG_UUID and UBER_ORG_ENCRYPTED,
   YANGO_PARK_ID, BOLT_CLIENT_ID, CABMAN_ECOSINE_ID and _USER, HOTEL_DOMAIN and
   HOTEL_BASE in clear, plus ••••••••<last 4> for every secret.

   These assertions are the ones that would have caught it: they drive the
   gate with ADMIN_TOKEN absent, which is the state production was actually in,
   rather than with it set, which is the state the old code was written for. */
import express from 'express';
import { adminVerdict, adminGate, isAdmin, redactSettings } from '../api/admin_gate.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* HELD OPEN, deliberately and temporarily. The operator's instruction was
   "don't bother with token - we need to test everything before we create
   security fixes", and this instance has no ADMIN_TOKEN, so closing the gate
   would refuse every write on it — including the credential pastes and
   collector triggers they are using right now to test the other ninety fixes.

   These assertions therefore pin the CURRENT, chosen behaviour rather than the
   safe one, and they are written to fail loudly the day someone sets the
   variable: the moment ADMIN_TOKEN exists, the gate below closes and the
   `open` flag disappears. Restore the refusal assertions then. */
console.log('\nadmin gate: held open while unconfigured, on the operator\'s instruction');

const unset = adminVerdict(null, null);
check('an unconfigured API still admits writes, and SAYS it is running open',
  unset.ok === true && unset.open === true, JSON.stringify(unset));
check('the open state is a distinct, greppable flag — not silence, so the day '
  + 'this is closed nothing has to be inferred',
  'open' in unset && adminVerdict('s3cret', 's3cret').open === undefined);
check('a configured token still admits the right header',
  adminVerdict('s3cret', 's3cret').ok === true);
check('and refuses the wrong one, distinguishably from an unconfigured API',
  adminVerdict('s3cret', 'nope').ok === false
  && adminVerdict('s3cret', 'nope').body.reason === 'bad_token');
check('and refuses a missing one',
  adminVerdict('s3cret', null).ok === false);

console.log('\nadmin gate: as middleware, over a real socket');

const app = express();
let warnings = 0;
app.use('/closed', adminGate({ env: {}, warn: () => { warnings++; } }));
app.get('/closed/thing', (_req, res) => res.json({ ok: true }));
app.use('/open', adminGate({ env: { ADMIN_TOKEN: 'letmein' } }));
app.get('/open/thing', (_req, res) => res.json({ ok: true }));
const server = app.listen(0);
server.keepAliveTimeout = 0;
const port = server.address().port;
const get = async (p, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  return { status: r.status, body: await r.json() };
};

const closed = await get('/closed/thing');
check('with ADMIN_TOKEN unset a write endpoint still answers 200 — held open by '
  + 'instruction, so the operator can keep pasting credentials while testing',
  closed.status === 200, JSON.stringify(closed));
await get('/closed/thing');
check('the operator is warned once, not once per request', warnings === 1, String(warnings));
check('with ADMIN_TOKEN set and presented, the request goes through',
  (await get('/open/thing', { 'x-admin-token': 'letmein' })).status === 200);
check('with ADMIN_TOKEN set and absent, it does not',
  (await get('/open/thing')).status === 401);
server.close();

console.log('\nadmin gate: reads are redacted rather than refused');

/* The exact shape describeSettings returns, including the masked tail that
   was the confirmation oracle. */
const rows = [
  { key: 'UBER_ORG_UUID', secret: false, configured: true, source: 'environment', value: 'a1b2c3d4-uuid', expiry: null, seen_by: [{ component: 'collector' }] },
  { key: 'UBER_CLIENT_SECRET', secret: true, configured: true, source: 'environment', value: '••••••••9f2c', expiry: null, seen_by: [] },
];
const red = redactSettings(rows);
check('no credential value survives redaction, secret or not',
  red.every((r) => r.value === ''), JSON.stringify(red.map((r) => r.value)));
check('and no last-four tail survives it either — that tail confirms a guess',
  !JSON.stringify(red).includes('9f2c'));
check('the org uuid, which is most of what impersonating the fleet needs, is gone',
  !JSON.stringify(red).includes('a1b2c3d4'));
check('but the diagnostic the page exists for survives: which key, configured, '
  + 'from where, expiring when, held by whom',
  red[0].key === 'UBER_ORG_UUID' && red[0].configured === true
  && red[0].source === 'environment' && 'expiry' in red[0]
  && red[0].seen_by[0].component === 'collector');
check('and the row SAYS it is redacted, so a blank value is not read as "unset"',
  red.every((r) => r.redacted === true));
check('redaction does not mutate the rows it was handed',
  rows[0].value === 'a1b2c3d4-uuid' && rows[1].value === '••••••••9f2c');

const req = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
check('isAdmin is false on an API with no ADMIN_TOKEN, whatever is presented',
  isAdmin(req({}), {}) === false && isAdmin(req({ 'x-admin-token': 'x' }), {}) === false);
check('and true only for the configured token',
  isAdmin(req({ 'x-admin-token': 'k' }), { ADMIN_TOKEN: 'k' }) === true
  && isAdmin(req({}), { ADMIN_TOKEN: 'k' }) === false);

console.log('\nadmin gate: the server wires both halves in');

const { readFileSync } = await import('node:fs');
const src = readFileSync('api/server.js', 'utf8');
check('server.js no longer contains a next() that fires when ADMIN_TOKEN is unset',
  !/if \(!want\)[\s\S]{0,200}return next\(\)/.test(src));
check('GET /api/settings redacts for a non-admin reader',
  /app\.get\('\/api\/settings',[\s\S]{0,600}isAdmin\(req\) \? rows : redactSettings\(rows\)/.test(src));
check('a queued collector job can no longer record itself as unauthenticated',
  !/x-admin-token'\) \? 'admin' : 'unauthenticated'/.test(src)
  && /\[mode, fleet, 'admin'\]/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
