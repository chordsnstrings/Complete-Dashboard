/* Passkeys and single sign-on — the HTTP surface (ULM-DESIGN §5.1, §10.1).
   ─────────────────────────────────────────────────────────────────────────
   Two more ways in beside email + password + two-step, BOTH OFF until the
   Owner turns them on (access_config `passkeys`, `sso`; Set up → Access →
   Settings). §14 decision 3 — email only, or the company's Google or
   Microsoft, and is a passkey on every phone acceptable — stays the Owner's:
   this file builds both so that the decision is a switch, not a project.

     /api/auth/methods                    what the sign-in page may offer
     /api/auth/passkey/login/options,     sign in with a passkey, no email
       /api/auth/passkey/login              typed (discoverable credentials)
     /api/auth/passkey/register/options,  add a passkey to your own account
       /api/auth/passkey/register           (signed in, re-confirmed first)
     /api/auth/passkey/stepup/options,    "confirm it is you" with a passkey
       /api/auth/passkey/stepup
     /api/auth/passkeys, …/remove         your passkeys; remove one
     /api/auth/sso/start                  off to the company's provider
     /api/auth/sso/callback               …and back (a browser navigation)
     /api/auth/sso/code                   the two-step code still owed
     /api/access/signin-methods           the Owner's view: state, readiness
     /api/access/users/:id/signin-methods a person's passkeys and links

   All under /api/auth/ and /api/access/, so the access manifest classes
   every one of them `self` (api/access/manifest.js lookupEntry): the gate
   passes them through and each handler makes its own decision, as the
   password routes in api/access/routes.js do. Turning the methods on is
   POST /api/access/config (signinMethodChanges below, called from there), and
   taking them off a person is POST /api/access/users/:id actions
   `remove_passkeys` and `unlink_sso` — both inside the existing handlers so
   they keep that handler's Owner, step-up, ceiling and audit rules rather
   than a second copy of them.

   THE SAME SESSION AS THE PASSWORD PATH. A passkey or single sign-on ends in
   startSession below, which is the password path's own: svc.createSession
   with the company's idle and absolute limits, the fm_sid cookie, a fresh
   CSRF cookie, recordSuccess (so the 60-day dormancy clock sees it) — plus
   one column, access_session.auth_method, saying how it was opened. So
   step-up, four-eyes, the shaper, CSRF and the audit judge these sessions
   exactly as they judge a password session: none of them knows the
   difference, and none of them was changed.

   TWO-STEP. A passkey is only accepted with user verification (a PIN or a
   fingerprint at the authenticator), which is two factors — §5.1 "a passkey
   counts as MFA" — so its session is mfa_ok. A single sign-on counts as two
   factors only when the provider says it used them (`amr` contains 'mfa',
   RFC 8176); otherwise a person with two-step on is asked for their code
   after the provider, exactly as after a password, and a role that requires
   two-step and has none set up is held to setting it up (middleware.js
   identify, which now also accepts a session opened by a multi-factor
   method).

   OPEN MODE. With both switches off — the default — every route here
   answers "not turned on" and nothing else in the product changes. With one
   on, the session it issues is a signed-in session like any other: held to
   its role, which in open mode is never MORE than an anonymous visitor sees. */
import crypto from 'node:crypto';
import * as svc from './service.js';
import { appendAudit } from './audit.js';
import { SID, CSRF, setCookie, issueCsrf } from './middleware.js';
import { newToken, tokenHash, safeEqual, verifyTotp, unseal } from './crypto.js';
import * as wa from './webauthn.js';
import {
  createOidc, ssoEnv, pkcePair, emailVerified, emailDomain, multiFactor, parseDomains, domainProblem, OidcError,
} from './oidc.js';
import { SSO_REFUSALS } from '../public/signin_methods.js';

export const SSO_BIND = 'fm_sso';
export const SSO_TICKET = 'fm_sso_t';
const PASSKEYS_OFF = 'Passkeys are not turned on for FleetMirror. The Owner turns them on in Set up → Access → Settings.';
const MAX_PASSKEYS = 10;

/* ── the store ─────────────────────────────────────────────────────────── */
const PK_COLS = `id, user_id, credential_id, public_key, alg, sign_count, transports, user_handle, aaguid,
  backup_eligible, backed_up, name, created_at, last_used_at, disabled_at, disabled_reason`;
