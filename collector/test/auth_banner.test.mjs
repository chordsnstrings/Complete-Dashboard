/* ── an expired session used to look like a quiet week ─────────────────────
   The failure this whole feature exists for was measured live on 2026-08-26:
   with the `sid` cookie dropped, a request to supplier.uber.com/graphql
   follows a redirect to auth.uber.com and answers 404 "Not Found". The
   collector parsed that as JSON, failed, read `data.errors` (undefined) and
   the row list (undefined), and returned no error and no rows — the exact
   shape of a week in which nobody drove. The run recorded 'ok'.

   So the most perishable credential in this deployment could stop on a Friday
   and every page would report healthy sources through the weekend.

   Which cookie mattered was measured too, because guessing would have shipped
   a warning nobody could trust: dropping `sid` or `csid` bounces to the login
   page on both fleets, while dropping `sp-jwt-session` or `jwt-session`
   changes nothing at all. That is why nothing here reads a token's expiry —
   Egari's `jwt-session` was three hours past its `exp` while Egari collected
   normally, and a banner that goes amber on a working fleet is one nobody
   reads twice.

   These tests hold down the detection, the states, and the one property the
   banner depends on: silence when there is nothing true to say. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { authFailure, saysAuth, noteCredential, noteUberRest, uberOrgCredential } from '../src/auth_state.js';
import { authRoutes } from '../api/auth_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

/* ── detection ──────────────────────────────────────────────────────────── */
const SENT = 'https://supplier.uber.com/graphql';

/* The real observed shape: fetch followed the redirect, so the only trace is
   the final URL. Everything else about this response says "fine". */
check('a redirect to the login host is an authentication failure',
  authFailure(SENT, { status: 404, ok: false, data: 'Not Found',
    finalUrl: 'https://auth.uber.com/v2/?breeze_init_req_id=x' })?.kind === 'expired');
check('and it names where it landed, because that is the whole diagnosis',
  /auth\.uber\.com/.test(authFailure(SENT, { status: 404, data: 'Not Found',
    finalUrl: 'https://auth.uber.com/v2/' })?.reason || ''));
check('a 401 is one too',
  authFailure(SENT, { status: 401, data: {}, finalUrl: SENT })?.kind === 'expired');
check('a 403 is one too',
  authFailure(SENT, { status: 403, data: {}, finalUrl: SENT })?.kind === 'expired');
/* A JSON caller that gets HTML has been handed a login page, whatever status
   came with it. This is the case that produced 200 OK and no rows. */
check('an HTML body where JSON was promised is one too',
  authFailure(SENT, { status: 200, ok: true, data: '<html><body>Sign in', finalUrl: SENT })?.kind === 'expired');
check('and it quotes what came back instead',
  /web page/.test(authFailure(SENT, { status: 200, data: '<html>Sign in</html>', finalUrl: SENT })?.reason || ''));

/* The other half matters more: a working response must never raise a banner. */
check('a good JSON answer is not a failure',
  authFailure(SENT, { status: 200, ok: true, finalUrl: SENT,
    data: { data: { getEarnerBreakdownsV2: { earnerEarningsBreakdowns: [] } } } }) === null);
check('an EMPTY good answer is not a failure either — that is a quiet week',
  authFailure(SENT, { status: 200, ok: true, finalUrl: SENT, data: { data: {} } }) === null);
check('a provider error inside a well-formed body is not a redirect failure',
  authFailure(SENT, { status: 200, ok: true, finalUrl: SENT,
    data: { errors: [{ message: 'Invalid GraphQL query' }] } }) === null);
check('a redirect that stays on the same host is not a failure',
  authFailure(SENT, { status: 200, ok: true, data: { data: {} },
    finalUrl: 'https://supplier.uber.com/graphql?x=1' }) === null);
check('no response at all is not an accusation', authFailure(SENT, null) === null);

