/* ROW-LEVEL SECURITY AS THE BACKSTOP TO THE API'S FLEET FILTER (ULM-DESIGN §4).
   ═════════════════════════════════════════════════════════════════════════
   THE GAP THIS CLOSES. Until now a one-fleet reader's scope was enforced in
   exactly one place: the access gate rewrites the fleet filter of a 'param'
   route to the reader's fleet (api/access/middleware.js judge()), and the
   handler is trusted to put that filter on every statement it sends. A
   handler that forgets it on one sub-query — a total, a lookup, a "latest day"
   anchor — reads the other fleet, and nothing below the API notices. Every one
   of the 78 'param' GET routes is a place that can happen, and a review of the
   handler is the only thing that has ever looked.

   WHAT THIS ADDS. A request the gate has narrowed to some fleets runs every
   statement it sends inside its own short transaction:

     BEGIN READ ONLY;
     SET LOCAL ROLE fleet_request;          -- owns nothing, cannot bypass RLS
     SET LOCAL app.fleets = 'egari';        -- the reader's fleets
     <the handler's statement>
     COMMIT;

   and sql/schema_v124.sql has given every fleet-bearing table a policy that
   shows `fleet_request` only the rows of the fleets in `app.fleets`. So a
   statement that forgot its fleet filter still cannot read the other fleet:
   Postgres removes those rows before the handler ever sees them.

   WHY A TRANSACTION PER STATEMENT, NOT ONE PER REQUEST. SET LOCAL lasts until
   the end of its transaction and reverts by itself on COMMIT, ROLLBACK, an
   error or a dropped connection — so a pooled connection can never go back to
   the pool still wearing the restricted role and quietly narrow the next
   caller's answer. One transaction per request would serialise a handler's
   parallel statements onto one connection (/api/coverage sends ten at once)
   and would hold a pool slot for the whole request, JavaScript included. The
   cost of the per-statement form is two extra round trips on the same
   connection, about a millisecond each between the app and its database.

   WHY READ ONLY, AND WHY A WRITE IN SCOPE FAILS RATHER THAN RUNNING AS
   BEFORE. Measured in this codebase on 2026-11-12: api/target_weights.js
   monthWeights() LEARNS a month's weekday weights from the trips table and
   FREEZES them into target_weights — a company-wide table with no fleet column
   — the first time any reader opens the month. Under the restricted role the
   learning would read one fleet's trips; had the freeze then run unrestricted
   it would have written one fleet's weights into the company's targets for
   good. A narrowed read feeding a shared write is exactly how row-level
   security could change an answer for every OTHER caller, which it must never
   do. So nothing in scope writes: the transaction is READ ONLY and the role is
   granted SELECT and nothing else. Code that must compute a company-wide
   figure or record a fact during a scoped request says so explicitly with
   outsideFleetScope() (monthWeights does) — a visible, greppable exemption
   instead of a silent one. The scope also closes when the response ends
   (enterFleetScope), so the bookkeeping that runs after it — the access audit,
   the slow-query plan — runs exactly as it always has.

   WHO IS NARROWED, AND WHO IS NOT. Only a request the gate marks: a signed-in
   person or wall screen whose grants cover some fleets but not all, reading
   (GET/HEAD) a 'param' route. Everybody else — the Owner and every all-fleet
   role, the system's warmer and refresher, an anonymous visitor in open mode,
   every write — never enters a scope, so their statements take the pool's own
   query() untouched: the same function, the same connection handling, the same
   SQL text. The collector never enters one either.

   NOT A PERMISSION SYSTEM OF ITS OWN. The gate decides; this only makes the
   database hold the gate's decision. When the role is missing or unusable,
   fleetScopeReady() is false, the gate marks nothing, and the product behaves
   exactly as before — with the true reason in fleetScopeState().reason and in
   the boot log, never a silent absence.

   Pure: no pg import, so the gate and the tests can load it without a pool. */
import { AsyncLocalStorage } from 'node:async_hooks';

/* The restricted role and the setting its policies read. Fixed names, because
   the policy text in sql/schema_v124.sql spells them. */
export const RLS_ROLE = 'fleet_request';
export const RLS_SETTING = 'app.fleets';
/* The policy's name on every fleet-bearing table. */
export const RLS_POLICY = 'fm_fleet_scope';

/* A fleet id is written into the SET LOCAL as a literal (SET takes no bind
   parameters, and the preamble is one simple-protocol round trip), so nothing
   that is not a plain fleet id can ever reach it. Fleet ids are this
   product's own ('ecosine', 'egari'); anything else is refused outright, never
   escaped. */
