/* Who is calling, and may they have this answer?
   ─────────────────────────────────────────────────────────────────────────
   Two middlewares, mounted in api/server.js BEFORE the response cache:

     identify  cookie session, device token, the internal warmer, or nobody.
     gate      finds the route's manifest entry, decides, rewrites the fleet
               filter to the caller's scope, installs the shaper on the way
               out, checks CSRF and step-up on actions, and audits actions.

   BEFORE THE CACHE, deliberately. The cache answers a hit without reaching the
   route; a guard mounted at the route would never run for a cached answer.

   SIGN-IN MODES (access_config.mode):
     open      sign-in exists and signed-in people see their role's view; a
               visitor who has not signed in still sees what everybody saw
               before — so switching this on does not lock out the people
               using the product until the Owner has made their accounts.
     enforced  nothing under /api answers without a session except the
               sign-in routes and the health check.
   The Owner flips it in Set up → Access. */
import { fullAccess, fingerprintOf, computeAccess } from './principal.js';
import { shapeBody, needsShaping } from './shape.js';
import { lookupEntry } from './manifest.js';
import { appendAudit } from './audit.js';
import * as svc from './service.js';
import { INTERNAL_TOKEN } from './internal.js';
import { safeEqual, newToken } from './crypto.js';
import { rank, withheldSentence, CLASS, ROLE } from '../public/access_model.js';

export const SID = 'fm_sid';
export const CSRF = 'fm_csrf';
export const DEV = 'fm_dev';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}
const secureReq = (req) => req.secure || String(req.get('x-forwarded-proto') || '').startsWith('https');
export function setCookie(res, req, name, value, { maxAge = null, httpOnly = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secureReq(req)) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}
export function clearCookies(res, req) {
  setCookie(res, req, SID, '', { maxAge: 0 });
  setCookie(res, req, CSRF, '', { maxAge: 0, httpOnly: false, sameSite: 'Strict' });
}
export function issueCsrf(res, req) {
  const t = newToken(18);
  setCookie(res, req, CSRF, t, { httpOnly: false, sameSite: 'Strict', maxAge: 7 * 86400 });
  return t;
}

const loopback = (req) => {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};
const ip = (req) => req.ip || null;

/* Actions that must be re-confirmed within ten minutes (§5.1). */
export const STEPUP_CAPS = new Set(['credentials.write', 'hr.import', 'access.manage', 'identity.merge', 'cash.import.commit']);
export const STEPUP_MINUTES = 10;
/* Classes whose answers must never be stored by a browser or a proxy (§9.2). */
export const NO_STORE = new Set(['CT', 'DOC', 'CASH', 'HR', 'MRG', 'PAX', 'AUDIT', 'RAW', 'CRED']);

