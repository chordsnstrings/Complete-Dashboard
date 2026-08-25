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
  return {
    connectionString: cs,
    max: 8,
    /* A query that will not finish must not hold a pool slot for ever. With
       eight connections, two stuck queries are a quarter of the API's capacity
       and the symptom is every other page becoming slow — which reads as a
       database problem rather than as one bad statement. Two minutes is far
       longer than the slowest honest query here (the full rollup, at about
       forty seconds) and far shorter than a hang.

       One value governs both processes. The collector's heaviest single
       statement is the full rollup at about forty seconds, so it fits — and if
       a backfill ever needs longer, STATEMENT_TIMEOUT_MS raises it for that
       component without touching the API's. */
    statement_timeout: Number(process.env.STATEMENT_TIMEOUT_MS || 120000),
    ssl: needSsl ? { rejectUnauthorized: false } : undefined,
  };
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
  for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql', 'schema_v15.sql', 'schema_v16.sql', 'schema_v17.sql', 'schema_v18.sql', 'schema_v19.sql', 'schema_v20.sql', 'schema_v21.sql', 'schema_v22.sql', 'schema_v23.sql', 'schema_v24.sql', 'schema_v25.sql', 'schema_v26.sql', 'schema_v27.sql', 'schema_v28.sql', 'schema_v29.sql', 'schema_v30.sql']) {
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
/* One statement per batch, not one per row.
   ─────────────────────────────────────────────────────────────────────────
   This sent a separate INSERT for every row. A year backfill writes about
   165,000 trips, so it sent 165,000 statements, each a round trip to a managed
   database on another host — and it is why a backfill pinned a one-vCPU
   Postgres for hours and every dashboard page timed out behind it. The work
   was never the writing; it was the asking.

   Three things have to be right for a multi-row upsert, and each of them is a
   real failure this code has to handle:

   1. Rows in one call can carry DIFFERENT columns — the sources build objects
      field by field and omit what a provider did not send. A single statement
      has one column list, so rows are grouped by their column signature and
      each group gets its own statement.

   2. A conflict key must not appear twice in one statement. Postgres refuses
      with "ON CONFLICT DO UPDATE command cannot affect row a second time" —
      the row-at-a-time version simply applied them in order, so duplicates
      inside one batch were legal and the last one won. The same rule is kept
      by de-duplicating on the conflict key before the statement, last write
      winning, which is what a sequential replay would have produced.

   3. Postgres allows 65,535 bind parameters per statement. A batch of 200
      rows of 25 columns is 5,000, but a wide table and a large chunk could
      cross it, so the batch size is derived from the column count.

   Same transaction per batch, same ON CONFLICT semantics, same idempotency on
   re-run. Only the number of round trips changed. */
export async function upsertMany(table, rows, conflict, chunk = 200) {
  if (!rows.length) return 0;
  const MAX_PARAMS = 60000;   // under Postgres's 65535, with room for the shape

  // Group by column signature: one statement can only carry one column list.
  const groups = new Map();
  for (const r of rows) {
    const cols = Object.keys(r);
    const key = cols.slice().sort().join('\u0000');
    if (!groups.has(key)) groups.set(key, { cols, rows: [] });
    groups.get(key).rows.push(r);
  }

  let n = 0;
  for (const { cols, rows: groupRows } of groups.values()) {
    const updates = cols.filter((c) => !conflict.includes(c)).map((c) => `${c}=EXCLUDED.${c}`);
    const doUpdate = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
    const perBatch = Math.max(1, Math.min(chunk, Math.floor(MAX_PARAMS / cols.length)));

    for (let i = 0; i < groupRows.length; i += perBatch) {
      const slice = groupRows.slice(i, i + perBatch);
      /* Last write wins within the batch, exactly as sequential upserts did.
         The key is built from the conflict columns; a row missing one of them
         cannot collide on it, so it is kept as its own entry. */
      const byKey = new Map();
      for (const r of slice) {
        byKey.set(conflict.map((c) => `${r[c]}`).join('\u0000'), r);
      }
      const batch = [...byKey.values()];

      const params = [];
      const tuples = batch.map((r) => {
        const ph = cols.map((c) => { params.push(r[c]); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`
          + ` ON CONFLICT (${conflict.join(',')}) ${doUpdate}`, params);
        await client.query('COMMIT');
        /* The count reports rows ACCEPTED, including the ones a duplicate
           inside the batch replaced — the caller is reporting how much of the
           provider's answer it stored, not how many statements ran. */
        n += slice.length;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    }
  }
  return n;
}

/* Record a run, and — where the source chunked its window — which chunks
   landed. A run that wrote rows while most of its windows failed reported
   status='ok' for months while the Uber trip history had a 299-day hole in it;
   `chunks` is what makes that impossible to miss. Passing chunks is optional,
   so a source that does not chunk is unaffected.

   `detail` is that list of windows and nothing around it — the shape
   schema_v12 documents and the shape every reader has to expect.

   The db handle is a parameter so a test can drive this writer against a
   throwaway database instead of hand-writing what it believes this stores. It
   believed wrong for as long as the coverage fixture existed: it wrote
   {chunks: [...]}, the endpoint read a 'chunks' key, and the two agreed with
   each other and with nothing that ships. A writer no test can call is a
   writer whose output no test can check. */
export async function logRun(run, db = pool) {
  const chunks = Array.isArray(run.chunks) ? run.chunks : null;
  const failed = chunks ? chunks.filter((c) => c.error).length : null;
  // A source that succeeded on some windows and failed on others is not 'ok',
  // whatever it managed to write.
  const status = run.status === 'error' ? 'error'
    : (failed ? 'partial' : (run.status || 'ok'));
  const { rows } = await db.query(
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
