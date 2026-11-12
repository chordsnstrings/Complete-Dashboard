/* ROW-LEVEL SECURITY THROUGH THE REAL GATE — who is narrowed, who is not.
   ═════════════════════════════════════════════════════════════════════════
   The access layer mounted exactly as api/server.js mounts it — identify,
   gate, the response cache, then rlsScope, then the routes — over real HTTP
   with real session cookies, against a PGlite database whose tables are
   owned by an ordinary login role (app_user), as on production, with
   sql/schema_v124.sql applied and the boot pass run. test/mount.mjs stubs the
   access layer out; this file must not, so it builds its own app the way
   test/access_core.test.mjs does. Synthetic people only (@example.test).

   The route under test FORGETS its fleet filter on purpose: it reads every
   trip whatever ?fleet= says. That is the failure row-level security exists
   for, and it shows each caller's path plainly — narrowed by the database,
   or exactly what it read before.

   Every block names the reversion that proves it. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from './schema.mjs';
import { accessLayer } from '../api/access/middleware.js';
import { lookupEntry } from '../api/access/manifest.js';
import * as svc from '../api/access/service.js';
import { responseCache } from '../api/cache.js';
import { internalHeaders } from '../api/access/internal.js';
import {
  scopedPglite, pgliteRunner, secureFleetScope, probeFleetScope, setFleetScopeState, fleetScopeState,
  currentFleetScope, RLS_ROLE,
} from '../src/fleet_scope.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the database, owned by an ordinary role ─────────────────────────── */
const pg = new PGlite();
await pg.exec(`CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
               GRANT CREATE ON SCHEMA public TO app_user;
               CREATE ROLE ${RLS_ROLE} NOLOGIN NOINHERIT;
               GRANT ${RLS_ROLE} TO app_user;
               SET ROLE app_user;`);
for (const f of SCHEMA_FILES) await pg.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
const db = scopedPglite(pg);              // ONE handle for everything, as production has one pool
await secureFleetScope(db);
setFleetScopeState(await probeFleetScope(db, pgliteRunner(pg)));
check('setup: row-level security is in use on this database', fleetScopeState().ready, fleetScopeState().reason);
await pg.exec(`
  INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine'), ('egari', 'Egari') ON CONFLICT DO NOTHING;
  INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status) VALUES
    ('uber', 'g-1', 'ecosine', 'L1', now(), 'completed'),
    ('uber', 'g-2', 'egari',   'L2', now(), 'completed'),
    ('uber', 'g-3', NULL,      'L3', now(), 'completed');
  INSERT INTO collection_run (source, fleet_id, mode, status, finished_at) VALUES ('uber', 'ecosine', 'incremental', 'ok', now() - interval '1 hour');`);

/* ── the routes, declared the way the manifest declares them ─────────── */
const base = { carries: ['BK'], grain: 'list', fields: [], whole: [], fleetRows: [], fleetKey: '', cap: null };
const MANIFEST = {
  'GET /api/t/forgot': { ...base, method: 'GET', path: '/api/t/forgot', subject: 'BK', fleet: 'param' },
  'GET /api/t/export': { ...base, method: 'GET', path: '/api/t/export', subject: 'BK', fleet: 'param', cap: 'export', auditRead: true },
  'GET /api/t/rows': { ...base, method: 'GET', path: '/api/t/rows', subject: 'BK', fleet: 'rows', fleetRows: ['rows'], fleetKey: 'fleet_id' },
  'GET /api/t/global': { ...base, method: 'GET', path: '/api/t/global', subject: 'BK', grain: 'aggregate', fleet: 'global' },
  /* Like the provider probes: a GET that acts (cap collector.probe) and
     records what it learned as it goes (src/auth_state.js noteCredential). */
  'GET /api/t/probe': { ...base, method: 'GET', path: '/api/t/probe', subject: 'CRED', carries: ['CRED'], grain: 'aggregate',
    fleet: 'param', cap: 'collector.probe' },
};
const lookup = (m, p) => { const real = lookupEntry(m, p); return real?.self ? real : MANIFEST[`${m} ${p}`] || null; };

