/* The driver-day roll-up, inside its statement timeout (2026-11-25).
   ──────────────────────────────────────────────────────────────────────────
   driver_day hit the 120 s statement timeout on production three times on
   25 Nov (two 14-day passes, one full pass at boot). Measured on a local
   Postgres 16 at production scale (729k trips, 1.07M timeline events), the
   statement spent its time in three places, and each is changed:
     · JIT compiling the identity register's CASE, 7.6 s of a 14-day pass:
       the statement now runs with JIT off, on one pooled connection;
     · that CASE (around two regexes) evaluated on every trip, twice, and on
       every statement and payout row: the stored person_key is read instead
       (the same register; test/person_key.test.mjs holds the two equal);
     · every timeline event ever recorded, sorted and windowed on every pass:
       a narrow pass now reads only what a span reaching its first day can be
       built from (api/online_span_sql.js, since).
   Full pass 47.6 s → 21.0 s, 14-day pass 11.5 s → 1.7 s, and the table
   identical row for row before and after, at that scale.

     §1  a narrow pass rebuilds, for every day it rewrites, exactly what a full
         pass (which reads every event) computed — on the shapes a bound gets
         wrong: an ONLINE closed after midnight, an open-ended ONLINE the
         evening before, a span running for days, a job across midnight, a
         blank status, an event exactly at midnight;
     §2  people still fold: register ids, spellings, a statement with no
         account id, a payout under a register id;
     §3  the statement reads the stored key and the bound (on the old code
         this fails: the register's CASE appeared five times, ev_floor never);
     §4  JIT is switched off on one connection and reset before it goes back;
         a full pass also gets a longer statement timeout there (the boot's
         full pass on production took 106 s after the change, against 120 s).

   Synthetic data only; the register ids are read from api/identity_map.js. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshDriverDays, queryWithoutJit } from '../src/rollup.js';
import { identityCase } from '../api/identity_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
const seen = [];
const db = { query: (t, p) => { seen.push(t); return pg.query(t, p); } };
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
const REG = [...identityCase('x', 'y').matchAll(/WHEN '([^']+)'/g)].map((m) => m[1]);

const SINCE = '2026-10-11';
const ev = (d, at, kind, status, job = null) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state, job_ext_id, collected_at)
   VALUES ('uber', 'ecosine', $1, $2::timestamptz, $3, $4, $4, $5, now())`, [d, at, kind, status, job]);
await ev('a', '2026-10-10 23:50+04', 'status', 'ONLINE'); await ev('a', '2026-10-11 00:30+04', 'status', 'OFFLINE');
await ev('b', '2026-10-09 10:00+04', 'status', 'ONLINE'); await ev('b', '2026-10-10 23:00+04', 'status', 'ONLINE');
await ev('c', '2026-10-10 23:40+04', 'status', 'ONLINE'); await ev('c', '2026-10-10 23:55+04', 'job', '', 'j1');
await ev('c', '2026-10-11 00:10+04', 'job', '', 'j1'); await ev('c', '2026-10-11 01:00+04', 'status', 'OFFLINE');
await ev('d', '2026-10-01 20:00+04', 'status', 'OFFLINE'); await ev('d', '2026-10-05 20:00+04', 'status', 'ONLINE');
await ev('d', '2026-10-12 08:00+04', 'status', 'OFFLINE');
await ev('e', '2026-10-10 22:00+04', 'status', 'ONLINE'); await ev('e', '2026-10-10 23:30+04', 'status', '');
await ev('e', '2026-10-11 02:00+04', 'status', 'OFFLINE');
await ev('f', '2026-10-10 21:00+04', 'status', 'ONLINE'); await ev('f', '2026-10-11 00:00+04', 'status', 'ONLINE');
await ev('f', '2026-10-11 03:00+04', 'status', 'OFFLINE');
await ev('g', '2026-10-12 09:00+04', 'status', 'ONLINE'); await ev('g', '2026-10-12 11:00+04', 'status', 'OFFLINE');
await ev(REG[0], '2026-10-10 23:00+04', 'status', 'ONLINE'); await ev(REG[0], '2026-10-11 01:00+04', 'status', 'OFFLINE');

let n = 0;
const trip = (d, name, at, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km, payment_type)
   VALUES ('uber', $1, 'ecosine', $2, $3, $4::timestamptz, $4::timestamptz + interval '15 minutes', 'completed', $5, 5, 'cash')`,
  [`t${(n += 1)}`, d, name, at, price]);
await trip(REG[0], 'Some  Name   HERE', '2026-10-11 09:00+04', 40);
await trip(REG[0], 'some name here', '2026-10-12 09:00+04', 30);
await trip(REG[1], 'Other Person', '2026-10-11 10:00+04', 25);
await trip(REG[1], 'Other Person', '2026-10-01 10:00+04', 25);
await trip('a', 'Edge A', '2026-10-11 00:05+04', 20);
await trip('c', 'Edge C', '2026-10-10 23:58+04', 33);
await trip('d', null, '2026-10-12 09:00+04', 12);
await trip('h', 'Twin Account', '2026-10-12 12:00+04', 10);
await trip('h2', 'twin   account', '2026-10-12 13:00+04', 11);
await trip('h2', 'Twin Account', '2026-10-12 14:00+04', 12);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day, gross, fees, net, tips, salik, cash, trips, source, pseudo, period_days)
  VALUES ('uber','ecosine','TWIN account',NULL,'2026-10-12',100,10,90,0,0,0,2,'uber_api',false,1),
         ('uber','ecosine','Other Person',$1,'2026-10-11',50,5,45,0,0,0,1,'uber_api',false,1),
         ('uber','ecosine','Nobody Seen',NULL,'2026-10-13',70,7,63,0,0,0,1,'uber_api',false,7)`, [REG[1]]);
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day, period_start, period_end, period_days, earnings, cash_earnings)
  VALUES ('bolt','egari',$1,'Bolt  Register Guy','2026-10-11','2026-10-11','2026-10-11',1,80,10),
         ('bolt','egari',$2,'some name here','2026-10-12','2026-10-12','2026-10-12',1,60,5)`, [REG[2], REG[0]]);
await q(`INSERT INTO collection_run (source, fleet_id, status, started_at, finished_at)
  VALUES ('uber_timeline','ecosine','ok', now() - interval '2 minutes', now() - interval '1 minute')`);

const COLS = `driver_ext_id, day::text, fleet_id, platforms, plates, trips, completed, cancelled, km, fares, first_min, last_min,
  span_min, on_job_min, wait_min, longest_wait_min, unknown_end, online_min, idle_online_min, stmt_gross, stmt_fees, stmt_net,
  stmt_tips, stmt_salik, stmt_cash, stmt_trips, payout, payout_cash, money_source, money, person_key, money_period_days`;
const rows = async () => JSON.stringify(await q(`SELECT ${COLS} FROM driver_day WHERE day >= $1 ORDER BY driver_ext_id, day`, [SINCE]));

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 a narrow pass rebuilds exactly what a full pass computed');
seen.length = 0;
await refreshDriverDays(db);
const fullSql = seen.find((t) => /INSERT INTO driver_day/.test(t)) || '';
const full = await rows();
await q(`DELETE FROM driver_day WHERE day >= $1`, [SINCE]);
seen.length = 0;
await refreshDriverDays(db, { since: SINCE });
const narrowSql = seen.find((t) => /INSERT INTO driver_day/.test(t)) || '';
const narrow = await rows();
const diff = (a, b) => { const A = JSON.parse(a), B = JSON.parse(b); const k = (r) => JSON.stringify(r);
  const sa = new Set(A.map(k)), sb = new Set(B.map(k));
  return [...A.filter((r) => !sb.has(k(r))).map((r) => `full only ${k(r)}`), ...B.filter((r) => !sa.has(k(r))).map((r) => `narrow only ${k(r)}`)].join('\n    '); };
check('every day from the bound on, every column, the same as the full pass', narrow === full, `\n    ${diff(full, narrow)}`);
const day = async (d, on) => (await q(`SELECT online_min, trips FROM driver_day WHERE driver_ext_id = $1 AND day = $2`, [d, on]))[0];
check('…the shapes a bound gets wrong are there to be compared: a span closed after midnight (a: 30 min on the 11th), a span of days (d: whole 11th), a job across midnight (c), the zero-minute day an open ONLINE ends on (b)',
  (await day('a', SINCE))?.online_min === 30 && (await day('d', SINCE))?.online_min === 1440
    && (await day('c', SINCE))?.online_min === 60 && (await day('b', SINCE))?.online_min === 0,
  JSON.stringify([await day('a', SINCE), await day('d', SINCE), await day('c', SINCE), await day('b', SINCE)]));

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 people still fold');
const person = async (d, on) => (await q(`SELECT person_key, money, payout FROM driver_day WHERE driver_ext_id = $1 AND day = $2`, [d, on]))[0];
const p0 = await person(REG[0], '2026-10-11'); const p0b = await person(REG[0], '2026-10-12');
check('a register id folds to its person, whatever the spelling on the trip; its payout lands on that day', p0 && p0b
  && p0.person_key === p0b.person_key && +p0b.payout === 60, JSON.stringify([p0, p0b]));
const twin = await q(`SELECT driver_ext_id, money FROM driver_day WHERE day = '2026-10-12' AND driver_ext_id IN ('h','h2') ORDER BY 1`);
check('two accounts one name: the statement with no account id lands once, on the busier account',
  twin.length === 2 && twin.find((r) => r.driver_ext_id === 'h2')?.money != null
    && +twin.find((r) => r.driver_ext_id === 'h2').money === 90 + 0, JSON.stringify(twin));
const nobody = await q(`SELECT driver_ext_id, money FROM driver_day WHERE day = '2026-10-13'`);
check('a statement with no account and no trips still gets its day, keyed by the name', nobody.length === 1 && +nobody[0].money === 63,
  JSON.stringify(nobody));

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 the statement reads the stored key and the bound');
const caseCount = (t) => t.split(`WHEN '${REG[0]}'`).length - 1;
check('the register\'s CASE is computed once (the final row\'s key), not on every trip, statement and payout — five times before',
  caseCount(fullSql) === 1 && caseCount(narrowSql) === 1, JSON.stringify([caseCount(fullSql), caseCount(narrowSql)]));
check('…the trip\'s stored key is joined by its primary key', /JOIN trip tk ON tk\.platform = n\.platform AND tk\.external_id = n\.external_id/.test(fullSql));
check('a narrow pass bounds the timeline events (ev_floor); a full pass reads them all', /ev_floor/.test(narrowSql) && !/ev_floor/.test(fullSql));

/* ── §4 ─────────────────────────────────────────────────────────────────── */
console.log('\n§4 JIT off on one connection, reset before it goes back');
const log = [];
const fakePool = (failReset = false) => ({
  query: () => { throw new Error('the pool itself must not run it'); },
  connect: async () => ({
    query: async (t) => { log.push(t); if (failReset && t === 'RESET jit') throw new Error('gone'); return { rows: [{ ok: 1 }] }; },
    release: (bad) => log.push(`release:${bad ? 'destroy' : 'keep'}`),
  }),
});
const r = await queryWithoutJit(fakePool(), 'SELECT 1', []);
check('SET jit = off, the statement, RESET jit, then the connection goes back', JSON.stringify(log) === JSON.stringify(['SET jit = off', 'SELECT 1', 'RESET jit', 'release:keep'])
  && r.rows[0].ok === 1, JSON.stringify(log));
log.length = 0;
await queryWithoutJit(fakePool(true), 'SELECT 1', []);
check('…and a connection whose reset failed is destroyed, never pooled with JIT off', log.at(-1) === 'release:destroy', JSON.stringify(log));
log.length = 0;
await queryWithoutJit(fakePool(), 'SELECT 1', [], { timeoutMs: 600000 });
check('a full pass also gets a longer statement timeout on that connection, reset with JIT before it goes back',
  JSON.stringify(log) === JSON.stringify(['SET jit = off', 'SET statement_timeout = 600000', 'SELECT 1', 'RESET jit', 'RESET statement_timeout', 'release:keep']),
  JSON.stringify(log));
const src = (await import('node:fs')).readFileSync(new URL('../src/rollup.js', import.meta.url), 'utf8');
check('…and only the full pass asks for it: quarter-hourly passes keep the pool\'s 120 s', /p, since \? \{\} : \{ timeoutMs: FULL_PASS_TIMEOUT_MS \}\);/.test(src));
const plain = []; await queryWithoutJit({ query: async (t) => { plain.push(t); return { rows: [] }; } }, 'SELECT 2', []);
check('PGlite (no pool): the statement alone', JSON.stringify(plain) === JSON.stringify(['SELECT 2']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
