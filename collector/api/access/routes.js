/* Sign-in, the account page, and Set up → Access — the HTTP surface.
   ─────────────────────────────────────────────────────────────────────────
   /api/auth/*    the caller about themselves: sign in, out, password,
                  two-step, sessions, look, preview, requests.
   /api/access/*  managing other people: users, grants, teams, roles,
                  requests, reviews, devices, the audit log, sign-in mode.
   Both prefixes are declared `self` in the manifest: these handlers make
   their own decisions, because what they decide IS access.

   Every change here is audited, and every rule of §6.4 is enforced here, not
   in the page: the ceiling (nobody confers more than they hold), the second
   Owner for sensitive grants, and nobody approving their own request. */
import * as svc from './service.js';
import { appendAudit, verifyChain } from './audit.js';
import { covers, computeAccess } from './principal.js';
import { FOUR_EYES } from './manifest.js';
import {
  verifyPassword, passwordProblem, newTotpSecret, verifyTotp, otpauthUri, seal, unseal,
  newRecoveryCodes, tokenHash, safeEqual, newToken,
} from './crypto.js';
import { SID, CSRF, DEV, setCookie, clearCookies, issueCsrf } from './middleware.js';
import {
  ROLES, ROLE, CLASSES, CLASS_CODES, CAPS, CAP_CODES, roleIsSensitive, rank,
} from '../public/access_model.js';

const MIN_REASON = 3;

