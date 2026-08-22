// Postgres pool + migration + generic upsert helpers.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from './log.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// Connection string is infra config — read straight from the environment (kept out of config.js to
// avoid an import cycle: config → settings → db). Managed Postgres presents a CA-signed cert the
// container doesn't trust; we enable TLS but skip chain verification. Strip `sslmode` first, else
// pg-connection-string parses it as verify-full and overrides our ssl option.
function poolConfig() {
  const p = process.env;
  let cs = p.DATABASE_URL
    || `postgres://${p.PGUSER || 'fleet'}:${p.PGPASSWORD || 'fleet'}@${p.PGHOST || 'db'}:${p.PGPORT || '5432'}/${p.PGDATABASE || 'fleet'}`;
  const needSsl = p.DATABASE_SSL === 'true' || /sslmode=/i.test(cs);
  if (needSsl) { try { const u = new URL(cs); u.searchParams.delete('sslmode'); cs = u.toString(); } catch { /* keep as-is */ } }
  return { connectionString: cs, max: 8, ssl: needSsl ? { rejectUnauthorized: false } : undefined };
}
export const pool = new pg.Pool(poolConfig());

/* pg-pool emits 'error' when a socket belonging to an IDLE client fails. With
   no listener that is an unhandled 'error' event thrown out of a socket
   callback, which takes the process down — and managed Postgres reaps idle
   backends as a matter of routine, so a failover killed both containers rather
   than reconnecting. The pool discards the broken client itself; all this has
   to do is refuse to be fatal. */
pool.on('error', (err) => log.error('db', 'idle client error', { err: err.message, code: err.code }));

export async function migrate() {
  for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql', 'schema_v15.sql', 'schema_v16.sql', 'schema_v17.sql', 'schema_v18.sql', 'schema_v19.sql', 'schema_v20.sql']) {
    try {
      const sql = readFileSync(join(__dir, '..', 'sql', f), 'utf8');
      await pool.query(sql);
      log.info('db', `migrated ${f}`);
    } catch (e) {
      // v2 is additive; a failure there must not block the base schema/boot
      log.error('db', `migration ${f} failed`, { err: String(e).slice(0, 200) });
      if (f === 'schema.sql') throw e;
    }
  }
}

// Upsert one row into `table`, conflict on `conflict` columns, updating the rest.
export async function upsert(table, row, conflict) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((c) => !conflict.includes(c)).map((c) => `${c}=EXCLUDED.${c}`);
  const doUpdate = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
  const text = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})
                ON CONFLICT (${conflict.join(',')}) ${doUpdate}`;
  await pool.query(text, vals);
}

// Batched upsert (chunks to keep parameter counts sane).
export async function upsertMany(table, rows, conflict, chunk = 200) {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    // sequential upserts inside a transaction for idempotent re-runs
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of slice) {
        const cols = Object.keys(r);
        const ph = cols.map((_, j) => `$${j + 1}`);
        const updates = cols.filter((c) => !conflict.includes(c)).map((c) => `${c}=EXCLUDED.${c}`);
        const doUpdate = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
        await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')}) ON CONFLICT (${conflict.join(',')}) ${doUpdate}`,
          cols.map((c) => r[c]));
      }
      await client.query('COMMIT');
      n += slice.length;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  return n;
}

/* Record a run, and — where the source chunked its window — which chunks
   landed. A run that wrote rows while most of its windows failed reported
   status='ok' for months while the Uber trip history had a 299-day hole in it;
   `chunks` is what makes that impossible to miss. Passing chunks is optional,
   so a source that does not chunk is unaffected. */
export async function logRun(run) {
  const chunks = Array.isArray(run.chunks) ? run.chunks : null;
  const failed = chunks ? chunks.filter((c) => c.error).length : null;
  // A source that succeeded on some windows and failed on others is not 'ok',
  // whatever it managed to write.
  const status = run.status === 'error' ? 'error'
    : (failed ? 'partial' : (run.status || 'ok'));
  const { rows } = await pool.query(
    `INSERT INTO collection_run
       (source,fleet_id,mode,window_start,window_end,status,rows_written,finished_at,error,
        chunks_total,chunks_failed,detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11) RETURNING id`,
    [run.source, run.fleet_id, run.mode, run.window_start, run.window_end, status,
     run.rows_written || 0, run.error || null,
     chunks ? chunks.length : null, failed,
     chunks ? JSON.stringify(chunks.map((c) => ({
       from: c.from, to: c.to, rows: c.rows ?? 0,
       error: c.error ? String(c.error).slice(0, 300) : null,
     }))) : null]);
  return rows[0].id;
}

export async function getState(source, fleet, key) {
  const { rows } = await pool.query('SELECT value FROM source_state WHERE source=$1 AND fleet_id=$2 AND key=$3',
    [source, fleet, key]);
  return rows[0]?.value ?? null;
}
export async function setState(source, fleet, key, value) {
  await pool.query(
    `INSERT INTO source_state (source,fleet_id,key,value,updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (source,fleet_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [source, fleet, key, value]);
}
