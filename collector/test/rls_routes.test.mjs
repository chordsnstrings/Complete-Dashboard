/* EVERY 'param' GET ROUTE UNDER ROW-LEVEL SECURITY — what it changes, measured.
   ═════════════════════════════════════════════════════════════════════════
   The gate narrows a one-fleet reader's 'param' routes in the database
   (src/fleet_scope.js). This mounts the whole API (test/mount.mjs) over a
   two-fleet database owned by an ordinary role, as on production, and calls
   every 'param' GET route the gate narrows — all 78 the manifest declares
   but the seven that are actions (cap collector.probe: the six provider
   probes and the plan diagnostic, which the gate leaves unscoped because
   their writes must land) — twice for each fleet: once as before (?fleet=X,
   no scope) and once inside X's scope, as the gate now runs it for a reader
   whose grants cover X alone.

   Two things are asserted.

   1. NOTHING BREAKS. Every route answers with the same status inside the
      scope as outside it. A route that wrote during a read, or read
      something the restricted role may not, would fail here with a 500 —
      the scope's transaction is read-only and the role is SELECT-only.

   2. WHERE AN ANSWER CHANGES, WE KNOW WHY. A route answering for fleet X
      gives the same body inside X's scope unless one of its statements read
      ANOTHER fleet's rows (or the rollups' all-fleets row) — which is
      exactly what the scope removes. Those routes are listed below with
      what each mixed in, as measured on 2026-11-12; every one of them was
      reading the other fleet while answering for one, which a one-fleet
      reader is not meant to see (ULM-DESIGN §4: "a figure never mixes in a
      fleet outside the caller's scope"). A route that starts differing and
      is not on the list fails: either its handler lost a fleet filter (fix
      the filter), or it needs a figure of the company's (compute that part
      outside the scope, explicitly — api/target_weights.js shows how — or
      it is not a 'param' route).

   The data is the shared fixture (test/fixture.mjs, one fleet), with every
   fleet-bearing table split between the two fleets by row position — a
   deterministic split, so the same rows land in the same fleet every run.

   REVERSIONS (each run on 2026-11-12; each failed as named): in
   fm_rls_secure grant SELECT on views only, not tables → every route fails
   inside the scope and "no route breaks" fails; make the policy USING
   (true) → nothing narrows, and "the scope does narrow" and section 2 fail. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { seedFleet } from './fixture.mjs';
import { refreshRollups } from '../src/rollup.js';
import { secureFleetScope, probeFleetScope, pgliteRunner, scopedPglite, enterFleetScope, RLS_ROLE } from '../src/fleet_scope.js';
import { READ_CAPS } from '../api/access/middleware.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Measured 2026-11-12, both readers. What each mixed in from the other fleet. */
const KNOWN = {
  '/api/compare': 'the collectors list names the other fleet\'s collectors',
  '/api/compliance/drivers': 'rows_with_a_date counts the other fleet\'s accounts',
  '/api/drivers/directory': 'a person\'s state, licence and rating are read from their accounts in the other fleet',
  '/api/economics/assets': 'alert coverage is measured over every fleet\'s alerts; a car\'s alerts and last position include rows filed under the other fleet',
  '/api/economics/drivers': 'the same alert coverage; a driver\'s alert distance and licence state include the other fleet',
  '/api/revenue': 'a platform\'s collection status is the other fleet\'s latest run',
  '/api/roster': 'a person\'s fleets worked, plates and lifetime trips include the other fleet',
  '/api/unauthorized/attributed': 'the attribution evidence (a driver\'s last trip) uses trips in the other fleet',
};
/* Bodies not comparable, with the reason. Their STATUS is still compared:
   a route that fails inside the scope fails here whatever its body. */
const SKIP = {
  '/api/online/hours': 'carries the current clock (live_to), which moves between the two calls',
  '/api/export/money.xlsx': 'a workbook stamps the second it was made inside the file, so two calls a second apart differ',
};
/* Fields that differ between any two calls (timings), never data. */
const VOLATILE = new Set(['wall_ms', 'live_to', 'took_ms', 'ms']);

const pg = new PGlite();
await pg.exec(`CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
               GRANT CREATE ON SCHEMA public TO app_user;
               CREATE ROLE ${RLS_ROLE} NOLOGIN NOINHERIT;
               GRANT ${RLS_ROLE} TO app_user;
               SET ROLE app_user;`);
