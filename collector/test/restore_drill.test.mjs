/* The restore drill's checks (src/restore_drill.js), on PGlite.
   ═════════════════════════════════════════════════════════════════════════
   The drill is what tells an operator a restore worked before the app is
   pointed at it, so each check must fail when it should, pass only what it
   can prove, and never print a secret:

     1. ledger — complete passes; a hole fails; newer files fail unless
        allowed before cutover; a changed file warns (it re-runs once);
     2. counts — exact and "at least" expectations; a missing table fails;
        an injection-shaped name never reaches SQL; nothing named is
        not_measured, not a pass;
     3. secret — the drill's key derivation IS src/settings.js's: a secret
        sealed by setSetting() under SETTINGS_KEY decrypts with the same key,
        fails with another, and the DATABASE_URL fallback is warned about;
        the plaintext never appears in the report;
     4. the CLI never prints DATABASE_URL, even when the connection fails.

   REVERSION: make keyFrom hash `env.DATABASE_URL || env.SETTINGS_KEY`
   (the wrong precedence) and section 3's "decrypts under SETTINGS_KEY" fails;
   drop the holes branch in ledgerCheck and "a hole fails" fails. */
process.env.SETTINGS_KEY = 'drill-test-key-A';   // before src/settings.js computes its key at import
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { applySchema, SCHEMA_FILES } from './schema.mjs';

const { ledgerCheck, countsCheck, secretCheck, parseExpect, runDrill, exitCode, keyFrom, decryptWith, countsNow }
  = await import('../src/restore_drill.js');
const { setSetting } = await import('../src/settings.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const sha = (f) => createHash('sha256').update(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')).digest('hex');

console.log('\n1. the migration ledger');
{
  const none = await ledgerCheck(db);
  check('no schema_applied at all fails, with the reason', none.status === 'fail' && /never migrated/.test(none.detail), none.detail);
  /* The table exactly as src/db.js ledger() creates it. */
  await db.exec(`CREATE TABLE schema_applied (file TEXT PRIMARY KEY, sha TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now(), ms INT)`);
  for (const f of SCHEMA_FILES) await db.query('INSERT INTO schema_applied (file, sha) VALUES ($1, $2)', [f, sha(f)]);
  const full = await ledgerCheck(db);
  check(`every registered file applied and current passes (${SCHEMA_FILES.length})`,
    full.status === 'pass' && full.applied === SCHEMA_FILES.length, full.detail);
  await db.query(`UPDATE schema_applied SET sha = 'stale' WHERE file = 'schema_v53.sql'`);
  const changed = await ledgerCheck(db);
  check('a changed file warns that it re-runs once (v53 does, by design)', changed.status === 'warn'
    && changed.changed.join() === 'schema_v53.sql' && /re-run once/.test(changed.detail), changed.detail);
  await db.query(`UPDATE schema_applied SET sha = $1 WHERE file = 'schema_v53.sql'`, [sha('schema_v53.sql')]);
  /* One name, held once: route_smoke reads two schema names inside one array
     literal as a hand-kept list of schema files. */
  const V40 = 'schema_v40.sql';
  await db.query(`DELETE FROM schema_applied WHERE file = 'schema_v40.sql'`);
  const hole = await ledgerCheck(db);
  check('a hole (a file never applied although later ones were) fails', hole.status === 'fail'
    && hole.holes.join() === 'schema_v40.sql', hole.detail);
  await db.query('INSERT INTO schema_applied (file, sha) VALUES ($1, $2)', [V40, sha(V40)]);
  /* The newest registered file stands for "a newer checkout than the
     database" (it named v115 until the 2026-11-12 batch put later files after it). */
  const NEWEST = SCHEMA_FILES[SCHEMA_FILES.length - 1];
  await db.query('DELETE FROM schema_applied WHERE file = $1', [NEWEST]);
  const pend = await ledgerCheck(db);
  check('newer files not applied yet fail by default (the first boot applies them)',
    pend.status === 'fail' && pend.pending.join() === NEWEST, pend.detail);
  const allowed = await ledgerCheck(db, { allowPending: true });
  check('and warn when allowed, before cutover', allowed.status === 'warn' && /will apply on first boot/.test(allowed.detail), allowed.detail);
  await db.query('INSERT INTO schema_applied (file, sha) VALUES ($1, $2)', [NEWEST, sha(NEWEST)]);
}