const FLEET_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export function validFleets(fleets) {
  const list = Array.isArray(fleets) ? fleets : [fleets];
  if (!list.length) return [];
  for (const f of list) {
    if (typeof f !== 'string' || !FLEET_ID.test(f)) {
      throw new Error(`fleet scope: ${JSON.stringify(f)} is not a fleet id`);
    }
  }
  return [...new Set(list)].sort();
}

/* The statements that make a transaction the reader's. An EMPTY list is legal
   and narrows to nothing: the policy then shows no fleet's rows at all, which
   is the closed direction for a reader whose grants name no fleet. */
export function restrictSql(fleets) {
  const list = validFleets(fleets);
  return `SET TRANSACTION READ ONLY; SET LOCAL ROLE ${RLS_ROLE}; `
    + `SET LOCAL ${RLS_SETTING} = '${list.join(',')}'`;
}

/* ── the request's scope ───────────────────────────────────────────────── */
const als = new AsyncLocalStorage();

/* The scope a statement issued right here belongs to, or null. A store whose
   response has ended is no scope: what runs after the answer is bookkeeping. */
export function currentFleetScope() {
  const s = als.getStore();
  return s && s.open ? s : null;
}

/* Run fn with every statement it issues narrowed to `fleets`. */
export function withFleetScope(fleets, fn) {
  const store = { fleets: validFleets(fleets), open: true };
  return als.run(store, fn);
}

/* For an Express request: open the scope for the rest of the chain and close
   it the moment the response is ended, so the access audit (res 'finish'),
   the slow-query plan and anything else that runs after the answer go
   through the pool exactly as before. */
export function enterFleetScope(fleets, res, next) {
  const store = { fleets: validFleets(fleets), open: true };
  const end = res.end;
  res.end = function endFleetScope(...args) {
    store.open = false;
    return end.apply(this, args);
  };
  return als.run(store, next);
}

/* The explicit exemption: a company-wide computation or a bookkeeping write
   that must run unrestricted even inside a scoped request. Every caller says
   in a comment why its figure is not one fleet's. */
export function outsideFleetScope(fn) {
  return als.exit(fn);
}

/* ── running one statement as the reader ───────────────────────────────── */

/* A node-postgres pool: check out a connection, make the transaction the
   reader's in ONE round trip, run the statement with the caller's own
   arguments (text and values, or a config object), COMMIT. Any failure rolls
   back; a connection that cannot even roll back is destroyed rather than
   returned, because a pooled connection must never be left inside the
   reader's transaction. */
export function poolRunner(pool) {
  return async function runRestricted(fleets, args) {
    const sql = `BEGIN; ${restrictSql(fleets)}`;
    const client = await pool.connect();
    let broken;
    try {
      await client.query(sql);
      const r = await client.query(...args);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { broken = e2; }
      throw e;
    } finally {
      client.release(broken);
    }
  };
}

/* The same contract over PGlite, for the tests: one transaction per
   statement, the reader's role and fleets set first. PGlite is one session,
   so its own transaction() is what keeps concurrent statements apart. */
export function pgliteRunner(pg) {
  return async function runRestricted(fleets, args) {
    const [text, values, options] = args;
    const body = restrictSql(fleets);
    return pg.transaction(async (tx) => {
      await tx.exec(body);
      return typeof text === 'object' && text
        ? tx.query(text.text, text.values, options)
        : tx.query(text, values, options);
    });
  };
}

/* A query function that is the raw one outside a scope and the restricted
   runner inside it. Callback style is kept, because pg's Pool.query accepts
   it. A Submittable (a cursor or a stream, which nothing in this codebase
   uses) cannot be run inside the runner's transaction and is refused inside a
   scope rather than run unrestricted. */
export function scopedQuery(rawQuery, runner) {
  return function query(...args) {
    const s = currentFleetScope();
    if (!s) return rawQuery(...args);
    if (args[0] && typeof args[0].submit === 'function') {
      return Promise.reject(new Error('fleet scope: a streaming query cannot run under row-level security'));
    }
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const p = runner(s.fleets, args);
    if (!cb) return p;
    p.then((r) => cb(null, r), (e) => cb(e));
    return undefined;
  };
}

/* Patch a node-postgres pool IN PLACE. Every module in this codebase imports
   the one pool from src/db.js and calls pool.query on it, so the instance is
   the one place a scope can be honoured without touching ninety call sites.
   Outside a scope the patched function forwards its arguments untouched to
   the pool's own query(), bound to the pool — the old path, byte for byte.
   Idempotent. */
