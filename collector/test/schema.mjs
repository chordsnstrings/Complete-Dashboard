/* The schema files the server actually applies, read from the migration itself.
   ──────────────────────────────────────────────────────────────────────────
   Seven test files each carried their own hand-maintained list of schema files
   to load into PGlite. Adding schema_v17.sql to src/db.js and forgetting one of
   the seven meant that test ran against a schema the server does not have —
   and it failed, correctly, with "column attempts does not exist", pointing at
   the test rather than at the code. Worse is the other direction: a test that
   happens not to touch the new column passes against a schema production never
   runs, and pins behaviour that is not real.

   One source of truth. Adding a migration to src/db.js is now the only step. */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
const list = src.match(/for \(const f of \[([^\]]+)\]\)/)?.[1];
if (!list) throw new Error('could not find the schema file list in src/db.js — has migrate() changed shape?');

export const SCHEMA_FILES = [...list.matchAll(/'([^']+\.sql)'/g)].map((m) => m[1]);
if (SCHEMA_FILES.length < 10) throw new Error(`only found ${SCHEMA_FILES.length} schema files; the parse is wrong`);

/* Apply every one of them to a PGlite instance, in order. */
export async function applySchema(db) {
  for (const f of SCHEMA_FILES) {
    await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
  }
  return SCHEMA_FILES;
}