const pkOut = (r) => (r ? { ...r, id: Number(r.id), user_id: Number(r.user_id), sign_count: Number(r.sign_count) } : null);
export async function listPasskeys(db, userId) {
  const { rows } = await db.query(`SELECT ${PK_COLS} FROM access_passkey WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows.map(pkOut);
}
async function passkeyByCredential(db, credentialId) {
  const { rows } = await db.query(`SELECT ${PK_COLS} FROM access_passkey WHERE credential_id = $1`, [credentialId]);
  return pkOut(rows[0]);
}
/* What a page may see of a passkey: never the key, the handle or the id. */
export const passkeyView = (r) => ({ id: r.id, name: r.name, created_at: r.created_at, last_used_at: r.last_used_at,
  transports: r.transports || [], synced: Boolean(r.backup_eligible), disabled_at: r.disabled_at, disabled_reason: r.disabled_reason });
/* The counter moves forward atomically: two sign-ins racing with the same
   number cannot both pass the check below and both land. */
async function recordPasskeyUse(db, id, v) {
  const { rowCount } = await db.query(
    `UPDATE access_passkey SET sign_count = $2, backed_up = $3, last_used_at = now()
      WHERE id = $1 AND disabled_at IS NULL AND (sign_count < $2 OR (sign_count = 0 AND $2 = 0))`, [id, v.signCount, v.backedUp]);
  return rowCount === 1;
}
async function disablePasskey(db, id, reason) {
  await db.query(`UPDATE access_passkey SET disabled_at = now(), disabled_reason = $2 WHERE id = $1 AND disabled_at IS NULL`, [id, reason]);
}
export async function removePasskeys(db, userId) {
  const { rowCount } = await db.query('DELETE FROM access_passkey WHERE user_id = $1', [userId]);
  return rowCount;
}
export async function unlinkSso(db, userId) {
  const { rowCount } = await db.query('DELETE FROM access_sso_identity WHERE user_id = $1', [userId]);
  return rowCount;
}
async function ssoIdentitiesOf(db, userId) {
  const { rows } = await db.query(
    'SELECT id, issuer, email, created_at, last_used_at FROM access_sso_identity WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
const regressionReason = (v) => `its signature counter went backwards (it had reached ${v.before}, and this sign-in said ${v.signCount}), `
  + 'which happens when a copy of the passkey is in use somewhere else.';

/* ── turning them on: called from POST /api/access/config ────────────────
   The Owner, re-confirmed, as for every company setting. Returns
   { changes } or { error, detail } with the true reason. Turning a method on
   needs the platform to be ready for it: a switch that cannot work would be a
   button on the sign-in page that fails for everybody. */
export function signinMethodChanges(body, { cfg = {}, env = process.env } = {}) {
  const changes = {};
  for (const k of ['passkeys', 'sso', 'sso_provision']) {
    if (body?.[k] === undefined) continue;
    if (!['on', 'off'].includes(body[k])) return { error: 'bad_switch', detail: 'Choose on or off.' };
    changes[k] = body[k];
  }
  if (body?.sso_domains !== undefined) {
    const list = parseDomains(body.sso_domains);
    if (list.length > 20) return { error: 'bad_domains', detail: 'List at most 20 domains.' };
    for (const d of list) { const p = domainProblem(d); if (p) return { error: 'bad_domains', detail: p }; }
    changes.sso_domains = list;
  }
  const next = { ...DEFAULT_CFG, ...cfg, ...changes };
  if (changes.passkeys === 'on') {
    const rp = wa.rpConfig(env);
    if (!rp.ok) return { error: 'not_ready', detail: `Passkeys cannot be turned on yet: ${rp.why}` };
  }
  if (changes.sso === 'on') {
    const se = ssoEnv(env);
    if (!se.ok) return { error: 'not_ready', detail: `Single sign-on cannot be turned on yet: ${se.why}` };
  }
  const noDomains = !parseDomains(next.sso_domains).length;
  if (noDomains && (next.sso === 'on' || next.sso_provision === 'on') && Object.keys(changes).some((k) => k.startsWith('sso'))) {
    return { error: 'no_domains', detail: 'List at least one company email domain first: single sign-on accepts addresses on those domains and no others.' };
  }
  return { changes };
}
const DEFAULT_CFG = { passkeys: 'off', sso: 'off', sso_provision: 'off', sso_domains: [] };

/* ═════════════════ the routes ═════════════════
   `env` is read when a request arrives (the tests pass their own); `http` is
   how the server reaches the provider (a test passes a mock provider). */
export function signinMethodRoutes(app, { db, layer, wrap, log = { info() {}, warn() {}, error() {} }, env = process.env,
  http = undefined, now = () => Date.now() }) {
  const oidc = createOidc({ ...(http ? { http } : {}), now });
  const audit = (req, action, subjectType, subjectId, detail = {}) => appendAudit(db, {
    actorId: req.fm?.user?.id ?? null,
    actorLabel: req.fm?.user?.email || req.fm?.kind || 'anonymous',
    action, subjectType, subjectId, detail, ip: req.ip, ua: req.get('user-agent'),
  }).catch((e) => log.error('access', 'audit failed', { err: String(e).slice(0, 200) }));

  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const fail = (res, status, error, detail, extra = {}) => { noStore(res); return res.status(status).json({ error, detail, ...extra }); };
  const slow = (res) => fail(res, 429, 'slow_down', 'Too many attempts from here. Wait fifteen minutes and try again.');
  const signedIn = (req) => req.fm?.kind === 'user' && req.fm.user;
  const csrfOk = (req) => {
    const want = req.fmCookies?.[CSRF];
    return Boolean(want) && safeEqual(req.get('x-fm-csrf') || '', want);
  };
  /* The same rules as routes.js me(): a screen is told it is a screen, a
     restricted session finishes setting up first, a change carries CSRF. */
  const me = (req, res, { write = false } = {}) => {
    if (req.fm?.kind === 'device') { fail(res, 403, 'not_allowed', 'This is a screen, not a person: it has no passkeys or sign-in of its own to manage.'); return null; }
    if (!signedIn(req)) { fail(res, 401, 'signin', 'Sign in first.'); return null; }
    if (req.fm.restricted) { fail(res, 403, 'restricted', 'Finish setting up your account first.', { need: req.fm.restricted }); return null; }
    if (write && !csrfOk(req)) { fail(res, 403, 'csrf', 'Reload the page and try again.'); return null; }
    return req.fm;
  };
  const manager = (req, res) => {
    const fm = me(req, res);
    if (!fm) return null;
    if (fm.access.preview) { fail(res, 403, 'preview', 'You are previewing a role, which is read-only.'); return null; }
    if (!fm.access.caps.includes('access.manage')) { fail(res, 403, 'not_allowed', 'Only the Owner and Access admins manage access.'); return null; }
    return fm;
  };
  const stepupFresh = (fm, minutes = 10) => fm.session?.stepup_at
    && now() - new Date(fm.session.stepup_at).getTime() < minutes * 60_000;

  /* Throttles, in memory like the password path's (one API process). */
  const tries = new Map();
  const limited = (key, max) => {
    const t0 = now();
    const t = tries.get(key) || { n: 0, at: t0 };
    if (t0 - t.at > 15 * 60_000) { t.n = 0; t.at = t0; }
    t.n += 1; tries.set(key, t);
    if (tries.size > 10000) tries.delete(tries.keys().next().value);
    return t.n > max;
  };
  const failures = (key) => { const t = tries.get(key); return t && now() - t.at <= 15 * 60_000 ? t.n : 0; };

  /* Ceremonies in flight: a challenge is issued once, used once, and lives
     five minutes. In memory, as the two-step tickets are: a restart ends a
     ceremony half-way, and the person simply tries again. */
  const challenges = new Map();
  const issueChallenge = (entry) => {
    const challenge = crypto.randomBytes(32).toString('base64url');
    challenges.set(challenge, { ...entry, challenge, exp: now() + 5 * 60_000 });
    if (challenges.size > 5000) challenges.delete(challenges.keys().next().value);
    return challenge;
  };
  const takeChallenge = (challenge, purpose) => {
    if (typeof challenge !== 'string') return null;
    const c = challenges.get(challenge);
    if (!c) return null;
    challenges.delete(challenge);
    return c.purpose === purpose && c.exp > now() ? c : null;
  };

  const startSession = async (req, res, user, { mfaOk, method }) => {
    const cfg = await svc.getConfig(db);
    const { token, maxAgeSeconds } = await svc.createSession(db, {
      userId: user.id, ip: req.ip, ua: req.get('user-agent'), mfaOk, cfg });
    await db.query('UPDATE access_session SET auth_method = $2 WHERE id = $1', [tokenHash(token), method]);
    setCookie(res, req, SID, token, { maxAge: maxAgeSeconds });
    issueCsrf(res, req);
    await svc.recordSuccess(db, user.id);
  };
  const inactive = (res, status) => fail(res, 403, 'inactive', status === 'suspended'
    ? 'This account is suspended. Ask the Owner or an Access admin.'
    : 'This account is not active. Use the link you were sent, or ask an admin for a new one.');

  const passkeyGate = async (res) => {
    const cfg = await svc.getConfig(db);
    if (cfg.passkeys !== 'on') { fail(res, 404, 'off', PASSKEYS_OFF); return null; }
    const rp = wa.rpConfig(env);
    if (!rp.ok) { fail(res, 503, 'not_ready', `Passkeys are turned on, but they cannot work yet: ${rp.why}`); return null; }
    return rp;
  };
  /* One passkey assertion, judged: the credential on record, not disabled,
     its signature, and its counter. A regression disables the credential —
     the copy and the original cannot be told apart, so neither is trusted —
     and says so. Returns the row, or null with the refusal already sent. */
  const judgeAssertion = async (req, res, { credential, challenge, rp, row, requireUserHandle, failAction, failDetail }) => {
    if (row.disabled_at) {
      await audit(req, failAction, 'user', row.user_id, { ...failDetail, method: 'passkey', why: 'disabled', passkey: row.id });
      fail(res, 403, 'passkey_disabled', `This passkey is switched off: ${row.disabled_reason || 'it was disabled.'} `
        + 'Remove it on your account page and add it again.');
      return null;
    }
    let v;
    try { v = wa.verifyAssertion({ credential, challenge, rp, stored: row, requireUserHandle }); } catch (e) {
      if (!(e instanceof wa.WebAuthnError)) throw e;
      await audit(req, failAction, 'user', row.user_id, { ...failDetail, method: 'passkey', why: e.code, passkey: row.id });
      fail(res, 401, 'passkey_refused', e.detail);
      return null;
    }
    if (v.regressed || !(await recordPasskeyUse(db, row.id, v))) {
      const why = regressionReason(v);
      await disablePasskey(db, row.id, why);
      await audit(req, 'auth.passkey_counter_regressed', 'user', row.user_id, { passkey: row.id, stored: v.before, presented: v.signCount });
      fail(res, 403, 'passkey_cloned', `This passkey has been switched off: ${why} Sign in another way, remove it on your account page, and add it again.`);
      return null;
    }
    return { row, v };
  };

  /* ── what the sign-in page may offer ──────────────────────────────── */
  app.get('/api/auth/methods', wrap(async (req, res) => {
    noStore(res);
    const cfg = await svc.getConfig(db);
    const rp = wa.rpConfig(env);
    const se = ssoEnv(env);
    const out = {
      passkeys: cfg.passkeys === 'on' && rp.ok,
      sso: cfg.sso === 'on' && se.ok && parseDomains(cfg.sso_domains).length ? { name: se.name } : null,
    };
    if (signedIn(req)) {
      const u = await svc.getUserSecrets(db, req.fm.user.id);
      const { rows: [n] } = await db.query(
        'SELECT count(*)::int AS n FROM access_passkey WHERE user_id = $1 AND disabled_at IS NULL', [req.fm.user.id]);
      out.mine = { passkeys: n.n, password: Boolean(u?.password_hash), totp: Boolean(u?.totp_enabled) };
    }
    return res.json(out);
  }));

  /* ── signing in with a passkey ─────────────────────────────────────── */
  app.post('/api/auth/passkey/login/options', wrap(async (req, res) => {
    noStore(res);
    if (limited(`pko:${req.ip}`, 60)) return slow(res);
    const rp = await passkeyGate(res);
    if (!rp) return undefined;
    return res.json({ publicKey: wa.requestOptions({ rp, challenge: issueChallenge({ purpose: 'login' }) }) });
  }));

  app.post('/api/auth/passkey/login', wrap(async (req, res) => {
    noStore(res);
    if (limited(`pkl:${req.ip}`, 30)) return slow(res);
    const rp = await passkeyGate(res);
    if (!rp) return undefined;
    const credential = req.body?.credential;
    const ch = takeChallenge(wa.clientDataChallenge(credential?.response?.clientDataJSON), 'login');
    if (!ch) {
      await audit(req, 'auth.login_failed', 'passkey', null, { method: 'passkey', why: 'no live challenge' });
      return fail(res, 401, 'expired', 'That passkey sign-in took too long, or was already used. Try again.');
    }
    const row = typeof credential?.id === 'string' ? await passkeyByCredential(db, credential.id) : null;
    if (!row) {
      await audit(req, 'auth.login_failed', 'passkey', null, { method: 'passkey', why: 'unknown passkey' });
      /* Most often a passkey removed from the account but still on the
         device, which keeps offering it: said, so the person knows to delete
         it there too. */
      return fail(res, 401, 'unknown_passkey', 'This passkey is not registered with FleetMirror — it may have been removed from your account, '
        + 'though this device still offers it. Sign in another way; then delete it from this device\u2019s saved passkeys, or add it again on your account page.');
    }
    const judged = await judgeAssertion(req, res, { credential, challenge: ch.challenge, rp, row, requireUserHandle: true,
      failAction: 'auth.login_failed', failDetail: {} });
    if (!judged) return undefined;
    const user = await svc.getUser(db, row.user_id);
    if (!user || user.status !== 'active') {
      await audit(req, 'auth.login_refused', 'user', row.user_id, { status: user?.status, method: 'passkey' });
      return inactive(res, user?.status);
    }
    await startSession(req, res, user, { mfaOk: true, method: 'passkey' });
    await audit(req, 'auth.login', 'user', user.id, { method: 'passkey', mfa: true, passkey: row.id });
    return res.json({ ok: true, mustChangePassword: user.must_change_password });
  }));

  /* ── adding a passkey to your own account ──────────────────────────────
     Re-confirmed first (the password, the code, or a passkey you already
     have): a new way into the account is a change to the account's access,
     and somebody at an unlocked machine must not be able to leave one
     behind. */
  app.post('/api/auth/passkey/register/options', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    noStore(res);
    const rp = await passkeyGate(res);
    if (!rp) return undefined;
    if (!stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    if (limited(`pkr:${fm.user.id}`, 20)) return slow(res);
    const mine = await listPasskeys(db, fm.user.id);
    if (mine.length >= MAX_PASSKEYS) return fail(res, 409, 'too_many', `You have ${MAX_PASSKEYS} passkeys already. Remove one you no longer use first.`);
    const userHandle = mine[0]?.user_handle || crypto.randomBytes(32).toString('base64url');
    const challenge = issueChallenge({ purpose: 'register', userId: fm.user.id, sessionId: fm.session.id, userHandle });
    return res.json({ publicKey: wa.creationOptions({ rp, challenge, userHandle, email: fm.user.email, name: fm.user.name, exclude: mine }) });
  }));

  app.post('/api/auth/passkey/register', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    noStore(res);
    const rp = await passkeyGate(res);
    if (!rp) return undefined;
    if (!stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    const credential = req.body?.credential;
    const ch = takeChallenge(wa.clientDataChallenge(credential?.response?.clientDataJSON), 'register');
    if (!ch || ch.userId !== fm.user.id || ch.sessionId !== fm.session.id) {
      return fail(res, 400, 'expired', 'That passkey set-up took too long, or was started somewhere else. Start again.');
    }
    let v;
    try { v = wa.verifyRegistration({ credential, challenge: ch.challenge, rp }); } catch (e) {
      if (!(e instanceof wa.WebAuthnError)) throw e;
      await audit(req, 'auth.passkey_add_failed', 'user', fm.user.id, { why: e.code });
      return fail(res, 400, 'passkey_refused', e.detail);
    }
    if (await passkeyByCredential(db, v.credentialId)) return fail(res, 409, 'already', 'This passkey is already registered with FleetMirror.');
    const name = String(req.body?.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)
      || `Passkey added ${new Date(now()).toISOString().slice(0, 10)}`;
    let id;
    try {
      const { rows } = await db.query(
        `INSERT INTO access_passkey (user_id, credential_id, public_key, alg, sign_count, transports, user_handle, aaguid,
           backup_eligible, backed_up, name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [fm.user.id, v.credentialId, v.publicKey, v.alg, v.signCount, v.transports, ch.userHandle, v.aaguid, v.backupEligible, v.backedUp, name]);
      id = Number(rows[0].id);
    } catch (e) {
      if (String(e?.code) === '23505') return fail(res, 409, 'already', 'This passkey is already registered with FleetMirror.');
      throw e;
    }
    await audit(req, 'auth.passkey_added', 'user', fm.user.id, { passkey: id, alg: v.algName, synced: v.backupEligible, format: v.fmt });
    return res.json({ ok: true, passkey: passkeyView({ id, name, created_at: new Date(now()).toISOString(), last_used_at: null,
      transports: v.transports, backup_eligible: v.backupEligible, disabled_at: null, disabled_reason: null }) });
  }));

  /* ── "confirm it is you", with a passkey ───────────────────────────────
     Step-up is the same ten minutes, the same session column (stepup_at)
     and the same audit action as /api/auth/stepup: only the proof differs.
     The credential must be one of the signed-in person's own. */
  app.post('/api/auth/passkey/stepup/options', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    noStore(res);
    const rp = await passkeyGate(res);
    if (!rp) return undefined;
    if (limited(`pks:${fm.user.id}`, 20)) return slow(res);
    const allow = (await listPasskeys(db, fm.user.id)).filter((r) => !r.disabled_at);
    if (!allow.length) {
      return fail(res, 409, 'no_passkey', 'You have no passkey on this account. Confirm with your password or code instead, or add a passkey on your account page.');
    }
    const challenge = issueChallenge({ purpose: 'stepup', userId: fm.user.id, sessionId: fm.session.id });
    return res.json({ publicKey: wa.requestOptions({ rp, challenge, allow }) });
  }));

  app.post('/api/auth/passkey/stepup', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    noStore(res);
    const rp = await passkeyGate(res);
    if (!rp) return undefined;
    if (limited(`pks:${fm.user.id}`, 20)) return slow(res);
    const credential = req.body?.credential;
    const ch = takeChallenge(wa.clientDataChallenge(credential?.response?.clientDataJSON), 'stepup');
    if (!ch || ch.userId !== fm.user.id || ch.sessionId !== fm.session.id) {
      await audit(req, 'auth.stepup_failed', 'user', fm.user.id, { method: 'passkey', why: 'no live challenge' });
      return fail(res, 401, 'expired', 'That took too long, or was started somewhere else. Try again.');
    }
    const row = typeof credential?.id === 'string' ? await passkeyByCredential(db, credential.id) : null;
    if (!row || row.user_id !== fm.user.id) {
      await audit(req, 'auth.stepup_failed', 'user', fm.user.id, { method: 'passkey', why: row ? 'another person’s passkey' : 'unknown passkey' });
      return fail(res, 401, 'bad_credentials', 'That passkey is not one of yours on this account.');
    }
    const judged = await judgeAssertion(req, res, { credential, challenge: ch.challenge, rp, row, requireUserHandle: false,
      failAction: 'auth.stepup_failed', failDetail: {} });
    if (!judged) return undefined;
    await svc.patchSession(db, fm.session.id, { stepup: true });
    layer.cache.clear();
    await audit(req, 'auth.stepup', 'user', fm.user.id, { method: 'passkey', passkey: row.id });
    return res.json({ ok: true });
  }));

  /* ── your passkeys ─────────────────────────────────────────────────────
     Listing and removing work whether or not passkeys are switched on: a
     person can always take a way into their account away. */
  app.get('/api/auth/passkeys', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    noStore(res);
    const cfg = await svc.getConfig(db);
    const rp = wa.rpConfig(env);
    return res.json({
      on: cfg.passkeys === 'on' && rp.ok,
      why: cfg.passkeys !== 'on' ? PASSKEYS_OFF : rp.ok ? null : rp.why,
      passkeys: (await listPasskeys(db, fm.user.id)).map(passkeyView),
      sso: (await ssoIdentitiesOf(db, fm.user.id)).map((s) => ({ issuer: s.issuer, email: s.email, created_at: s.created_at, last_used_at: s.last_used_at })),
    });
  }));

  /* Removing one signs out every OTHER session too, as a password change
     does: the usual reason to remove a passkey is a lost phone, and the
     phone's own session is the one that must end. */
  app.post('/api/auth/passkeys/remove', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    noStore(res);
    if (!stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    const id = Number(req.body?.id);
    if (!Number.isSafeInteger(id)) return fail(res, 400, 'bad_request', 'Which passkey?');
    const { rowCount } = await db.query('DELETE FROM access_passkey WHERE id = $1 AND user_id = $2', [id, fm.user.id]);
    if (!rowCount) return fail(res, 404, 'not_found', 'There is no such passkey on your account.');
    const n = await svc.revokeUserSessions(db, fm.user.id, 'a passkey was removed', { except: fm.session.id });
    layer.cache.clear();
    await audit(req, 'auth.passkey_removed', 'user', fm.user.id, { passkey: id, sessions_ended: n });
    return res.json({ ok: true, signedOut: n });
  }));

  /* ═════════════════ single sign-on ═════════════════ */
  const states = new Map();          // state → { nonce, verifier, back, bind, exp }
  const ssoTickets = new Map();      // ticket → { userId, exp, tries, back }
  const goSignin = (res, sso, back = '') => {
    noStore(res);
    return res.redirect(302, `/signin?sso=${encodeURIComponent(sso)}${back && back !== '/' ? `&back=${encodeURIComponent(back)}` : ''}`);
  };
  const refuse = (res, code) => {
    if (!Object.prototype.hasOwnProperty.call(SSO_REFUSALS, code)) throw new Error(`no sentence for the single sign-on refusal ${code}`);
    return goSignin(res, code);
  };
  /* Where to send the person afterwards: a path on this site, nothing else.
     The sign-in page applies its own full check (signin.js safeBack) on the
     way out; this is the first of two. */
  const cleanBack = (raw) => {
    const s = String(raw || '');
    if (!s.startsWith('/') || s.startsWith('//') || s.length > 512 || /[\\\u0000- \u007f]/.test(s)) return '/';
    if (/^\/(?:signin|api)(?:[/.?#]|$)/i.test(s)) return '/';
    return s;
  };
  const OAUTH_DENIED = new Set(['access_denied', 'login_required', 'consent_required', 'interaction_required', 'account_selection_required']);

  app.get('/api/auth/sso/start', wrap(async (req, res) => {
    if (limited(`sso:${req.ip}`, 30)) return refuse(res, 'slow_down');
    const cfg = await svc.getConfig(db);
    if (cfg.sso !== 'on') return refuse(res, 'off');
    const se = ssoEnv(env);
    if (!se.ok || !parseDomains(cfg.sso_domains).length) return refuse(res, 'not_configured');
    let doc;
    try { doc = await oidc.discover(se.issuer); } catch (e) {
      if (!(e instanceof OidcError)) throw e;
      log.warn('access', 'single sign-on: provider unreachable', { detail: e.detail.slice(0, 200) });
      return refuse(res, 'provider_unreachable');
    }
    const state = newToken(24);
    const nonce = newToken(24);
    const bind = newToken(24);
    const { verifier, challenge } = pkcePair();
    states.set(state, { nonce, verifier, back: cleanBack(req.query.back), bind: tokenHash(bind), exp: now() + 10 * 60_000 });
    if (states.size > 2000) states.delete(states.keys().next().value);
    /* The state is bound to THIS browser by a cookie only this site can set
       and read. Without it, somebody could start a sign-in as themselves,
       stop at the provider's return address, and send that address to a
       colleague — whose browser would finish it and be signed in as the
       sender (login CSRF). Lax, because the return is a top-level GET from
       the provider's site. */
    setCookie(res, req, SSO_BIND, bind, { maxAge: 600 });
    noStore(res);
    return res.redirect(302, oidc.authorizeUrl(doc, { clientId: se.clientId, redirectUri: se.redirectUri, state, nonce, challenge }));
  }));

  app.get('/api/auth/sso/callback', wrap(async (req, res) => {
    if (limited(`ssoc:${req.ip}`, 30)) return refuse(res, 'slow_down');
    const stateKey = String(req.query.state || '');
    const st = states.get(stateKey);
    if (st) states.delete(stateKey);
    const bind = req.fmCookies?.[SSO_BIND];
    setCookie(res, req, SSO_BIND, '', { maxAge: 0 });
    const refused = async (code, detail = {}) => {
      await audit(req, 'auth.sso_refused', 'sso', null, { why: code, ...detail });
      return refuse(res, code);
    };
    if (!st || st.exp < now()) return refused('expired');
    if (!bind || !safeEqual(tokenHash(bind), st.bind)) return refused('browser');
    const cfg = await svc.getConfig(db, { fresh: true });
    if (cfg.sso !== 'on') return refused('off');
    const se = ssoEnv(env);
    if (!se.ok) return refused('not_configured');
    if (req.query.error) {
      const err = String(req.query.error).replace(/[^a-z_]/gi, '').slice(0, 40);
      if (OAUTH_DENIED.has(err)) return refused('denied', { provider: err });
      return refused('provider_error', { provider: err });
    }
    const code = String(req.query.code || '');
    if (!code || code.length > 4096) return refused('exchange', { detail: 'no code in the return address' });
    let claims;
    try {
      const doc = await oidc.discover(se.issuer);
      const tok = await oidc.exchange(doc, { code, verifier: st.verifier, clientId: se.clientId, clientSecret: se.clientSecret, redirectUri: se.redirectUri });
      claims = await oidc.verifyIdToken(doc, tok.id_token, { issuer: se.issuer, clientId: se.clientId, nonce: st.nonce });
    } catch (e) {
      if (!(e instanceof OidcError)) throw e;
      log.warn('access', 'single sign-on refused', { code: e.code, detail: e.detail.slice(0, 200) });
      const detail = { detail: e.detail.slice(0, 200) };
      if (e.code === 'token' || e.code === 'jwks') return refused('token', detail);
      if (e.code === 'exchange') return refused('exchange', detail);
      return refused('provider_unreachable', detail);
    }
    const email = svc.normEmail(claims.email);
    if (!svc.validEmail(email)) return refused('no_email');
    if (!emailVerified(claims)) return refused('unverified_email', { email });
    const domain = emailDomain(email);
    if (!parseDomains(cfg.sso_domains).includes(domain)) return refused('domain', { email });
    /* Google: accounts.google.com signs in every Google account, a free one
       made with a company address among them. `hd` is set only for the
       company's own Workspace accounts (Google's own guidance for
       restricting to a domain). */
    if (se.google && claims.hd !== domain) return refused('hosted_domain', { email });

    /* Who this is. The provider's subject first — once linked, it decides,
       so an address the provider re-issues to somebody else does not open
       the old holder's account. Then the address, for a first sign-on. */
    const { rows: [link] } = await db.query(
      'SELECT id, user_id FROM access_sso_identity WHERE issuer = $1 AND subject = $2', [se.issuer, claims.sub]);
    let user = link ? await svc.getUser(db, Number(link.user_id)) : await svc.getUserByEmail(db, email);
    let provisioned = false;
    if (!link && user) {
      const { rows: [other] } = await db.query('SELECT 1 FROM access_sso_identity WHERE user_id = $1 AND issuer = $2', [user.id, se.issuer]);
      if (other) return refused('other_identity', { email, user: user.id });
    }
    if (!user) {
      if (cfg.sso_provision !== 'on') return refused('no_account', { email });
      /* A new account with NO access: no grant, no team, no password. It
         can sign in and see nothing until an Access admin gives it a role. */
      user = await svc.createUser(db, { email: String(claims.email).trim(), name: String(claims.name || '').slice(0, 120), status: 'active' });
      provisioned = true;
      await audit(req, 'auth.sso_provisioned', 'user', user.id, { email, issuer: se.issuer });
    }
    if (user.status === 'invited') {
      /* An invitation is accepted by proving the address — at the provider
         instead of with a password. Only a live one: an invitation that
         expired is not opened by a later sign-on. */
      const { rowCount } = await db.query(
        `UPDATE access_link SET used_at = now() WHERE user_id = $1 AND purpose = 'invite' AND used_at IS NULL AND expires_at > now()`, [user.id]);
      if (!rowCount) return refused('invite_expired', { email, user: user.id });
      user = await svc.updateUser(db, user.id, { status: 'active' });
      await audit(req, 'auth.invite_accepted', 'user', user.id, { method: 'sso' });
    }
    if (user.status !== 'active') {
      await audit(req, 'auth.login_refused', 'user', user.id, { status: user.status, method: 'sso' });
      if (user.status === 'suspended') return refuse(res, 'suspended');
      return refuse(res, 'inactive');
    }
    if (link) {
      await db.query('UPDATE access_sso_identity SET email = $2, last_used_at = now() WHERE id = $1', [link.id, email]);
    } else {
      await db.query(
        `INSERT INTO access_sso_identity (user_id, issuer, subject, email, last_used_at) VALUES ($1, $2, $3, $4, now())`,
        [user.id, se.issuer, claims.sub, email]);
      await audit(req, 'auth.sso_linked', 'user', user.id, { issuer: se.issuer, email, provisioned });
    }
    const mfa = multiFactor(claims);
    if (!mfa && user.totp_enabled) {
      const ticket = newToken(24);
      ssoTickets.set(ticket, { userId: user.id, exp: now() + 5 * 60_000, tries: 0, back: st.back });
      if (ssoTickets.size > 5000) ssoTickets.delete(ssoTickets.keys().next().value);
      setCookie(res, req, SSO_TICKET, ticket, { maxAge: 300, sameSite: 'Strict' });
      return goSignin(res, 'code', st.back);
    }
    await startSession(req, res, user, { mfaOk: mfa, method: 'sso' });
    await audit(req, 'auth.login', 'user', user.id, { method: 'sso', mfa, issuer: se.issuer });
    return goSignin(res, 'done', st.back);
  }));

  /* The code after the provider: the password path's /api/auth/login/code,
     for a ticket the provider's return trip left in an HttpOnly cookie
     rather than one a password produced. The same five tries a ticket, the
     same ten failures per person per fifteen minutes, the same account lock,
     the same recovery codes. */
  app.post('/api/auth/sso/code', wrap(async (req, res) => {
    noStore(res);
    const key = req.fmCookies?.[SSO_TICKET];
    const t = key ? ssoTickets.get(key) : null;
    const done = () => { ssoTickets.delete(key); setCookie(res, req, SSO_TICKET, '', { maxAge: 0, sameSite: 'Strict' }); };
    if (!t || t.exp < now()) { if (key) done(); return fail(res, 401, 'expired', 'That sign-in took too long. Start again.'); }
    t.tries += 1;
    if (t.tries > 5) { done(); return fail(res, 429, 'slow_down', 'Too many wrong codes. Start again.'); }
    const u = await svc.getUserSecrets(db, t.userId);
    if (!u || u.status !== 'active' || failures(`code:${t.userId}`) >= 10
      || (u.locked_until && new Date(u.locked_until).getTime() > now())) {
      done();
      return fail(res, 429, 'slow_down', 'Too many wrong codes. Wait fifteen minutes and try again.');
    }
    const code = String(req.body?.code || '').trim();
    let ok = false;
    const secret = unseal(u.totp_secret);
    if (secret) {
      const step = verifyTotp(secret, code, { now: now(), lastStep: u.totp_last_step });
      if (step != null) { ok = true; await db.query('UPDATE access_user SET totp_last_step = $2 WHERE id = $1', [u.id, step]); }
    }
    if (!ok && /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(code)) {
      const h = tokenHash(code.toLowerCase());
      const { rowCount } = await db.query(
        'UPDATE access_user SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)', [u.id, h]);
      if (rowCount === 1) { ok = true; await audit(req, 'auth.recovery_code_used', 'user', u.id, { method: 'sso' }); }
    }
    if (!ok) {
      limited(`code:${t.userId}`, Infinity);
      await svc.recordFailure(db, u.id);
      await audit(req, 'auth.code_failed', 'user', u.id, { method: 'sso' });
      return fail(res, 401, 'bad_code', 'That code is not right. Use the current code from your authenticator app.');
    }
    done();
    const user = await svc.getUser(db, u.id);
    await startSession(req, res, user, { mfaOk: true, method: 'sso' });
    await audit(req, 'auth.login', 'user', user.id, { method: 'sso', mfa: true });
    return res.json({ ok: true, mustChangePassword: user.must_change_password, back: t.back || '/' });
  }));

  /* ═════════════════ for the Owner and Access admins ═════════════════ */
  app.get('/api/access/signin-methods', wrap(async (req, res) => {
    const fm = manager(req, res);
    if (!fm) return undefined;
    noStore(res);
    const cfg = await svc.getConfig(db, { fresh: true });
    const rp = wa.rpConfig(env);
    const se = ssoEnv(env);
    const { rows: [pk] } = await db.query(
      'SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS people FROM access_passkey WHERE disabled_at IS NULL');
    const { rows: [ln] } = await db.query('SELECT count(*)::int AS n FROM access_sso_identity');
    /* "Check the provider": a live read of its discovery document, on
       request only — a page view must not call another company's server. */
    let provider = null;
    if (req.query.check === '1' && se.ok) {
      try {
        const d = await oidc.discover(se.issuer, { fresh: true });
        provider = { ok: true, detail: `The provider answered: sign-in at ${new URL(d.authorization_endpoint).host}.` };
      } catch (e) {
        if (!(e instanceof OidcError)) throw e;
        provider = { ok: false, detail: e.detail };
      }
    }
    return res.json({
      owner: (fm.grants || []).some((g) => g.role_code === 'OWN'),
      config: { passkeys: cfg.passkeys, sso: cfg.sso, sso_provision: cfg.sso_provision, sso_domains: parseDomains(cfg.sso_domains) },
      passkeys: { ready: rp.ok, why: rp.ok ? null : rp.why, rpId: rp.rpId || null, origin: rp.origin || null, registered: pk.n, people: pk.people },
      sso: { ready: se.ok, why: se.why, name: se.name, issuer: se.issuer || null, clientId: se.clientId || null,
        secretSet: Boolean(se.clientSecret), redirectUri: se.redirectUri || null, linked: ln.n, provider },
    });
  }));

  app.get('/api/access/users/:id/signin-methods', wrap(async (req, res) => {
    const fm = manager(req, res);
    if (!fm) return undefined;
    noStore(res);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return fail(res, 400, 'bad_request', 'Which person?');
    return res.json({
      passkeys: (await listPasskeys(db, id)).map(passkeyView),
      sso: (await ssoIdentitiesOf(db, id)).map((s) => ({ issuer: s.issuer, email: s.email, created_at: s.created_at, last_used_at: s.last_used_at })),
    });
  }));
}