export function installFleetScope(pool) {
  if (pool.query && pool.query.fleetScoped) return pool;
  const raw = pool.query.bind(pool);
  const q = scopedQuery(raw, poolRunner(pool));
  q.fleetScoped = true;
  q.raw = raw;
  pool.query = q;
  return pool;
}

/* For tests: a { query } handle over PGlite that honours the scope. */
export function scopedPglite(pg) {
  const raw = (...a) => pg.query(...a);
  return { query: scopedQuery(raw, pgliteRunner(pg)), exec: (s) => pg.exec(s), pg };
}

/* ── is it usable here? ────────────────────────────────────────────────── */

/* Not usable until the boot probe says so. The gate asks this on every
   request, so it must be a plain read. */
let state = Object.freeze({ ready: false, reason: 'Row-level security has not been checked yet: the API is still starting.' });
export const fleetScopeState = () => state;
export const fleetScopeReady = () => state.ready === true;
export function setFleetScopeState(next) {
  state = Object.freeze({ ...next });
  return state;
}

/* The reader's cache namespace. A scoped answer is computed from one fleet's
   rows, so it must never be stored where an unscoped caller would be handed
   it — /api/forecast?fleet=egari computed under the reader's role is not the
   answer the Owner gets for the same address if any statement behind it ever
   reads the other fleet. The key cannot be produced by a request line (every
   URL starts with '/'), and the response cache's stale refresh reads the
   fleets back out of it (api/cache.js pump) to recompute under the same
   scope. */
const RLS_KEY = /^rls:([a-z0-9_,-]*)\|/;
export function rlsCacheKey(fleets, key) {
  return `rls:${validFleets(fleets).join(',')}|${key}`;
}
export function parseRlsCacheKey(key) {
  const m = RLS_KEY.exec(String(key || ''));
  if (!m) return null;
  return { fleets: m[1] ? m[1].split(',') : [], url: String(key).slice(m[0].length) };
}

/* ── the boot pass and the probe ───────────────────────────────────────── */

/* Bring every object up to the policy, ONE OBJECT PER STATEMENT. Each call of
   fm_rls_secure() is its own transaction, so the ACCESS EXCLUSIVE lock that
   ENABLE ROW LEVEL SECURITY, CREATE POLICY and ALTER VIEW take is held for
   one object for a moment — never for fifty at once while the pass waits on
   the fifty-first behind a forty-second rollup. A busy object is skipped
   after lockMs (lock_timeout inside the function) and picked up on the next
   boot; a refused one says why. Never throws: an absent function (the
   migration could not create it) is a reason, not a failure. */
/* Did fm_rls_secure() leave this object short of the policy? Its answer
   lists what it did, then the problem: 'granted SELECT, busy: …'. */
export const securedShort = (result) => /(?:^|, )(?:busy|refused|failed|deferred): /.test(String(result || ''));

/* `budgetMs` bounds the whole pass. It runs before the API serves (the
   migration gate answers 503 meanwhile), and on the first boot with v124 —
   fifty objects, a deploy's old containers still reading them — every busy
   object could cost its full lockMs. What the budget does not reach is
   reported 'deferred' and finished by the next boot, exactly as a busy object
   is. */
export async function secureFleetScope(db, { lockMs = 3000, budgetMs = Infinity } = {}) {
  let plan;
  try {
    plan = (await db.query('SELECT rel::text AS rel, why FROM fm_rls_plan()')).rows;
  } catch (e) {
    return { ran: false, reason: `The row-level security plan could not be read: ${String(e.message || e).slice(0, 200)}`, objects: [] };
  }
  const objects = [];
  const t0 = Date.now();
  for (const p of plan) {
    if (Date.now() - t0 > budgetMs) {
      objects.push({ rel: p.rel, why: p.why, result: 'deferred: the boot pass used its time budget; the next boot continues' });
      continue;
    }
    let result;
    try {
      result = (await db.query('SELECT fm_rls_secure($1::regclass, $2::int) AS r', [p.rel, lockMs])).rows[0]?.r;
    } catch (e) {
      result = `failed: ${String(e.message || e).slice(0, 200)}`;
    }
    objects.push({ rel: p.rel, why: p.why, result: result || 'nothing to do' });
  }
  return { ran: true, objects };
}

/* What the database holds, and whether the restricted path can be used. The
   catalog first, then a trial: assume the role for real, read one fleet table
   under the policy, roll back. `runner` is how the trial runs (poolRunner on
   production, pgliteRunner in the tests), so it proves the exact code path
   the requests will use. Never throws. */
