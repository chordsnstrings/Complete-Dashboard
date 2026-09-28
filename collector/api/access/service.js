/* The access store: people, sessions, grants, teams, links, requests, devices.
   ─────────────────────────────────────────────────────────────────────────
   Every function takes `db` first — the pool in production, a pglite handle or
   a local Postgres in the tests — and nothing here reads a request. The HTTP
   surface is api/access/routes.js; the decision is api/access/principal.js.

   CACHING. A session is looked up on every request, and its grants change
   rarely, so the resolved caller is held in memory for a short while. Any
   change to a grant, team, role, person or session bumps `accessVersion`, and
   an entry from an older version is recomputed: a revoked grant takes effect
   on the very next request, not after the cache ages out. */
import { computeAccess } from './principal.js';
import { hashPassword, verifyPassword, needsRehash, newToken, tokenHash } from './crypto.js';
import { appendAudit } from './audit.js';
import { ROLE, CLASS_CODES } from '../public/access_model.js';

export const DEFAULTS = Object.freeze({
  mode: 'open',            // 'open' = sign-in available, not yet required; 'enforced' = required
  mfa: 'admins',           // 'admins' (Owner, Access admin) | 'writers' | 'none'
  cash_stepup_aed: 10000,  // re-confirm identity above this amount on a single cash entry
  idle_minutes: 720,       // 12 h without a request ends a session
  session_days: 7,         // absolute lifetime of a session
  single_owner_delay_hours: 24, // a sensitive grant by the only Owner waits this long once sign-in is required
});

let accessVersion = 1;
export const bumpAccess = () => { accessVersion += 1; };
export const currentAccessVersion = () => accessVersion;

const num = (v) => (v == null ? null : Number(v));
export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

