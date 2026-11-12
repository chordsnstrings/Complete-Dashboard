/* ROW-LEVEL SECURITY — the role, the policies, the boot pass and the
   restricted path, on a real database.
   ═════════════════════════════════════════════════════════════════════════
   sql/schema_v124.sql and src/fleet_scope.js (ULM-DESIGN §4). What PGlite can
   prove, it proves here; what only production can prove is listed at the
   end of collector/docs/ULM-DESIGN.md ("As built, 2026-11-12").

   PGlite runs as a superuser, and a superuser is exempt from every policy —
   so a test that applied the schema as `postgres` would prove nothing about
   the OWNER exemption production relies on. Each database below is built as
   an ordinary login role instead, exactly the two shapes DigitalOcean's
   managed Postgres can hand the application:

     app_user   owns every table (it ran every migration), NO CREATEROLE —
                v124 cannot make the role, so everything must stay inert and
                say why; then an administrator makes it and the next boot
                finishes the job.
     app_admin  owns every table, CREATEROLE and BYPASSRLS (DigitalOcean's
                doadmin) — v124 makes the role and grants itself SET.

   Every block names the reversion that proves it. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from './schema.mjs';
import {
  validFleets, restrictSql, rlsCacheKey, parseRlsCacheKey, scopedQuery, installFleetScope,
  withFleetScope, enterFleetScope, outsideFleetScope, currentFleetScope, poolRunner, pgliteRunner,
  scopedPglite, secureFleetScope, probeFleetScope, RLS_ROLE, securedShort,
} from '../src/fleet_scope.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

/* ══ 1. the fleet ids that may reach SQL ══════════════════════════════════
   REVERSION: drop the FLEET_ID test in validFleets — the quote and the
   semicolon reach restrictSql and both refusals fail. */
console.log('\n1. what may be written into SET LOCAL');
{
  check('a fleet id passes', JSON.stringify(validFleets(['egari'])) === '["egari"]');
  check('ids are de-duplicated and sorted (one cache key per scope)',
    JSON.stringify(validFleets(['egari', 'ecosine', 'egari'])) === '["ecosine","egari"]');
  check('a quote is refused, never escaped', throws(() => validFleets(["egari'; RESET ROLE; --"])));
  check('a comma inside one id is refused (it would be two fleets)', throws(() => validFleets(['egari,ecosine'])));
  check('a non-string is refused', throws(() => validFleets([42])));
  check('the preamble is read-only, the role, then the fleets',
    restrictSql(['egari']) === "SET TRANSACTION READ ONLY; SET LOCAL ROLE fleet_request; SET LOCAL app.fleets = 'egari'");
  check('an empty scope is legal and narrows to nothing', restrictSql([]).endsWith("app.fleets = ''"));
  const k = rlsCacheKey(['egari'], '/api/kpis?fleet=egari');
  check('a scoped cache key cannot be a request line (it does not start with /)', !k.startsWith('/'));
  const back = parseRlsCacheKey(k);
  check('…and gives back its fleets and its address', back && back.fleets.join() === 'egari' && back.url === '/api/kpis?fleet=egari');
  check('an ordinary key is not a scoped one', parseRlsCacheKey('/api/kpis?fleet=egari') === null);
}

/* ══ 2. the pool's query(), inside and outside a scope ════════════════════
   A fake node-postgres pool records every statement, so the protocol is
   checked exactly: outside a scope the pool's own query() gets the caller's
   arguments untouched; inside, one connection runs BEGIN + the preamble in
   one round trip, then the caller's statement, then COMMIT.
   REVERSION: in scopedQuery return rawQuery(...args) unconditionally — every
   "inside a scope" check fails. */