/* ── the provider's own words ───────────────────────────────────────────── */
check('an unauthenticated message is read as an auth failure', saysAuth('UNAUTHENTICATED'));
check('so is an expired token', saysAuth('Code: invalid-argument, token has expired'));
check('so is permission denied', saysAuth('PERMISSION_DENIED'));
/* Narrow on purpose: a pattern that also caught these would paint a red
   banner over a rate limit or a bad query, and a banner that is sometimes
   wrong is one nobody reads. */
check('a rate limit is not an auth failure', !saysAuth('429 too many requests, slow down'));
check('a bad query is not an auth failure', !saysAuth('Invalid GraphQL query'));
check('a page-size refusal is not an auth failure',
  !saysAuth('driver-uuids or page size cannot be more than 10'));

/* ── what gets recorded ─────────────────────────────────────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
authRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

/* Nothing observed yet. An empty table is not a clean bill of health, and the
   banner has to stay silent rather than claim one. */
let d = await get('/api/auth');
check('an empty record reports itself as unobserved, not healthy',
  d.observed === false && d.rows.length === 0 && d.headline === null, JSON.stringify(d));

await noteCredential(db, { provider: 'uber', fleet: 'ecosine', credential: 'UBER_WEB_COOKIE',
  state: 'ok', surface: 'supplier graphql' });
d = await get('/api/auth');
check('a working credential raises nothing',
  d.stopped === 0 && d.at_risk === 0 && d.headline === null, JSON.stringify(d));
check('and it records when it last worked',
  d.rows[0].last_ok_at != null && d.rows[0].severity === 'ok');

await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: 'UBER_WEB_COOKIE_EGARI',
  state: 'expired', detail: 'redirected to auth.uber.com — the session is no longer signed in',
  surface: 'supplier graphql' });
d = await get('/api/auth');
const eg = d.rows.find((r) => r.fleet_id === 'egari');
check('a refused credential is stopped', eg?.severity === 'stopped', JSON.stringify(eg));
check('the headline names the key a person has to replace',
  /UBER_WEB_COOKIE_EGARI/.test(d.headline || ''), d.headline);
check('and the provider’s own words, not a summary',
  /auth\.uber\.com/.test(d.headline || ''), d.headline);
check('one fleet failing leaves the other alone',
  d.rows.find((r) => r.fleet_id === 'ecosine')?.severity === 'ok');

/* last_ok_at is what turns "Uber is broken" into "Uber stopped at 14:20 and
   last worked at 09:54", so a failure must not erase it. */
check('a failure does not erase when the credential last worked',
  eg?.last_ok_at == null, 'egari never succeeded here, so it stays null');
await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: 'UBER_WEB_COOKIE_EGARI',
  state: 'ok', surface: 'supplier graphql' });
await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: 'UBER_WEB_COOKIE_EGARI',
  state: 'expired', detail: 'refused', surface: 'supplier graphql' });
d = await get('/api/auth');
const eg2 = d.rows.find((r) => r.fleet_id === 'egari');
check('a credential that worked and then failed keeps its last success',
  eg2.state === 'expired' && eg2.last_ok_at != null, JSON.stringify(eg2));

/* ── the stall, which is the amber the cookie could not honestly give ───── */
await db.query(`INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, started_at, finished_at)
                VALUES ('yango','ecosine','incremental','ok',5, now() - interval '40 hours', now() - interval '40 hours')`);
await noteCredential(db, { provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY',
  state: 'ok', surface: 'fleet api' });
d = await get('/api/auth');
const y = d.rows.find((r) => r.provider === 'yango');
check('a credential that works while its source has stalled is at risk',
  y?.severity === 'at-risk', JSON.stringify(y));
check('and the banner says how long against what was expected',
  y.run_age_h > 12 && y.stall_limit_h === 12, JSON.stringify(y));

/* A stall on a credential that is already refused would report one fault
   twice, in two colours. */
