#!/usr/bin/env node
/* Rebuild the person spine by hand, or look at what it would do.
   ─────────────────────────────────────────────────────────────────────────
   The collector runs this on every pass (src/run.js), so nothing here is
   required in normal operation. It exists for the two moments when it is:
   the first build against a database that has never had one, and answering
   "what would this change" before letting it.

     node bin/persons.mjs            counts what it would do, writes nothing
     node bin/persons.mjs --apply    writes

   The dry run is the default for the same reason it is on /api/ledger/entry:
   the expensive mistake is writing something nobody meant to write. */
import { refreshPersons } from '../src/persons.js';
import { pool } from '../src/db.js';

const apply = process.argv.includes('--apply');
const out = await refreshPersons(pool, { dryRun: !apply });
if (out.refused) {
  console.error(`REFUSED: ${out.why}`);
  process.exit(1);
}
console.log(JSON.stringify(out, null, 2));
if (!apply) {
  console.log('\nNothing was written. Re-run with --apply to build it.');
}
await pool.end?.();
