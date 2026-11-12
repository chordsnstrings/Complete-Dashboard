/* THE RESTORE DRILL — the checks bin/restore-drill.mjs runs against a restored
   database. docs/BACKUP-RESTORE.md is the procedure; this is how an operator
   knows the procedure worked before pointing the app at it.
   ═════════════════════════════════════════════════════════════════════════════
   A backup nobody has restored is a hope, not a backup. The repository had no
   backup or restore note anywhere until 2026-11-12 (the system audit), and the
   one thing a restore can get silently wrong here is not the data: it is the
   key. src/settings.js:11-13 derives the AES-256-GCM key every stored secret
   is sealed with from SETTINGS_KEY, falling back to DATABASE_URL. A restore
   lands in a NEW cluster with a NEW DATABASE_URL — so a deployment without
   SETTINGS_KEY would come up with every Uber cookie, Bolt token, FMS password
   and API key in app_setting unreadable (dec() returns null, the collectors
   see "not configured"), and nothing would say why. Production does set
   SETTINGS_KEY (measured 2026-11-12, both components), which is exactly why
   it must be carried over unchanged.

   THREE CHECKS, each answering pass / warn / fail / not_measured — never a
   pass it cannot prove:
     ledger   every schema file this checkout registers (src/schema_files.js)
              has a row in schema_applied with the SHA-256 of the file as it
              is now. A file missing BEFORE the last applied one is a hole and
              fails; missing files at the end are migrations the first boot
              will apply (fail, or warn with allowPending); a changed SHA
              will re-run once at the next boot (src/db.js runMigrations) and
              warns — schema_v53.sql does this by design whenever the merge
              register is regenerated.
     counts   row counts of the tables the operator names match what they
              recorded when the backup was taken (exact, or "at least").
              Nothing named is not_measured, not a pass.
     secret   the stored secrets in app_setting decrypt with the key THIS
              environment derives — exactly as src/settings.js derives it —
              without a value, a length or a prefix ever leaving this module.
              Which input the key came from is reported, and a key derived
              from DATABASE_URL is warned about even when it works.

   READ ONLY by construction: bin/restore-drill.mjs opens the session READ
   ONLY, and nothing here writes. Table names in expectations are checked
   against an identifier pattern AND to_regclass before they reach SQL. */
import crypto, { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCHEMA_FILES } from './schema_files.js';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/* The tables `--counts` prints, to be recorded when a backup is taken and
   handed back as expectations after a restore. Whole-table counts only. */
export const MAJOR_TABLES = Object.freeze(['trip', 'alert', 'telemetry_snapshot', 'driver_timeline_event',
  'driver_payout_day', 'driver_statement_day', 'ledger_entry', 'occupancy_segment', 'driver',
  'driver_platform_id', 'vehicle', 'app_setting', 'access_user', 'collection_run', 'schema_applied']);

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows || []);
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/* ── the key, exactly as src/settings.js:11-13 makes it ─────────────────── */
export function keyFrom(env = process.env) {
  const source = env.SETTINGS_KEY ? 'SETTINGS_KEY' : env.DATABASE_URL ? 'DATABASE_URL' : 'built-in development key';
  const key = createHash('sha256').update(env.SETTINGS_KEY || env.DATABASE_URL || 'fleet-dev-key').digest();
  return { source, key };
}
/* src/settings.js dec(), byte for byte: v1:<iv>:<tag>:<data>, base64. A
   wrong key fails the GCM tag and answers null — it never yields garbage. */