await db.query(`INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, started_at, finished_at)
                VALUES ('uber','egari','incremental','ok',5, now() - interval '40 hours', now() - interval '40 hours')`);
d = await get('/api/auth');
check('a stopped credential is not also reported as merely at risk',
  d.rows.find((r) => r.provider === 'uber' && r.fleet_id === 'egari').severity === 'stopped');
check('red outranks amber in the headline',
  /stopped working/.test(d.headline || ''), d.headline);

/* ── a fleet with no credential at all ──────────────────────────────────── */
await noteCredential(db, { provider: 'cabman', fleet: 'egari', credential: 'CABMAN_EGARI_PASS',
  state: 'missing', detail: 'no tracker account is configured for this fleet' });
d = await get('/api/auth');
const cb = d.rows.find((r) => r.provider === 'cabman');
check('a credential that was never configured is missing, not stopped',
  cb?.severity === 'missing' && d.missing === 1, JSON.stringify(cb));
check('and missing never turns the banner red, because nothing broke',
  !/CABMAN/.test(d.headline || ''), d.headline);

/* ── the REST refusal the token grant cannot see ────────────────────────── */
/* uberOAuthToken() succeeds — the client credentials are fine — and then every
   data call for one of the two orgs answers 403 "bad key". Production logged
   that twice a minute while /api/auth reported UBER_CLIENT_SECRET ok, because
   the grant is a different request from the call. */
const REST = 'https://api.uber.com/v1/vehicle-suppliers/drivers/actions?org_id=x';
const REFUSED = { status: 403, ok: false, finalUrl: REST,
  data: { code: 'rtapi.internal_server_error', message: 'bad key' } };

check('a 403 on a data call is an authentication failure',
  authFailure(REST, REFUSED)?.kind === 'expired');
check('and it quotes the provider rather than the status alone',
  /bad key/.test(authFailure(REST, REFUSED)?.reason || ''), authFailure(REST, REFUSED)?.reason);
/* Which credential, as far as a status code can say. These endpoints select
   what you are asking for with org_id, so 403 is about that key; 401 would be
   about the token behind it, which is a different credential and a different
   fix. */
check('a 403 blames the resource selector, not the token',
  authFailure(REST, REFUSED)?.blames === 'resource');
check('a 401 blames the token',
  authFailure(REST, { ...REFUSED, status: 401 })?.blames === 'token');

check('the org credential is named per fleet',
  uberOrgCredential('egari') === 'UBER_ORG_ENCRYPTED_EGARI'
  && uberOrgCredential('ecosine') === 'UBER_ORG_ENCRYPTED');

await noteUberRest(db, REST, REFUSED, { fleet: 'egari' }, 'drivers/actions');
d = await get('/api/auth');
const org = d.rows.find((r) => r.credential === 'UBER_ORG_ENCRYPTED_EGARI');
check('a refused org key is recorded against the key a person would replace',
  org?.severity === 'stopped' && org.fleet_id === 'egari', JSON.stringify(org));
check('and the banner headline names it with the provider\'s words',
  /UBER_ORG_ENCRYPTED_EGARI/.test(d.headline || '') && /bad key/.test(d.headline || ''),
  d.headline);
/* The secret is a different credential and must not be dragged down with it —
   it is working, and telling somebody to replace it would waste their time. */
const secret = d.rows.find((r) => r.credential === 'UBER_CLIENT_SECRET');
check('the client secret is not blamed for the org key being wrong',
  secret == null || secret.severity !== 'stopped', JSON.stringify(secret));

/* A good answer must clear it again, or the banner can only ever go red. */
await noteUberRest(db, REST, { status: 200, ok: true, finalUrl: REST,
  data: { driverStatusOverviews: [] } }, { fleet: 'egari' }, 'drivers/actions');