export function accessRoutes(app, { db, layer, wrap, log = { info() {}, warn() {}, error() {} } }) {
  const audit = (req, action, subjectType, subjectId, detail = {}) => appendAudit(db, {
    actorId: req.fm?.user?.id ?? null,
    actorLabel: req.fm?.user?.email || req.fm?.kind || 'anonymous',
    action, subjectType, subjectId, detail, ip: req.ip, ua: req.get('user-agent'),
  }).catch((e) => log.error('access', 'audit failed', { err: String(e).slice(0, 200) }));

  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const fail = (res, status, error, detail, extra = {}) => { noStore(res); return res.status(status).json({ error, detail, ...extra }); };
  const signedIn = (req) => req.fm?.kind === 'user' && req.fm.user;
  const csrfOk = (req) => {
    const want = req.fmCookies?.[CSRF];
    return Boolean(want) && safeEqual(req.get('x-fm-csrf') || '', want);
  };
  /* The signed-in person, for their own account routes. `allowRestricted`:
     the password and two-step routes must work while the session is
     restricted to exactly those. */
  const me = (req, res, { allowRestricted = false, write = false } = {}) => {
    /* A wall screen IS signed in — as a screen. "Sign in first" sent it to
       the sign-in page from Approvals (sweep, 2026-09-28), stranding the
       display. It is told the true reason instead. */
    if (req.fm?.kind === 'device') { fail(res, 403, 'not_allowed', 'This is a screen, not a person: it has no account, approvals or access to manage.'); return null; }
    if (!signedIn(req)) { fail(res, 401, 'signin', 'Sign in first.'); return null; }
    if (req.fm.restricted && !allowRestricted) { fail(res, 403, 'restricted', 'Finish setting up your account first.', { need: req.fm.restricted }); return null; }
    if (write && !csrfOk(req)) { fail(res, 403, 'csrf', 'Reload the page and try again.'); return null; }
    return req.fm;
  };
  const stepupFresh = (fm, minutes = 10) => fm.session?.stepup_at
    && Date.now() - new Date(fm.session.stepup_at).getTime() < minutes * 60_000;
  /* A manager of access: holds access.manage, is not previewing, has
     re-confirmed recently for anything that changes a grant. */
  const manager = (req, res, { write = false, stepup = false } = {}) => {
    const fm = me(req, res, { write });
    if (!fm) return null;
    if (fm.access.preview) { fail(res, 403, 'preview', 'You are previewing a role, which is read-only.'); return null; }
    if (!fm.access.caps.includes('access.manage')) { fail(res, 403, 'not_allowed', 'Only the Owner and Access admins manage access.'); return null; }
    if (stepup && !stepupFresh(fm)) { fail(res, 403, 'stepup', 'Confirm it is you to continue.'); return null; }
    return fm;
  };
  const isOwner = (fm) => (fm.grants || []).some((g) => g.role_code === 'OWN');

  /* ── rate limiting for sign-in: per address, per 15 minutes ─────────── */
  const tries = new Map();
  const limited = (key, max = 20) => {
    const now = Date.now();
    const t = tries.get(key) || { n: 0, at: now };
    if (now - t.at > 15 * 60_000) { t.n = 0; t.at = now; }
    t.n += 1; tries.set(key, t);
    if (tries.size > 10000) tries.delete(tries.keys().next().value);
    return t.n > max;
  };
  /* FAILURES, counted apart from attempts and read without adding one.
     The sign-in throttle is keyed on the ADDRESS TYPED AND THE DEVICE, and
     applies whether or not the address has an account (security review,
     2026-09-28). The old rule locked the ACCOUNT after five wrong passwords
     and said so with a 423: any visitor could learn which addresses have
     accounts (an unknown one never locks), and anyone who knew the Owner's
     address could keep the Owner locked out — the correct password was
     refused during the lock — with five requests every fifteen minutes. Now
     a stranger's failures throttle the stranger; the account's own counter
     only closes it after fifty failures from anywhere (a spread-out attack),
     and every one of these answers is the same sentence. */
  const failures = (key) => {
    const t = tries.get(key);
    return t && Date.now() - t.at <= 15 * 60_000 ? t.n : 0;
  };
  const failed = (key) => { limited(key, Infinity); };
  /* Two-step tickets: a password was right, a code is still owed. */
  const tickets = new Map();

  const startSession = async (req, res, user, { mfaOk }) => {
    const cfg = await svc.getConfig(db);
    const { token, maxAgeSeconds } = await svc.createSession(db, {
      userId: user.id, ip: req.ip, ua: req.get('user-agent'), mfaOk, cfg });
    setCookie(res, req, SID, token, { maxAge: maxAgeSeconds });
    issueCsrf(res, req);
    await svc.recordSuccess(db, user.id);
  };

  /* ── who am I ─────────────────────────────────────────────────────── */
  app.get('/api/auth/me', wrap(async (req, res) => {
    noStore(res);
    const fm = req.fm || { kind: 'anonymous', mode: 'open' };
    const fleets = await svc.allFleets(db);
    if (!req.fmCookies?.[CSRF]) issueCsrf(res, req);
    const base = { mode: fm.mode, fleets, now: new Date().toISOString() };
    if (fm.kind === 'anonymous') return res.json({ ...base, signedIn: false, kind: 'anonymous' });
    if (fm.kind === 'device') {
      return res.json({ ...base, signedIn: true, kind: 'device', device: fm.device,
        access: summary(fm.access), roles: [fm.device.role] });
    }
    if (fm.kind !== 'user') return res.json({ ...base, signedIn: false, kind: fm.kind });
    const u = fm.user;
    const teams = await svc.teamsOf(db, u.id);
    const cfg = fm.cfg || await svc.getConfig(db);
    /* Each grant's role by its NAME as well as its code: a company's own
       role (C_…) is in no table the page carries, and the account page said
       "your company's own role C_…" instead of what the Owner called it. */
    const custom = (fm.grants || []).some((g) => !ROLE[g.role_code]) ? await svc.customRoles(db) : {};
    const roleName = (code) => ROLE[code]?.name || custom[code]?.name || code;
    return res.json({
      ...base, signedIn: true, kind: 'user',
      user: { id: u.id, email: u.email, name: u.name, prefs: u.prefs || {}, totp: u.totp_enabled,
        mustChangePassword: u.must_change_password, lastLoginAt: u.last_login_at },
      restricted: fm.restricted || null,
      mfaRequired: layer.mfaRequired(cfg, fm),
      owner: isOwner(fm),
      preview: fm.access.preview,
      roles: [...new Set((fm.grants || []).map((g) => g.role_code))],
      grants: (fm.grants || []).map((g) => ({ id: g.id, role: g.role_code, name: roleName(g.role_code), fleets: g.fleets, expires_at: g.expires_at,
        via: g.team_id ? 'team' : 'direct', team_id: g.team_id })),
      teams,
      access: summary(fm.access),
      stepupFresh: Boolean(stepupFresh(fm)),
    });
  }));
  const summary = (a) => ({
    levels: a.levels, levelsAny: a.levelsAny, byFleet: a.byFleet, caps: a.caps, capsAny: a.capsAny,
    scope: a.scope, allScope: a.allScope, preview: a.preview,
  });

  /* ── sign in ──────────────────────────────────────────────────────── */
  app.post('/api/auth/login', wrap(async (req, res) => {
    noStore(res);
    const email = svc.normEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const pair = `fail:${email}|${req.ip}`;
    const slow = () => fail(res, 429, 'slow_down', 'Too many attempts from here. Wait fifteen minutes and try again.');
    if (limited(`ip:${req.ip}`, 30) || failures(pair) >= 5 || failures(`failem:${email}`) >= 50) return slow();
    const user = email ? await svc.getUserByEmail(db, email) : null;
    const generic = () => fail(res, 401, 'bad_credentials', 'That email and password do not match an account.');
    const wrong = () => { failed(pair); failed(`failem:${email}`); };
    if (!user || !user.password_hash) {
      /* Same work as a real check, so the answer's timing does not say
         whether the address has an account. */
      verifyPassword(password, 'scrypt$14$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      wrong();
      await audit(req, 'auth.login_failed', 'email', null, { email, why: 'no account' });
      return generic();
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      /* Closed after fifty failures from anywhere: the same work and the
         same answer as the throttle, so it says nothing an unknown address
         would not. */
      verifyPassword(password, user.password_hash);
      return slow();
    }
    if (!verifyPassword(password, user.password_hash)) {
      wrong();
      const r = await svc.recordFailure(db, user.id);
      await audit(req, 'auth.login_failed', 'user', user.id, { failures: r?.failed_logins });
      return generic();
    }
    if (user.status !== 'active') {
      await audit(req, 'auth.login_refused', 'user', user.id, { status: user.status });
      return fail(res, 403, 'inactive', user.status === 'suspended'
        ? 'This account is suspended. Ask the Owner or an Access admin.'
        : 'This account is not active. Use the link you were sent, or ask an admin for a new one.');
    }
    if (user.totp_enabled) {
      const ticket = newToken(24);
      tickets.set(ticket, { userId: user.id, exp: Date.now() + 5 * 60_000, tries: 0, password });
      if (tickets.size > 5000) tickets.delete(tickets.keys().next().value);
      return res.json({ ok: false, mfa: 'code', ticket });
    }
    await startSession(req, res, user, { mfaOk: false });
    await svc.recordSuccess(db, user.id, password, user.password_hash);
    await audit(req, 'auth.login', 'user', user.id, {});
    return res.json({ ok: true, mustChangePassword: user.must_change_password });
  }));

  app.post('/api/auth/login/code', wrap(async (req, res) => {
    noStore(res);
    const t = tickets.get(String(req.body?.ticket || ''));
    if (!t || t.exp < Date.now()) return fail(res, 401, 'expired', 'That sign-in took too long. Start again.');
    t.tries += 1;
    if (t.tries > 5) { tickets.delete(req.body.ticket); return fail(res, 429, 'slow_down', 'Too many wrong codes. Start again.'); }
    const u = await svc.getUserSecrets(db, t.userId);
    /* The second factor is counted too (security review, 2026-09-28): a
       wrong code used to cost nothing but the ticket's own five tries, and a
       new ticket was one password away — about 7,200 guesses a day against a
       six-digit code, none of them recorded against the account. */
    if (!u || u.status !== 'active' || failures(`code:${t.userId}`) >= 10
      || (u.locked_until && new Date(u.locked_until).getTime() > Date.now())) {
      tickets.delete(req.body.ticket);
      return fail(res, 429, 'slow_down', 'Too many wrong codes. Wait fifteen minutes and try again.');
    }
    const code = String(req.body?.code || '').trim();
    let ok = false;
    const secret = unseal(u?.totp_secret);
    if (secret) {
      const step = verifyTotp(secret, code, { lastStep: u.totp_last_step });
      if (step != null) {
        ok = true;
        await db.query('UPDATE access_user SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
      }
    }
    if (!ok && /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(code)) {
      const h = tokenHash(code.toLowerCase());
      const { rowCount } = await db.query(
        `UPDATE access_user SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)`,
        [u.id, h]);
      if (rowCount === 1) { ok = true; await audit(req, 'auth.recovery_code_used', 'user', u.id, {}); }
    }
    if (!ok) {
      failed(`code:${t.userId}`);
      await svc.recordFailure(db, u.id);
      await audit(req, 'auth.code_failed', 'user', u?.id, {});
      return fail(res, 401, 'bad_code', 'That code is not right. Use the current code from your authenticator app.');
    }
    tickets.delete(req.body.ticket);
    const user = await svc.getUserByEmail(db, u.email);
    await startSession(req, res, user, { mfaOk: true });
    await svc.recordSuccess(db, user.id, t.password, user.password_hash);
    await audit(req, 'auth.login', 'user', user.id, { mfa: true });
    return res.json({ ok: true, mustChangePassword: user.must_change_password });
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    noStore(res);
    const token = req.fmCookies?.[SID];
    /* The CSRF header, like every other change: another site could post here
       and sign a person out, wiping the site's storage (security review,
       2026-09-28). A request with neither a session nor the header — a
       cross-site form, no cookie sent — is answered and changes nothing. */
    const csrf = req.fmCookies?.[CSRF];
    const csrfOk = Boolean(csrf) && safeEqual(req.get('x-fm-csrf') || '', csrf);
    if ((token || req.fmCookies?.[DEV]) && !csrfOk) return fail(res, 403, 'csrf', 'Reload the page and try again.');
    if (!token && !req.fmCookies?.[DEV] && !csrfOk) return res.json({ ok: true });
    if (token) {
      const s = await svc.sessionForToken(db, token);
      if (s) {
        await svc.revokeSession(db, s.id, 'signed out');
        await audit(req, 'auth.logout', 'user', s.user_id, {});
      }
    }
    clearCookies(res, req);
    /* A wall screen signed in by its device link, with no person signed in
       over it, signs ITSELF out: its cookie goes too. (A person signed in on
       a screen's browser signs only themself out; the screen stays.) */
    if (!token && req.fmCookies?.[DEV]) setCookie(res, req, DEV, '', { maxAge: 0 });
    /* Empties this browser's HTTP cache and storage for the site, so nothing
       the person read stays behind for the next person at this machine. */
    res.set('Clear-Site-Data', '"cache", "storage"');
    return res.json({ ok: true });
  }));

  /* ── one-time links: first password, reset ─────────────────────────── */
  app.post('/api/auth/link/check', wrap(async (req, res) => {
    noStore(res);
    if (limited(`link:${req.ip}`, 40)) return fail(res, 429, 'slow_down', 'Too many attempts. Wait fifteen minutes.');
    const l = await svc.linkForToken(db, String(req.body?.token || ''));
    if (!l) return fail(res, 404, 'bad_link', 'This link has expired or was already used. Ask for a new one.');
    return res.json({ ok: true, purpose: l.purpose, email: l.email, name: l.name });
  }));
  app.post('/api/auth/link/accept', wrap(async (req, res) => {
    noStore(res);
    if (limited(`link:${req.ip}`, 40)) return fail(res, 429, 'slow_down', 'Too many attempts. Wait fifteen minutes.');
    const token = String(req.body?.token || '');
    const l = await svc.linkForToken(db, token);
    if (!l) return fail(res, 404, 'bad_link', 'This link has expired or was already used. Ask for a new one.');
    const password = String(req.body?.password || '');
    const problem = passwordProblem(password, { email: l.email });
    if (problem) return fail(res, 400, 'weak_password', problem);
    if (!(await svc.useLink(db, tokenHash(token)))) return fail(res, 404, 'bad_link', 'This link was already used.');
    await svc.setPassword(db, l.user_id, password);
    const name = String(req.body?.name || '').trim();
    if (name && l.purpose === 'invite') await svc.updateUser(db, l.user_id, { name: name.slice(0, 120) });
    await svc.revokeUserSessions(db, l.user_id, `password set by ${l.purpose} link`);
    await audit(req, `auth.${l.purpose}_accepted`, 'user', l.user_id, {});
    return res.json({ ok: true, email: l.email });
  }));

  /* ── my account ───────────────────────────────────────────────────── */
  app.post('/api/auth/password', wrap(async (req, res) => {
    const fm = me(req, res, { allowRestricted: true, write: true });
    if (!fm) return undefined;
    const u = await svc.getUserSecrets(db, fm.user.id);
    if (!verifyPassword(String(req.body?.current || ''), u.password_hash)) {
      await audit(req, 'auth.password_change_failed', 'user', fm.user.id, {});
      return fail(res, 401, 'bad_credentials', 'Your current password is not right.');
    }
    const next = String(req.body?.next || '');
    const problem = passwordProblem(next, { email: fm.user.email });
    if (problem) return fail(res, 400, 'weak_password', problem);
    if (verifyPassword(next, u.password_hash)) return fail(res, 400, 'same_password', 'Choose a password you have not used here.');
    await svc.setPassword(db, fm.user.id, next);
    await svc.revokeUserSessions(db, fm.user.id, 'password changed', { except: fm.session.id });
    layer.cache.clear();
    await audit(req, 'auth.password_changed', 'user', fm.user.id, {});
    return res.json({ ok: true });
  }));

  app.post('/api/auth/stepup', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    if (limited(`step:${fm.user.id}`, 10)) return fail(res, 429, 'slow_down', 'Too many attempts. Wait fifteen minutes.');
    const u = await svc.getUserSecrets(db, fm.user.id);
    let ok = false;
    /* With two-step on, re-confirming takes a code — the password alone is
       the one factor somebody at an unlocked machine may already have. */
    if (u.totp_enabled) {
      const code = String(req.body?.code || '').trim();
      const step = code ? verifyTotp(unseal(u.totp_secret), code, { lastStep: u.totp_last_step }) : null;
      if (step != null) { ok = true; await db.query('UPDATE access_user SET totp_last_step = $2 WHERE id = $1', [u.id, step]); }
    } else if (req.body?.password) {
      ok = verifyPassword(String(req.body.password), u.password_hash);
    }
    if (!ok) {
      await audit(req, 'auth.stepup_failed', 'user', fm.user.id, {});
      return fail(res, 401, 'bad_credentials', u.totp_enabled ? 'That code is not right.' : 'That password is not right.');
    }
    await svc.patchSession(db, fm.session.id, { stepup: true });
    layer.cache.clear();
    await audit(req, 'auth.stepup', 'user', fm.user.id, {});
    return res.json({ ok: true });
  }));

  app.post('/api/auth/totp/setup', wrap(async (req, res) => {
    const fm = me(req, res, { allowRestricted: true, write: true });
    if (!fm) return undefined;
    if (fm.user.totp_enabled) return fail(res, 409, 'already', 'Two-step sign-in is already on.');
    const secret = newTotpSecret();
    await db.query('UPDATE access_user SET totp_secret = $2, totp_last_step = NULL WHERE id = $1', [fm.user.id, seal(secret)]);
    return res.json({ secret, uri: otpauthUri(secret, fm.user.email) });
  }));
  app.post('/api/auth/totp/enable', wrap(async (req, res) => {
    const fm = me(req, res, { allowRestricted: true, write: true });
    if (!fm) return undefined;
    const u = await svc.getUserSecrets(db, fm.user.id);
    /* Only while two-step is OFF, and never with a code already used
       (security review, 2026-09-28): this route checked neither. The code a
       person had just signed in with, replayed here within its 90 seconds,
       granted step-up, replaced the recovery codes and signed the person out
       everywhere else. /api/auth/totp/setup clears totp_last_step, so a
       first enrolment is unaffected. */
    if (u.totp_enabled) return fail(res, 409, 'already', 'Two-step sign-in is already on.');
    const secret = unseal(u.totp_secret);
    const step = secret ? verifyTotp(secret, req.body?.code, { lastStep: u.totp_last_step }) : null;
    if (step == null) return fail(res, 400, 'bad_code', 'That code is not right. Enter the six digits your app shows now.');
    const codes = newRecoveryCodes();
    await db.query(
      `UPDATE access_user SET totp_enabled = true, totp_last_step = $2, recovery_codes = $3 WHERE id = $1`,
      [fm.user.id, step, codes.map((c) => tokenHash(c))]);
    await svc.patchSession(db, fm.session.id, { mfaOk: true, stepup: true });
    await svc.revokeUserSessions(db, fm.user.id, 'two-step sign-in turned on', { except: fm.session.id });
    layer.cache.clear();
    svc.bumpAccess();
    await audit(req, 'auth.totp_enabled', 'user', fm.user.id, {});
    return res.json({ ok: true, recoveryCodes: codes });
  }));
  app.post('/api/auth/totp/disable', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    const cfg = await svc.getConfig(db);
    if (layer.mfaRequired(cfg, fm)) return fail(res, 403, 'required', 'Two-step sign-in is required for your role.');
    if (!stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    await db.query(`UPDATE access_user SET totp_enabled = false, totp_secret = NULL, recovery_codes = '{}' WHERE id = $1`, [fm.user.id]);
    svc.bumpAccess();
    await audit(req, 'auth.totp_disabled', 'user', fm.user.id, {});
    return res.json({ ok: true });
  }));

  app.get('/api/auth/sessions', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    noStore(res);
    const rows = await svc.listSessions(db, fm.user.id);
    return res.json({ current: fm.session.id.slice(0, 12), sessions: rows });
  }));
  app.post('/api/auth/sessions/revoke', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    const prefix = String(req.body?.id || '');
    if (req.body?.all === true) {
      const n = await svc.revokeUserSessions(db, fm.user.id, 'signed out everywhere', { except: fm.session.id });
      await audit(req, 'auth.sessions_revoked', 'user', fm.user.id, { n });
      return res.json({ ok: true, revoked: n });
    }
    if (!/^[0-9a-f]{12}$/.test(prefix)) return fail(res, 400, 'bad_request', 'Which session?');
    const { rowCount } = await db.query(
      `UPDATE access_session SET revoked_at = now(), revoked_reason = 'signed out from account page'
        WHERE user_id = $1 AND left(id, 12) = $2 AND revoked_at IS NULL`, [fm.user.id, prefix]);
    svc.bumpAccess();
    await audit(req, 'auth.session_revoked', 'user', fm.user.id, {});
    return res.json({ ok: true, revoked: rowCount });
  }));

  app.post('/api/auth/prefs', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    const look = req.body?.look;
    const prefs = { ...(fm.user.prefs || {}) };
    if (look === 'arkiv' || look === 'classic') prefs.look = look;
    await svc.updateUser(db, fm.user.id, { prefs });
    layer.cache.clear();
    return res.json({ ok: true, prefs });
  }));

  /* The Owner previewing a role: read-only, audited, on this session only. */
  app.post('/api/auth/preview', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    if (!isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only the Owner can preview a role.');
    const role = req.body?.role || null;
    if (role && (!ROLE[role] || role === 'OWN')) return fail(res, 400, 'bad_role', 'Choose one of the built-in roles.');
    await svc.patchSession(db, fm.session.id, { viewAs: role });
    layer.cache.clear();
    await audit(req, role ? 'access.preview_started' : 'access.preview_ended', 'role', role, {});
    return res.json({ ok: true, preview: role });
  }));

  /* Showing a masked class in full, for ten minutes, on this session only —
     with a reason, after re-confirming, and recorded (ULM-DESIGN §6.2). Only
     a class the role holds MASKED can be revealed: reveal is not a way round
     a class the role does not hold at all. */
  app.post('/api/auth/reveal', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    if (fm.access.preview) return fail(res, 403, 'preview', 'You are previewing a role, which is read-only.');
    const cls = String(req.body?.class || '');
    if (!CLASS_CODES.includes(cls) || fm.access.levelsAny?.[cls] !== 'M') {
      return fail(res, 403, 'not_allowed', 'Only something your role sees masked can be shown in full.');
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < MIN_REASON) return fail(res, 400, 'reason', 'Say why you need to see it in full.');
    if (!stepupFresh(fm)) return fail(res, 403, 'stepup', 'Confirm it is you to continue.');
    const until = Date.now() + 10 * 60_000;
    const cur = layer.reveals.get(fm.session.id) || {};
    cur[cls] = until;
    layer.reveals.set(fm.session.id, cur);
    if (layer.reveals.size > 5000) layer.reveals.delete(layer.reveals.keys().next().value);
    await audit(req, 'access.reveal', 'class', cls, { reason, view: String(req.body?.view || '').slice(0, 120), minutes: 10 });
    return res.json({ ok: true, class: cls, until: new Date(until).toISOString() });
  }));

  /* Asking for access from a page that said "not shown to your role". */
  app.post('/api/auth/request', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < MIN_REASON) return fail(res, 400, 'reason', 'Say briefly why you need it.');
    const cls = CLASS_CODES.includes(req.body?.class) ? req.body.class : null;
    const role = ROLE[req.body?.role] || null;
    const open = await svc.listRequests(db, { status: 'open', userId: fm.user.id });
    if (open.length >= 10) return fail(res, 429, 'too_many', 'You already have ten open requests.');
    const r = await svc.createRequest(db, { userId: fm.user.id, view: req.body?.view || '', classCode: cls,
      roleCode: role?.code || null, reason });
    await audit(req, 'access.requested', 'request', r.id, { view: r.view, class: cls, role: role?.code });
    return res.json({ ok: true, id: r.id });
  }));
  app.get('/api/auth/requests', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    noStore(res);
    return res.json({ requests: await svc.listRequests(db, { userId: fm.user.id }) });
  }));

  /* A wall display signs in with its device token once; the token becomes a
     cookie so the screen survives a reload. */
  app.post('/api/auth/device', wrap(async (req, res) => {
    noStore(res);
    if (limited(`dev:${req.ip}`, 20)) return fail(res, 429, 'slow_down', 'Too many attempts.');
    const d = await svc.deviceForToken(db, String(req.body?.token || ''));
    if (!d) return fail(res, 401, 'bad_device', 'This screen link is not valid. Ask the Owner for a new one.');
    setCookie(res, req, DEV, String(req.body.token), { maxAge: 365 * 86400 });
    await appendAudit(db, { actorLabel: `device:${d.name}`, action: 'auth.device_signed_in', subjectType: 'device', subjectId: d.id, detail: {}, ip: req.ip });
    return res.json({ ok: true, name: d.name });
  }));

  /* ═════════════════ managing access ═════════════════ */

  app.get('/api/access/overview', wrap(async (req, res) => {
    const fm = manager(req, res);
    if (!fm) return undefined;
    noStore(res);
    const [users, teams, grants, custom, requests, devices, cfg, owners, fleets] = await Promise.all([
      svc.listUsers(db), svc.listTeams(db), svc.listGrants(db, {}), svc.customRoles(db),
      svc.listRequests(db, { status: 'open' }), svc.listDevices(db), svc.getConfig(db, { fresh: true }),
      svc.activeOwners(db), svc.allFleets(db)]);
    return res.json({
      users, teams, grants, requests, devices, owners: owners.map((o) => o.id), fleets,
      roles: [...ROLES.map((r) => ({ ...r, builtin: true })), ...Object.values(custom)],
      classes: CLASSES, caps: CAPS,
      config: { mode: cfg.mode, mfa: cfg.mfa, cash_stepup_aed: cfg.cash_stepup_aed,
        idle_minutes: cfg.idle_minutes, session_days: cfg.session_days,
        single_owner_delay_hours: cfg.single_owner_delay_hours },
      me: { id: fm.user.id, owner: isOwner(fm), levels: fm.access.levels, caps: fm.access.caps, scope: fm.access.scope },
    });
  }));

  /* The ceiling and the second-Owner rule, in one place. Returns
     { status, effectiveAt, why } or { refuse }. */
  async function grantDecision(fm, role, fleets, { targetUserId = null } = {}) {
    if (!role) return { refuse: 'Choose a role.' };
    if (role.device) return { refuse: 'That role is for a screen, not a person. Add it under Screens.' };
    const grantor = { levels: fm.access.levels, caps: fm.access.caps };
    if (!covers(grantor, role)) return { refuse: 'You cannot give access you do not hold yourself.' };
    const all = fm.access.allFleets;
    const want = fleets && fleets.length ? fleets : all;
    if (want.some((f) => !all.includes(f))) return { refuse: 'Unknown fleet.' };
    if (want.some((f) => !fm.access.scope.includes(f))) return { refuse: 'You can only give access to your own fleets.' };
    if (targetUserId != null && Number(targetUserId) === Number(fm.user.id)) {
      return { refuse: 'You cannot give access to yourself. Ask another Owner or Access admin.' };
    }
    if (!roleIsSensitive(role)) return { status: 'active' };
    const owners = await svc.activeOwners(db);
    const cfg = await svc.getConfig(db, { fresh: true });
    if (!isOwner(fm)) return { status: 'pending', why: 'This role needs an Owner to approve it.' };
    if (owners.length > 1) return { status: 'pending', why: 'This role needs a second Owner to approve it.' };
    /* The only Owner. While sign-in is not yet required everybody can see
       everything anonymously anyway, so a delay protects nothing; once it is
       required, the grant waits (§6.4). */
    const hours = cfg.mode === 'enforced' ? Number(cfg.single_owner_delay_hours ?? 24) : 0;
    if (hours > 0) {
      return { status: 'active', effectiveAt: new Date(Date.now() + hours * 3600_000).toISOString(),
        why: `There is only one Owner, so this role takes effect in ${hours} hours. Add a second Owner to approve grants at once.` };
    }
    return { status: 'active' };
  }

  const parseFleets = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : null);
  const parseExpiry = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) || d.getTime() <= Date.now() ? 'bad' : d.toISOString();
  };

  app.post('/api/access/users', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const email = String(req.body?.email || '').trim();
    if (!svc.validEmail(email)) return fail(res, 400, 'bad_email', 'Enter a real email address.');
    if (await svc.getUserByEmail(db, email)) return fail(res, 409, 'exists', 'Someone already has an account with that email.');
    const grants = Array.isArray(req.body?.grants) ? req.body.grants : [];
    const teamIds = Array.isArray(req.body?.teams) ? req.body.teams.map(Number).filter(Boolean) : [];
    const reason = String(req.body?.reason || '').trim();
    /* Decide every grant before creating anything, so a refused grant leaves
       no half-made account behind. */
    const decided = [];
    for (const g of grants) {
      const role = await svc.roleByCode(db, g.role);
      const exp = parseExpiry(g.expires_at);
      if (exp === 'bad') return fail(res, 400, 'bad_expiry', 'An end date must be in the future.');
      if (role?.timeboxed && !exp) return fail(res, 400, 'needs_expiry', `The ${role.name} role must have an end date.`);
      const d = await grantDecision(fm, role, parseFleets(g.fleets));
      if (d.refuse) return fail(res, 403, 'refused', d.refuse);
      decided.push({ role, fleets: parseFleets(g.fleets), exp, d });
    }
    const user = await svc.createUser(db, { email, name: req.body?.name || '', createdBy: fm.user.id });
    for (const x of decided) {
      await svc.createGrant(db, { userId: user.id, roleCode: x.role.code, fleets: x.fleets, expiresAt: x.exp,
        effectiveAt: x.d.effectiveAt || null, status: x.d.status, reason, by: fm.user.id });
    }
    for (const t of teamIds) await svc.setMember(db, t, user.id, true, fm.user.id);
    const token = await svc.createLink(db, user.id, 'invite', fm.user.id, 7 * 24);
    await audit(req, 'access.user_invited', 'user', user.id, {
      grants: decided.map((x) => ({ role: x.role.code, fleets: x.fleets, status: x.d.status, expires: x.exp })),
      teams: teamIds, reason });
    return res.json({ ok: true, user, link: `/signin#invite=${token}`, expiresInDays: 7,
      notes: decided.filter((x) => x.d.why).map((x) => `${x.role.name}: ${x.d.why}`) });
  }));

  app.post('/api/access/users/:id', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const id = Number(req.params.id);
    const target = await svc.getUser(db, id);
    if (!target) return fail(res, 404, 'not_found', 'No such person.');
    const action = String(req.body?.action || '');
    const reason = String(req.body?.reason || '').trim();
    if (id === fm.user.id && ['suspend', 'offboard'].includes(action)) {
      return fail(res, 403, 'self', 'You cannot suspend or offboard yourself.');
    }
    /* The last Owner cannot be removed. */
    const owners = await svc.activeOwners(db);
    const targetIsOwner = owners.some((o) => o.id === id);
    if (targetIsOwner && !isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only an Owner can change another Owner.');
    if (targetIsOwner && owners.length === 1 && ['suspend', 'offboard'].includes(action)) {
      return fail(res, 403, 'last_owner', 'This is the only Owner. Make someone else an Owner first.');
    }
    /* THE CEILING, FOR ACCOUNTS AS WELL AS GRANTS.
       ─────────────────────────────────────────────────────────────────────
       An Access admin cannot GIVE access they do not hold (grantDecision).
       They could still TAKE it: a password-reset link for a Finance manager
       comes back in this response, a two-step reset clears the second
       factor, and the account is theirs — with CASH and the commit action,
       and every act recorded under the victim's name (security review,
       2026-09-28). So an action on an account is held to the same ceiling as
       a grant: the manager must hold everything the person holds or is
       waiting for (a pending grant is access the account will have). An
       Owner holds everything and passes. Suspending and signing out are
       exempt: they only take access away, and are how a compromised
       account is stopped by whoever notices first. */
    if (!isOwner(fm) && !['suspend', 'signout'].includes(action)) {
      const theirs = computeAccess({ grants: await svc.heldOrWaiting(db, id), roles: await svc.customRoles(db),
        allFleets: fm.access.allFleets });
      if (!covers({ levels: fm.access.levels, caps: fm.access.caps }, { levels: theirs.levelsAny, caps: theirs.capsAny })) {
        return fail(res, 403, 'ceiling', 'This person holds access you do not hold yourself, so only an Owner can do that.');
      }
    }
    if (action === 'rename') {
      await svc.updateUser(db, id, { name: String(req.body?.name || '').trim().slice(0, 120) });
    } else if (action === 'suspend') {
      if (reason.length < MIN_REASON) return fail(res, 400, 'reason', 'Say why.');
      await svc.updateUser(db, id, { status: 'suspended', suspended_reason: reason });
      await svc.revokeUserSessions(db, id, 'suspended');
    } else if (action === 'reinstate') {
      await svc.updateUser(db, id, { status: target.password_changed_at ? 'active' : 'invited', suspended_reason: null });
    } else if (action === 'offboard') {
      if (reason.length < MIN_REASON) return fail(res, 400, 'reason', 'Say why.');
      await svc.updateUser(db, id, { status: 'offboarded', offboarded_at: new Date().toISOString(), suspended_reason: reason });
      await svc.revokeUserSessions(db, id, 'offboarded');
      for (const g of await svc.listGrants(db, { userId: id })) await svc.endGrant(db, g.id, fm.user.id);
      for (const t of await svc.teamsOf(db, id)) await svc.setMember(db, t.id, id, false);
      await db.query(`UPDATE access_link SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [id]);
    } else if (action === 'reset') {
      if (target.status === 'offboarded') return fail(res, 409, 'offboarded', 'This person has been offboarded.');
      const token = await svc.createLink(db, id, target.status === 'invited' ? 'invite' : 'reset', fm.user.id,
        target.status === 'invited' ? 7 * 24 : 24);
      await audit(req, 'access.link_issued', 'user', id, { purpose: target.status === 'invited' ? 'invite' : 'reset' });
      return res.json({ ok: true, link: `/signin#${target.status === 'invited' ? 'invite' : 'reset'}=${token}` });
    } else if (action === 'signout') {
      const n = await svc.revokeUserSessions(db, id, `signed out by ${fm.user.email}`);
      await audit(req, 'access.sessions_revoked', 'user', id, { n });
      return res.json({ ok: true, revoked: n });
    } else if (action === 'reset_mfa') {
      await db.query(`UPDATE access_user SET totp_enabled = false, totp_secret = NULL, recovery_codes = '{}' WHERE id = $1`, [id]);
      await svc.revokeUserSessions(db, id, 'two-step reset by admin');
    } else {
      return fail(res, 400, 'bad_action', 'Unknown action.');
    }
    layer.cache.clear();
    await audit(req, `access.user_${action}`, 'user', id, { reason });
    return res.json({ ok: true, user: await svc.getUser(db, id) });
  }));

  app.post('/api/access/grants', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const userId = req.body?.userId ? Number(req.body.userId) : null;
    const teamId = req.body?.teamId ? Number(req.body.teamId) : null;
    if (!userId === !teamId) return fail(res, 400, 'bad_request', 'Give the grant to a person or a team.');
    if (userId && !(await svc.getUser(db, userId))) return fail(res, 404, 'not_found', 'No such person.');
    const role = await svc.roleByCode(db, req.body?.role);
    const fleets = parseFleets(req.body?.fleets);
    const exp = parseExpiry(req.body?.expires_at);
    if (exp === 'bad') return fail(res, 400, 'bad_expiry', 'An end date must be in the future.');
    if (role?.timeboxed && !exp) return fail(res, 400, 'needs_expiry', 'The Auditor role must have an end date.');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < MIN_REASON) return fail(res, 400, 'reason', 'Say briefly why.');
    /* A grant to a team the grantor is in is a grant to themselves. */
    if (teamId) {
      const teams = await svc.listTeams(db);
      const t = teams.find((x) => x.id === teamId);
      if (!t) return fail(res, 404, 'not_found', 'No such team.');
      if (t.members.includes(fm.user.id)) return fail(res, 403, 'refused', 'You are in this team, so this would give access to yourself.');
    }
    const d = await grantDecision(fm, role, fleets, { targetUserId: userId });
    if (d.refuse) return fail(res, 403, 'refused', d.refuse);
    const g = await svc.createGrant(db, { userId, teamId, roleCode: role.code, fleets, expiresAt: exp,
      effectiveAt: d.effectiveAt || null, status: d.status, reason, by: fm.user.id });
    layer.cache.clear();
    await audit(req, 'access.grant_created', userId ? 'user' : 'team', userId || teamId,
      { grant: g.id, role: role.code, fleets, expires: exp, status: d.status, reason });
    return res.json({ ok: true, grant: g, note: d.why || null });
  }));

  app.post('/api/access/grants/:id/approve', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    if (!isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only an Owner approves these.');
    const g = await svc.getGrant(db, Number(req.params.id));
    if (!g || g.status !== 'pending') return fail(res, 404, 'not_found', 'Nothing waiting to approve.');
    if (g.granted_by === fm.user.id) return fail(res, 403, 'self', 'Someone other than the person who asked must approve it.');
    if (g.user_id === fm.user.id) return fail(res, 403, 'self', 'You cannot approve access for yourself.');
    if (g.team_id) {
      const t = (await svc.listTeams(db)).find((x) => x.id === g.team_id);
      if (t?.members.includes(fm.user.id)) return fail(res, 403, 'self', 'You are in this team.');
    }
    const out = await svc.approveGrant(db, g.id, fm.user.id);
    layer.cache.clear();
    await audit(req, 'access.grant_approved', 'grant', g.id, { role: g.role_code });
    return res.json({ ok: true, grant: out });
  }));
  app.post('/api/access/grants/:id/revoke', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const g = await svc.getGrant(db, Number(req.params.id));
    if (!g) return fail(res, 404, 'not_found', 'No such grant.');
    if (g.role_code === 'OWN') {
      if (!isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only an Owner can remove an Owner.');
      const owners = await svc.activeOwners(db);
      if (g.status === 'active' && owners.length <= 1 && owners.some((o) => o.id === g.user_id)) {
        return fail(res, 403, 'last_owner', 'This is the only Owner. Make someone else an Owner first.');
      }
    }
    const out = await svc.endGrant(db, g.id, fm.user.id, g.status === 'pending' ? 'declined' : 'revoked');
    layer.cache.clear();
    await audit(req, 'access.grant_revoked', 'grant', g.id, { role: g.role_code, reason: req.body?.reason || '' });
    return res.json({ ok: true, grant: out });
  }));

  app.post('/api/access/teams', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true });
    if (!fm) return undefined;
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) return fail(res, 400, 'bad_name', 'Name the team.');
    try {
      const t = await svc.createTeam(db, { name, description: req.body?.description || '', leadUserId: req.body?.lead || null, by: fm.user.id });
      await audit(req, 'access.team_created', 'team', t.id, { name });
      return res.json({ ok: true, team: t });
    } catch (e) {
      if (/unique/i.test(String(e))) return fail(res, 409, 'exists', 'A team with that name exists.');
      throw e;
    }
  }));
  app.post('/api/access/teams/:id', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: Boolean(req.body?.member) });
    if (!fm) return undefined;
    const id = Number(req.params.id);
    const team = (await svc.listTeams(db)).find((t) => t.id === id);
    if (!team) return fail(res, 404, 'not_found', 'No such team.');
    if (req.body?.member) {
      const uid = Number(req.body.member.userId);
      if (uid === fm.user.id && req.body.member.on) return fail(res, 403, 'self', 'You cannot add yourself to a team.');
      /* Adding someone to a team gives them the team's grants: the ceiling
         applies exactly as if each grant were given directly. */
      if (req.body.member.on) {
        for (const g of await svc.listGrants(db, { teamId: id, statuses: ['active', 'pending'] })) {
          const role = await svc.roleByCode(db, g.role_code);
          if (!covers({ levels: fm.access.levels, caps: fm.access.caps }, role || {})) {
            return fail(res, 403, 'refused', 'This team gives access you do not hold yourself.');
          }
        }
      }
      await svc.setMember(db, id, uid, Boolean(req.body.member.on), fm.user.id);
      await audit(req, req.body.member.on ? 'access.team_member_added' : 'access.team_member_removed', 'team', id, { user: uid });
    } else {
      await svc.updateTeam(db, id, { name: req.body?.name, description: req.body?.description,
        leadUserId: req.body?.lead === undefined ? undefined : (req.body.lead ? Number(req.body.lead) : null),
        archived: req.body?.archived === true });
      await audit(req, 'access.team_updated', 'team', id, { name: req.body?.name, lead: req.body?.lead, archived: req.body?.archived });
    }
    layer.cache.clear();
    return res.json({ ok: true });
  }));

  app.post('/api/access/roles', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) return fail(res, 400, 'bad_name', 'Name the role.');
    const levels = Object.fromEntries(Object.entries(req.body?.levels || {})
      .filter(([c, l]) => CLASS_CODES.includes(c) && ['F', 'M', 'A'].includes(l)));
    const caps = (req.body?.caps || []).filter((c) => CAP_CODES.includes(c));
    if (!covers({ levels: fm.access.levels, caps: fm.access.caps }, { levels, caps })) {
      return fail(res, 403, 'refused', 'A role you make cannot hold more than you do.');
    }
    const code = `C_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 20)}_${newToken(3).replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()}`;
    await svc.createRole(db, { code, name, description: req.body?.description || '', basedOn: req.body?.basedOn || null, levels, caps, by: fm.user.id });
    await audit(req, 'access.role_created', 'role', code, { name, levels, caps });
    return res.json({ ok: true, code });
  }));

  app.get('/api/access/requests', wrap(async (req, res) => {
    const fm = manager(req, res);
    if (!fm) return undefined;
    noStore(res);
    return res.json({ requests: await svc.listRequests(db, { status: req.query.status || null }) });
  }));
  app.post('/api/access/requests/:id', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: Boolean(req.body?.approve) });
    if (!fm) return undefined;
    const id = Number(req.params.id);
    const r = (await svc.listRequests(db, { status: 'open' })).find((x) => x.id === id);
    if (!r) return fail(res, 404, 'not_found', 'No open request with that number.');
    if (r.user_id === fm.user.id) return fail(res, 403, 'self', 'Someone else must decide your own request.');
    const reason = String(req.body?.reason || '').trim();
    if (!req.body?.approve) {
      await svc.decideRequest(db, id, { status: 'declined', by: fm.user.id, reason });
      await audit(req, 'access.request_declined', 'request', id, { reason });
      return res.json({ ok: true });
    }
    const role = await svc.roleByCode(db, req.body?.role);
    const exp = parseExpiry(req.body?.expires_at);
    if (exp === 'bad') return fail(res, 400, 'bad_expiry', 'An end date must be in the future.');
    if (role?.timeboxed && !exp) return fail(res, 400, 'needs_expiry', `The ${role.name} role must have an end date.`);
    const d = await grantDecision(fm, role, parseFleets(req.body?.fleets), { targetUserId: r.user_id });
    if (d.refuse) return fail(res, 403, 'refused', d.refuse);
    const g = await svc.createGrant(db, { userId: r.user_id, roleCode: role.code, fleets: parseFleets(req.body?.fleets),
      expiresAt: exp, effectiveAt: d.effectiveAt || null, status: d.status, reason: `request #${id}: ${reason || r.reason}`, by: fm.user.id });
    await svc.decideRequest(db, id, { status: 'approved', by: fm.user.id, reason, grantId: g.id });
    layer.cache.clear();
    await audit(req, 'access.request_approved', 'request', id, { grant: g.id, role: role.code, expires: exp });
    return res.json({ ok: true, grant: g, note: d.why || null });
  }));

  app.get('/api/access/audit', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    if (!fm.access.levels.AUDIT) return fail(res, 403, 'withheld', 'Not shown to your role: the audit log. The Owner, Access admins and Auditors can see it.', { class: 'AUDIT' });
    noStore(res);
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));
    const before = Number(req.query.before) || null;
    const { rows } = await db.query(
      `SELECT id, at, actor_id, actor_label, action, subject_type, subject_id, detail, ip
         FROM access_audit WHERE ($1::bigint IS NULL OR id < $1)
          AND ($2::text IS NULL OR action LIKE $2 || '%')
          AND ($3::bigint IS NULL OR actor_id = $3)
        ORDER BY id DESC LIMIT $4`,
      [before, req.query.action || null, req.query.actor ? Number(req.query.actor) : null, limit]);
    return res.json({ rows: rows.map((r) => ({ ...r, id: Number(r.id), actor_id: r.actor_id == null ? null : Number(r.actor_id) })) });
  }));
  app.get('/api/access/audit/verify', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    if (!fm.access.levels.AUDIT) return fail(res, 403, 'withheld', 'Not shown to your role.', { class: 'AUDIT' });
    noStore(res);
    return res.json(await verifyChain(db));
  }));

  app.post('/api/access/devices', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) return fail(res, 400, 'bad_name', 'Name the screen, e.g. "Office wall".');
    /* A screen's link is a session: whoever makes one can open it. A wall
       screen shows revenue in full, so an Access admin — who holds none —
       could read it through a screen they made themselves (review,
       2026-09-28). The ceiling, as for any grant: the maker must hold what
       the screen shows, over the fleets it shows. */
    const fleets = parseFleets(req.body?.fleets);
    const wall = await svc.roleByCode(db, 'WALL');
    if (!covers({ levels: fm.access.levels, caps: fm.access.caps }, wall || {})
      || (fleets || fm.access.allFleets).some((f) => !fm.access.scope.includes(f))) {
      return fail(res, 403, 'refused', 'A wall screen shows figures you do not hold yourself, so only someone who holds them can add one.');
    }
    const d = await svc.createDevice(db, { name, fleets, by: fm.user.id });
    await audit(req, 'access.device_created', 'device', d.id, { name });
    return res.json({ ok: true, id: d.id, link: `/signin#device=${d.token}` });
  }));
  app.post('/api/access/devices/:id/revoke', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true });
    if (!fm) return undefined;
    await svc.revokeDevice(db, Number(req.params.id));
    layer.cache.clear();
    await audit(req, 'access.device_revoked', 'device', Number(req.params.id), {});
    return res.json({ ok: true });
  }));

  /* The sign-in mode and the other company-wide settings: the Owner only,
     re-confirmed. Turning sign-in on is refused while no Owner could sign in
     afterwards. */
  app.post('/api/access/config', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true, stepup: true });
    if (!fm) return undefined;
    if (!isOwner(fm)) return fail(res, 403, 'not_allowed', 'Only the Owner changes these.');
    const changes = {};
    if (req.body?.mode !== undefined) {
      if (!['open', 'enforced'].includes(req.body.mode)) return fail(res, 400, 'bad_mode', 'Choose open or required.');
      changes.mode = req.body.mode;
    }
    if (req.body?.mfa !== undefined) {
      if (!['admins', 'writers', 'none'].includes(req.body.mfa)) return fail(res, 400, 'bad_mfa', 'Unknown two-step policy.');
      if (req.body.mfa !== 'none' && !fm.user.totp_enabled) {
        return fail(res, 409, 'mfa_first', 'Turn on two-step sign-in for yourself first, or you would be asked for it straight away.');
      }
      changes.mfa = req.body.mfa;
    }
    if (req.body?.cash_stepup_aed !== undefined) {
      const n = Number(req.body.cash_stepup_aed);
      if (!Number.isFinite(n) || n < 0) return fail(res, 400, 'bad_amount', 'Enter an amount in AED.');
      changes.cash_stepup_aed = n;
    }
    if (req.body?.single_owner_delay_hours !== undefined) {
      const n = Number(req.body.single_owner_delay_hours);
      if (!Number.isFinite(n) || n < 0 || n > 168) return fail(res, 400, 'bad_hours', 'Enter 0 to 168 hours.');
      changes.single_owner_delay_hours = n;
    }
    for (const [k, v] of Object.entries(changes)) await svc.setConfig(db, k, v, fm.user.id);
    await svc.getConfig(db, { fresh: true });
    layer.cache.clear();
    await audit(req, 'access.config_changed', 'config', null, changes);
    return res.json({ ok: true, config: await svc.getConfig(db, { fresh: true }) });
  }));

  /* Reviews: once a quarter each team's lead keeps or removes each grant. */
  app.get('/api/access/reviews', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    noStore(res);
    const { rows } = await db.query(
      `SELECT r.*, t.name AS team_name, t.lead_user_id FROM access_review r JOIN access_team t ON t.id = r.team_id
        ORDER BY r.opened_at DESC LIMIT 200`);
    const mine = rows.filter((r) => fm.access.caps.includes('access.manage') || Number(r.lead_user_id) === fm.user.id);
    return res.json({ reviews: mine.map((r) => ({ ...r, id: Number(r.id), team_id: Number(r.team_id) })) });
  }));
  app.post('/api/access/reviews/open', wrap(async (req, res) => {
    const fm = manager(req, res, { write: true });
    if (!fm) return undefined;
    const d = new Date();
    const period = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    const { rowCount } = await db.query(
      `INSERT INTO access_review (team_id, period, due_at)
       SELECT id, $1, now() + interval '14 days' FROM access_team WHERE archived_at IS NULL
       ON CONFLICT (team_id, period) DO NOTHING`, [period]);
    await audit(req, 'access.review_opened', 'review', period, { teams: rowCount });
    return res.json({ ok: true, period, opened: rowCount });
  }));
  app.post('/api/access/reviews/:id/attest', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT r.*, t.lead_user_id FROM access_review r JOIN access_team t ON t.id = r.team_id WHERE r.id = $1`, [id]);
    const r = rows[0];
    if (!r || r.closed_at) return fail(res, 404, 'not_found', 'No open review with that number.');
    if (Number(r.lead_user_id) !== fm.user.id && !fm.access.caps.includes('access.manage')) {
      return fail(res, 403, 'not_allowed', 'Only the team lead or an admin attests this team.');
    }
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    for (const dcs of decisions) {
      if (dcs.keep === false && dcs.userId) {
        await svc.setMember(db, Number(r.team_id), Number(dcs.userId), false, fm.user.id);
      }
    }
    await db.query(`UPDATE access_review SET closed_at = now(), attested_by = $2, decisions = $3 WHERE id = $1`,
      [id, fm.user.id, JSON.stringify(decisions)]);
    layer.cache.clear();
    await audit(req, 'access.review_attested', 'review', id, { removed: decisions.filter((x) => x.keep === false).length });
    return res.json({ ok: true });
  }));

  /* ── four-eyes proposals (api/access/middleware.js propose/takeProposal) ── */
  /* A stored proposal is the payload of a route that combines every fleet
     ('mixed'): cash rows with names, fleets and amounts; two people to merge.
     So it is judged as that route is — the action held on EVERY fleet
     (access.caps), and each class it carries in full on every fleet
     (access.levels) — never on any one fleet, which showed a one-fleet cash
     desk the other fleet's rows (security review, 2026-09-28). The preparer
     always sees their own. */
  const proposalVisible = (fm, p) => {
    const f = FOUR_EYES[p.kind];
    if (!f) return false;
    if (Number(p.prepared_by) === fm.user.id) return true;
    const caps = fm.access.caps || [];
    if (!(caps.includes(f.propose) || caps.includes(f.commit))) return false;
    return (f.commitNeeds || []).every((c) => (fm.access.levels?.[c] || '') === 'F');
  };
  app.get('/api/access/proposals', wrap(async (req, res) => {
    const fm = me(req, res);
    if (!fm) return undefined;
    noStore(res);
    const { rows } = await db.query(
      `SELECT p.id, p.kind, p.summary, p.payload, p.prepared_by, p.prepared_at, p.status, p.decided_by, p.decided_at, p.result,
              u.email AS prepared_email, u.name AS prepared_name, d.email AS decided_email
         FROM access_proposal p LEFT JOIN access_user u ON u.id = p.prepared_by LEFT JOIN access_user d ON d.id = p.decided_by
        WHERE p.status = 'open' OR p.prepared_at > now() - interval '30 days'
        ORDER BY p.prepared_at DESC LIMIT 200`);
    const out = rows.filter((p) => proposalVisible(fm, p)).map((p) => {
      const f = FOUR_EYES[p.kind];
      return { ...p, id: Number(p.id), view: f?.view || null, prepared_by: Number(p.prepared_by), decided_by: p.decided_by == null ? null : Number(p.decided_by),
        canCommit: p.status === 'open' && Number(p.prepared_by) !== fm.user.id && (fm.access.caps || []).includes(f.commit),
        mine: Number(p.prepared_by) === fm.user.id };
    });
    return res.json({ proposals: out });
  }));
  app.post('/api/access/proposals/:id/decline', wrap(async (req, res) => {
    const fm = me(req, res, { write: true });
    if (!fm) return undefined;
    if (fm.access.preview) return fail(res, 403, 'preview', 'You are previewing a role, which is read-only.');
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT * FROM access_proposal WHERE id = $1', [id]);
    const p = rows[0];
    if (!p || p.status !== 'open') return fail(res, 404, 'not_found', 'No open proposal with that number.');
    const f = FOUR_EYES[p.kind];
    const mine = Number(p.prepared_by) === fm.user.id;
    if (!mine && !(fm.access.capsAny || []).includes(f?.commit)) return fail(res, 403, 'not_allowed', 'Only the preparer or someone who may commit it can decline it.');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < MIN_REASON) return fail(res, 400, 'reason', 'Say why.');
    await db.query(`UPDATE access_proposal SET status = 'declined', decided_by = $2, decided_at = now(), result = $3 WHERE id = $1 AND status = 'open'`,
      [id, fm.user.id, JSON.stringify({ reason, withdrawn: mine })]);
    await audit(req, mine ? 'proposal.withdrawn' : 'proposal.declined', 'proposal', id, { reason });
    return res.json({ ok: true });
  }));
}

/* Suspends people who have not signed in for 60 days, and ends grants whose
   end date passed (they already confer nothing; this marks them so the
   Access page stops listing them as current). Run by the API's scheduler. */
export async function housekeeping(db, { log = { info() {} } } = {}) {
  const dormant = await db.query(
    `UPDATE access_user u SET status = 'suspended', suspended_reason = 'no sign-in for 60 days'
      WHERE status = 'active' AND COALESCE(last_login_at, created_at) < now() - interval '60 days'
        AND NOT EXISTS (SELECT 1 FROM access_grant g WHERE g.user_id = u.id AND g.role_code = 'OWN' AND g.status = 'active')
      RETURNING id`);
  const ended = await db.query(
    `UPDATE access_grant SET status = 'revoked', revoked_at = now()
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id`);
  if (dormant.rowCount || ended.rowCount) {
    svc.bumpAccess();
    await appendAudit(db, { actorLabel: 'system:housekeeping', action: 'access.housekeeping', subjectType: 'system',
      detail: { suspended: dormant.rows.map((r) => Number(r.id)), grants_ended: ended.rows.map((r) => Number(r.id)) } });
    log.info('access', 'housekeeping', { suspended: dormant.rowCount, grants_ended: ended.rowCount });
  }
}
