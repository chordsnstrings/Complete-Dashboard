/* PASSKEYS AND SINGLE SIGN-ON — both ceremonies, end to end, through the
   real access gate.
   ═════════════════════════════════════════════════════════════════════════
   The same harness as test/access_core.test.mjs: a pglite database built
   from every schema file (v121 included), identify → gate → the response
   cache → the routes, over real HTTP with real cookies. The routes are the
   real ones: api/access/routes.js and api/access/signin_methods.js. The
   authenticator is synthetic (test/_authenticator.mjs) and so is the
   company's sign-in provider (an express app with its own RSA key, reached
   by the server's real fetch). Synthetic people only, @example.test.

   What it holds the build to:
     · OFF BY DEFAULT, AND OPEN MODE UNCHANGED — every new route says "not
       turned on" until the Owner turns it on, and an anonymous visitor's
       answers are the same before and after.
     · THE SAME SESSION — a passkey or single sign-on session has the
       password path's lifetime, cookie and restrictions; it differs only in
       auth_method.
     · STEP-UP, FOUR-EYES, AUDIT exactly as the password path: a passkey
       sign-in does not re-confirm anything by itself; a four-eyes commit
       by the preparer is refused whichever way each of them signed in; every
       sign-in, refusal and change is in the hash chain.
     · PASSKEYS — registration only signed in and re-confirmed; user
       verification; a counter that goes backwards disables the credential;
       "a passkey counts as MFA" (middleware.js identify).
     · SINGLE SIGN-ON — PKCE, nonce and a state bound to the browser;
       verified addresses on the Owner's domains only; existing accounts
       only unless the Owner allows provisioning (then with no access); the
       provider's subject, once linked, decides; two-step still owed when
       the provider did not use it.

   REVERSIONS THAT PROVE IT — each was made, run, and seen to fail the named
   check, 2026-11-12:
     · middleware.js identify: drop `&& !multiFactorSession` — "…the same
       person's passkey session is not held to it" fails.
     · signin_methods.js callback: skip the binding-cookie comparison —
       "a return trip without this browser's cookie is refused" fails.
     · signin_methods.js callback: skip the existing-subject check — "the
       same address under a different provider account is refused" fails.
     · signin_methods.js passkey register/options: drop the stepupFresh
       check — "adding a passkey needs a fresh re-confirmation" fails.
     · routes.js config: drop the signinMethodChanges call — "the Owner
       turns passkeys on" fails (the switch is ignored). */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from './schema.mjs';
import { accessLayer } from '../api/access/middleware.js';
import { accessRoutes } from '../api/access/routes.js';
import { signinMethodRoutes } from '../api/access/signin_methods.js';
import { FOUR_EYES, lookupEntry } from '../api/access/manifest.js';
import * as svc from '../api/access/service.js';
import { verifyChain } from '../api/access/audit.js';
import { hotp, totpStep, hashPassword, newTotpSecret, seal, tokenHash } from '../api/access/crypto.js';
import { responseCache } from '../api/cache.js';
import { SSO_REFUSALS } from '../api/public/signin_methods.js';
import { makeAuthenticator, mockProvider } from './_authenticator.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The environment the server reads. PUBLIC_URL is where the authenticator
   and the provider think the site is; the test maps it onto the real port. */
const PUBLIC = 'http://localhost:8310';
const idp = await mockProvider();
for (const k of ['PUBLIC_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_NAME', 'ACCESS_MODE']) delete process.env[k];
process.env.PUBLIC_URL = PUBLIC;

const pg = new PGlite();
for (const f of SCHEMA_FILES) await pg.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
const db = { query: (t, p) => pg.query(t, p) };

/* Data routes of the test's own (as access_core does), behind the REAL
   self-deciding rule for /api/auth and /api/access. */
const MANIFEST = {
  'GET /api/t/kpis': { method: 'GET', path: '/api/t/kpis', subject: 'REV', carries: ['REV'], grain: 'aggregate',
    fields: [], whole: [], fleet: 'param', fleetRows: [], fleetKey: '', cap: null },
  'GET /api/t/cash': { method: 'GET', path: '/api/t/cash', subject: 'CASH', carries: ['ID', 'CASH'], grain: 'list',
    fields: [], whole: [], fleet: 'mixed', fleetRows: [], fleetKey: '', cap: null },
  'POST /api/ledger/import/commit': { method: 'POST', path: '/api/ledger/import/commit', subject: 'CASH', carries: ['CASH', 'ID'],
    grain: 'none', fields: [], whole: [], fleet: 'mixed', fleetRows: [], fleetKey: '', cap: 'cash.import.commit',
    fourEyes: FOUR_EYES['POST /api/ledger/import/commit'] },
};
const lookup = (m, p) => { const real = lookupEntry(m, p); return real?.self ? real : MANIFEST[`${m} ${p}`] || null; };
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
const layer = accessLayer({ db, lookup });
app.use(layer.identify);
app.use(layer.gate);
app.use('/api', responseCache({ pool: db, ttlMs: 0 }));
app.get('/api/t/kpis', (req, res) => res.json({ trips: 5, revenue: 900 }));
app.get('/api/t/cash', (req, res) => res.json([{ name: 'Test Driver A', balance: 10 }]));
const imported = [];
app.post('/api/ledger/import/commit', (req, res) => { imported.push(req.body); res.json({ ok: true, wrote: req.body.rows.length }); });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: 'internal', detail: String(e) }));
accessRoutes(app, { db, layer, wrap, smsSend: async () => ({ ok: true }), reportHttp: async () => ({ status: 200, data: {} }) });
signinMethodRoutes(app, { db, layer, wrap });
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;