d = await get('/api/auth');
{
  const back = d.rows.find((r) => r.credential === 'UBER_ORG_ENCRYPTED_EGARI');
  check('a working call clears the refusal', back?.state === 'ok', JSON.stringify(back));
  check('and the last-success time is now recorded', back?.last_ok_at != null);
  /* Not green, and correctly so: this fixture also carries a uber/egari run
     that finished forty hours ago, and the credential working while its source
     has stalled is exactly what amber is for. Red would be wrong — nobody has
     to replace anything — and green would hide a source that has stopped. */
  check('a working credential over a stalled source is amber, not red or green',
    back?.severity === 'at-risk', String(back?.severity));
}
/* One fleet's key failing says nothing about the other's. */
await noteUberRest(db, REST, REFUSED, { fleet: 'ecosine' }, 'earners/payments');
d = await get('/api/auth');
check('the two fleets carry their own org keys',
  d.rows.filter((r) => /UBER_ORG_ENCRYPTED/.test(r.credential)).length === 2,
  JSON.stringify(d.rows.filter((r) => /UBER_ORG/.test(r.credential)).map((r) => `${r.credential}=${r.severity}`)));

/* ── every state a source can record has to reach the reader ─────────────
   The severity map tested only for 'expired' and 'missing'. Every other state
   fell through to the stall clock — which only fires for state 'ok' — and
   landed on 'ok'. Measured on production 2026-09-02, minutes after the
   collector first learned to record its refusals: two rows read state
   'invalid' and severity 'ok', with stopped 0 and no headline. One was a Bolt
   token minted for the wrong fleet's owner, the other a Yango session
   answering 403. Both were shown as fine. */
console.log('\nno recorded state is rendered as healthy');
{
  const { noteCredential } = await import('../src/auth_state.js');
  await noteCredential(db, { provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN',
    state: 'invalid', detail: 'the token belongs to owner 173999, not 174036' });
  await noteCredential(db, { provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY',
    state: 'unknown', detail: 'the cookie-free comparison did not complete' });
  const a = await get('/api/auth');
  const bolt = a.rows.find((r) => r.credential === 'BOLT_REFRESH_TOKEN');
  const yango = a.rows.find((r) => r.credential === 'YANGO_API_KEY');
  check('a credential recorded invalid is stopped, not ok',
    bolt?.severity === 'stopped', JSON.stringify(bolt && [bolt.state, bolt.severity]));
  check('…and it reaches the headline, which is the only thing anyone reads',
    /173999/.test(a.headline || ''), String(a.headline).slice(0, 120));
  check('a check that could not run is at-risk, not ok',
    yango?.severity === 'at-risk', JSON.stringify(yango && [yango.state, yango.severity]));
  /* The rule, not just these two states: the failure was a state added by one
     change and silently rendered healthy by another, so the default has to be
     the safe answer for a state nobody has thought of yet. */
  await noteCredential(db, { provider: 'fms', fleet: 'ecosine', credential: 'FMS_PASSWORD',
    state: 'a-state-nobody-has-written-yet', detail: 'from the future' });
  const b = await get('/api/auth');
  check('…and a state this page has never seen is not assumed to be fine',
    b.rows.find((r) => r.credential === 'FMS_PASSWORD')?.severity === 'at-risk',
    JSON.stringify(b.rows.find((r) => r.credential === 'FMS_PASSWORD')));
}

console.log('\nand a run that wrote nothing does not reset the stall clock');
{
  /* lastOk counted any 'partial' as the source still collecting. A partial
     that wrote no rows is not evidence that anything works — and it is what an
     all-but-one-window failure looked like before logRun learned to escalate. */
  const src = await import('node:fs').then((fs) => fs.readFileSync('api/auth_routes.js', 'utf8'));
  check('a partial with no rows is skipped when measuring the last good run',
    /r\.status === 'partial' && !\(Number\(r\.rows_written\) > 0\)/.test(src),
    'the clock must not be reset by a run that produced nothing');
  check('…and rows_written is actually selected, or the guard reads undefined',
    /status, finished_at, rows_written/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
