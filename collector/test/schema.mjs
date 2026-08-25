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

/* Imported, not parsed. This used to recover the list with a regex over
   src/db.js's `for (const f of [...])`, which broke the moment that loop
   changed shape — and took every database-backed test in the suite down with
   it, all reporting "could not find the schema file list" rather than anything
   about the code under test. */
export { SCHEMA_FILES } from '../src/schema_files.js';
import { SCHEMA_FILES as FILES } from '../src/schema_files.js';

/* Apply every one of them to a PGlite instance, in order. */
export async function applySchema(db) {
  for (const f of FILES) {
    await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
  }
  return FILES;
}
