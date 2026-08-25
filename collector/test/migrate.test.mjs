/* ── every deploy included six minutes of a dashboard that does not load ───
   The API answers 503 while migrate() runs, and migrate() replayed all
   thirty-one schema files in full on every boot. Three of those files contain
   a `DELETE FROM insight a USING insight b` — a self-join over a table holding
   thirty thousand rows, which is nine hundred million row comparisons. Each
   one hit the two-minute statement timeout, failed, was logged, and was
   swallowed. Every boot. For months.

   That cost twice over. It burned four to six minutes of 503 on every single
   deploy, AND the de-duplication never once completed — which is why the
   insight table stayed 99.3% duplicates while three separate places in this
   codebase claimed to be pruning it, and why the unique indexes schema_v15
   creates immediately afterwards could never be built.

   Two fixes, and these assertions hold both:

   1. THE DELETE IS AN ANTI-JOIN NOW. DISTINCT ON picks the survivors with one
      sort and the delete removes what is not in that set — O(n log n), and it
      finishes. The tiebreak is identical in all three places so they cannot
      disagree about which copy lives.
   2. A MIGRATION THAT HAS SUCCEEDED DOES NOT RUN AGAIN. schema_applied records
      the SHA-256 of each file's contents; a matching hash is skipped. Keyed on
      CONTENT, not on name, so editing a migration re-runs it exactly once —
      which is the only reason fixing the DELETEs above is deployable. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema, SCHEMA_FILES } from './schema.mjs';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nmigrations: nothing quadratic survives');

const QUADRATIC = /DELETE\s+FROM\s+(\w+)\s+\w+\s+USING\s+\1\b/i;
const offenders = [];
for (const f of SCHEMA_FILES) {
  const sql = readFileSync(`sql/${f}`, 'utf8');
  /* Comment lines are allowed to quote the old statement — the files explain
     what they replaced, and that explanation is the point. Only executable
     lines are tested. */
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  if (QUADRATIC.test(code)) offenders.push(f);
}
check('no schema file deletes a table by joining it to itself',
  offenders.length === 0, offenders.join(', '));

const collector = readFileSync('src/insights.js', 'utf8');
check('and neither does the prune that runs after every insight generation',
  !QUADRATIC.test(collector.replace(/\/\*[\s\S]*?\*\//g, '')),
  'src/insights.js still self-joins insight — it will time out and prune nothing');

/* All three places must agree on the survivor, or two of them fight over it
   every half hour. Named one at a time rather than in an array, because
   route_smoke.test.mjs bans an array of schema filenames — that is how a
   hand-maintained schema list looks, and the ban is right even though this
   would have been a benign instance of it. */
const TIE = /ORDER BY code, entity_type, entity_id, computed_at DESC, id DESC/;
const agrees = (f) => TIE.test(readFileSync(f, 'utf8'));
check('the boot-time catch-up purge picks the newest copy', agrees('sql/schema_v31.sql'));
check('the null-window purge picks it the same way', agrees('sql/schema_v15.sql'));
check('and so does the prune that runs after every generation', agrees('src/insights.js'));

console.log('\nmigrations: the de-duplication actually de-duplicates');

await applySchema(db);
/* Twelve copies of three findings, plus one that is already unique.
   ─────────────────────────────────────────────────────────────────────────
   The copies carry a MOVING WINDOW, which is what the real duplicates are:
   schema_v15 gave the null-window and fleet-level rules unique indexes and
   could not touch the windowed ones, because a sliding 30-day lookback
   recomputed every half hour keys the same finding about the same vehicle
   differently every time. Those are the 29,430 rows v31 exists to remove, and
   a fixture using null windows could not even be inserted — v15's unique index
   rejects it, which is that index doing its job. */
const mk = (code, ent, at, ws) => q(
  `INSERT INTO insight (code, category, severity, entity_type, entity_id, title, detail,
                        computed_at, window_start, window_end)
   VALUES ($1,'ops','info','vehicle',$2,'t','d',$3,$4,$4::date + 30)`, [code, ent, at, ws]);
for (let i = 0; i < 4; i++) {
  const win = `2026-07-0${i + 1}`;
  await mk('dup_a', 'L1', `2026-08-0${i + 1}T00:00:00Z`, win);
  await mk('dup_a', 'L2', `2026-08-0${i + 1}T00:00:00Z`, win);
  await mk('dup_b', 'L1', `2026-08-0${i + 1}T00:00:00Z`, win);
}
await mk('solo', 'L9', '2026-08-01T00:00:00Z', '2026-07-01');
const before = (await q('SELECT count(*)::int n FROM insight'))[0].n;
check('the fixture holds the duplicates it means to', before === 13, String(before));

const purge = readFileSync('sql/schema_v31.sql', 'utf8');
const stmt = purge.slice(purge.indexOf('WITH keep AS'));
await db.exec(stmt.slice(0, stmt.indexOf(';') + 1));
const after = await q('SELECT code, entity_id, computed_at FROM insight ORDER BY 1, 2');
check('one row survives per (code, entity_type, entity_id)',
  after.length === 4, JSON.stringify(after.map((r) => [r.code, r.entity_id])));
/* Compared as a DATE, not as a string. A Postgres timestamptz arrives as a JS
   Date, and String(Date) is "Tue Aug 04 2026 …" — a substring test for
   "2026-08-04" matches none of them and fails a check the code passes. */
const day = (v) => new Date(v).toISOString().slice(0, 10);
check('and it is the NEWEST copy, which is the one both readers already serve',
  after.every((r) => day(r.computed_at) === (r.code === 'solo' ? '2026-08-01' : '2026-08-04')),
  JSON.stringify(after.map((r) => [r.code, day(r.computed_at)])));
check('a finding with no duplicates is untouched',
  after.some((r) => r.code === 'solo'));

/* Idempotent: a second run on a clean table deletes nothing. This is what lets
   it sit unguarded in a file that may be replayed. */
await db.exec(stmt.slice(0, stmt.indexOf(';') + 1));
check('running it again deletes nothing',
  (await q('SELECT count(*)::int n FROM insight'))[0].n === 4);

/* And with that done, the unique indexes schema_v15 could never create are
   creatable — which was the whole point of the delete it does first. */
const idx = await q(
  "SELECT indexname FROM pg_indexes WHERE indexname IN ('insight_nullwindow_uniq','insight_fleet_verdict_uniq')");
check('the unique indexes the purge exists to make possible are present',
  idx.length === 2, JSON.stringify(idx.map((r) => r.indexname)));

console.log('\nmigrations: a file that has applied does not apply again');

const dbSrc = readFileSync('src/db.js', 'utf8');
check('migrate() keeps a ledger of what it has applied',
  /schema_applied/.test(dbSrc) && /createHash\('sha256'\)/.test(dbSrc));
check('keyed on the file CONTENTS, so editing a migration re-runs it once',
  /applied\.get\(f\) === sha/.test(dbSrc),
  'skipping by filename would make a fixed migration undeployable');
check('a file that FAILS is not recorded, so it retries on the next boot',
  dbSrc.indexOf('INSERT INTO schema_applied') < dbSrc.indexOf('} catch (e) {',
    dbSrc.indexOf('INSERT INTO schema_applied')),
  'the ledger write must be inside the try, after the migration succeeded');
check('and a database with no ledger still migrates, rather than refusing to boot',
  /ledger unavailable/.test(dbSrc));
check('schema.sql is still the one file whose failure is fatal',
  /if \(f === 'schema\.sql'\) throw e;/.test(dbSrc));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
