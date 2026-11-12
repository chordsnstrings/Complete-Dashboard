/* ROW-LEVEL SECURITY ON A REAL POSTGRES — the real src/db.js, its real pool.
   ═════════════════════════════════════════════════════════════════════════
   test/rls_scope.test.mjs proves the SQL on PGlite (Postgres 18 in WASM, one
   session, no pool). What PGlite cannot show is proved here against a real
   server, ideally Postgres 16 — production's major version on DigitalOcean:

     · src/db.js migrate() end to end — every schema file, then the
       row-level security pass and the probe — as an ordinary owner without
       CREATEROLE (inert, with the reason), then again after an
       administrator creates the role (secured, in use);
     · the PATCHED node-postgres pool: a scoped statement really runs as
       BEGIN; SET LOCAL ROLE …; <stmt>; COMMIT on a pooled connection, many
       at once on separate connections, and no pooled connection ever goes
       back still wearing the restricted role;
     · the lock_timeout guard: an object whose lock is held by a long reader
       is skipped as 'busy' in well under a second instead of stalling the
       boot, and secured by the next pass;
     · Postgres 16's grant rules: a CREATEROLE user (DigitalOcean's doadmin)
       that creates fleet_request holds ADMIN but not SET on it, and v124's
       self-grant is what lets it SET ROLE.

   Needs a superuser connection (RLS_PG, else ACCESS_PAGES_PG, else
   postgres://fleet@127.0.0.1:55432/fleet) to play the administrator. When
   none can be reached it prints a skip line and exits 0. It creates and drops
   two throwaway databases and three roles; it refuses to start if a
   fleet_request role already exists with rights it cannot drop.

   REVERSIONS (each run on 2026-11-12 against Postgres 16.15; each failed as
   named): delete step 2 of sql/schema_v124.sql → "v124 granted itself SET";
   delete fm_rls_secure's set_config('lock_timeout', …) → the pass waits on
   the reader until the statement timeout and "reported busy" and "skipped in
   well under a second" fail (run with STATEMENT_TIMEOUT_MS=5000 to see it in
   seconds); in src/fleet_scope.js poolRunner drop 'BEGIN; ' from the
   preamble → SET LOCAL outside a transaction does nothing and "reads only
   Egari" fails. */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const ADMIN_URL = process.env.RLS_PG || process.env.ACCESS_PAGES_PG || 'postgres://fleet@127.0.0.1:55432/fleet';
const DB1 = 'fleet_rls_pg_owner';
const DB2 = 'fleet_rls_pg_admin';
const urlFor = (base, { user, password, db }) => {
  const u = new URL(base);
  if (user) { u.username = user; u.password = password || ''; }
  if (db) u.pathname = `/${db}`;
  return u.toString();
};