/* A tiny browser: one cookie jar, no automatic redirects (the test follows
   them, so it can look at every hop), and its own address. */
let ipSeq = 10;
const browser = () => {
  const jar = {};
  const ip = `198.51.100.${ipSeq++}`;
  const call = async (method, path, body, { csrf = true, headers = {} } = {}) => {
    const url = path.startsWith('http') ? path : B + path;
    const h = { ...headers, 'x-forwarded-for': ip, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (csrf && jar.fm_csrf && method !== 'GET') h['x-fm-csrf'] = decodeURIComponent(jar.fm_csrf);
    const r = await fetch(url, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const setc = r.headers.getSetCookie?.() || [];
    if (url.startsWith(B)) {
      for (const c of setc) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i); const v = kv.slice(i + 1);
        if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v;
      }
    }
    let j = null; try { j = await r.clone().json(); } catch { /* not json */ }
    return { status: r.status, json: j, location: r.headers.get('location'), setc, headers: r.headers };
  };
  return { jar, ip, get: (p, o) => call('GET', p, undefined, o), post: (p, b = {}, o) => call('POST', p, b, o) };
};

/* ── people ─────────────────────────────────────────────────────────── */
const PASS = 'a long synthetic test password';
async function person(email, role, { totp = false, status = 'active' } = {}) {
  const u = await svc.createUser(db, { email, name: `Test ${role || 'Nobody'}`, status, passwordHash: hashPassword(PASS) });
  if (role) await svc.createGrant(db, { userId: u.id, roleCode: role, reason: 'test' });
  let secret = null;
  if (totp) {
    secret = newTotpSecret();
    await db.query('UPDATE access_user SET totp_enabled = true, totp_secret = $2 WHERE id = $1', [u.id, seal(secret)]);
  }
  return { id: u.id, email, secret };
}
/* A code from the step AFTER the last one this PERSON used: the server
   refuses a code twice (the replay rule), and accepts the steps one either
   side of now — three codes a person per thirty seconds. Past those, wait
   for the clock. */
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function code(p) {
  for (;;) {
    const t = totpStep();
    const s = Math.max((p.lastStep ?? -Infinity) + 1, t - 1);
    if (s <= t + 1) { p.lastStep = s; return hotp(p.secret, s); }
    await sleep(1000);
  }
}
async function signInPassword(b, p) {
  const r = await b.post('/api/auth/login', { email: p.email, password: PASS });
  if (r.json?.mfa === 'code') return b.post('/api/auth/login/code', { ticket: r.json.ticket, code: await code(p) });
  return r;
}
async function stepUp(b, p) {
  return b.post('/api/auth/stepup', p.secret ? { code: await code(p) } : { password: PASS });
}
/* A re-confirmation lasts ten minutes on its session; asked again only when
   it has run out, so the test spends no code it does not need. */
async function freshStepUp(b, p) {
  const s = await sessionRow(b);
  if (s?.stepup_at && Date.now() - new Date(s.stepup_at).getTime() < 8 * 60_000) return { status: 200 };
  return stepUp(b, p);
}
const sessionRow = async (b) => (await db.query('SELECT * FROM access_session WHERE id = $1', [tokenHash(decodeURIComponent(b.jar.fm_sid))])).rows[0];
const auditOf = async (action) => (await db.query('SELECT * FROM access_audit WHERE action = $1 ORDER BY id', [action])).rows;

const owner = await person('owner@example.test', 'OWN', { totp: true });
const fin = await person('finance@example.test', 'FIN');
const clk = await person('cash@example.test', 'CLK');
const acc = await person('access@example.test', 'ACC', { totp: true });
const sus = await person('suspended@example.test', 'DSP', { status: 'suspended' });

const ob = browser();
const ab = browser();
console.log('\n1. off by default, and open mode as it was');
{
  const anon = browser();
  const k = await anon.get('/api/t/kpis');
  check('an anonymous visitor in open mode gets the data, unshaped', k.status === 200 && k.json.revenue === 900);
  const m = await anon.get('/api/auth/methods');
  check('the sign-in page is offered neither method', m.status === 200 && m.json.passkeys === false && m.json.sso === null);
  const o = await anon.post('/api/auth/passkey/login/options', {});
  check('passkey sign-in says it is not turned on', o.status === 404 && o.json.error === 'off' && /not turned on/.test(o.json.detail));
  const s = await anon.get('/api/auth/sso/start');
  check('single sign-on sends the browser back to say it is not turned on', s.status === 302 && s.location === '/signin?sso=off');
  check('every new route is a self-deciding /api/auth or /api/access route in the manifest',
    ['/api/auth/methods', '/api/auth/passkey/login', '/api/auth/sso/callback', '/api/access/signin-methods', '/api/access/users/7/signin-methods']
      .every((p) => lookupEntry('GET', p)?.self === true));
  const cfg = await svc.getConfig(db, { fresh: true });
  check('the four settings default to off and no domains', cfg.passkeys === 'off' && cfg.sso === 'off' && cfg.sso_provision === 'off'
    && Array.isArray(cfg.sso_domains) && cfg.sso_domains.length === 0);
}