export async function probeFleetScope(db, runner) {
  const out = { ready: false, role: RLS_ROLE, setting: RLS_SETTING };
  try {
    const [role] = (await db.query(
      'SELECT oid, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [RLS_ROLE])).rows;
    const [c] = (await db.query(`
      WITH t AS (
        SELECT c.oid, c.relkind, c.relrowsecurity,
               c.relname <> 'driver'   -- the person spine, exempt (sql/schema_v124.sql)
               AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname IN ('fleet_id', 'fleet')
                          AND a.atttypid IN ('text'::regtype, 'varchar'::regtype)) AS fleet,
               EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = $1) AS policy,
               coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on',
                                              'security_invoker=1', 'security_invoker=yes'], false) AS invoker
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v'))
      SELECT count(*) FILTER (WHERE fleet AND relkind IN ('r', 'p'))::int AS fleet_tables,
             count(*) FILTER (WHERE fleet AND relkind IN ('r', 'p') AND relrowsecurity AND policy)::int AS protected,
             count(*) FILTER (WHERE relkind = 'v')::int AS views,
             count(*) FILTER (WHERE relkind = 'v' AND invoker)::int AS invoker_views,
             (SELECT min(oid::regclass::text) FROM t WHERE fleet AND relkind IN ('r', 'p')
                AND NOT (relrowsecurity AND policy)) AS first_unprotected
        FROM t`, [RLS_POLICY])).rows;
    Object.assign(out, c);
    if (!role) {
      out.reason = `There is no ${RLS_ROLE} role in this database, so row-level security is not in use and the API's own fleet filter is the only one. `
        + 'The application\'s database user could not create it (creating a role needs CREATEROLE). An administrator can: '
        + `CREATE ROLE ${RLS_ROLE} NOLOGIN NOINHERIT; GRANT ${RLS_ROLE} TO <the application's user>; and the next boot finishes the rest.`;
      return out;
    }
    if (role.rolsuper || role.rolbypassrls) {
      out.reason = `The ${RLS_ROLE} role is a superuser or may bypass row-level security, so it would narrow nothing. It is not used.`;
      return out;
    }
    const [g] = (await db.query(`
      SELECT count(*) FILTER (WHERE NOT has_table_privilege($1::oid, c.oid, 'SELECT'))::int AS unreadable,
             count(*) FILTER (WHERE c.relowner = $1::oid OR pg_has_role($1::oid, c.relowner, 'USAGE'))::int AS owner_like
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')`, [role.oid])).rows;
    Object.assign(out, g);
    if (g.owner_like > 0) {
      out.reason = `The ${RLS_ROLE} role owns, or holds the rights of the owner of, ${g.owner_like} tables or views, and an owner is exempt from row-level security. It is not used.`;
      return out;
    }
    if (g.unreadable > 0) {
      out.reason = `The ${RLS_ROLE} role cannot read ${g.unreadable} tables or views (the boot pass could not grant them), so a one-fleet reader's page would fail on them. It is not used.`;
      return out;
    }
    if (!c.fleet_tables) {
      out.reason = 'No fleet-bearing table was found, so there is nothing for row-level security to narrow. It is not used.';
      return out;
    }
    const probe = (await db.query(`
      SELECT c.oid::regclass::text AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = $1)
       ORDER BY 1 LIMIT 1`, [RLS_POLICY])).rows[0]?.rel;
    try {
      await runner([], [`SELECT 1 FROM ${probe ? probe : 'pg_class'} LIMIT 1`]);
    } catch (e) {
      out.reason = `Assuming the ${RLS_ROLE} role failed (${String(e.message || e).slice(0, 160)}), so row-level security is not in use.`;
      return out;
    }
    out.ready = true;
    const gaps = [];
    if (c.protected < c.fleet_tables) gaps.push(`${c.fleet_tables - c.protected} of ${c.fleet_tables} fleet tables do not carry the policy yet (first: ${c.first_unprotected}) — their rows are narrowed only by the API until the next boot secures them`);
    if (c.invoker_views < c.views) gaps.push(`${c.views - c.invoker_views} of ${c.views} views still run as their owner, which row-level security exempts — a statement through them is narrowed only by the API`);
    out.reason = gaps.length
      ? `In use, partly: ${gaps.join('; ')}.`
      : `In use: ${c.protected} fleet tables carry the policy and all ${c.views} views run as the reader.`;
    return out;
  } catch (e) {
    out.ready = false;
    out.reason = `Row-level security could not be checked (${String(e.message || e).slice(0, 160)}), so it is not in use.`;
    return out;
  }
}