/* ── is there a Postgres, and may this test play its administrator? ──── */
const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
try { await admin.connect(); } catch (e) {
  console.log(`  - skipped: no Postgres at ${ADMIN_URL.replace(/\/\/[^@]*@/, '//')} (${String(e.message || e).slice(0, 80)})`);
  process.exit(0);
}
const me = (await admin.query('SELECT rolsuper, version() AS v FROM pg_roles WHERE rolname = current_user')).rows[0];
if (!me?.rolsuper) {
  console.log('  - skipped: the connection is not a superuser, and this test has to play the administrator who creates the role');
  await admin.end(); process.exit(0);
}
console.log(`  (on ${String(me.v).split(' on ')[0]})`);
const pw = { user: randomBytes(12).toString('hex'), adminRole: randomBytes(12).toString('hex') };
const cleanup = async () => {
  for (const db of [DB1, DB2]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  for (const r of ['fleet_request', 'rls_app_user', 'rls_app_admin']) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
};
await cleanup();
if ((await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'fleet_request'`)).rows.length) {
  console.log('  - skipped: this cluster already has a fleet_request role with rights elsewhere; run against a throwaway cluster');
  await admin.end(); process.exit(0);
}
await admin.query(`CREATE ROLE rls_app_user LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${pw.user}'`);
await admin.query(`CREATE ROLE rls_app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS PASSWORD '${pw.adminRole}'`);
await admin.query(`CREATE DATABASE ${DB1} OWNER rls_app_user`);
await admin.query(`CREATE DATABASE ${DB2} OWNER rls_app_admin`);
const admin1 = new pg.Client({ connectionString: urlFor(ADMIN_URL, { db: DB1 }) });
await admin1.connect();

/* ── src/db.js, as the application's owner without CREATEROLE ──────────── */
process.env.DATABASE_URL = urlFor(ADMIN_URL, { user: 'rls_app_user', password: pw.user, db: DB1 });
process.env.DATABASE_SSL = 'false';
const { pool, migrate } = await import('../src/db.js');
const fs = await import('../src/fleet_scope.js');
const { withFleetScope, fleetScopeState, secureFleetScope, probeFleetScope, poolRunner } = fs;
let exitCode = 1;
try {
  console.log('\n1. src/db.js migrate() by an owner without CREATEROLE');
  await migrate();
  const st = fleetScopeState();
  check('every migration applied and the boot finished; row-level security is NOT in use, with the true reason',
    !st.ready && /no fleet_request role/.test(st.reason), st.reason);
  const on = (await admin1.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relrowsecurity`)).rows[0].n;
  check('INERT: not one table has row-level security on', on === 0, `${on} tables`);
  const failedFiles = (await admin1.query(`SELECT count(*)::int n FROM schema_applied`)).rows[0].n;
  check('every schema file is recorded as applied (none failed, v124 included)', failedFiles === SCHEMA_FILES.length,
    `${failedFiles} of ${SCHEMA_FILES.length}`);

  console.log('\n2. an administrator creates the role; the next boot secures everything');
  await admin.query('CREATE ROLE fleet_request NOLOGIN NOINHERIT; GRANT fleet_request TO rls_app_user;');
  await migrate();
  const st2 = fleetScopeState();
  check('the next boot: in use, every fleet table and view secured', st2.ready && /^In use: \d+ fleet tables/.test(st2.reason), st2.reason);
  const forced = (await admin1.query(`SELECT count(*)::int n FROM pg_class WHERE relforcerowsecurity`)).rows[0].n;
  check('…and nothing is FORCEd', forced === 0);

  console.log('\n3. the patched pool');
  await pool.query(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine'), ('egari', 'Egari') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status) VALUES
    ('uber', 'p-1', 'ecosine', 'L1', now(), 'completed'), ('uber', 'p-2', 'egari', 'L2', now(), 'completed'),
    ('uber', 'p-3', NULL, 'L3', now(), 'completed')`);
  const fleetsOf = (r) => r.rows.map((x) => x.fleet_id ?? 'NULL').join(',');
  check('outside a scope the owner reads every row, as before',
    fleetsOf(await pool.query('SELECT fleet_id FROM trip_norm ORDER BY external_id')) === 'ecosine,egari,NULL');
  check('inside an Egari scope a statement with no fleet filter reads only Egari (table)',
    fleetsOf(await withFleetScope(['egari'], () => pool.query('SELECT fleet_id FROM trip ORDER BY external_id'))) === 'egari');
  check('…and through the view',
    fleetsOf(await withFleetScope(['egari'], () => pool.query('SELECT fleet_id FROM trip_norm ORDER BY external_id'))) === 'egari');
  const many = await Promise.all(Array.from({ length: 24 }, (_, i) => {
    const f = i % 2 ? 'egari' : 'ecosine';
    return withFleetScope([f], () => pool.query('SELECT $1::text AS want, array_agg(fleet_id ORDER BY fleet_id) AS got, pg_backend_pid() AS pid FROM trip', [f]));
  }));
  check('24 scoped statements at once, two fleets, each reads only its own',
    many.every((r) => JSON.stringify(r.rows[0].got) === JSON.stringify([r.rows[0].want])));
  check('…across more than one pooled connection', new Set(many.map((r) => r.rows[0].pid)).size > 1);
  const after = await Promise.all(Array.from({ length: 16 }, () => pool.query(
    `SELECT current_user::text AS u, coalesce(current_setting('app.fleets', true), '') AS f, pg_backend_pid() AS pid`)));
  check('afterwards no pooled connection is still the restricted role or carries a fleet',
    after.every((r) => r.rows[0].u === 'rls_app_user' && r.rows[0].f === ''), JSON.stringify(after.map((r) => r.rows[0]).slice(0, 3)));
  let w = null;
  await withFleetScope(['egari'], () => pool.query(`INSERT INTO fleet (id, name) VALUES ('zz', 'no')`)).catch((e) => { w = e; });
  check('a write inside a scope is refused', /read-only/.test(String(w?.message)), String(w?.message));
  let bad = null;
  await withFleetScope(['egari'], () => pool.query('SELECT no_such_column FROM trip')).catch((e) => { bad = e; });
  const healthy = await pool.query('SELECT current_user::text AS u');
  check('a failing scoped statement rolls back and the pool stays healthy', bad && healthy.rows[0].u === 'rls_app_user');

  console.log('\n4. a busy table is skipped, not waited on');
  await pool.query('CREATE TABLE rls_lock_probe (id int, fleet_id text); INSERT INTO rls_lock_probe VALUES (1, \'ecosine\'), (2, \'egari\')');
  await admin1.query('BEGIN');
  await admin1.query('SELECT count(*) FROM rls_lock_probe');          // a reader holds its lock, as a long rollup would
  const t0 = Date.now();
  const sec = await secureFleetScope(pool, { lockMs: 400 });
  const ms = Date.now() - t0;
  const busy = sec.objects.find((o) => o.rel === 'rls_lock_probe');
  check('the busy table is reported busy, with the reason', busy && /busy: .*lock timeout/.test(busy.result), JSON.stringify(busy));
  check('…and its read grant landed anyway (GRANT waits on no reader)', busy && /^granted SELECT, busy: /.test(busy.result));
  check(`…and skipped in well under a second (${ms} ms), not waited on`, ms < 3000);
  const st3 = await probeFleetScope(pool, poolRunner(pool));
  check('the probe says it is in use, partly, naming the table', st3.ready && /partly/.test(st3.reason) && /rls_lock_probe/.test(st3.reason), st3.reason);
  await admin1.query('COMMIT');
  const sec2 = await secureFleetScope(pool, { lockMs: 400 });
  check('the next pass secures it', /fleet policy/.test(sec2.objects.find((o) => o.rel === 'rls_lock_probe')?.result || ''));
  check('…and it narrows', fleetsOf(await withFleetScope(['egari'], () => pool.query('SELECT fleet_id FROM rls_lock_probe'))) === 'egari');
  await pool.end();

  console.log('\n5. v124 applied by a CREATEROLE user (DigitalOcean\'s doadmin), on Postgres 16 rules');
  await admin1.query('REASSIGN OWNED BY fleet_request TO postgres').catch(() => {});
  await admin1.query('DROP OWNED BY fleet_request');
  await admin1.end();
  await admin.query(`DROP DATABASE ${DB1} WITH (FORCE)`);
  await admin.query('DROP ROLE fleet_request');
  const a = new pg.Client({ connectionString: urlFor(ADMIN_URL, { user: 'rls_app_admin', password: pw.adminRole, db: DB2 }) });
  await a.connect();
  for (const f of SCHEMA_FILES) await a.query(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
  const m = (await admin.query(`SELECT r.rolinherit, r.rolbypassrls, r.rolcanlogin,
       bool_or(am.set_option) AS can_set, bool_or(am.admin_option) AS can_admin
     FROM pg_roles r JOIN pg_auth_members am ON am.roleid = r.oid
     JOIN pg_roles mem ON mem.oid = am.member AND mem.rolname = 'rls_app_admin'
    WHERE r.rolname = 'fleet_request' GROUP BY 1, 2, 3`)).rows[0];
  check('v124 made the role (no login, no inherit, no bypass)', m && !m.rolinherit && !m.rolbypassrls && !m.rolcanlogin, JSON.stringify(m));
  check('v124 granted itself SET (Postgres 16 gives a role\'s creator ADMIN only)', m && m.can_set === true && m.can_admin === true, JSON.stringify(m));
  const apool = new pg.Pool({ connectionString: urlFor(ADMIN_URL, { user: 'rls_app_admin', password: pw.adminRole, db: DB2 }), max: 4 });
  const sec3 = await secureFleetScope(a);
  const st4 = await probeFleetScope(a, poolRunner(apool));
  check('the boot pass secures everything and the role can be assumed',
    sec3.objects.length > 100 && st4.ready, `${sec3.objects.length} objects; ${st4.reason}`);
  await a.query(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'E'), ('egari', 'G') ON CONFLICT DO NOTHING;
    INSERT INTO trip (platform, external_id, fleet_id, requested_at, status) VALUES ('uber', 'a-1', 'ecosine', now(), 'completed'), ('uber', 'a-2', 'egari', now(), 'completed')`);
  const own = (await a.query('SELECT count(*)::int n FROM trip_norm')).rows[0].n;
  const reader = await poolRunner(apool)(['ecosine'], ['SELECT fleet_id FROM trip_norm']);
  check('the owner (BYPASSRLS) reads both; the Ecosine reader reads Ecosine', own === 2 && fleetsOf(reader) === 'ecosine');
  await apool.end();
  await a.end();
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await pool.end().catch(() => {});
  await admin1.end().catch(() => {});
  await cleanup();
  await admin.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(exitCode);