export function decryptWith(key, blob) {
  try {
    const [v, iv, tag, data] = String(blob).split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

/* ── expectations ────────────────────────────────────────────────────────
   "trip=705000,alert>=905000" on the command line, or a JSON object
   {"trip": 705000, "alert": ">=905000"} from a file. */
export function parseExpect(spec) {
  const out = [];
  const bad = [];
  const add = (table, op, n, raw) => {
    if (!IDENT.test(table) || !Number.isFinite(n) || n < 0) bad.push(raw);
    else out.push({ table, op, n });
  };
  if (spec && typeof spec === 'object') {
    for (const [t, v] of Object.entries(spec)) {
      const m = /^(>=)?\s*(\d+)$/.exec(String(v).trim());
      if (!m) bad.push(`${t}=${v}`); else add(t, m[1] ? '>=' : '=', Number(m[2]), `${t}=${v}`);
    }
  } else {
    for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([^=<>\s]+)\s*(>=|=)\s*(\d+)$/.exec(part);
      if (!m) bad.push(part); else add(m[1], m[2], Number(m[3]), part);
    }
  }
  return { expects: out, bad };
}

/* ── the checks ──────────────────────────────────────────────────────── */
export async function ledgerCheck(db, { files = SCHEMA_FILES, sqlDir = SQL_DIR, allowPending = false } = {}) {
  let applied;
  try {
    applied = new Map(rowsOf(await db.query('SELECT file, sha FROM schema_applied')).map((r) => [r.file, r.sha]));
  } catch (e) {
    return { name: 'ledger', status: 'fail',
      detail: 'schema_applied does not exist: this database was never migrated by this app, or the restore is not of it',
      error: String(e?.message || e).slice(0, 160) };
  }
  const missing = [];
  const changed = [];
  let lastApplied = -1;
  files.forEach((f, i) => {
    const sha = createHash('sha256').update(readFileSync(join(sqlDir, f), 'utf8')).digest('hex');
    if (!applied.has(f)) missing.push({ file: f, i });
    else { lastApplied = i; if (applied.get(f) !== sha) changed.push(f); }
  });
  const holes = missing.filter((m) => m.i < lastApplied).map((m) => m.file);
  const pending = missing.filter((m) => m.i > lastApplied).map((m) => m.file);
  const extra = [...applied.keys()].filter((f) => !files.includes(f));
  const base = { name: 'ledger', files: files.length, applied: files.length - missing.length,
    holes, pending, changed, extra };
  if (holes.length) {
    return { ...base, status: 'fail', detail: `${holes.length} schema file(s) never applied although later ones were: `
      + `${holes.join(', ')} — a gap in the migration history, not a newer checkout` };
  }
  if (pending.length && !allowPending) {
    return { ...base, status: 'fail', detail: `${pending.length} newer schema file(s) not applied yet (${pending.join(', ')}); `
      + 'the first boot of this checkout applies them — re-run after it, or pass --allow-pending before cutover' };
  }
  const notes = [];
  if (pending.length) notes.push(`${pending.length} newer file(s) will apply on first boot: ${pending.join(', ')}`);
  if (changed.length) notes.push(`${changed.length} file(s) changed since applied and will re-run once at the next boot: ${changed.join(', ')}`);
  return { ...base, status: notes.length ? 'warn' : 'pass',
    detail: notes.length ? notes.join('; ') : `all ${files.length} schema files applied, each matching this checkout` };
}

export async function countsCheck(db, expects = []) {
  if (!expects.length) {
    return { name: 'counts', status: 'not_measured',
      detail: 'no expectations given: pass --expect table=N[,table>=N] or --expect-file (record them at backup time with --counts)' };
  }
  const rows = [];
  for (const e of expects) {
    const exists = rowsOf(await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${e.table}`]))[0]?.ok;
    if (!exists) { rows.push({ ...e, actual: null, ok: false, why: 'no such table' }); continue; }
    const actual = Number(rowsOf(await db.query(`SELECT count(*)::bigint AS n FROM public.${e.table}`))[0]?.n);
    rows.push({ ...e, actual, ok: e.op === '>=' ? actual >= e.n : actual === e.n });
  }
  const bad = rows.filter((r) => !r.ok);
  return { name: 'counts', status: bad.length ? 'fail' : 'pass', rows,
    detail: bad.length
      ? bad.map((r) => `${r.table}: expected ${r.op === '>=' ? 'at least ' : ''}${r.n}, found ${r.actual ?? r.why}`).join('; ')
      : `${rows.length} table count(s) as expected` };
}

export async function secretCheck(db, env = process.env) {
  const { source, key } = keyFrom(env);
  let rows;
  try {
    rows = rowsOf(await db.query(
      `SELECT key, value FROM app_setting WHERE is_secret AND value LIKE 'v1:%' ORDER BY key`));
  } catch (e) {
    return { name: 'secret', status: 'fail', key_source: source,
      detail: 'app_setting could not be read', error: String(e?.message || e).slice(0, 160) };
  }
  const warnFallback = source !== 'SETTINGS_KEY'
    ? ` WARNING: SETTINGS_KEY is not set here, so the key comes from ${source}. A restore into a new cluster has a new `
      + 'DATABASE_URL, and every stored secret would stop decrypting. Set SETTINGS_KEY to the value production uses.'
    : '';
  if (!rows.length) {
    return { name: 'secret', status: 'not_measured', key_source: source, total: 0,
      detail: `no stored secret in app_setting to test the key against (secrets may all be environment variables).${warnFallback}` };
  }
  /* Names only. A value, its length or its first characters would all be a
     disclosure; a setting's NAME is in src/settings.js for anyone to read. */
  const failed = [];
  let ok = 0;
  for (const r of rows) { if (decryptWith(key, r.value) != null) ok += 1; else failed.push(r.key); }
  const status = ok === 0 ? 'fail' : failed.length ? 'warn' : (source === 'SETTINGS_KEY' ? 'pass' : 'warn');
  const detail = ok === 0
    ? `none of ${rows.length} stored secret(s) decrypt with the key from ${source}: this is not the key they were sealed with`
    : failed.length
      ? `${ok} of ${rows.length} stored secret(s) decrypt with the key from ${source}; these do not: ${failed.join(', ')} `
        + '(sealed under another key — re-enter them on the Settings page)'
      : `all ${rows.length} stored secret(s) decrypt with the key from ${source}`;
  return { name: 'secret', status, key_source: source, total: rows.length, decrypted: ok, failed, detail: detail + warnFallback };
}

/* Counts of the major tables, for recording at backup time. */
export async function countsNow(db, tables = MAJOR_TABLES) {
  const out = {};
  for (const t of tables) {
    const exists = rowsOf(await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${t}`]))[0]?.ok;
    if (exists) out[t] = Number(rowsOf(await db.query(`SELECT count(*)::bigint AS n FROM public.${t}`))[0]?.n);
  }
  return out;
}

export async function runDrill(db, { env = process.env, expects = [], allowPending = false } = {}) {
  const checks = [
    await ledgerCheck(db, { allowPending }),
    await countsCheck(db, expects),
    await secretCheck(db, env),
  ];
  return { checks, code: exitCode(checks) };
}

/* 0 all passed (warnings allowed), 1 anything failed, 2 nothing failed but
   something could not be measured — a drill that proved less than it was
   asked to is not a pass. */
export const exitCode = (checks) => (checks.some((c) => c.status === 'fail') ? 1
  : checks.some((c) => c.status === 'not_measured') ? 2 : 0);