/* ── config ─────────────────────────────────────────────────────────── */
let cfgCache = null; let cfgAt = 0;
export async function getConfig(db, { fresh = false } = {}) {
  if (!fresh && cfgCache && Date.now() - cfgAt < 5000) return cfgCache;
  const { rows } = await db.query('SELECT key, value FROM access_config');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  /* The environment may pin the mode (tests, and a break-glass on the
     platform). It can only ever make sign-in REQUIRED, never lift it. */
  if (process.env.ACCESS_MODE === 'enforced') out.mode = 'enforced';
  cfgCache = out; cfgAt = Date.now();
  return out;
}
export async function setConfig(db, key, value, by) {
  if (!(key in DEFAULTS)) throw new Error(`unknown access setting ${key}`);
  await db.query(
    `INSERT INTO access_config (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), by ?? null]);
  cfgCache = null;
}

/* ── fleets ─────────────────────────────────────────────────────────── */
let fleetCache = null; let fleetAt = 0;
export async function allFleets(db) {
  if (fleetCache && Date.now() - fleetAt < 60_000) return fleetCache;
  const { rows } = await db.query('SELECT id, name FROM fleet ORDER BY id');
  fleetCache = rows.map((r) => ({ id: r.id, name: r.name }));
  fleetAt = Date.now();
  return fleetCache;
}
export const resetFleetCache = () => { fleetCache = null; };

/* ── people ─────────────────────────────────────────────────────────── */
const USER_COLS = `id, email, email_norm, name, status, must_change_password, totp_enabled,
  failed_logins, locked_until, password_changed_at, last_login_at, last_seen_at, prefs,
  suspended_reason, created_at, created_by, offboarded_at`;
const userOut = (r) => (r ? { ...r, id: num(r.id), created_by: num(r.created_by) } : null);

export async function getUser(db, id) {
  const { rows } = await db.query(`SELECT ${USER_COLS} FROM access_user WHERE id = $1`, [id]);
  return userOut(rows[0]);
}
export async function getUserByEmail(db, email) {
  const { rows } = await db.query(
    `SELECT ${USER_COLS}, password_hash, totp_secret, totp_last_step, recovery_codes
       FROM access_user WHERE email_norm = $1`, [normEmail(email)]);
  return rows[0] ? { ...userOut(rows[0]), password_hash: rows[0].password_hash,
    totp_secret: rows[0].totp_secret, totp_last_step: rows[0].totp_last_step,
    recovery_codes: rows[0].recovery_codes } : null;
}
export async function getUserSecrets(db, id) {
  const { rows } = await db.query(
    'SELECT id, email, status, locked_until, password_hash, totp_secret, totp_enabled, totp_last_step, recovery_codes FROM access_user WHERE id = $1', [id]);
  return rows[0] ? { ...rows[0], id: num(rows[0].id) } : null;
}
export async function listUsers(db) {
  const { rows } = await db.query(`SELECT ${USER_COLS} FROM access_user ORDER BY lower(name), email_norm`);
  return rows.map(userOut);
}
export async function createUser(db, { email, name = '', status = 'invited', passwordHash = null,
  mustChange = false, createdBy = null }) {
  const { rows } = await db.query(
    `INSERT INTO access_user (email, email_norm, name, status, password_hash, must_change_password,
       password_changed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $7)
     RETURNING ${USER_COLS}`,
    [String(email).trim(), normEmail(email), String(name || '').trim(), status, passwordHash, mustChange, createdBy]);
  bumpAccess();
  return userOut(rows[0]);
}
export async function updateUser(db, id, patch) {
  const allowed = ['name', 'status', 'must_change_password', 'suspended_reason', 'prefs', 'offboarded_at'];
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    vals.push(k === 'prefs' ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return getUser(db, id);
  vals.push(id);
  const { rows } = await db.query(
    `UPDATE access_user SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING ${USER_COLS}`, vals);
  bumpAccess();
  return userOut(rows[0]);
}
export async function setPassword(db, id, plain, { mustChange = false } = {}) {
  await db.query(
    `UPDATE access_user SET password_hash = $2, must_change_password = $3, password_changed_at = now(),
       failed_logins = 0, locked_until = NULL,
       status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
     WHERE id = $1`, [id, hashPassword(plain), mustChange]);
  bumpAccess();
}

/* Sign-in bookkeeping. Five wrong passwords lock the account for fifteen
   minutes; the lock is per account so an attacker cannot spray one password
   across every address without each of them locking in turn. */
/* Fifty, not five: the per-address, per-device throttle in routes.js stops
   one guesser after five; this closes the account only against a spread-out
   attack, so a stranger cannot lock the Owner out (security review,
   2026-09-28). */
export const LOCK_AFTER = 50;
export const LOCK_MINUTES = 15;
export async function recordFailure(db, id) {
  const { rows } = await db.query(
    `UPDATE access_user SET failed_logins = failed_logins + 1,
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
     WHERE id = $1 RETURNING failed_logins, locked_until`, [id, LOCK_AFTER, String(LOCK_MINUTES)]);
  return rows[0];
}
export async function recordSuccess(db, id, plain, storedHash) {
  await db.query(
    `UPDATE access_user SET failed_logins = 0, locked_until = NULL, last_login_at = now(), last_seen_at = now()
     WHERE id = $1`, [id]);
  if (plain && needsRehash(storedHash)) {
    await db.query('UPDATE access_user SET password_hash = $2 WHERE id = $1', [id, hashPassword(plain)]);
  }
}
export { verifyPassword };

/* ── roles ──────────────────────────────────────────────────────────── */
export async function customRoles(db) {
  const { rows } = await db.query(
    'SELECT code, name, description, based_on, levels, caps, created_at, created_by FROM access_role WHERE archived_at IS NULL ORDER BY name');
  return Object.fromEntries(rows.map((r) => [r.code, {
    code: r.code, name: r.name, desc: r.description, basedOn: r.based_on,
    levels: r.levels || {}, caps: r.caps || [], custom: true, created_by: num(r.created_by),
  }]));
}
export async function roleByCode(db, code) {
  return ROLE[code] || (await customRoles(db))[code] || null;
}
export async function createRole(db, { code, name, description = '', basedOn = null, levels, caps, by }) {
  const clean = Object.fromEntries(Object.entries(levels || {})
    .filter(([c, l]) => CLASS_CODES.includes(c) && ['F', 'M', 'A'].includes(l)));
  await db.query(
    `INSERT INTO access_role (code, name, description, based_on, levels, caps, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [code, name, description, basedOn, JSON.stringify(clean), caps || [], by ?? null]);
  bumpAccess();
}

/* ── grants ─────────────────────────────────────────────────────────── */
const grantOut = (r) => ({ ...r, id: num(r.id), user_id: num(r.user_id), team_id: num(r.team_id),
  granted_by: num(r.granted_by), approved_by: num(r.approved_by), revoked_by: num(r.revoked_by) });

/* The grants that confer anything right now: active, started, not ended —
   given to the person directly or to a team they are in. */
export async function effectiveGrants(db, userId) {
  const { rows } = await db.query(
    `SELECT g.* FROM access_grant g
      WHERE g.status = 'active' AND g.effective_at <= now()
        AND (g.expires_at IS NULL OR g.expires_at > now())
        AND (g.user_id = $1 OR g.team_id IN (
              SELECT m.team_id FROM access_team_member m JOIN access_team t ON t.id = m.team_id
               WHERE m.user_id = $1 AND t.archived_at IS NULL))`, [userId]);
  return rows.map(grantOut);
}
export async function listGrants(db, { userId = null, teamId = null, statuses = ['active', 'pending'] } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM access_grant
      WHERE status = ANY($3::text[])
        AND ($1::bigint IS NULL OR user_id = $1) AND ($2::bigint IS NULL OR team_id = $2)
      ORDER BY created_at DESC`, [userId, teamId, statuses]);
  return rows.map(grantOut);
}
export async function getGrant(db, id) {
  const { rows } = await db.query('SELECT * FROM access_grant WHERE id = $1', [id]);
  return rows[0] ? grantOut(rows[0]) : null;
}
export async function createGrant(db, { userId = null, teamId = null, roleCode, fleets = null,
  expiresAt = null, effectiveAt = null, status = 'active', reason = '', by = null }) {
  const { rows } = await db.query(
    `INSERT INTO access_grant (user_id, team_id, role_code, fleets, expires_at, effective_at, status, reason, granted_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $8, $9) RETURNING *`,
    [userId, teamId, roleCode, fleets && fleets.length ? fleets : null, expiresAt, effectiveAt, status, reason, by]);
  bumpAccess();
  return grantOut(rows[0]);
}
export async function approveGrant(db, id, by) {
  const { rows } = await db.query(
    `UPDATE access_grant SET status = 'active', approved_by = $2, approved_at = now(),
       effective_at = GREATEST(effective_at, now())
     WHERE id = $1 AND status = 'pending' RETURNING *`, [id, by]);
  bumpAccess();
  return rows[0] ? grantOut(rows[0]) : null;
}
export async function endGrant(db, id, by, status = 'revoked') {
  const { rows } = await db.query(
    `UPDATE access_grant SET status = $3, revoked_by = $2, revoked_at = now()
     WHERE id = $1 AND status IN ('active', 'pending') RETURNING *`, [id, by, status]);
  bumpAccess();
  return rows[0] ? grantOut(rows[0]) : null;
}
/* Owners who hold the role directly and are active — the people a sensitive
   grant must be approved by. */
export async function activeOwners(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.id, u.email, u.name FROM access_user u
       JOIN access_grant g ON g.user_id = u.id
      WHERE g.role_code = 'OWN' AND g.status = 'active' AND g.effective_at <= now()
        AND (g.expires_at IS NULL OR g.expires_at > now()) AND u.status = 'active'`);
  return rows.map((r) => ({ ...r, id: num(r.id) }));
}