console.log('\n2. row counts against what was recorded');
{
  await db.query(`INSERT INTO trip (platform, external_id, fleet_id, requested_at, status)
    SELECT 'uber', 't' || g, 'ecosine', now() - make_interval(days => g), 'completed' FROM generate_series(1, 3) g`);
  const p = parseExpect('trip=3,alert>=0');
  check('the command-line form parses', p.bad.length === 0 && p.expects.length === 2 && p.expects[1].op === '>=');
  const ok = await countsCheck(db, p.expects);
  check('exact and at-least expectations pass when met', ok.status === 'pass', ok.detail);
  const short = await countsCheck(db, parseExpect('trip>=5').expects);
  check('a short table fails and says by how much', short.status === 'fail' && /expected at least 5, found 3/.test(short.detail), short.detail);
  const ghost = await countsCheck(db, parseExpect('no_such_table=1').expects);
  check('a table that does not exist fails as such', ghost.status === 'fail' && /no such table/.test(ghost.detail), ghost.detail);
  const evil = parseExpect('trip;drop table trip=1,Trip=1');
  check('an injection-shaped or non-identifier name is refused before SQL', evil.expects.length === 0 && evil.bad.length === 2, JSON.stringify(evil));
  const file = parseExpect({ taken_at: undefined, trip: 3, alert: '>=0' });
  check('the JSON form parses (exact numbers and ">=")', file.expects.length === 2 && file.expects.find((e) => e.table === 'alert').op === '>=');
  check('nothing named is not_measured, never a pass', (await countsCheck(db, [])).status === 'not_measured');
  const now = await countsNow(db);
  check('--counts lists the major tables that exist', now.trip === 3 && 'schema_applied' in now && !('no_such_table' in now));
}

console.log('\n3. a stored secret decrypts with the key this environment derives');
{
  const empty = await secretCheck(db, { DATABASE_URL: 'postgres://x' });
  check('no stored secret: not measured, and still warns when the key is a fallback',
    empty.status === 'not_measured' && /WARNING: SETTINGS_KEY is not set/.test(empty.detail), empty.detail);
  const PLAIN = 'sk-live-THIS-MUST-NEVER-PRINT-123';
  await setSetting('SMSALA_API_TOKEN', PLAIN, db);   // sealed by src/settings.js itself, under SETTINGS_KEY A
  const stored = (await db.query(`SELECT value, is_secret FROM app_setting WHERE key = 'SMSALA_API_TOKEN'`)).rows[0];
  check('setup: src/settings.js stored it sealed', stored.is_secret === true && /^v1:/.test(stored.value) && !stored.value.includes(PLAIN));
  const good = await secretCheck(db, { SETTINGS_KEY: 'drill-test-key-A', DATABASE_URL: 'postgres://new-cluster' });
  check('decrypts under the same SETTINGS_KEY: the drill derives the key exactly as the app does',
    good.status === 'pass' && good.decrypted === 1 && good.key_source === 'SETTINGS_KEY', good.detail);
  const wrong = await secretCheck(db, { SETTINGS_KEY: 'some-other-key' });
  check('fails under any other key', wrong.status === 'fail' && /not the key they were sealed with/.test(wrong.detail), wrong.detail);
  const fallback = await secretCheck(db, { DATABASE_URL: 'postgres://new-cluster' });
  check('with no SETTINGS_KEY the key comes from DATABASE_URL: fails here, and says why a restore breaks it',
    fallback.status === 'fail' && fallback.key_source === 'DATABASE_URL' && /new DATABASE_URL/.test(fallback.detail), fallback.detail);
  await db.query(`INSERT INTO app_setting (key, value, is_secret) VALUES ('BOLT_PORTAL_TOKEN', 'v1:AAAA:BBBB:CCCC', true)`);
  const mixed = await secretCheck(db, { SETTINGS_KEY: 'drill-test-key-A' });
  check('one secret sealed under another key: a warning that names the SETTING, not its value',
    mixed.status === 'warn' && mixed.failed.join() === 'BOLT_PORTAL_TOKEN' && mixed.decrypted === 1, mixed.detail);
  const all = JSON.stringify([good, wrong, fallback, mixed]);
  check('no report carries the plaintext, or any slice of it', !all.includes(PLAIN) && !all.includes('THIS-MUST-NEVER'));
  check('decryptWith answers null, never garbage, for a wrong key',
    decryptWith(keyFrom({ SETTINGS_KEY: 'x' }).key, stored.value) === null
    && decryptWith(keyFrom({ SETTINGS_KEY: 'drill-test-key-A' }).key, stored.value) === PLAIN);
}

