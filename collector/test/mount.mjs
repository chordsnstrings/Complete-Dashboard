/* Mounts the whole API — server.js and every route module — against a database
   handle, exactly the way production does.
   ─────────────────────────────────────────────────────────────────────────
   Three test files were each building this themselves, and they had drifted
   apart: one mounted eight route modules by name while ten shipped, one
   mounted eleven, one defined `endOfDay` differently from the server. A test
   that mounts a different application from the one that ships is testing a
   different application.

   server.js declares its routes at module top level against a live pool, so it
   cannot simply be imported. The routes between the two markers below are
   evaluated as a function body with the helpers injected — the same trick
   route_smoke has used since /api/vehicles shipped 500ing on every call. The
   route modules ARE importable, so they are discovered and mounted rather than
   listed; a module nobody adds to a list is a module nothing executes. */
import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { win, winDays } from '../api/window.js';
import { rollupGrainSql } from '../src/rollup.js';

export const START = "/* ───────────────────────── overview ───────────────────────── */";
export const END = '/* ───────────────── per-driver detail pages ───────────────── */';

export async function mountAll(db, { serverRoutes = true } = {}) {
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  const app = express();
  app.use(express.json());

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    res.status(500).json({ error: 'internal', detail: String(e).slice(0, 300) });
  });
  const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
  /* The window comes from the real module now, not a copy. This file's own
     header warns about helpers here drifting from the server's, and `range`
     was doing exactly that: the server learned to honour `?days=` and this
     copy did not, so a route reading a days window would have passed here
     while returning every trip in production. */
  const range = (req) => {
    const [from, to] = winDays(req);
    return [from, to, req.query.platform || null, req.query.fleet || null];
  };
  const W = (alias = '') => {
    const c = alias ? `${alias}.` : '';
    return `${c}local_day BETWEEN $1::date AND $2::date`
      + ` AND ($3::text IS NULL OR ${c}platform=$3)`
      + ` AND ($4::text IS NULL OR ${c}fleet_id=$4)`;
  };
  const F = W();
  const FB = `${F} AND is_booking`;
  const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;
  const CANON = (col) => `regexp_replace(
    btrim(regexp_replace(lower(${col}), '\\s+', ' ', 'g')),
    '(\\m\\w+)( \\1)+', '\\1', 'g')`;
  const quote = (v) => {
    if (!/^[a-z0-9_]{1,32}$/i.test(String(v))) throw new Error(`unexpected platform name: ${v}`);
    return `'${v}'`;
  };
  const requireAdmin = (_req, _res, next) => next();
  const stub = async () => ({});
  /* describeSettings returns an ARRAY of setting descriptors. Stubbed as {} it
     made /api/settings answer an object, which then read as a shape difference
     against the mock — a finding about the harness, not about the code. */
  const stubList = async () => [];

  const src = readFileSync('api/server.js', 'utf8');
  const injected = {
    q, wrap, range, F, FB, W, DAYWIN, CANON, quote, endOfDay, requireAdmin, win, winDays,
    rollupGrainSql, rollupState: async () => [],
    /* The response cache object server.js closes over. The harness mounts a
       slice of that file, so anything the slice references has to be here —
       and a stub is right rather than the real cache: these tests assert what
       routes RETURN, and a cache between them and the route would have the
       second call answer from the first. */
    cache: { stats: () => ({ hit: 0, miss: 0, skip: 0, entries: 0, version: 'test' }) },
    describeSettings: stubList, setSetting: stub, deleteSetting: stub, loadSettings: stub,
    /* The routes read config for the things an operator can change without a
       deploy — which fleets exist, chiefly. Injected rather than imported so a
       test never depends on what happens to be in the environment's settings
       table; both fleets are present so a route that narrows to one has
       something to narrow to. */
    config: { uber: { orgs: [{ fleet: 'ecosine' }, { fleet: 'egari' }] } },
    insights: { run: stub }, pool: { query: db.query.bind(db) },
    /* Every api/*_sql.js module, discovered rather than listed.
       This was `...(await import('../api/custody_sql.js'))`, one name written
       out by hand — and the day api/income_sql.js arrived, every route in the
       slice that used it threw ReferenceError. The harness reports that as an
       empty body, so nine assertions across three files failed with `undefined`
       and pointed at the queries rather than at this line.

       Same rule as the schema list and the test runner: a file that exists is
       a file that participates. The suffix is the contract — these modules are
       SQL builders and pure helpers, importable with no side effects, which is
       what makes importing all of them safe. */
    ...Object.assign({}, ...await Promise.all(
      readdirSync('api').filter((f) => f.endsWith('_sql.js'))
        .map((f) => import(`../api/${f}`)))),
  };
  /* Evaluate an arbitrary fragment of server.js against the same helpers. Tests
     that want ONE route rather than the whole file slice it out and mount it
     here, so they cannot drift from the real injection set — three of them had,
     and all three broke the moment server.js started using a helper their own
     hand-written list did not name. */
  const mountSource = (fragment) => {
    const names = Object.keys(injected);
    // eslint-disable-next-line no-new-func
    new Function('app', ...names, fragment)(app, ...names.map((k) => injected[k]));
  };
  if (serverRoutes) {
    /* Both markers must be found. indexOf returns -1 when a marker is renamed,
       and slice(-1, n) silently yields a fragment or an empty string — so the
       whole of server.js would stop being mounted and every test over it would
       report a clean 404 instead of an error. Fail loudly instead. */
    const a = src.indexOf(START); const b = src.indexOf(END);
    if (a < 0 || b < 0 || b <= a) {
      throw new Error(`api/server.js route markers not found (start=${a}, end=${b}). `
        + 'Update START/END in test/mount.mjs to match the section comments.');
    }
    mountSource(src.slice(a, b));
  }

  const deps = { q, wrap, range, endOfDay, F, FB, W, DAYWIN, CANON, win, winDays, rollupGrainSql };
  const mounted = [];
  for (const f of readdirSync('api').filter((x) => x.endsWith('_routes.js'))) {
    const mod = await import(`../api/${f}`);
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function' || !/Routes$/.test(name)) continue;
      fn(app, deps);
      mounted.push(`${f}:${name}`);
    }
  }

  /* The real server ends with this, after every route and before the static
     handler: an /api path matching nothing is a 404, not the dashboard. It
     lives outside the START/END slice, so mounting it here is what lets a test
     check the behaviour rather than only its position in the source.

     Only when this harness has mounted the whole app. Express fixes middleware
     order at registration, and a test that passes serverRoutes:false goes on to
     add its slice with mountSource AFTERWARDS — so registering the guard here
     unconditionally put it in front of routes that did not exist yet and turned
     every one of them into a 404. Which is the same shadowing bug the guard was
     written to fix, introduced at the other end. */
  if (serverRoutes) {
    app.use('/api', (req, res) => res.status(404).json({
      error: 'no such endpoint', path: req.originalUrl.split('?')[0],
    }));
  }

  const server = app.listen(0);
  const port = server.address().port;
  return {
    app, q, server, port, mounted, deps, mountSource,
    /* Tolerant of a non-JSON body: an unmounted path gets Express's 404 HTML,
       and a caller that throws on it reports a parse error instead of naming
       the route that is missing. */
    get: async (p) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      const text = await r.text();
      try { return { status: r.status, body: JSON.parse(text) }; }
      catch { return { status: r.status, body: null, raw: text.slice(0, 120) }; }
    },
  };
}

/** Every GET route the application declares, from server.js and every module. */
export function declaredRoutes() {
  const fromServer = [...readFileSync('api/server.js', 'utf8')
    .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]);
  const fromModules = readdirSync('api').filter((f) => f.endsWith('_routes.js'))
    .flatMap((f) => [...readFileSync(`api/${f}`, 'utf8')
      .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]));
  // Probes call live provider APIs over the network; they are covered by their
  // own allowlist test, not by being executed against a fixture.
  return [...new Set([...fromServer, ...fromModules])].filter((r) => !r.startsWith('/api/probe/'));
}
