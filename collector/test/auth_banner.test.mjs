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
import { authFailure, saysAuth, noteCredential } from '../src/auth_state.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