const app = express();
app.use(express.json());
const layer = accessLayer({ db, lookup });
app.use(layer.identify);
app.use(layer.gate);
const cache = responseCache({ pool: db, ttlMs: 0 });   // the version re-read on every request (8b of access_core)
app.use('/api', cache);
app.use(layer.rlsScope);                                 // after the cache, as in api/server.js
const calls = [];
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: 'internal', detail: String(e.message || e) }));
/* Reads every trip: the fleet filter is "forgotten". */
const everyTrip = async () => (await db.query('SELECT fleet_id, external_id FROM trip_norm ORDER BY external_id')).rows;
for (const p of ['/api/t/forgot', '/api/t/export', '/api/t/global']) {
  app.get(p, wrap(async (req, res) => {
    calls.push({ path: p, asked: req.query.fleet ?? null, scope: currentFleetScope()?.fleets?.join(',') ?? null,
      refresh: req.get('x-fm-rls') ?? null });
    res.json({ asked: req.query.fleet ?? null, rows: await everyTrip() });
  }));
}
app.get('/api/t/probe', wrap(async (req, res) => {
  calls.push({ path: '/api/t/probe', scope: currentFleetScope()?.fleets?.join(',') ?? null });
  await db.query(`INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ('rls-test', $1, 'probe', 'seen', now())
                  ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [req.query.fleet]);
  res.json({ fleet: req.query.fleet, rows: await everyTrip() });
}));
app.get('/api/t/rows', wrap(async (req, res) => {
  calls.push({ path: '/api/t/rows', scope: currentFleetScope()?.fleets?.join(',') ?? null });
  res.json({ rows: await everyTrip() });
}));
const server = app.listen(0);
server.keepAliveTimeout = 0;
const B = `http://127.0.0.1:${server.address().port}`;
cache.setPort(server.address().port);

/* ── the callers ─────────────────────────────────────────────────────── */
const cfg = await svc.getConfig(db);
const person = async (email, fleets, roleCode = 'OPS') => {
  const u = await svc.createUser(db, { email, name: email, status: 'active' });
  await svc.createGrant(db, { userId: u.id, roleCode, fleets });
  const { token } = await svc.createSession(db, { userId: u.id, mfaOk: true, cfg });
  return `fm_sid=${encodeURIComponent(token)}`;
};
const everyFleet = await person('all-fleets@example.test', null);
const egariOnly = await person('egari-only@example.test', ['egari']);
/* Connections admin over Egari alone: holds collector.probe for one fleet. */
const egariConnections = `${await person('egari-connections@example.test', ['egari'], 'CON')}; fm_csrf=rls-test-csrf`;
const get = async (path, { cookie = null, headers = {} } = {}) => {
  const r = await fetch(B + path, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json, h: r.headers };
};
const fleetsIn = (r) => (r.json?.rows || []).map((x) => x.fleet_id ?? 'NULL').join(',');
const lastCall = () => calls[calls.length - 1];

/* ══ 1. the one-fleet reader ══════════════════════════════════════════════
   REVERSION: in the gate, delete the markScoped() call for 'param' routes —
   the reader is served all three trips and every check here fails. */
console.log('\n1. a reader with one fleet: the database holds the gate\'s decision');
{
  const r = await get('/api/t/forgot', { cookie: egariOnly });
  check('the gate rewrote the filter to the reader\'s fleet', r.status === 200 && r.json.asked === 'egari', JSON.stringify(r.json));
  check('a handler that FORGOT the filter still returns only Egari\'s rows', fleetsIn(r) === 'egari', fleetsIn(r));
  check('the statements ran in the reader\'s scope', lastCall().scope === 'egari');
  check('the answer says it was narrowed in the database (x-fm-rls)', r.h.get('x-fm-rls') === 'egari');
  const ex = await get('/api/t/export', { cookie: egariOnly });
  check('a download (a read with a cap) is narrowed the same way', ex.status === 200 && fleetsIn(ex) === 'egari', `${ex.status} ${fleetsIn(ex)}`);
  /* The access audit is written on 'finish', after the scope has closed —
     through the same query-only handle, so an INSERT still inside the
     read-only scope would have failed. */
  await new Promise((r2) => setTimeout(r2, 100));
  const audit = (await pg.query(`SELECT count(*)::int n FROM access_audit WHERE subject_id = 'GET /api/t/export'`)).rows[0].n;
  check('…and its audit row is still written (the scope closed with the response)', audit === 1, `rows ${audit}`);
}

/* ══ 2. everybody the API does not narrow: exactly as before ══════════════
   REVERSION: mark every GET in the gate (drop the !access.allScope test) —
   the all-fleet reader is narrowed and "both fleets" fails. */
console.log('\n2. everybody else reads exactly what they read before');
{
  const all = await get('/api/t/forgot?fleet=egari', { cookie: everyFleet });
  check('an all-fleet reader: no scope, every row the handler read', fleetsIn(all) === 'ecosine,egari,NULL' && lastCall().scope === null, fleetsIn(all));
  check('…and no x-fm-rls header', all.h.get('x-fm-rls') === null);
  const anon = await get('/api/t/forgot?fleet=egari');
  check('an anonymous visitor in open mode: no scope, every row', anon.status === 200 && fleetsIn(anon) === 'ecosine,egari,NULL' && lastCall().scope === null, `${anon.status} ${fleetsIn(anon)}`);
  const sys = await get('/api/t/forgot?fleet=egari&warm=1', { headers: internalHeaders() });
  check('the system (the warmer): no scope, every row', fleetsIn(sys) === 'ecosine,egari,NULL' && lastCall().scope === null, fleetsIn(sys));
  const rows = await get('/api/t/rows', { cookie: egariOnly });
  check('a \'rows\' route for the one-fleet reader is NOT narrowed in the database (the shaper trims it, as before)',
    lastCall().scope === null && rows.h.get('x-fm-rls') === null);
  check('…and the shaper still drops the other fleet\'s rows and says how many', fleetsIn(rows) === 'egari' && rows.json._withheld?.FLEET === '2',
    `${fleetsIn(rows)} ${JSON.stringify(rows.json._withheld)}`);
  const glob = await get('/api/t/global', { cookie: egariOnly });
  check('a \'global\' route is not narrowed (the company\'s by definition)', glob.status === 200 && lastCall().scope === null);
  /* REVERSION: drop the READ_CAPS condition from the gate's marking — the
     probe runs in the reader's read-only scope, its bookkeeping INSERT fails
     and the call 500s. */
  const probe = await get('/api/t/probe', { cookie: egariConnections, headers: { 'x-fm-csrf': 'rls-test-csrf' } });
  check('a GET that ACTS (a provider probe, cap collector.probe) is not narrowed: its writes must land',
    probe.status === 200 && lastCall().scope === null && probe.h.get('x-fm-rls') === null,
    `${probe.status} ${JSON.stringify(probe.json).slice(0, 160)}`);
  const noted = (await pg.query(`SELECT count(*)::int n FROM source_state WHERE source = 'rls-test' AND fleet_id = 'egari'`)).rows[0].n;
  check('…and what it recorded was written', noted === 1);
}

/* ══ 3. the response cache keeps the two apart ════════════════════════════
   REVERSION: in markScoped, keep req.fmCacheKey as it was (no rlsCacheKey) —
   the all-fleet reader is handed the reader's narrowed answer from the cache
   for the same address and "every row" fails; the reverse hands the reader
   the unscoped one. */
console.log('\n3. the response cache never hands one\'s answer to the other');
{
  const q = '/api/t/forgot?fleet=egari&k=cache';
  calls.length = 0;
  const a = await get('/api/t/forgot?k=cache', { cookie: egariOnly });     // rewritten to ?k=cache&fleet=egari
  const b = await get(q, { cookie: everyFleet });
  check('the reader first: computed under the scope', a.h.get('x-cache') === 'miss' && fleetsIn(a) === 'egari');
  check('the all-fleet reader at the very same address is NOT given the reader\'s answer',
    b.h.get('x-cache') === 'miss' && fleetsIn(b) === 'ecosine,egari,NULL', `${b.h.get('x-cache')} ${fleetsIn(b)}`);
  const a2 = await get('/api/t/forgot?k=cache', { cookie: egariOnly });
  const b2 = await get(q, { cookie: everyFleet });
  check('each is then served its own answer from the cache', a2.h.get('x-cache') === 'hit' && fleetsIn(a2) === 'egari'
    && b2.h.get('x-cache') === 'hit' && fleetsIn(b2) === 'ecosine,egari,NULL', `${a2.h.get('x-cache')} ${fleetsIn(a2)} | ${b2.h.get('x-cache')} ${fleetsIn(b2)}`);
  check('the cache\'s own version query is unscoped: both are told the same data version',
    a2.h.get('x-data-version') && a2.h.get('x-data-version') === b2.h.get('x-data-version'),
    `${a2.h.get('x-data-version')} vs ${b2.h.get('x-data-version')}`);
}

/* ══ 4. the stale refresh recomputes under the same scope ════════════════
   The cache answers a stale entry at once and refreshes it in the
   background by fetching the key as a URL, as the system. For a scoped key
   it must recompute under the same scope and file it under the same key.
   REVERSION: in api/cache.js pump, fetch `key` as before — the refresh
   requests "rls:egari|/api/…" (no such address), the entry is never renewed,
   and "the refreshed answer has the new Egari trip" fails. */
console.log('\n4. the stale refresh of a scoped answer');
{
  const p = '/api/t/forgot?k=stale';
  await get(p, { cookie: egariOnly });                                   // cached under the reader's key
  await pg.exec(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status) VALUES
      ('uber', 'g-4', 'egari', 'L4', now(), 'completed'), ('uber', 'g-5', 'ecosine', 'L5', now(), 'completed');
    INSERT INTO collection_run (source, fleet_id, mode, status, finished_at) VALUES ('uber', 'egari', 'incremental', 'ok', now());`);
  calls.length = 0;
  const s = await get(p, { cookie: egariOnly });
  check('the version moved: the reader is handed the stale copy at once', s.h.get('x-cache') === 'stale' && fleetsIn(s) === 'egari');
  for (let i = 0; i < 50 && !calls.some((c) => c.refresh); i++) await new Promise((r) => setTimeout(r, 40));
  const rc = calls.find((c) => c.refresh);
  check('the background refresh ran as the system, naming the reader\'s fleets', rc && rc.refresh === 'egari', JSON.stringify(calls));
  check('…and its statements ran in the reader\'s scope', rc && rc.scope === 'egari');
  await new Promise((r) => setTimeout(r, 100));
  const h = await get(p, { cookie: egariOnly });
  check('the refreshed answer is a hit with the new Egari trip and not the new Ecosine one',
    h.h.get('x-cache') === 'hit' && fleetsIn(h) === 'egari,egari' && h.json.rows.some((x) => x.external_id === 'g-4')
      && !h.json.rows.some((x) => x.external_id === 'g-5'), `${h.h.get('x-cache')} ${JSON.stringify(h.json.rows)}`);
  /* The header is honoured from the process itself only. */
  const forged = await get('/api/t/forgot?fleet=egari&k=forged', { cookie: everyFleet, headers: { 'x-fm-rls': 'egari' } });
  check('an outside caller sending x-fm-rls is not narrowed by it (and cannot pick a scope)',
    fleetsIn(forged) === 'ecosine,egari,NULL,egari,ecosine' && forged.h.get('x-fm-rls') === null && lastCall().scope === null,
    `${fleetsIn(forged)} ${forged.h.get('x-fm-rls')}`);
}

/* ══ 5. not in use: the product as it was ═════════════════════════════════
   With the role unusable the probe says so and the gate marks nothing: the
   one-fleet reader is back on the API's filter alone — which is exactly the
   leak this whole change exists to stop, shown here so the difference is on
   the record. */
console.log('\n5. when row-level security is not in use');
{
  const saved = fleetScopeState();
  setFleetScopeState({ ready: false, reason: 'test: not in use' });
  const r = await get('/api/t/forgot?k=off', { cookie: egariOnly });
  check('the gate marks nothing (no x-fm-rls, no scope)', r.h.get('x-fm-rls') === null && lastCall().scope === null);
  check('…and the forgotten filter reads every fleet again — the API\'s filter alone, as before this change',
    fleetsIn(r) === 'ecosine,egari,NULL,egari,ecosine', fleetsIn(r));
  setFleetScopeState(saved);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