console.log('\n2. the patched pool');
{
  const log = [];
  const released = [];
  const fakeClient = (fail = null) => ({
    query: async (...a) => {
      log.push(['client', a[0], a[1] ?? null]);
      if (fail && String(a[0]).startsWith(fail.on)) throw fail.err;
      if (a[0] === 'ROLLBACK' && fail?.rollback) throw new Error('connection gone');
      return { rows: [{ ok: 1 }], command: 'SELECT' };
    },
    release: (err) => released.push(err ?? null),
  });
  let nextClient = () => fakeClient();
  const pool = {
    query: function rawQuery(...a) { log.push(['pool', a[0], a[1] ?? null]); return Promise.resolve({ rows: [{ raw: 1 }] }); },
    connect: async () => nextClient(),
  };
  installFleetScope(pool);
  installFleetScope(pool);   // idempotent: not wrapped twice
  const r0 = await pool.query('SELECT 1 WHERE $1', [true]);
  check('outside a scope the pool\'s own query() runs, with the same arguments',
    r0.rows[0].raw === 1 && log.length === 1 && log[0][0] === 'pool' && log[0][1] === 'SELECT 1 WHERE $1' && log[0][2][0] === true);
  log.length = 0;
  const r1 = await withFleetScope(['egari'], () => pool.query('SELECT * FROM trip WHERE id = $1', [7]));
  check('inside a scope: one connection, BEGIN and the preamble in ONE round trip',
    log[0][0] === 'client' && log[0][1] === `BEGIN; ${restrictSql(['egari'])}`, JSON.stringify(log[0]));
  check('…then the statement with its own values', log[1][1] === 'SELECT * FROM trip WHERE id = $1' && log[1][2][0] === 7);
  check('…then COMMIT, and the connection goes back', log[2][1] === 'COMMIT' && released.length === 1 && released[0] === null);
  check('…and the caller gets the statement\'s own result', r1.rows[0].ok === 1 && log.length === 3);

  log.length = 0; released.length = 0;
  nextClient = () => fakeClient({ on: 'SELECT', err: Object.assign(new Error('boom'), { code: '42P01' }) });
  let caught = null;
  await withFleetScope(['egari'], () => pool.query('SELECT broken')).catch((e) => { caught = e; });
  check('a failing statement rolls back and rethrows the original error',
    caught?.message === 'boom' && log.some((l) => l[1] === 'ROLLBACK') && !log.some((l) => l[1] === 'COMMIT'));
  check('…and the connection is returned, not destroyed (the rollback worked)', released.length === 1 && released[0] === null);

  log.length = 0; released.length = 0;
  nextClient = () => fakeClient({ on: 'SELECT', err: new Error('boom'), rollback: true });
  await withFleetScope(['egari'], () => pool.query('SELECT broken')).catch(() => {});
  check('a connection that cannot even roll back is DESTROYED, never pooled inside the reader\'s transaction',
    released.length === 1 && released[0] instanceof Error);

  log.length = 0;
  nextClient = () => fakeClient();
  const viaCb = await new Promise((resolve) => withFleetScope(['egari'],
    () => pool.query('SELECT cb', [], (err, res) => resolve({ err, res }))));
  check('callback style still works inside a scope', !viaCb.err && viaCb.res.rows[0].ok === 1 && log[1][1] === 'SELECT cb');

  let refused = null;
  await withFleetScope(['egari'], () => pool.query({ submit() {} })).catch((e) => { refused = e; });
  check('a streaming query is refused inside a scope, never run unrestricted', /streaming/.test(refused?.message || ''));

  log.length = 0;
  await withFleetScope(['egari'], () => outsideFleetScope(() => pool.query('SELECT company')));
  check('outsideFleetScope() takes the raw path even inside a scope', log.length === 1 && log[0][0] === 'pool');

  /* The scope closes when the response ends: what runs after the answer —
     the access audit on 'finish', the slow-query plan — is unscoped. */
  log.length = 0;
  const res = { end() { return 'ended'; } };
  let afterEnd = null;
  await new Promise((resolve) => enterFleetScope(['egari'], res, async () => {
    await pool.query('SELECT during');
    res.end();
    afterEnd = currentFleetScope();
    await pool.query('SELECT after');
    resolve();
  }));
  check('a statement before res.end() is scoped', log[0][1].startsWith('BEGIN;') && log[1][1] === 'SELECT during');
  check('after res.end() the scope is closed and statements are raw',
    afterEnd === null && log[log.length - 1][0] === 'pool' && log[log.length - 1][1] === 'SELECT after');
}