console.log('\n2. the Owner turns passkeys on');
{
  const r = await signInPassword(ob, owner);
  check('the Owner signs in with a password and a code', r.status === 200, JSON.stringify(r.json));
  const noStep = await ob.post('/api/access/config', { passkeys: 'on' });
  check('turning them on needs a fresh re-confirmation', noStep.status === 403 && noStep.json.error === 'stepup');
  await stepUp(ob, owner);
  delete process.env.PUBLIC_URL;
  const notReady = await ob.post('/api/access/config', { passkeys: 'on' });
  check('…and is refused, with the true reason, while PUBLIC_URL is unset', notReady.status === 409 && /PUBLIC_URL is not set/.test(notReady.json.detail));
  process.env.PUBLIC_URL = PUBLIC;
  const bad = await ob.post('/api/access/config', { passkeys: 'maybe' });
  check('a value other than on or off is refused', bad.status === 400 && bad.json.error === 'bad_switch');
  const ok = await ob.post('/api/access/config', { passkeys: 'on' });
  check('the Owner turns passkeys on', ok.status === 200 && ok.json.config.passkeys === 'on');
  await signInPassword(ab, acc);
  await stepUp(ab, acc);
  const notOwner = await ab.post('/api/access/config', { passkeys: 'off' });
  check('an Access admin cannot switch them', notOwner.status === 403 && /Only the Owner/.test(notOwner.json.detail));
  const m = await browser().get('/api/auth/methods');
  check('the sign-in page is now offered passkeys', m.json.passkeys === true && m.json.sso === null);
  const cl = (await auditOf('access.config_changed')).at(-1);
  check('the change is in the audit log, by the Owner', cl && Number(cl.actor_id) === owner.id && cl.detail.passkeys === 'on');
}

console.log('\n3. adding a passkey to your own account');
const finKey = makeAuthenticator({ origin: PUBLIC, rpId: 'localhost' });
const fb = browser();
{
  const anon = await browser().post('/api/auth/passkey/register/options', {});
  check('nobody signed in cannot add one', anon.status === 401);
  await signInPassword(fb, fin);
  const noCsrf = await fb.post('/api/auth/passkey/register/options', {}, { csrf: false });
  check('a change without the CSRF header is refused', noCsrf.status === 403 && noCsrf.json.error === 'csrf');
  const stale = await fb.post('/api/auth/passkey/register/options', {});
  check('adding a passkey needs a fresh re-confirmation', stale.status === 403 && stale.json.error === 'stepup');
  await stepUp(fb, fin);
  const o = await fb.post('/api/auth/passkey/register/options', {});
  check('options: discoverable, user verification required, no attestation', o.status === 200
    && o.json.publicKey.authenticatorSelection.userVerification === 'required' && o.json.publicKey.attestation === 'none'
    && o.json.publicKey.rp.id === 'localhost' && o.json.publicKey.user.name === fin.email);
  check('…and the user handle is opaque — not the email, not the row id',
    o.json.publicKey.user.id.length >= 43 && !Buffer.from(o.json.publicKey.user.id, 'base64url').toString().includes('finance'));
  /* Someone else's browser cannot finish this person's ceremony. */
  const other = browser();
  await signInPassword(other, clk);
  await stepUp(other, clk);
  const stolen = await other.post('/api/auth/passkey/register', { credential: finKey.create(o.json.publicKey) });
  check('a ceremony started in one session cannot be finished in another', stolen.status === 400 && stolen.json.error === 'expired');
  const o2 = await fb.post('/api/auth/passkey/register/options', {});
  const uvless = makeAuthenticator({ origin: PUBLIC, rpId: 'localhost' });
  const noUv = await fb.post('/api/auth/passkey/register', { credential: uvless.create(o2.json.publicKey, { flags: { uv: false } }) });
  check('an authenticator that did not verify the person is refused, saying so', noUv.status === 400 && /did not verify the person/.test(noUv.json.detail));
  const o3 = await fb.post('/api/auth/passkey/register/options', {});
  const reg = await fb.post('/api/auth/passkey/register', { credential: finKey.create(o3.json.publicKey), name: 'Test laptop' });
  check('a passkey is added', reg.status === 200 && reg.json.passkey.name === 'Test laptop');
  const row = (await db.query('SELECT * FROM access_passkey WHERE user_id = $1', [fin.id])).rows[0];
  check('stored: credential id, public key, sign count, transports, the person', row && row.credential_id === finKey.credentialId
    && row.public_key.length > 80 && Number(row.sign_count) === 0 && row.transports.includes('internal') && Number(row.user_id) === fin.id);
  const o4 = await fb.post('/api/auth/passkey/register/options', {});
  check('the next set-up excludes it, and reuses the same user handle', o4.json.publicKey.excludeCredentials.some((c) => c.id === finKey.credentialId)
    && o4.json.publicKey.user.id === row.user_handle);
  const again = await fb.post('/api/auth/passkey/register', { credential: finKey.create(o4.json.publicKey) });
  check('the same passkey twice is refused', again.status === 409 && again.json.error === 'already');
  const list = await fb.get('/api/auth/passkeys');
  check('the account page lists it — and never its key, handle or id', list.json.passkeys.length === 1
    && !JSON.stringify(list.json).includes(row.public_key) && !JSON.stringify(list.json).includes(row.credential_id));
  check('the addition is in the audit log', (await auditOf('auth.passkey_added')).some((a) => Number(a.actor_id) === fin.id));
}