await applySchema(pg);
await seedFleet(pg);
await pg.exec(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine'), ('egari', 'Egari') ON CONFLICT DO NOTHING`);
const tabs = (await pg.query(`
  SELECT c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname IN ('fleet_id', 'fleet') AND NOT a.attisdropped
     AND c.relname NOT LIKE 'rollup\\_%' ORDER BY 1`)).rows;
let moved = 0;
for (const { relname, attname } of tabs) {
  /* Every other row by physical position: deterministic for a deterministic
     fixture, and independent of timestamps the fixture takes from now(). */
  const r = await pg.query(`UPDATE ${relname} SET ${attname} = 'egari'
    WHERE ${attname} = 'ecosine' AND ((ctid::text::point)[1])::int % 2 = 0`);
  moved += r.affectedRows || 0;
}
await refreshRollups({ db: pg });
const db = { query: (t, p) => pg.query(t, p) };
await secureFleetScope(db);
const state = await probeFleetScope(db, pgliteRunner(pg));
check('setup: two fleets of data, row-level security in use', moved > 100 && state.ready, `${moved} rows moved; ${state.reason}`);

const h = await mountAll(scopedPglite(pg), {
  pre: (app) => app.use((req, res, next) => (req.get('x-test-scope')
    ? enterFleetScope(req.get('x-test-scope').split(','), res, next) : next())),
});
const manifest = JSON.parse(readFileSync('api/access/manifest.json', 'utf8'));
/* Exactly the routes the gate marks: GET 'param', no action cap but a read
   one (api/access/middleware.js). None has a path parameter today. */
const routes = Object.values(manifest.routes || manifest)
  .filter((r) => r.method === 'GET' && r.fleet === 'param' && !r.path.includes(':') && (!r.cap || READ_CAPS.has(r.cap)))
  .map((r) => r.path).sort();
const call = async (p, scope) => {
  const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { headers: scope ? { 'x-test-scope': scope } : {} });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json: compare text */ }
  return { status: r.status, body, text };
};
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, strip(x)])) : v);
const same = (a, b) => (a.body !== null && b.body !== null
  ? JSON.stringify(strip(a.body)) === JSON.stringify(strip(b.body)) : a.text === b.text);

console.log(`\n1. every 'param' GET route (${routes.length}), as each fleet's reader`);
const statusBroken = [];
const changed = new Map();
for (const path of routes) {
  for (const fleet of ['egari', 'ecosine']) {
    const p = `${path}?fleet=${fleet}&from=2026-08-01&to=2026-08-31`;
    const before = await call(p, null);
    const scoped = await call(p, fleet);
    if (before.status !== scoped.status || scoped.status >= 500) {
      statusBroken.push(`${path} (${fleet}): ${before.status} before, ${scoped.status} scoped — ${scoped.text.slice(0, 160)}`);
    } else if (!SKIP[path] && !same(before, scoped)) {
      changed.set(path, [...(changed.get(path) || []), fleet]);
    }
  }
}
check('no route breaks inside the scope: the same status for every route and both fleets, never a 500',
  statusBroken.length === 0, `\n      ${statusBroken.join('\n      ')}`);
const unexplained = [...changed.keys()].filter((p) => !KNOWN[p]);
check('every answer that changes is one we can explain (it mixed another fleet in)',
  unexplained.length === 0, `\n      not on the list: ${unexplained.join(', ')} — see this file's header`);
const narrowed = Object.keys(KNOWN).filter((p) => changed.has(p));
check(`the scope does narrow: ${narrowed.length} of the ${Object.keys(KNOWN).length} routes known to mix fleets change here`,
  narrowed.length >= 6, `changed: ${[...changed.keys()].join(', ')}`);
console.log(`     unchanged: ${routes.length - Object.keys(SKIP).length - changed.size} · changed: ${[...changed.entries()].map(([p, f]) => `${p} (${f.join('+')})`).join(', ')}`);

/* ══ 2. why a 'rows' route is left to the shaper ═════════════════════════
   The gate narrows 'param' routes in the database and NOT 'rows' ones
   (api/access/middleware.js). A 'rows' answer is computed over every fleet
   and trimmed by the shaper — and some of its per-row figures need the
   company. /api/lowperf is the measured case: a day's plan is the COMPANY's
   target, and each driver's share of it is that plan over the drivers active
   that day across the company. Inside one fleet's scope the active count
   falls to that fleet's, and every share would grow by the same factor —
   wrong numbers, not narrower ones. This pins the reason the line is drawn
   where it is; it fails if a later change makes the count fleet-blind. */
console.log('\n2. why \'rows\' routes are not narrowed in the database');
{
  const p = '/api/lowperf?from=2026-08-01&to=2026-08-31';
  const all = await call(p, null);
  const one = await call(p, 'egari');
  const days = (r) => new Map((r.body?.days || []).map((d) => [d.day, d.active]));
  const a = days(all), b = days(one);
  const shrunk = [...a.entries()].filter(([d, n]) => Number.isFinite(n) && Number.isFinite(b.get(d)) && b.get(d) < n);
  check('/api/lowperf: inside one fleet\'s scope the drivers active on a day — the divisor of the company\'s plan — shrink',
    all.status === 200 && one.status === 200 && shrunk.length > 0,
    `${all.status}/${one.status}; first days: ${JSON.stringify([...a.entries()].slice(0, 3))} vs ${JSON.stringify([...b.entries()].slice(0, 3))}`);
  if (shrunk.length) console.log(`     e.g. ${shrunk[0][0]}: ${shrunk[0][1]} drivers active across the company, ${b.get(shrunk[0][0])} inside Egari's scope`);
}

h.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