/* ══ 3. v124 without CREATEROLE: inert, and says why ══════════════════════ */
const asRole = async (pg, role, fn) => { await pg.exec(`SET ROLE ${role}`); try { return await fn(); } finally { await pg.exec('RESET ROLE'); } };
async function buildAs(role) {
  const pg = new PGlite();
  await pg.exec(`CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
                 CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
                 GRANT CREATE ON SCHEMA public TO app_user, app_admin;`);
  const failed = [];
  await asRole(pg, role, async () => {
    for (const f of SCHEMA_FILES) {
      try { await pg.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')); }
      catch (e) { failed.push(`${f}: ${String(e.message).slice(0, 120)}`); }
    }
  });
  return { pg, failed };
}
const fleetTables = async (pg) => (await pg.query(`
  SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
         EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'fm_fleet_scope') AS pol
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attname IN ('fleet_id', 'fleet'))
   ORDER BY 1`)).rows;
const views = async (pg) => (await pg.query(`
  SELECT c.relname, coalesce('security_invoker=true' = ANY (c.reloptions), false) AS inv
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v' ORDER BY 1`)).rows;

console.log('\n3. v124 applied by a user without CREATEROLE (DigitalOcean, a made user)');
const U = await buildAs('app_user');
const upg = U.pg;
const udb = { query: (t, p) => upg.query(t, p) };
{
  check('every schema file applies, v124 included — nothing raised', U.failed.length === 0, U.failed.join(' | '));
  const role = (await upg.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname = '${RLS_ROLE}'`)).rows[0].n;
  check('the role could not be made (no CREATEROLE)', role === 0);
  /* A second boot replays the file; it must still raise nothing. */
  let again = null;
  await asRole(upg, 'app_user', () => upg.exec(readFileSync(new URL('../sql/schema_v124.sql', import.meta.url), 'utf8'))).catch((e) => { again = e; });
  check('…and replaying v124 on the next boot raises nothing either', again === null, String(again));
  const sec = await asRole(upg, 'app_user', () => secureFleetScope(udb));
  check('the boot pass finds nothing to do while the role is missing', sec.ran && sec.objects.length === 0, JSON.stringify(sec).slice(0, 200));
  const t = await fleetTables(upg);
  check('INERT: no table has row-level security switched on', t.length > 40 && t.every((r) => !r.rls && !r.pol));
  check('INERT: no view was changed', (await views(upg)).every((v) => !v.inv));
  const st = await asRole(upg, 'app_user', () => probeFleetScope(udb, pgliteRunner(upg)));
  check('the probe says it is not in use, and the true reason', !st.ready && /no fleet_request role/.test(st.reason)
    && /CREATEROLE/.test(st.reason), st.reason);
}

/* ══ 4. the administrator makes the role; the next boot does the rest ════ */
console.log('\n4. an administrator creates the role; the next boot secures everything');
let firstPass;
{
  await upg.exec(`CREATE ROLE ${RLS_ROLE} NOLOGIN NOINHERIT; GRANT ${RLS_ROLE} TO app_user;`);
  /* A pass out of time leaves the rest to the next boot, said so, and the
     next pass picks up where it stopped. REVERSION: drop the budget test in
     secureFleetScope — nothing is deferred and this check fails. */
  const short = await asRole(upg, 'app_user', () => secureFleetScope(udb, { budgetMs: 0 }));
  const deferred = short.objects.filter((o) => /^deferred: /.test(o.result));
  check('a boot pass out of time defers the rest, saying so (and counts it as short)',
    deferred.length > 50 && deferred.every((o) => securedShort(o.result)), `${deferred.length} of ${short.objects.length}`);
  firstPass = await asRole(upg, 'app_user', () => secureFleetScope(udb));
  const bad = firstPass.objects.filter((o) => securedShort(o.result));
  check('the next pass secured every object left, refused none', firstPass.objects.length > 50 && bad.length === 0,
    bad.slice(0, 3).map((o) => `${o.rel}: ${o.result}`).join(' | '));
  const t = await fleetTables(upg);
  const spine = t.find((r) => r.relname === 'driver');
  const rest = t.filter((r) => r.relname !== 'driver');
  /* §4: "A test fails if any fleet-bearing table lacks a policy." It does,
     here — and for any table a later migration adds, because the boot pass
     secures whatever has a fleet column, and this asserts it over the live
     catalog rather than over a list. */
  check('EVERY fleet-bearing table carries the policy with row-level security on',
    rest.length >= 49 && rest.every((r) => r.rls && r.pol), rest.filter((r) => !(r.rls && r.pol)).map((r) => r.relname).join(','));
  check('…and none is FORCEd (the owner, every unrestricted caller, stays exempt)', rest.every((r) => !r.force));
  check('the person spine (driver) is exempt: rows about a person stay whole', spine && !spine.rls && !spine.pol);
  check('every view runs as the reader (security_invoker)', (await views(upg)).every((v) => v.inv));
  const unreadable = (await upg.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND NOT has_table_privilege('${RLS_ROLE}', c.oid, 'SELECT')`)).rows[0].n;
  check('the role can read every table and view (a scoped page never fails on a grant)', unreadable === 0);
  const writes = (await upg.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND (has_table_privilege('${RLS_ROLE}', c.oid, 'INSERT')
       OR has_table_privilege('${RLS_ROLE}', c.oid, 'UPDATE') OR has_table_privilege('${RLS_ROLE}', c.oid, 'DELETE'))`)).rows[0].n;
  check('…and write nothing at all', writes === 0);
  const again = await asRole(upg, 'app_user', () => secureFleetScope(udb));
  check('a second boot finds nothing to do (one catalog query)', again.objects.length === 0);
  const st = await asRole(upg, 'app_user', () => probeFleetScope(udb, pgliteRunner(upg)));
  check('the probe: in use, and says how much', st.ready && /^In use: \d+ fleet tables/.test(st.reason), st.reason);
}

/* ══ 5. what each caller reads ════════════════════════════════════════════
   REVERSION: in fm_rls_secure, make the policy USING (true) — "reads only
   Egari" fails on the table, the view and the aggregate; drop its
   `current_user <> 'fleet_request' OR` arm — "any other role keeps every row"
   fails (a role that is neither owner nor BYPASSRLS then reads nothing);
   add FORCE ROW LEVEL SECURITY — "none is FORCEd" (section 4) fails. */
console.log('\n5. the policy: the owner, the reader, everybody else');
const usdb = scopedPglite(upg);
{
  await asRole(upg, 'app_user', () => upg.exec(`
    INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine'), ('egari', 'Egari') ON CONFLICT DO NOTHING;
    INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status) VALUES
      ('uber', 't-eco', 'ecosine', 'L1', now(), 'completed'),
      ('uber', 't-ega', 'egari',   'L2', now(), 'completed'),
      ('uber', 't-nul', NULL,      'L3', now(), 'completed');
    INSERT INTO rollup_day (day, platform, fleet_id, bookings) VALUES
      (current_date, '*', '*', 3), (current_date, '*', 'ecosine', 1), (current_date, '*', 'egari', 1)
      ON CONFLICT DO NOTHING;
    INSERT INTO driver (full_name) VALUES ('Test Person A');`));
  const own = async (sql) => asRole(upg, 'app_user', async () => (await upg.query(sql)).rows);
  const scoped = async (fleets, sql) => asRole(upg, 'app_user', () => withFleetScope(fleets, async () => (await usdb.query(sql)).rows));
  const fleetsOf = (rows) => rows.map((r) => r.fleet_id ?? 'NULL').join(',');

  check('the owner reads both fleets and the unattributed trip — today\'s answer, unchanged',
    fleetsOf(await own('SELECT fleet_id FROM trip ORDER BY external_id')) === 'ecosine,egari,NULL');
  check('…through the view as well', fleetsOf(await own('SELECT fleet_id FROM trip_norm ORDER BY external_id')) === 'ecosine,egari,NULL');
  check('a statement that FORGOT its fleet filter, run for an Egari reader, reads only Egari',
    fleetsOf(await scoped(['egari'], 'SELECT fleet_id FROM trip ORDER BY external_id')) === 'egari');
  check('…through trip_norm too (the view runs as the reader)',
    fleetsOf(await scoped(['egari'], 'SELECT fleet_id FROM trip_norm ORDER BY external_id')) === 'egari');
  check('…and an aggregate over the forgotten filter counts Egari alone',
    (await scoped(['egari'], 'SELECT count(*)::int n FROM trip'))[0].n === 1);
  check('the rollups\' all-fleets row is not Egari\'s and is not shown',
    fleetsOf(await scoped(['egari'], `SELECT fleet_id FROM rollup_day WHERE platform = '*' ORDER BY fleet_id`)) === 'egari');
  check('an empty scope reads no fleet\'s rows (closed)', (await scoped([], 'SELECT count(*)::int n FROM trip'))[0].n === 0);
  check('a person row (fleet NULL) is still found: the spine is exempt',
    (await scoped(['egari'], `SELECT count(*)::int n FROM driver WHERE full_name = 'Test Person A'`))[0].n === 1);
  check('a two-fleet scope reads both', fleetsOf(await scoped(['ecosine', 'egari'], 'SELECT fleet_id FROM trip ORDER BY external_id')) === 'ecosine,egari');
  let w = null;
  await scoped(['egari'], `INSERT INTO fleet (id, name) VALUES ('zz', 'nope')`).catch((e) => { w = e; });
  check('a write inside a scope is refused (read-only transaction, SELECT-only role)', /read-only|permission denied/.test(String(w?.message)), String(w?.message));
  const who = await scoped(['egari'], `SELECT current_user::text AS u, current_setting('app.fleets', true) AS f`);
  check('inside: the restricted role, the reader\'s fleets', who[0].u === RLS_ROLE && who[0].f === 'egari');
  const after = await own(`SELECT current_user::text AS u, coalesce(current_setting('app.fleets', true), '') AS f`);
  check('after: back to the owner, the setting gone (SET LOCAL ended with the transaction)', after[0].u === 'app_user' && after[0].f === '');
  /* Two readers at once on one database: each statement is its own
     transaction, so neither sees the other's scope. */
  const [a, b] = await asRole(upg, 'app_user', () => Promise.all([
    withFleetScope(['egari'], async () => (await usdb.query('SELECT fleet_id FROM trip ORDER BY 1')).rows),
    withFleetScope(['ecosine'], async () => (await usdb.query('SELECT fleet_id FROM trip ORDER BY 1')).rows),
  ]));
  check('two scopes in flight together stay apart', fleetsOf(a) === 'egari' && fleetsOf(b) === 'ecosine');
  /* A role this migration cannot see — a reporting login an administrator
     made — that is neither the owner nor BYPASSRLS keeps reading what it read. */
  await upg.exec(`CREATE ROLE report_reader NOLOGIN; GRANT SELECT ON trip, trip_norm TO report_reader;`);
  const other = await asRole(upg, 'report_reader', async () => (await upg.query('SELECT count(*)::int n FROM trip')).rows[0].n);
  check('any other role keeps every row (the policy narrows fleet_request alone)', other === 3);
}

/* ══ 6. the boot pass heals what later migrations undo ════════════════════
   Measured on PGlite: CREATE OR REPLACE VIEW keeps a view's grants and
   RESETS security_invoker — the reader can still read it, now as the owner,
   i.e. every fleet. DROP + CREATE (sql/schema_v53.sql's way, whenever the
   identity register changes) loses both. A migration that adds a fleet table
   adds one with no policy. All three must be found and secured on the next
   boot, which runs right after the migrations and before anything is served.
   REVERSION: delete the view branch of fm_rls_plan — the redefined view is
   not listed and the reader keeps reading every fleet through it. */
console.log('\n6. healing after a view is redefined or rebuilt, and a new fleet table');
const scopedCount = (sql) => asRole(upg, 'app_user', () => withFleetScope(['egari'],
  async () => (await usdb.query(sql)).rows[0].n));
const probeU = () => asRole(upg, 'app_user', () => probeFleetScope(udb, pgliteRunner(upg)));
const planU = () => asRole(upg, 'app_user', async () => (await upg.query('SELECT rel::text, why FROM fm_rls_plan()')).rows);
{
  await asRole(upg, 'app_user', () => upg.exec('CREATE VIEW rls_probe_view AS SELECT fleet_id, external_id FROM trip'));
  await asRole(upg, 'app_user', () => secureFleetScope(udb));
  check('a new view is secured by the pass (it narrows)', await scopedCount('SELECT count(*)::int n FROM rls_probe_view') === 1);

  await asRole(upg, 'app_user', () => upg.exec('CREATE OR REPLACE VIEW rls_probe_view AS SELECT fleet_id, external_id FROM trip'));
  const pv = (await planU()).find((p) => p.rel === 'rls_probe_view');
  check('CREATE OR REPLACE VIEW resets it: listed, with why', pv && pv.why === 'view runs as its owner', JSON.stringify(pv));
  check('…and until the pass the reader DOES read every fleet through it (why the pass exists)',
    await scopedCount('SELECT count(*)::int n FROM rls_probe_view') === 3);
  const st = await probeU();
  check('the probe reports that gap in plain words while it lasts', st.ready && /partly/.test(st.reason)
    && /1 of \d+ views still run as their owner/.test(st.reason), st.reason);
  await asRole(upg, 'app_user', () => secureFleetScope(udb));
  check('after the next boot pass it narrows again', await scopedCount('SELECT count(*)::int n FROM rls_probe_view') === 1);

  await asRole(upg, 'app_user', () => upg.exec('DROP VIEW rls_probe_view; CREATE VIEW rls_probe_view AS SELECT fleet_id, external_id FROM trip'));
  const pv2 = (await planU()).find((p) => p.rel === 'rls_probe_view');
  check('DROP + CREATE loses the grant too: listed, with both reasons',
    pv2 && /not readable by fleet_request/.test(pv2.why) && /runs as its owner/.test(pv2.why), JSON.stringify(pv2));
  const st2 = await probeU();
  check('…and the probe takes the restricted path out of use rather than let a page fail on the grant',
    !st2.ready && /cannot read 1 tables or views/.test(st2.reason), st2.reason);
  await asRole(upg, 'app_user', () => secureFleetScope(udb));
  check('the next pass puts both back', (await probeU()).ready
    && await scopedCount('SELECT count(*)::int n FROM rls_probe_view') === 1);

  await asRole(upg, 'app_user', () => upg.exec(`CREATE TABLE rls_probe_table (id int, fleet_id text);
    INSERT INTO rls_probe_table VALUES (1, 'ecosine'), (2, 'egari');`));
  const pt = (await planU()).find((p) => p.rel === 'rls_probe_table');
  check('a new fleet table is listed, with why', pt && /no fleet policy/.test(pt.why) && /row-level security off/.test(pt.why), JSON.stringify(pt));
  await asRole(upg, 'app_user', () => secureFleetScope(udb));
  check('…and secured by the next pass', await scopedCount('SELECT count(*)::int n FROM rls_probe_table') === 1);
}

/* ══ 7. a role that would narrow nothing is never used ════════════════════
   REVERSION: drop the bypass and owner_like checks in probeFleetScope — a
   BYPASSRLS role reads as "in use" while narrowing nothing. */
console.log('\n7. refusing a restricted role that would not restrict');
{
  await upg.exec(`ALTER ROLE ${RLS_ROLE} BYPASSRLS`);
  const st = await asRole(upg, 'app_user', () => probeFleetScope(udb, pgliteRunner(upg)));
  check('a role that may bypass row-level security is not used, and the probe says so',
    !st.ready && /bypass row-level security/.test(st.reason), st.reason);
  const plan = await asRole(upg, 'app_user', async () => (await upg.query('SELECT count(*)::int n FROM fm_rls_plan()')).rows[0].n);
  check('…and the boot pass leaves the database alone meanwhile', plan === 0);
  await upg.exec(`ALTER ROLE ${RLS_ROLE} NOBYPASSRLS`);
  /* An owner is exempt from row-level security, and so is a role holding
     the owner's rights. NOINHERIT is what stops a stray grant doing that; if
     somebody also turned INHERIT on, the reader would read everything of
     that owner's. (Postgres itself refuses the grant that would make the
     APPLICATION's user such an owner — app_user is a member of
     fleet_request, and membership cannot loop — so a second owner is
     needed to show it.) */
  await upg.exec(`CREATE ROLE other_owner NOLOGIN;
    CREATE TABLE rls_owned (id int, fleet_id text);
    INSERT INTO rls_owned VALUES (1, 'ecosine'), (2, 'egari');
    ALTER TABLE rls_owned OWNER TO other_owner;
    GRANT SELECT ON rls_owned TO ${RLS_ROLE};
    CREATE POLICY fm_fleet_scope ON rls_owned AS PERMISSIVE FOR ALL TO PUBLIC
      USING (current_user <> '${RLS_ROLE}' OR fleet_id = ANY (string_to_array(nullif(current_setting('app.fleets', true), ''), ',')));
    ALTER TABLE rls_owned ENABLE ROW LEVEL SECURITY;
    GRANT other_owner TO ${RLS_ROLE};`);
  check('(NOINHERIT holds: the grant gives the reader none of the owner\'s rights)',
    await scopedCount('SELECT count(*)::int n FROM rls_owned') === 1);
  await upg.exec(`ALTER ROLE ${RLS_ROLE} INHERIT`);
  /* PG 16+ fixes a grant's INHERIT when it is made; grant it afresh. */
  await upg.exec(`REVOKE other_owner FROM ${RLS_ROLE}; GRANT other_owner TO ${RLS_ROLE};`);
  check('(with INHERIT the reader really would read every fleet of that owner\'s)',
    await scopedCount('SELECT count(*)::int n FROM rls_owned') === 2);
  const st2 = await probeU();
  check('…so the probe refuses the role, naming why', !st2.ready && /rights of the owner/.test(st2.reason), st2.reason);
  await upg.exec(`REVOKE other_owner FROM ${RLS_ROLE}; ALTER ROLE ${RLS_ROLE} NOINHERIT; DROP TABLE rls_owned;`);
  const st3 = await probeU();
  check('put right, it is in use again', st3.ready, st3.reason);
}

/* ══ 8. v124 by a CREATEROLE user (DigitalOcean's doadmin) ═══════════════
   On Postgres 16+ the creator of a role holds ADMIN on it but not SET, so
   SET ROLE fails until it grants itself the role — which v124 does.
   REVERSION: delete step 2 of v124 — the trial SET ROLE fails and the probe
   reports "Assuming the fleet_request role failed". */
console.log('\n8. v124 applied by a CREATEROLE user');
{
  const A = await buildAs('app_admin');
  const apg = A.pg;
  const adb = { query: (t, p) => apg.query(t, p) };
  check('every schema file applies', A.failed.length === 0, A.failed.join(' | '));
  const r = (await apg.query(`SELECT rolsuper, rolbypassrls, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = '${RLS_ROLE}'`)).rows[0];
  check('v124 made the role: no login, no inherit, no bypass', r && !r.rolsuper && !r.rolbypassrls && !r.rolinherit && !r.rolcanlogin, JSON.stringify(r));
  const sec = await asRole(apg, 'app_admin', () => secureFleetScope(adb));
  check('the boot pass secures everything', sec.objects.length > 100 && !sec.objects.some((o) => securedShort(o.result)));
  const st = await asRole(apg, 'app_admin', () => probeFleetScope(adb, pgliteRunner(apg)));
  check('and the application can assume the role (v124 granted itself SET)', st.ready, st.reason);
  await asRole(apg, 'app_admin', () => apg.exec(`INSERT INTO fleet (id, name) VALUES ('ecosine','E'), ('egari','G') ON CONFLICT DO NOTHING;
    INSERT INTO trip (platform, external_id, fleet_id, requested_at, status) VALUES ('uber','a','ecosine',now(),'completed'), ('uber','b','egari',now(),'completed');`));
  const owner = await asRole(apg, 'app_admin', async () => (await apg.query('SELECT count(*)::int n FROM trip_norm')).rows[0].n);
  const sdb = scopedPglite(apg);
  let reader = null, readErr = null;
  try {
    reader = await asRole(apg, 'app_admin', () => withFleetScope(['ecosine'], async () => (await sdb.query('SELECT fleet_id FROM trip_norm')).rows));
  } catch (e) { readErr = e; }
  check('the owner reads both; the Ecosine reader reads Ecosine', owner === 2 && reader?.length === 1 && reader[0].fleet_id === 'ecosine',
    String(readErr?.message || JSON.stringify(reader)));
}

/* ══ 9. a company-wide figure computed during a scoped request ═══════════
   api/target_weights.js monthWeights() learns a month's weekday weights from
   EVERY fleet's trips and freezes them into target_weights, a table with no
   fleet. Reached inside a reader's scope, the learning must not read one
   fleet and the freeze must not fail on the read-only transaction: both run
   outside the scope, explicitly. Inert today (no route that reaches it is
   narrowed), and here so that narrowing one later cannot break it.
   REVERSION: in monthWeights call learnWeights(q, from) and q(INSERT …)
   directly — the INSERT fails with "cannot execute INSERT in a read-only
   transaction" and the trips reads are recorded as scoped. */
console.log('\n9. a company-wide figure inside a scope (api/target_weights.js)');
{
  const { monthWeights } = await import('../api/target_weights.js');
  const seen = [];
  const q = async (t, p) => {
    seen.push({ scoped: Boolean(currentFleetScope()), sql: String(t).replace(/\s+/g, ' ').trim() });
    return (await usdb.query(t, p)).rows;
  };
  let err = null, mw = null;
  await asRole(upg, 'app_user', () => withFleetScope(['egari'], async () => {
    try { mw = await monthWeights(q, '2026-11', { now: new Date('2026-11-12T08:00:00Z') }); } catch (e) { err = e; }
  }));
  check('the month\'s weights freeze without error from inside an Egari reader\'s scope', !err && mw && mw.frozen === true,
    String(err?.message || JSON.stringify(mw)).slice(0, 160));
  const trips = seen.filter((s) => /FROM trip_norm/.test(s.sql));
  check('…the learning read the trips OUTSIDE the scope (every fleet, as for everyone)', trips.length > 0 && trips.every((s) => !s.scoped),
    JSON.stringify(trips.map((s) => ({ scoped: s.scoped, sql: s.sql.slice(0, 80) }))));
  const insert = seen.find((s) => /^INSERT INTO target_weights/.test(s.sql));
  check('…and so did the freeze', insert && !insert.scoped, JSON.stringify(insert));
  const rows = (await asRole(upg, 'app_user', async () => (await upg.query(`SELECT count(*)::int n FROM target_weights WHERE month = '2026-11-01'`)).rows[0].n));
  check('one company row was written', rows === 1);
}

/* ══ 10. a process-wide memo reached from a scoped request ═══════════════
   api/performance_routes.js holds its shaped context in a map every caller
   shares, keyed on the question and validated by the data version. Both of
   its routes are 'param', so a one-fleet reader reaches the map from inside
   a scope (independent review of fix/rls, 2026-11-12). The fake q answers
   the version query the way row-level security does — inside an Egari
   scope collection_run shows Egari's runs only, so its max(finished_at) is
   older whenever the other fleet ran last — and records whether the period
   query ran under a scope.
   REVERSION: in load() key on `${grain}|${show}|${fleet || ''}|${w.today}`
   and call dataVersion(q) directly — the reader's request evicts the Owner's
   context ("the Owner's context survives…" fails: periodsSql runs again),
   the version is read inside the scope, and with equal versions the reader
   is handed the Owner's unscoped context. */
console.log('\n10. a shared memo inside a scope (api/performance_routes.js)');
{
  const express = (await import('express')).default;
  const { performanceRoutes } = await import('../api/performance_routes.js');
  let olderInScope = true;
  const versions = [], periods = [];
  const q = async (text) => {
    const s = currentFleetScope();
    if (/FROM collection_run/.test(String(text))) {
      versions.push(s ? s.fleets.join(',') : null);
      return [{ c: s && olderInScope ? '2026-11-12T05:00:00Z' : '2026-11-12T06:00:00Z', r: '2026-11-12T06:00:00Z' }];
    }
    periods.push(s ? s.fleets.join(',') : null);
    return [];
  };
  const app = express();
  app.use((req, res, next) => (req.get('x-scope') ? enterFleetScope(req.get('x-scope').split(','), res, next) : next()));
  performanceRoutes(app, { q, wrap: (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e.message || e) })) });
  const server = app.listen(0);
  const get = async (path, scope) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`,
    { headers: scope ? { 'x-scope': scope } : {} })).status;
  const M = '/api/performance/fleet?fleet=egari&grain=month';
  const statuses = [await get(M, null), await get(M, null)];
  check('setup: the Owner\'s context is computed once and then held', periods.length === 1 && periods[0] === null, JSON.stringify(periods));
  statuses.push(await get(M, 'egari'));
  check('the Egari reader\'s context is computed under the reader\'s scope', periods.length === 2 && periods[1] === 'egari', JSON.stringify(periods));
  statuses.push(await get(M, null));
  check('the Owner\'s context survives the reader\'s request (no periodsSql again)', periods.length === 2, JSON.stringify(periods));
  statuses.push(await get(M, 'egari'));
  check('…and the reader\'s survives the Owner\'s', periods.length === 2, JSON.stringify(periods));
  check('the version is never read inside a scope (it is the company\'s, as the response cache keys on)',
    versions.length >= 4 && versions.every((v) => v === null), JSON.stringify(versions));
  /* Equal versions: the other fleet did not run last. The reader must still
     get a context computed under its own scope, never the Owner's. */
  olderInScope = false;
  const W = '/api/performance/fleet?fleet=egari&grain=week';
  statuses.push(await get(W, null));
  const before = periods.length;
  statuses.push(await get(W, 'egari'));
  check('with equal versions the reader is not handed the Owner\'s unscoped context',
    periods.length === before + 1 && periods[periods.length - 1] === 'egari', JSON.stringify(periods.slice(before - 1)));
  check('every request answered 200', statuses.every((s) => s === 200), JSON.stringify(statuses));
  server.close();
}