const passkeySignIn = async (b, key, over = {}) => {
  const o = await b.post('/api/auth/passkey/login/options', {});
  if (o.status !== 200) return o;
  const credential = key.get(o.json.publicKey, over);
  const r = await b.post('/api/auth/passkey/login', { credential });
  r.credential = credential;
  return r;
};

console.log('\n4. signing in with a passkey: the same session as a password');
const fp = browser();
{
  const r = await passkeySignIn(fp, finKey);
  check('a passkey signs in, with no email typed', r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  const me = await fp.get('/api/auth/me');
  check('…as the person it belongs to', me.json.signedIn && me.json.user.email === fin.email && !me.json.restricted);
  const ps = await sessionRow(fb);
  const ks = await sessionRow(fp);
  const life = (s) => Math.round((new Date(s.expires_at) - new Date(s.created_at)) / 3600_000);
  check('the session has the password session\'s absolute and idle limits', life(ks) === life(ps) && ks.idle_minutes === ps.idle_minutes && ks.kind === 'browser');
  check('…and differs only in how it was opened: passkey, two-step done', ks.auth_method === 'passkey' && ks.mfa_ok === true && ps.auth_method === null);
  check('…with the same HttpOnly, SameSite=Lax session cookie and a fresh CSRF cookie',
    r.setc.some((c) => /^fm_sid=/.test(c) && /HttpOnly/.test(c) && /SameSite=Lax/.test(c)) && r.setc.some((c) => /^fm_csrf=/.test(c)));
  check('…and no re-confirmation of its own: step-up is still owed', !ks.stepup_at);
  const cash = await fp.get('/api/t/cash');
  check('the data answers as the person\'s role', cash.status === 200 && cash.json[0].balance === 10);
  const replay = await fp.post('/api/auth/passkey/login', { credential: r.credential });
  check('the same signed answer again is refused (the challenge was used)', replay.status === 401 && replay.json.error === 'expired');
  const login = (await auditOf('auth.login')).at(-1);
  check('the sign-in is in the audit log, as a passkey sign-in', Number(login.subject_id) === fin.id && login.detail.method === 'passkey' && login.detail.mfa === true);
  const unknown = await passkeySignIn(browser(), makeAuthenticator({ origin: PUBLIC, rpId: 'localhost' }));
  check('a passkey that was never registered is refused, saying so', unknown.status === 401 && unknown.json.error === 'unknown_passkey' && /not registered/.test(unknown.json.detail));
  const evil = await passkeySignIn(browser(), finKey, { origin: 'https://evil.example' });
  check('a passkey used on another site is refused', evil.status === 401 && /not on http:\/\/localhost:8310/.test(evil.json.detail));
  const sk = makeAuthenticator({ origin: PUBLIC, rpId: 'localhost' });
  await db.query(`INSERT INTO access_passkey (user_id, credential_id, public_key, alg, user_handle)
    VALUES ($1, $2, $3, -7, $4)`, [sus.id, sk.credentialId,
    (await import('../api/access/webauthn.js')).keyToSpki((await import('node:crypto')).createPublicKey(sk.state.privateKey)), 'h-sus']);
  sk.state.userHandle = 'h-sus';
  const susp = await passkeySignIn(browser(), sk);
  check('a suspended account is refused with the password path\'s sentence', susp.status === 403 && /suspended/.test(susp.json.detail));
}

console.log('\n5. a counter that goes backwards switches the passkey off');
{
  const k2 = makeAuthenticator({ origin: PUBLIC, rpId: 'localhost', counter: 0 });
  const b = browser();
  await signInPassword(b, clk);
  await stepUp(b, clk);
  const o = await b.post('/api/auth/passkey/register/options', {});
  await b.post('/api/auth/passkey/register', { credential: k2.create(o.json.publicKey) });
  const first = await passkeySignIn(browser(), k2);
  check('a counting authenticator signs in (counter 1)', first.status === 200);
  const cloned = await passkeySignIn(browser(), k2, { count: 1 });
  check('the same counter again is refused as a copy, the reason given', cloned.status === 403 && cloned.json.error === 'passkey_cloned'
    && /counter went backwards/.test(cloned.json.detail));
  const after = await passkeySignIn(browser(), k2, { count: 9 });
  check('…and the passkey stays off, even with a higher counter', after.status === 403 && after.json.error === 'passkey_disabled');
  check('…recorded in the audit log', (await auditOf('auth.passkey_counter_regressed')).length === 1);
  const list = await b.get('/api/auth/passkeys');
  check('the account page shows it switched off, and why', /went backwards/.test(list.json.passkeys[0].disabled_reason || ''));
}

console.log('\n6. step-up and four-eyes, exactly as the password path');
{
  /* The cash desk prepares a sheet; Finance commits it. */
  const cb = browser();
  await signInPassword(cb, clk);
  const prop = await cb.post('/api/ledger/import/commit', { rows: [{ amount: 10 }], batch: 'b-1' });
  check('the cash desk\'s commit is stored as a proposal', prop.status === 202 && prop.json.proposal);
  const nostep = await fp.post('/api/ledger/import/commit', { proposal: prop.json.proposal });
  check('Finance, signed in by passkey, is asked to re-confirm before committing', nostep.status === 403 && nostep.json.error === 'stepup');
  const so = await fp.post('/api/auth/passkey/stepup/options', {});
  check('step-up options list only this person\'s passkeys', so.status === 200 && so.json.publicKey.allowCredentials.length === 1
    && so.json.publicKey.allowCredentials[0].id === finKey.credentialId);
  const wrongKey = makeAuthenticator({ origin: PUBLIC, rpId: 'localhost' });
  const bad = await fp.post('/api/auth/passkey/stepup', { credential: wrongKey.get(so.json.publicKey) });
  check('another passkey cannot confirm it is them', bad.status === 401 && /not one of yours/.test(bad.json.detail));
  const so2 = await fp.post('/api/auth/passkey/stepup/options', {});
  const st = await fp.post('/api/auth/passkey/stepup', { credential: finKey.get(so2.json.publicKey) });
  check('their own passkey does', st.status === 200);
  check('…in the same column and with the same audit action as /api/auth/stepup',
    Boolean((await sessionRow(fp)).stepup_at) && (await auditOf('auth.stepup')).at(-1).detail.method === 'passkey');
  const commit = await fp.post('/api/ledger/import/commit', { proposal: prop.json.proposal });
  check('then the commit goes through, and exactly the stored rows land', commit.status === 200 && imported.length === 1 && imported[0].batch === 'b-1');
  /* Finance prepares; Finance — signed in another way, in another browser — cannot commit. */
  const own = await fp.post('/api/ledger/import/commit', { rows: [{ amount: 5 }], batch: 'b-2' });
  const fb2 = browser();
  await signInPassword(fb2, fin);
  await stepUp(fb2, fin);
  const self = await fb2.post('/api/ledger/import/commit', { proposal: own.json.proposal });
  check('the preparer cannot commit their own proposal from a password session either', self.status === 403 && self.json.error === 'four_eyes');
  const nb = browser();
  await signInPassword(nb, clk);
  const noKey = await nb.post('/api/auth/passkey/stepup/options', {});
  check('step-up with a passkey, for somebody without one, says so', noKey.status === 409 && /no passkey/.test(noKey.json.detail));
  const actAudit = (await db.query(`SELECT * FROM access_audit WHERE action = 'act:cash.import.commit' ORDER BY id DESC LIMIT 1`)).rows[0];
  check('the commit by a passkey session is in the audit log under the person', actAudit && Number(actAudit.actor_id) === fin.id);
}

console.log('\n7. a passkey counts as two-step (ULM-DESIGN §5.1)');
{
  /* Everyone who can change anything must now use two-step. Finance has no
     authenticator app — only a passkey. */
  await freshStepUp(ob, owner);
  const pol = await ob.post('/api/access/config', { mfa: 'writers' });
  check('the Owner requires two-step of everyone who can write', pol.status === 200);
  const pw = browser();
  await signInPassword(pw, fin);
  const held = await pw.get('/api/t/cash');
  check('Finance signing in with a password is held to setting up two-step', held.status === 403 && held.json.need === 'mfa');
  const pk = browser();
  const r = await passkeySignIn(pk, finKey);
  const ok = await pk.get('/api/t/cash');
  check('…the same person\'s passkey session is not held to it', r.status === 200 && ok.status === 200, JSON.stringify(ok.json));
  await freshStepUp(ob, owner);
  await ob.post('/api/access/config', { mfa: 'admins' });
}

console.log('\n8. removing passkeys');
{
  const keep = browser();
  await passkeySignIn(keep, finKey);
  const mineNow = (await keep.get('/api/auth/passkeys')).json.passkeys;
  const nostep = await keep.post('/api/auth/passkeys/remove', { id: mineNow[0].id });
  check('removing one needs a fresh re-confirmation', nostep.status === 403 && nostep.json.error === 'stepup', JSON.stringify(nostep.json));
  const notMine = await fb.post('/api/auth/passkeys/remove', { id: 999999 });
  check('…and only removes one of your own', notMine.status === 404 && /no such passkey/.test(notMine.json.detail));
  /* The Access admin cannot take a Finance manager's passkeys away: the ceiling. */
  await freshStepUp(ab, acc);
  const ceiling = await ab.post(`/api/access/users/${fin.id}`, { action: 'remove_passkeys' });
  check('an Access admin cannot remove a Finance manager\'s passkeys (the ceiling)', ceiling.status === 403 && ceiling.json.error === 'ceiling');
  const look = await ab.get(`/api/access/users/${fin.id}/signin-methods`);
  check('…but can see which passkeys they have, never the keys', look.status === 200 && look.json.passkeys.length === 1 && !('public_key' in look.json.passkeys[0]));
  await freshStepUp(ob, owner);
  const rm = await ob.post(`/api/access/users/${fin.id}`, { action: 'remove_passkeys', reason: 'lost phone' });
  check('the Owner removes them', rm.status === 200 && (await db.query('SELECT 1 FROM access_passkey WHERE user_id = $1', [fin.id])).rows.length === 0);
  check('…and every session they had is ended', (await keep.get('/api/auth/me')).json.signedIn === false);
  check('…recorded as an account action', (await auditOf('access.user_remove_passkeys')).length === 1);
  const gone = await passkeySignIn(browser(), finKey);
  check('the removed passkey no longer signs in', gone.status === 401 && gone.json.error === 'unknown_passkey');
}

console.log('\n9. single sign-on: the Owner turns it on');
process.env.OIDC_ISSUER = idp.issuer;
process.env.OIDC_CLIENT_ID = idp.clientId;
process.env.OIDC_CLIENT_SECRET = idp.clientSecret;
{
  await freshStepUp(ob, owner);
  const noDomain = await ob.post('/api/access/config', { sso: 'on' });
  check('turning it on with no company domain listed is refused, saying why', noDomain.status === 400 && noDomain.json.error === 'no_domains');
  const gmail = await ob.post('/api/access/config', { sso_domains: ['gmail.com'] });
  check('a public mail domain is refused', gmail.status === 400 && /public email service/.test(gmail.json.detail));
  delete process.env.OIDC_CLIENT_SECRET;
  const noSecret = await ob.post('/api/access/config', { sso: 'on', sso_domains: ['example.test'] });
  check('without the client secret in the environment it is refused, naming what is missing', noSecret.status === 409 && /OIDC_CLIENT_SECRET/.test(noSecret.json.detail));
  process.env.OIDC_CLIENT_SECRET = idp.clientSecret;
  const on = await ob.post('/api/access/config', { sso: 'on', sso_domains: ['Example.TEST'] });
  check('with the environment set and a domain, it turns on', on.status === 200 && on.json.config.sso === 'on' && on.json.config.sso_domains[0] === 'example.test');
  const m = await browser().get('/api/auth/methods');
  check('the sign-in page offers it, by the provider\'s name only', m.json.sso && m.json.sso.name === '127.0.0.1' && !JSON.stringify(m.json).includes(idp.clientSecret));
  const view = await ob.get('/api/access/signin-methods?check=1');
  check('the Owner\'s view: ready, the return address, the provider checked live — and never the secret', view.status === 200 && view.json.sso.ready
    && view.json.sso.redirectUri === `${PUBLIC}/api/auth/sso/callback` && view.json.sso.provider.ok && view.json.sso.secretSet === true
    && !JSON.stringify(view.json).includes(idp.clientSecret));
}

/* One single sign-on, followed hop by hop: our start → the provider →
   our callback → the sign-in page. */
async function sso(b, { claims = {}, override = {}, back = '/money', keepCookie = true, tamperState = false, error = null } = {}) {
  idp.claims = { sub: 'sub-0001', email: 'finance@example.test', email_verified: true, name: 'Test Finance', ...claims };
  idp.override = override;
  const s = await b.get(`/api/auth/sso/start?back=${encodeURIComponent(back)}`);
  if (s.status !== 302 || !s.location.startsWith(idp.issuer)) return { start: s };
  const a = new URL(s.location);
  const hop = await fetch(s.location, { redirect: 'manual' });
  let cb = hop.headers.get('location');
  if (error) cb = `${PUBLIC}/api/auth/sso/callback?error=${error}&state=${a.searchParams.get('state')}`;
  if (tamperState) cb = cb.replace(/state=[^&]+/, 'state=forged');
  if (!keepCookie) delete b.jar.fm_sso;
  const r = await b.get(cb.replace(PUBLIC, ''));
  return { start: s, authorize: a, callback: r, to: r.location };
}

console.log('\n10. single sign-on: the round trip');
const sb = browser();
{
  const r = await sso(sb);
  const q = r.authorize.searchParams;
  check('the provider is asked for a code with S256 PKCE, a nonce, a state and our return address',
    q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256' && q.get('code_challenge')?.length === 43
    && q.get('nonce')?.length >= 32 && q.get('state')?.length >= 32 && q.get('redirect_uri') === `${PUBLIC}/api/auth/sso/callback`
    && q.get('scope') === 'openid email profile');
  check('…and the state is bound to this browser by an HttpOnly cookie', r.start.setc.some((c) => /^fm_sso=/.test(c) && /HttpOnly/.test(c) && /SameSite=Lax/.test(c)));
  check('an existing person with a verified address on the domain is signed in, back to where they were', r.to === '/signin?sso=done&back=%2Fmoney', r.to);
  const me = await sb.get('/api/auth/me');
  check('…as that person', me.json.signedIn && me.json.user.email === fin.email);
  const s = await sessionRow(sb);
  check('the same session as the password path: opened by sso, two-step not done (the provider did not say mfa)',
    s.auth_method === 'sso' && s.mfa_ok === false && s.idle_minutes === 720);
  const link = (await db.query('SELECT * FROM access_sso_identity WHERE user_id = $1', [fin.id])).rows[0];
  check('the provider\'s subject is linked to the person', link && link.subject === 'sub-0001' && link.issuer === idp.issuer);
  check('the sign-in and the link are in the audit log', (await auditOf('auth.sso_linked')).length === 1
    && (await auditOf('auth.login')).at(-1).detail.method === 'sso');
  check('the binding cookie is cleared on the way back', r.callback.setc.some((c) => /^fm_sso=;/.test(c) && /Max-Age=0/.test(c)));
  const prop = await sb.post('/api/ledger/import/commit', { rows: [{ amount: 1 }], batch: 'b-3' });
  const ksb = browser();
  const k3 = makeAuthenticator({ origin: PUBLIC, rpId: 'localhost' });
  await signInPassword(ksb, fin); await stepUp(ksb, fin);
  const o = await ksb.post('/api/auth/passkey/register/options', {});
  await ksb.post('/api/auth/passkey/register', { credential: k3.create(o.json.publicKey) });
  const kb = browser();
  await passkeySignIn(kb, k3);
  const so = await kb.post('/api/auth/passkey/stepup/options', {});
  await kb.post('/api/auth/passkey/stepup', { credential: k3.get(so.json.publicKey) });
  const self = await kb.post('/api/ledger/import/commit', { proposal: prop.json.proposal });
  check('four-eyes: prepared by single sign-on, the same person cannot commit it by passkey', self.status === 403 && self.json.error === 'four_eyes');
}

console.log('\n11. single sign-on: what is refused, and why');
{
  const refusedTo = async (opts, code, name) => {
    const r = await sso(browser(), opts);
    check(name, r.to === `/signin?sso=${code}` || r.start?.location === `/signin?sso=${code}`, JSON.stringify(r.to || r.start?.location));
    return r;
  };
  await refusedTo({ keepCookie: false }, 'browser', 'a return trip without this browser\'s cookie is refused (login CSRF)');
  await refusedTo({ tamperState: true }, 'expired', 'a state the server did not issue is refused');
  await refusedTo({ error: 'access_denied' }, 'denied', 'the provider\'s "access denied" is said as what it was');
  await refusedTo({ claims: { email_verified: false } }, 'unverified_email', 'an address the provider did not verify is refused');
  await refusedTo({ claims: { email: 'someone@other.example', sub: 'sub-x1' } }, 'domain', 'an address on a domain the Owner did not list is refused');
  await refusedTo({ claims: { email: 'stranger@example.test', sub: 'sub-x2' } }, 'no_account', 'an address with no account is refused while provisioning is off');
  await refusedTo({ claims: { sub: 'sub-9999' } }, 'other_identity', 'the same address under a different provider account is refused');
  await refusedTo({ override: { nonce: 'not-this-sign-in' } }, 'token', 'an ID token without this sign-in\'s nonce is refused');
  idp.signWith = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await refusedTo({}, 'token', 'an ID token not signed by the provider is refused');
  idp.signWith = null;
  await refusedTo({ claims: { email: 'suspended@example.test', sub: 'sub-s1' } }, 'suspended', 'a suspended account is refused with the password path\'s sentence');
  /* The state is used once. */
  const b = browser();
  idp.claims = { sub: 'sub-0001', email: fin.email, email_verified: true };
  const s = await b.get('/api/auth/sso/start');
  const hop = await fetch(s.location, { redirect: 'manual' });
  const cb = hop.headers.get('location').replace(PUBLIC, '');
  await b.get(cb);
  const savedBind = s.setc.find((c) => c.startsWith('fm_sso=')).split(';')[0].slice(7);
  b.jar.fm_sso = savedBind;
  const again = await b.get(cb);
  check('the same return address twice is refused the second time', again.location === '/signin?sso=expired');
  const why = (await auditOf('auth.sso_refused')).map((a) => a.detail.why);
  check('every refusal is in the audit log with its reason', ['browser', 'expired', 'denied', 'unverified_email', 'domain', 'no_account', 'other_identity', 'token']
    .every((w) => why.includes(w)), why.join(','));
  const src = readFileSync(new URL('../api/access/signin_methods.js', import.meta.url), 'utf8');
  const codes = new Set([...src.matchAll(/refused?\((?:res, )?'([a-z_]+)'/g)].map((m) => m[1]));
  check('every refusal the server can send has a sentence on the sign-in page', [...codes].every((c) => SSO_REFUSALS[c]), [...codes].filter((c) => !SSO_REFUSALS[c]).join());
  check('…and every sentence is one the server can send', Object.keys(SSO_REFUSALS).every((c) => codes.has(c)), Object.keys(SSO_REFUSALS).filter((c) => !codes.has(c)).join());
}

console.log('\n12. single sign-on: two-step, invitations and new accounts');
{
  /* The Owner has two-step on, and the provider did not say it used it. */
  const b = browser();
  const r = await sso(b, { claims: { sub: 'sub-own', email: owner.email } });
  check('a person with two-step on is asked for the code after the provider', r.to === '/signin?sso=code&back=%2Fmoney', r.to);
  check('…by a ticket in an HttpOnly, SameSite=Strict cookie — not in the address', r.callback.setc.some((c) => /^fm_sso_t=/.test(c) && /HttpOnly/.test(c) && /SameSite=Strict/.test(c))
    && !r.to.includes('ticket'));
  check('…and is not signed in until it is given', (await b.get('/api/auth/me')).json.signedIn === false);
  const wrong = await b.post('/api/auth/sso/code', { code: '000000' });
  check('a wrong code is refused', wrong.status === 401 && wrong.json.error === 'bad_code');
  const ok = await b.post('/api/auth/sso/code', { code: await code(owner) });
  check('the right one signs in, two-step done', ok.status === 200 && ok.json.back === '/money' && (await sessionRow(b)).mfa_ok === true);
  const me = await b.get('/api/auth/me');
  check('…and the session is not restricted', me.json.signedIn && !me.json.restricted);
  const reuse = await b.post('/api/auth/sso/code', { code: '123456' });
  check('the ticket works once', reuse.status === 401 && reuse.json.error === 'expired');
  /* A provider that says it used more than one factor. */
  const b2 = browser();
  const r2 = await sso(b2, { claims: { sub: 'sub-own', email: owner.email, amr: ['pwd', 'mfa'] } });
  check('when the provider says mfa, no code is asked', r2.to === '/signin?sso=done&back=%2Fmoney' && (await sessionRow(b2)).mfa_ok === true);

  /* An invitation, accepted by proving the address at the provider. */
  const inv = await svc.createUser(db, { email: 'invited@example.test', name: 'Test Invited', status: 'invited' });
  await svc.createGrant(db, { userId: inv.id, roleCode: 'DSP', reason: 'test' });
  await svc.createLink(db, inv.id, 'invite', owner.id, 168);
  const ib = browser();
  const ir = await sso(ib, { claims: { sub: 'sub-inv', email: 'invited@example.test' } });
  check('a live invitation is accepted by single sign-on', ir.to?.startsWith('/signin?sso=done') && (await svc.getUser(db, inv.id)).status === 'active');
  check('…and its link stops working', (await svc.linkForToken(db, 'irrelevant')) === null
    && (await db.query(`SELECT count(*)::int AS n FROM access_link WHERE user_id = $1 AND used_at IS NULL`, [inv.id])).rows[0].n === 0);
  const old = await svc.createUser(db, { email: 'late@example.test', name: 'Test Late', status: 'invited' });
  await svc.createLink(db, old.id, 'invite', owner.id, -1);
  const lr = await sso(browser(), { claims: { sub: 'sub-late', email: 'late@example.test' } });
  check('an expired invitation is not opened by a later sign-on', lr.to === '/signin?sso=invite_expired' && (await svc.getUser(db, old.id)).status === 'invited');

  /* New accounts, only when the Owner allows them — and then with no access. */
  await freshStepUp(ob, owner);
  const pv = await ob.post('/api/access/config', { sso_provision: 'on' });
  check('the Owner allows new accounts from single sign-on', pv.status === 200 && pv.json.config.sso_provision === 'on');
  const nb = browser();
  const nr = await sso(nb, { claims: { sub: 'sub-new', email: 'newcomer@example.test', name: 'Test Newcomer' } });
  const created = await svc.getUserByEmail(db, 'newcomer@example.test');
  check('a verified address on the domain with no account gets one', nr.to?.startsWith('/signin?sso=done') && created && created.status === 'active');
  check('…with no password, no grant and no team', !created.password_hash
    && (await db.query('SELECT count(*)::int AS n FROM access_grant WHERE user_id = $1', [created.id])).rows[0].n === 0);
  const sees = await nb.get('/api/t/kpis');
  check('…so it sees nothing until an Access admin gives it a role — and is told exactly that', sees.status === 403
    && sees.json.error === 'no_access' && /no access to anything yet/.test(sees.json.detail), JSON.stringify(sees.json));
  check('the new account is in the audit log', (await auditOf('auth.sso_provisioned')).length === 1);
  const pw = await nb.post('/api/auth/password', { current: '', next: 'a brand new password here' });
  check('changing a password it does not have says the true reason', pw.status === 409 && /has no password here/.test(pw.json.detail));
  const st = await nb.post('/api/auth/stepup', { password: 'anything' });
  check('re-confirming without a password or a code says the true reason', st.status === 409 && /no password or two-step code/.test(st.json.detail));

  /* Unlinking: the provider's account is no longer this person's. */
  await freshStepUp(ob, owner);
  const un = await ob.post(`/api/access/users/${fin.id}`, { action: 'unlink_sso', reason: 'mailbox reassigned' });
  check('the Owner unlinks a person\'s single sign-on, and their sessions end', un.status === 200
    && (await db.query('SELECT 1 FROM access_sso_identity WHERE user_id = $1', [fin.id])).rows.length === 0
    && (await sb.get('/api/auth/me')).json.signedIn === false);
}

console.log('\n13. throttles, and open mode once more');
{
  const b = browser();
  let last;
  for (let i = 0; i < 31; i += 1) last = await b.get('/api/auth/sso/start');
  check('a thirty-first start from one address in fifteen minutes is slowed down', last.location === '/signin?sso=slow_down');
  const anon = browser();
  const k = await anon.get('/api/t/kpis');
  check('with both methods on, an anonymous visitor in open mode still gets exactly what it got before', k.status === 200 && k.json.revenue === 900);
  const chain = await verifyChain(db);
  check('the audit log\'s hash chain is intact after all of it', chain.ok === true, JSON.stringify(chain).slice(0, 200));
}

server.close();
await idp.close();
console.log(`\n${fail ? '✗' : '✓'} access_passkey_sso: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