console.log('\n4. the whole drill, and its exit codes');
{
  const r = await runDrill(db, { env: { SETTINGS_KEY: 'drill-test-key-A' }, expects: parseExpect('trip=3').expects });
  check('ledger pass, counts pass, secret warn (one foreign secret): exit 0',
    r.checks.map((c) => c.status).join() === 'pass,pass,warn' && r.code === 0, r.checks.map((c) => `${c.name}:${c.status}`).join(' '));
  check('a failure is exit 1, a not-measured with no failure exit 2',
    exitCode([{ status: 'pass' }, { status: 'fail' }]) === 1 && exitCode([{ status: 'pass' }, { status: 'not_measured' }]) === 2);
}

console.log('\n5. the CLI never prints DATABASE_URL');
{
  const secretUrl = 'postgres://drilluser:Sup3rS3cretPw@127.0.0.1:1/fleet';
  const out = spawnSync(process.execPath, ['bin/restore-drill.mjs'], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, DATABASE_URL: secretUrl, SETTINGS_KEY: 'k' } });
  const text = `${out.stdout}\n${out.stderr}`;
  check('a refused connection exits 3', out.status === 3, `${out.status} ${text.slice(0, 200)}`);
  check('and neither the password, the user nor the URL appears in what it printed',
    !text.includes('Sup3rS3cretPw') && !text.includes('drilluser') && !text.includes('postgres://'), text.slice(0, 300));
  /* Review of 2026-11-12: node names the address bare ("connect
     ECONNREFUSED 127.0.0.1:1", "getaddrinfo ENOTFOUND <host>"), and the
     first draft printed it. A DigitalOcean host names the account and the
     cluster. REVERSION: drop the urlParts loop in bin/restore-drill.mjs's
     scrub and both checks below fail. */
  check('nor the host and port it could not reach', !text.includes('127.0.0.1') && !/:1\b/.test(text), text.slice(0, 300));
  const host = 'drill-cluster-do-user-424242-0.example.invalid';
  const nx = spawnSync(process.execPath, ['bin/restore-drill.mjs'], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, DATABASE_URL: `postgres://drilluser:Sup3rS3cretPw@${host}:25060/fleet`, SETTINGS_KEY: 'k' } });
  const nxText = `${nx.stdout}\n${nx.stderr}`;
  check('a host that does not resolve exits 3 without naming the host', nx.status === 3 && !nxText.includes(host)
    && !nxText.includes('424242') && !nxText.includes('25060'), `${nx.status} ${nxText.slice(0, 300)}`);
  const noUrl = spawnSync(process.execPath, ['bin/restore-drill.mjs'], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DATABASE_URL: '' } });
  check('no DATABASE_URL: says so and exits 3', noUrl.status === 3 && /DATABASE_URL is not set/.test(noUrl.stderr));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