/* ══ 11. a table the application reads but may not grant ════════════════
   The brief's own warning: on production "table ownership may differ from
   what you expect". A table owned by another role, which the application
   reads through a plain grant (no grant option), cannot be granted on to
   the restricted role — and GRANT says so with a WARNING, not an error. The
   pass must report that, not "granted SELECT" (independent review of
   fix/rls, 2026-11-12: it did, while the role still could not read it).
   REVERSION: in fm_rls_secure drop the has_table_privilege check after the
   GRANT — the result reads "granted SELECT, refused: must be owner of table
   rls_lent" and the first check fails. */
console.log('\n11. a table the application reads but may not grant on');
{
  await upg.exec(`CREATE ROLE review_owner NOLOGIN;
    CREATE TABLE rls_lent (id int, fleet_id text);
    ALTER TABLE rls_lent OWNER TO review_owner;
    GRANT SELECT ON rls_lent TO app_user;`);
  const sec = await asRole(upg, 'app_user', () => secureFleetScope(udb));
  const o = sec.objects.find((x) => x.rel === 'rls_lent');
  check('the pass says SELECT was NOT granted, naming the owner — never "granted SELECT"',
    o && /^refused: SELECT could not be granted to fleet_request/.test(o.result) && /review_owner/.test(o.result)
      && !/(^|, )granted SELECT/.test(o.result) && securedShort(o.result), JSON.stringify(o));
  const st = await asRole(upg, 'app_user', () => probeFleetScope(udb, pgliteRunner(upg)));
  check('…and the probe keeps the restricted path out of use, with the count', !st.ready && /cannot read 1 tables/.test(st.reason), st.reason);
  await upg.exec('DROP TABLE rls_lent; DROP ROLE review_owner;');
  const st2 = await asRole(upg, 'app_user', () => probeFleetScope(udb, pgliteRunner(upg)));
  check('put right, it is in use again', st2.ready, st2.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