/* ── teams ──────────────────────────────────────────────────────────── */
export async function listTeams(db) {
  const { rows } = await db.query(
    `SELECT t.*, COALESCE(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
       FROM access_team t LEFT JOIN access_team_member m ON m.team_id = t.id
      WHERE t.archived_at IS NULL GROUP BY t.id ORDER BY lower(t.name)`);
  return rows.map((r) => ({ ...r, id: num(r.id), lead_user_id: num(r.lead_user_id),
    members: (r.members || []).map(Number) }));
}
export async function createTeam(db, { name, description = '', leadUserId = null, by = null }) {
  const { rows } = await db.query(
    `INSERT INTO access_team (name, name_norm, description, lead_user_id, created_by)
     VALUES ($1, lower(trim($1)), $2, $3, $4) RETURNING *`, [String(name).trim(), description, leadUserId, by]);
  bumpAccess();
  return { ...rows[0], id: num(rows[0].id) };
}
export async function updateTeam(db, id, { name, description, leadUserId, archived }) {
  await db.query(
    `UPDATE access_team SET
       name = COALESCE($2, name), name_norm = COALESCE(lower(trim($2)), name_norm),
       description = COALESCE($3, description),
       lead_user_id = CASE WHEN $4::boolean THEN $5 ELSE lead_user_id END,
       archived_at = CASE WHEN $6::boolean THEN now() ELSE archived_at END
     WHERE id = $1`,
    [id, name ?? null, description ?? null, leadUserId !== undefined, leadUserId ?? null, Boolean(archived)]);
  bumpAccess();
}
export async function setMember(db, teamId, userId, on, by = null) {
  if (on) {
    await db.query(
      `INSERT INTO access_team_member (team_id, user_id, added_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`, [teamId, userId, by]);
  } else {
    await db.query('DELETE FROM access_team_member WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  }
  bumpAccess();
}
export async function teamsOf(db, userId) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.lead_user_id FROM access_team t JOIN access_team_member m ON m.team_id = t.id
      WHERE m.user_id = $1 AND t.archived_at IS NULL ORDER BY t.name`, [userId]);
  return rows.map((r) => ({ id: num(r.id), name: r.name, lead: num(r.lead_user_id) === Number(userId) }));
}

/* ── sessions ───────────────────────────────────────────────────────── */
export async function createSession(db, { userId = null, deviceId = null, kind = 'browser', ip = null, ua = null,
  mfaOk = false, cfg }) {
  const token = newToken();
  const days = Number(cfg?.session_days || DEFAULTS.session_days);
  const idle = Number(cfg?.idle_minutes || DEFAULTS.idle_minutes);
  await db.query(
    `INSERT INTO access_session (id, user_id, device_id, kind, expires_at, idle_minutes, ip, ua, mfa_ok)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval, $6, $7, $8, $9)`,
    [tokenHash(token), userId, deviceId, kind, String(days), idle, ip, ua ? String(ua).slice(0, 300) : null, mfaOk]);
  return { token, maxAgeSeconds: days * 86400 };
}
/* The live session for a token, or null. Expired by its absolute end, by
   idleness, or by revocation — each is simply "not signed in". */
export async function sessionForToken(db, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT s.*, (s.last_seen_at + (s.idle_minutes || ' minutes')::interval) AS idle_until
       FROM access_session s WHERE s.id = $1`, [tokenHash(token)]);
  const s = rows[0];
  if (!s || s.revoked_at) return null;
  const now = Date.now();
  if (new Date(s.expires_at).getTime() <= now) return null;
  if (s.kind === 'browser' && new Date(s.idle_until).getTime() <= now) return null;
  return { ...s, user_id: num(s.user_id), device_id: num(s.device_id) };
}
export async function touchSession(db, id) {
  await db.query(
    `UPDATE access_session SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [id]);
}
export async function patchSession(db, id, { stepup = false, mfaOk = null, viewAs } = {}) {
  await db.query(
    `UPDATE access_session SET
       stepup_at = CASE WHEN $2::boolean THEN now() ELSE stepup_at END,
       mfa_ok = COALESCE($3, mfa_ok),
       view_as = CASE WHEN $4::boolean THEN $5 ELSE view_as END
     WHERE id = $1`, [id, stepup, mfaOk, viewAs !== undefined, viewAs ?? null]);
  bumpAccess();
}
export async function revokeSession(db, id, reason = 'signed out') {
  await db.query(
    `UPDATE access_session SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, reason]);
  bumpAccess();
}
export async function revokeUserSessions(db, userId, reason, { except = null } = {}) {
  const { rowCount } = await db.query(
    `UPDATE access_session SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3)`, [userId, reason, except]);
  bumpAccess();
  return rowCount;
}
export async function listSessions(db, userId) {
  const { rows } = await db.query(
    `SELECT id, kind, created_at, last_seen_at, expires_at, ip, ua, view_as FROM access_session
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [userId]);
  /* The id is the token's hash; the first eight characters are enough to
     name one to revoke and reveal nothing usable. */
  return rows.map((r) => ({ ...r, id: r.id.slice(0, 12) }));
}

/* ── one-time links (invite, reset) ─────────────────────────────────── */
export async function createLink(db, userId, purpose, by, hours) {
  const token = newToken();
  await db.query(
    `UPDATE access_link SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await db.query(
    `INSERT INTO access_link (token_hash, user_id, purpose, expires_at, created_by)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
    [tokenHash(token), userId, purpose, String(hours), by]);
  return token;
}
export async function linkForToken(db, token) {
  const { rows } = await db.query(
    `SELECT l.*, u.email, u.name, u.status FROM access_link l JOIN access_user u ON u.id = l.user_id
      WHERE l.token_hash = $1`, [tokenHash(token)]);
  const l = rows[0];
  if (!l || l.used_at || new Date(l.expires_at).getTime() <= Date.now()) return null;
  if (l.status === 'offboarded' || l.status === 'suspended') return null;
  return { ...l, user_id: num(l.user_id) };
}
export async function useLink(db, tokenHashValue) {
  const { rowCount } = await db.query(
    'UPDATE access_link SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL', [tokenHashValue]);
  return rowCount === 1;
}

/* ── access requests ────────────────────────────────────────────────── */
export async function createRequest(db, { userId, view = '', classCode = null, roleCode = null, reason = '' }) {
  const { rows } = await db.query(
    `INSERT INTO access_request (user_id, view, class_code, role_code, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, String(view).slice(0, 120), classCode, roleCode, String(reason).slice(0, 600)]);
  return { ...rows[0], id: num(rows[0].id), user_id: num(rows[0].user_id) };
}
export async function listRequests(db, { status = null, userId = null } = {}) {
  const { rows } = await db.query(
    `SELECT r.*, u.email, u.name FROM access_request r JOIN access_user u ON u.id = r.user_id
      WHERE ($1::text IS NULL OR r.status = $1) AND ($2::bigint IS NULL OR r.user_id = $2)
      ORDER BY r.created_at DESC LIMIT 300`, [status, userId]);
  return rows.map((r) => ({ ...r, id: num(r.id), user_id: num(r.user_id), decided_by: num(r.decided_by) }));
}
export async function decideRequest(db, id, { status, by, reason = '', grantId = null }) {
  const { rows } = await db.query(
    `UPDATE access_request SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, grant_id = $5
      WHERE id = $1 AND status = 'open' RETURNING *`, [id, status, by, reason, grantId]);
  return rows[0] ? { ...rows[0], id: num(rows[0].id), user_id: num(rows[0].user_id) } : null;
}

/* ── devices (wall display) ─────────────────────────────────────────── */
export async function createDevice(db, { name, roleCode = 'WALL', fleets = null, by }) {
  const token = newToken();
  const { rows } = await db.query(
    `INSERT INTO access_device (name, role_code, fleets, token_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, roleCode, fleets && fleets.length ? fleets : null, tokenHash(token), by]);
  bumpAccess();
  return { id: num(rows[0].id), token };
}
export async function deviceForToken(db, token) {
  const { rows } = await db.query(
    'SELECT * FROM access_device WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash(token)]);
  return rows[0] ? { ...rows[0], id: num(rows[0].id) } : null;
}
export async function listDevices(db) {
  const { rows } = await db.query(
    'SELECT id, name, role_code, fleets, created_at, created_by, last_seen_at, revoked_at FROM access_device ORDER BY created_at DESC');
  return rows.map((r) => ({ ...r, id: num(r.id), created_by: num(r.created_by) }));
}
export async function revokeDevice(db, id) {
  await db.query('UPDATE access_device SET revoked_at = now() WHERE id = $1', [id]);
  await db.query(`UPDATE access_session SET revoked_at = now(), revoked_reason = 'device revoked' WHERE device_id = $1`, [id]);
  bumpAccess();
}

/* ── the caller ─────────────────────────────────────────────────────── */
export async function accessForUser(db, userId, { viewAs = null } = {}) {
  const [grants, roles, fleets] = await Promise.all([effectiveGrants(db, userId), customRoles(db), allFleets(db)]);
  return { grants, access: computeAccess({ grants, roles, allFleets: fleets.map((f) => f.id), viewAs }) };
}

/* ── the first Owner ────────────────────────────────────────────────── */
/* BOOTSTRAP_OWNER_EMAIL + BOOTSTRAP_OWNER_PASSWORD_HASH, set on the platform,
   create the first Owner the first time the API boots with no active Owner.
   Only the password's scrypt hash is in the environment, never the password.
   The account must choose its own password at first sign-in. Once any Owner
   exists these variables do nothing at all — they cannot be used later to
   take an account over. */
export async function bootstrapOwner(db, { email = process.env.BOOTSTRAP_OWNER_EMAIL,
  hash = process.env.BOOTSTRAP_OWNER_PASSWORD_HASH, log = () => {} } = {}) {
  if (!email || !hash) return { done: false, why: 'not configured' };
  if (!validEmail(email) || !String(hash).startsWith('scrypt$')) return { done: false, why: 'malformed' };
  const owners = await activeOwners(db);
  if (owners.length) return { done: false, why: 'an Owner already exists' };
  let user = await getUserByEmail(db, email);
  if (!user) {
    user = await createUser(db, { email, name: '', status: 'active', passwordHash: hash, mustChange: true });
  } else {
    await db.query(
      `UPDATE access_user SET password_hash = $2, must_change_password = true, status = 'active',
         failed_logins = 0, locked_until = NULL, password_changed_at = now() WHERE id = $1`, [user.id, hash]);
  }
  await createGrant(db, { userId: user.id, roleCode: 'OWN', reason: 'first Owner, created at handover', by: null });
  await appendAudit(db, { actorLabel: 'system:bootstrap', action: 'access.bootstrap_owner',
    subjectType: 'user', subjectId: user.id, detail: { email: normEmail(email) } });
  log(`bootstrapped the first Owner (${normEmail(email)})`);
  return { done: true, userId: user.id };
}
