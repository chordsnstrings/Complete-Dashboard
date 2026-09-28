/* The audit log: append-only and hash-chained (ULM-DESIGN §12).
   ─────────────────────────────────────────────────────────────────────────
   Each row's hash covers its own content and the previous row's hash, so a row
   deleted or edited afterwards breaks the chain from that point on and
   verifyChain says where. Appends are serialised with a transaction-scoped
   advisory lock: two concurrent writers reading the same "last hash" would
   fork the chain, and a forked chain proves nothing.

   Values that must not be copied here are not: `detail` is scrubbed of keys
   carrying documents, contact details, credentials and raw payloads before it
   is stored (§12.1) — the log records THAT a value changed, and a keyed hash
   of it, never the value. */
import crypto from 'node:crypto';

const LOCK = 7_345_119;   // arbitrary, fixed: the audit chain's advisory lock
const SECRET_KEYS = /(password|secret|token|cookie|api_?key|refresh|emirates|licen[cs]e_no|passport|visa_no|rta_permit|phone|email|raw|totp|recovery)/i;

const keyed = (v) => crypto.createHmac('sha256',
  `fleetmirror-audit|${process.env.ACCESS_KEY || process.env.SETTINGS_KEY || 'fleet-dev-key'}`)
  .update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

export function scrub(detail, depth = 0) {
  if (detail == null || typeof detail !== 'object') return detail;
  if (depth > 5) return '[deep]';
  if (Array.isArray(detail)) return detail.slice(0, 50).map((x) => scrub(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEYS.test(k) && v != null && v !== '') out[k] = { hashed: keyed(v) };
    else out[k] = scrub(v, depth + 1);
  }
  return out;
}

/* Keys sorted at every depth: jsonb stores an object's keys in its own order,
   so the detail read back is not the detail written, key for key, and a hash
   over JSON.stringify of each would never agree. */
const canon = (v) => (v == null || typeof v !== 'object' ? JSON.stringify(v ?? null)
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`);
const hashRow = (prev, row) => crypto.createHash('sha256')
  .update(canon([prev || '', row.at, row.actor_id == null ? null : String(row.actor_id), row.actor_label,
    row.action, row.subject_type ?? null, row.subject_id ?? null, row.detail, row.ip ?? null]))
  .digest('hex');

/* db: a pg Pool (or anything with connect()) or a client already inside a
   transaction ({ query } with inTx: true). */
export async function appendAudit(db, entry) {
  const row = {
    at: new Date().toISOString(),
    actor_id: entry.actorId == null ? null : String(entry.actorId),
    actor_label: String(entry.actorLabel || ''),
    action: String(entry.action),
    subject_type: entry.subjectType ?? null,
    subject_id: entry.subjectId == null ? null : String(entry.subjectId),
    /* Through JSON first, so the hash covers exactly what jsonb stores. A
       detail value of `undefined` (a request with no role: `role: role?.code`)
       was hashed as "role":null while jsonb dropped the key, and verifyChain
       then reported a break at an entry nobody had touched — found by the
       Access pages' test on 2026-09-28, entry #13. */
    detail: JSON.parse(JSON.stringify(scrub(entry.detail || {}))),
    ip: entry.ip ?? null,
    ua: entry.ua ? String(entry.ua).slice(0, 200) : null,
  };
  const run = async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    const last = (await client.query('SELECT hash FROM access_audit ORDER BY id DESC LIMIT 1')).rows[0];
    const hash = hashRow(last?.hash, row);
    await client.query(
      `INSERT INTO access_audit (at, actor_id, actor_label, action, subject_type, subject_id, detail, ip, ua, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.at, row.actor_id, row.actor_label, row.action, row.subject_type, row.subject_id,
        JSON.stringify(row.detail), row.ip, row.ua, last?.hash || null, hash]);
    return hash;
  };
  if (typeof db.connect === 'function') {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const h = await run(client);
      await client.query('COMMIT');
      return h;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }
  return run(db);
}

/* Walks the chain in order. Returns { ok, rows, brokenAt } — the id of the
   first row whose hash does not follow from its predecessor. */
export async function verifyChain(db) {
  const { rows } = await db.query(
    `SELECT id, at, actor_id, actor_label, action, subject_type, subject_id, detail, ip, prev_hash, hash
       FROM access_audit ORDER BY id`);
  let prev = null;
  for (const r of rows) {
    const row = { ...r, at: new Date(r.at).toISOString() };
    if ((r.prev_hash || null) !== (prev || null) || hashRow(prev, row) !== r.hash) {
      return { ok: false, rows: rows.length, brokenAt: Number(r.id) };
    }
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, brokenAt: null };
}
