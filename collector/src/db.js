// Postgres pool + migration + generic upsert helpers.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const __dir = dirname(fileURLToPath(import.meta.url));
export const pool = new pg.Pool({ connectionString: config.db.connectionString, max: 8 });

export async function migrate() {
  const sql = readFileSync(join(__dir, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(sql);
  log.info('db', 'schema migrated');
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

export async function logRun(run) {
  const { rows } = await pool.query(
    `INSERT INTO collection_run (source,fleet_id,mode,window_start,window_end,status,rows_written,finished_at,error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`,
    [run.source, run.fleet_id, run.mode, run.window_start, run.window_end, run.status, run.rows_written || 0, run.error || null]);
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