export function accessLayer({ db, log = { info() {}, warn() {}, error() {} }, lookup = lookupEntry }) {
  /* Resolved callers, per session, for a short while — recomputed at once
     when any grant, team, role, person or session changes. */
  const cache = new Map();
  const TTL = 30_000;

  async function resolveSession(token) {
    const key = `s:${token}`;
    const hit = cache.get(key);
    if (hit && hit.version === svc.currentAccessVersion() && Date.now() - hit.at < TTL) return hit.value;
    const s = await svc.sessionForToken(db, token);
    let value = null;
    if (s && s.kind === 'browser' && s.user_id) {
      const user = await svc.getUser(db, s.user_id);
      if (user && user.status === 'active') {
        let viewAs = s.view_as || null;
        const { grants, access: own } = await svc.accessForUser(db, user.id);
        /* Only an Owner may preview, and only a built-in role. */
        if (viewAs && !(own.caps.includes('access.manage') && grants.some((g) => g.role_code === 'OWN') && ROLE[viewAs])) viewAs = null;
        const access = viewAs ? (await svc.accessForUser(db, user.id, { viewAs })).access : own;
        value = { kind: 'user', session: s, user, grants, access, owner: grants.some((g) => g.role_code === 'OWN') };
      }
    } else if (s && s.kind === 'device' && s.device_id) {
      value = await resolveDeviceById(s.device_id, s);
    }
    cache.set(key, { value, version: svc.currentAccessVersion(), at: Date.now() });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value;
  }
  async function resolveDeviceById(id, session = null) {
    const { rows } = await db.query('SELECT * FROM access_device WHERE id = $1 AND revoked_at IS NULL', [id]);
    const d = rows[0];
    if (!d) return null;
    const fleets = (await svc.allFleets(db)).map((f) => f.id);
    const access = computeAccess({ grants: [{ role_code: d.role_code, fleets: d.fleets }], allFleets: fleets });
    return { kind: 'device', session, device: { id: Number(d.id), name: d.name, role: d.role_code }, access };
  }

  async function identify(req, res, next) {
    /* Only the API needs to know who is asking. Pages, scripts and styles are
       the same for everybody and carry no data; the page asks /api/auth/me. */
    if (!req.path.startsWith('/api/')) return next();
    try {
      const cfg = await svc.getConfig(db);
      const base = { mode: cfg.mode, cfg };
      if (INTERNAL_TOKEN && loopback(req) && safeEqual(req.get('x-fm-internal') || '', INTERNAL_TOKEN)) {
        req.fm = { ...base, kind: 'system', access: fullAccess((await svc.allFleets(db)).map((f) => f.id)) };
        return next();
      }
      const cookies = parseCookies(req.headers.cookie);
      req.fmCookies = cookies;
      const token = cookies[SID];
      if (token) {
        const who = await resolveSession(token);
        if (who) {
          req.fm = { ...base, ...who };
          const s = who.session;
          if (s) {
            const needMfa = who.kind === 'user' && mfaRequired(cfg, who) && !who.user.totp_enabled;
            req.fm.restricted = who.kind === 'user' && who.user.must_change_password ? 'password'
              : needMfa ? 'mfa' : (who.kind === 'user' && who.user.totp_enabled && !s.mfa_ok ? 'mfa' : null);
            svc.touchSession(db, s.id).catch(() => {});
          }
          return next();
        }
        /* A cookie for a session that has ended: drop it, so the page stops
           presenting it and the reader is simply signed out. */
        clearCookies(res, req);
      }
      const devTok = cookies[DEV] || (String(req.get('authorization') || '').startsWith('Bearer fmd_')
        ? String(req.get('authorization')).slice('Bearer fmd_'.length) : null);
      if (devTok) {
        const d = await svc.deviceForToken(db, devTok);
        if (d) {
          const who = await resolveDeviceById(d.id);
          if (who) {
            db.query('UPDATE access_device SET last_seen_at = now() WHERE id = $1', [d.id]).catch(() => {});
            req.fm = { ...base, ...who };
            return next();
          }
        }
      }
      req.fm = { ...base, kind: 'anonymous' };
      return next();
    } catch (e) {
      /* Fail closed: a caller we could not identify is treated as nobody,
         which under 'enforced' means refused, and under 'open' means exactly
         what an anonymous visitor always saw. The error is logged, not shown. */
      log.error('access', 'identify failed', { err: String(e).slice(0, 200) });
      req.fm = { mode: 'enforced', kind: 'anonymous', broken: true };
      return next();
    }
  }

  function mfaRequired(cfg, who) {
    if (cfg.mfa === 'none') return false;
    const roles = (who.grants || []).map((g) => g.role_code);
    if (cfg.mfa === 'admins') return roles.includes('OWN') || roles.includes('ACC');
    if (cfg.mfa === 'writers') return (who.access?.capsAny || []).length > 0;
    return false;
  }

  const refuse = (res, status, body) => {
    res.set('Cache-Control', 'no-store');
    if (body.class) res.set('x-fm-withheld', body.class);
    return res.status(status).json(body);
  };
  const withheldBody = (cls, level, extra = {}) => ({
    error: 'withheld', class: cls, level: level || '',
    detail: cls && CLASS[cls] ? withheldSentence(cls, { level }) : (extra.detail || 'Not shown to your role.'),
    ...extra,
  });

  /* The fleets this request is about, and the levels that follow. */
  function judge(req, entry, access) {
    const all = access.allFleets;
    const scope = access.scope;
    let targets = all;
    let rewrite = null;
    let filterRows = null;
    if (entry.fleet === 'param') {
      const asked = String(req.query.fleet || '');
      if (asked) {
        if (!all.includes(asked)) return { refuse: withheldBody(null, '', { error: 'bad_fleet', detail: `There is no fleet called ${asked}.` }) };
        if (!scope.includes(asked)) return { refuse: withheldBody(null, '', { error: 'fleet_scope', detail: 'That fleet is outside your access.' }) };
        targets = [asked];
      } else if (!access.allScope) {
        if (scope.length === 1) { targets = [scope[0]]; rewrite = scope[0]; }
        else return { refuse: withheldBody(null, '', { error: 'fleet_scope', detail: 'Choose one of your fleets: this page cannot combine only some of them.' }) };
      }
    } else if (entry.fleet === 'rows') {
      targets = scope.length ? scope : all;
      if (!access.allScope) filterRows = scope;
    } else if (entry.fleet === 'global') {
      targets = scope.length ? scope : all;
    }
    const combine = entry.fleet === 'global' ? 'max' : 'min';
    const levels = access.levelsOver(targets, combine === 'max'
      ? (a, b) => (rank(a) >= rank(b) ? a : b) : (a, b) => (rank(a) <= rank(b) ? a : b));
    return { targets, rewrite, filterRows, levels };
  }

  async function gate(req, res, next) {
    const fm = req.fm || { kind: 'anonymous', mode: 'enforced' };
    const path = req.path;
    if (!path.startsWith('/api/')) return next();
    if (path === '/api/health') return next();
    const entry = lookup(req.method, path);
    if (entry?.self) return next();                 // /api/auth/*, /api/access/*: the handler decides
    if (fm.kind === 'system') return next();

    if (fm.kind === 'anonymous') {
      if (fm.mode === 'open' && !fm.broken) {
        if (!entry) log.warn('access', 'undeclared route served in open mode', { m: req.method, path });
        return next();                              // exactly what anonymous visitors always saw
      }
      if (entry?.public) return next();
      return refuse(res, 401, { error: 'signin', detail: 'Sign in to see this.' });
    }
    if (fm.restricted) {
      return refuse(res, 403, { error: 'restricted', need: fm.restricted,
        detail: fm.restricted === 'password' ? 'Choose a new password before continuing.'
          : 'Set up two-step sign-in before continuing.' });
    }
    if (!entry) {
      log.warn('access', 'undeclared route refused', { m: req.method, path });
      return refuse(res, 403, { error: 'undeclared', detail: 'This address is not open to signed-in roles yet.' });
    }
    if (entry.public) return next();

    const access = fm.access;
    const j = judge(req, entry, access);
    if (j.refuse) return refuse(res, 403, j.refuse);
    const L = j.levels;
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

    /* The subject: what the route is about. */
    const sl = L[entry.subject] || '';
    if (!sl) return refuse(res, 403, withheldBody(entry.subject, ''));
    if (sl === 'A' && (entry.grain === 'record' || entry.grain === 'list')) {
      return refuse(res, 403, withheldBody(entry.subject, 'A'));
    }
    /* Classes that cannot be separated from this answer. */
    for (const c of entry.whole || []) {
      const l = L[c] || '';
      if (!l || (l === 'A' && entry.grain !== 'aggregate')) return refuse(res, 403, withheldBody(c, l));
    }
    /* Actions. */
    if (entry.cap || isWrite) {
      if (access.preview) return refuse(res, 403, { error: 'preview', detail: 'You are previewing a role, which is read-only.' });
      const cap = entry.cap;
      if (!cap) return refuse(res, 403, { error: 'no_action', detail: 'This change is not open to signed-in roles yet.' });
      if (!access.capsOver(j.targets).includes(cap)) {
        return refuse(res, 403, { error: 'not_allowed', cap, detail: `Your role cannot do this: ${cap}.` });
      }
      if (fm.kind === 'user') {
        /* CSRF: a change must carry the token from the cookie in a header — a
           page on another site can make the browser send the cookie, but
           cannot read it to copy it into the header. */
        const want = req.fmCookies?.[CSRF];
        if (!want || !safeEqual(req.get('x-fm-csrf') || '', want)) {
          return refuse(res, 403, { error: 'csrf', detail: 'Reload the page and try again.' });
        }
        if (STEPUP_CAPS.has(cap) || entry.stepup) {
          const at = fm.session?.stepup_at ? new Date(fm.session.stepup_at).getTime() : 0;
          if (Date.now() - at > STEPUP_MINUTES * 60_000) {
            return refuse(res, 403, { error: 'stepup', detail: 'Confirm it is you to continue.' });
          }
        }
      }
    }

    /* The fleet filter, narrowed to the caller's scope. The cache key follows
       the rewritten filter, never the address typed. */
    if (j.rewrite) {
      req.query.fleet = j.rewrite;
      /* The key is the address WITH the fleet written in, so the cache's own
         background refresh — which fetches the key as a URL — recomputes
         exactly this answer. */
      const u = new URL(req.originalUrl, 'http://local');
      u.searchParams.set('fleet', j.rewrite);
      req.fmCacheKey = `${u.pathname}${u.search}`;
    }
    req.fm.levels = L;
    req.fm.entry = entry;
    req.fm.targets = j.targets;

    const fp = fingerprintOf(access);
    res.set('x-fm-scope', fp);
    if ((entry.carries || []).some((c) => NO_STORE.has(c))) res.set('Cache-Control', 'no-store, private');

    installShaper(req, res, entry, L, j.filterRows);
    if (isWrite || entry.cap || entry.auditRead) auditOnFinish(req, res, entry, fm, isWrite);
    return next();
  }

  function installShaper(req, res, entry, L, filterRows) {
    if (!needsShaping(entry, L, { fleets: filterRows })) return;
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const shapeAndSend = (obj) => {
      const { body, withheld } = shapeBody(obj, entry, L, { fleets: filterRows });
      const keys = Object.keys(withheld);
      if (keys.length) res.set('x-fm-withheld', keys.join(','));
      res.fmShaped = true;
      return origJson(body);
    };
    res.json = (obj) => {
      if (res.fmShaped || res.statusCode >= 400) return origJson(obj);
      /* Shape a copy: the response cache may hold this very object. */
      let copy;
      try { copy = JSON.parse(JSON.stringify(obj)); } catch { return origJson(obj); }
      return shapeAndSend(copy);
    };
    res.send = (b) => {
      if (res.fmShaped || res.statusCode >= 400 || typeof b !== 'string') return origSend(b);
      const type = String(res.get('content-type') || '');
      if (!type.includes('json')) return origSend(b);
      let obj;
      try { obj = JSON.parse(b); } catch { return origSend(b); }
      return shapeAndSend(obj);
    };
  }

  function auditOnFinish(req, res, entry, fm, isWrite) {
    const started = Date.now();
    res.on('finish', () => {
      if (!isWrite && res.statusCode >= 400) return;
      const actor = fm.kind === 'user' ? fm.user : null;
      appendAudit(db, {
        actorId: actor?.id ?? null,
        actorLabel: actor ? actor.email : fm.kind === 'device' ? `device:${fm.device?.name}` : fm.kind,
        action: isWrite || entry.cap ? `act:${entry.cap || req.method}` : `read:${req.path}`,
        subjectType: 'route',
        subjectId: `${req.method} ${req.path}`,
        detail: { status: res.statusCode, ms: Date.now() - started,
          query: Object.keys(req.query || {}), preview: fm.access?.preview || null,
          fleets: fm.targets || null },
        ip: ip(req), ua: req.get('user-agent'),
      }).catch((e) => log.error('access', 'audit append failed', { err: String(e).slice(0, 200) }));
    });
  }

  /* For routes that decide what to include themselves (the document columns
     on the driver page, the settings values, export addresses): the level
     this caller holds for `cls` on this request. Anonymous callers are
     answered by the legacy admin-token rule in api/admin_gate.js instead. */
  const levelOf = (req, cls) => {
    const fm = req.fm;
    if (!fm || fm.kind === 'anonymous') return null;
    if (fm.kind === 'system') return 'F';
    return fm.levels?.[cls] ?? fm.access?.levels?.[cls] ?? '';
  };

  return { identify, gate, levelOf, resolveSession, mfaRequired, cache };
}
