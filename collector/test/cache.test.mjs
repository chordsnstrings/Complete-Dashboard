/* ── the response cache ────────────────────────────────────────────────────
   Every /api GET answers a question about data that changes only when the
   collector writes — every thirty minutes, plus a quarter-hourly rollup. Two
   people opening the same page in the same minute ran the same aggregate
   twice. On a small managed Postgres that was most of the load, and it showed:
   the same endpoint measured 4.3s and 9.5s ten minutes apart, the difference
   being what else happened to be running.

   A cache that is merely fast is not worth having here. These tests are about
   the four ways it could be worse than no cache at all: serving an error for
   half an hour, serving one window's answer for another's, serving numbers
   from before a write, and growing until the process dies. */
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { responseCache } from '../api/cache.js';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

// PGlite has no pool.query signature difference that matters here.
const pool = { query: (t, p) => db.query(t, p) };

let calls = 0;
const app = express();
const cache = responseCache({ pool, ttlMs: 0 });   // re-read the version every time
app.use('/api', cache);
app.get('/api/thing', (req, res) => { calls++; res.json({ n: calls, days: req.query.days || null }); });
app.get('/api/boom', (_q, res) => { calls++; res.status(500).json({ error: 'internal' }); });
app.get('/api/live/now', (_q, res) => { calls++; res.json({ n: calls }); });
app.post('/api/thing', (_q, res) => { calls++; res.json({ n: calls }); });
const server = app.listen(0);
const port = server.address().port;
// The cache re-requests stale keys on itself, so it needs the real port.
cache.setPort(port);
const get = async (p, opts) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, opts);
  return { status: r.status, cache: r.headers.get('x-cache'), body: await r.json() };
};

console.log('\ncache: it caches');

const a = await get('/api/thing');
const b = await get('/api/thing');
check('the first call reaches the route', a.cache === 'miss' && a.body.n === 1);
check('the second is served from the cache, without reaching it',
  b.cache === 'hit' && b.body.n === 1, `${b.cache} n=${b.body.n}`);

console.log('\ncache: two questions are not one answer');

/* ?days=7 and ?days=90 share a path and are different questions. Keying on the
   path alone would serve a week's numbers to someone who asked for a quarter,
   which is the kind of wrong that looks entirely plausible. */
const w7 = await get('/api/thing?days=7');
const w90 = await get('/api/thing?days=90');
check('a different query string is a different entry',
  w7.body.days === '7' && w90.body.days === '90', JSON.stringify([w7.body, w90.body]));
check('and each is then cached on its own',
  (await get('/api/thing?days=7')).body.days === '7'
  && (await get('/api/thing?days=90')).body.days === '90');

console.log('\ncache: what it must never do');

/* An error cached against a data version that will not change for half an hour
   is an outage, not a slow page. */
/* Counted at the route rather than read off the body: a 500 body carries no
   marker of its own, and asserting on an absent field compares undefined with
   undefined and passes for the wrong reason. */
const beforeBoom = calls;
await get('/api/boom');
await get('/api/boom');
check('a 500 is not cached — it reaches the route again',
  calls === beforeBoom + 2, `${beforeBoom} -> ${calls}`);

const l1 = await get('/api/live/now');
const l2 = await get('/api/live/now');
check('a realtime route is never cached, however cacheable it looks',
  l1.body.n !== l2.body.n, `${l1.body.n} then ${l2.body.n}`);

const before = calls;
await get('/api/thing', { method: 'POST' });
await get('/api/thing', { method: 'POST' });
check('a POST is never served from the cache', calls === before + 2, `${before} -> ${calls}`);
// And a POST must not have poisoned the GET entry.
check('and does not disturb the GET entry it shares a path with',
  (await get('/api/thing')).body.n === 1);

console.log('\ncache: a write is noticed, without making anyone wait for it');

/* The version moves whenever a collection run or any of the three rollups
   finishes — several times a quarter hour on this deployment, which is faster
   than a warm pass can refill sixty entries. Invalidating outright meant every
   request was a miss, measured in production, and the cache did nothing at all.

   So a reader holding a stale answer gets it immediately and the refresh
   happens behind them. Only a reader with no entry at all waits. */
const stableN = (await get('/api/thing')).body.n;
await db.query(
  `INSERT INTO collection_run (source, mode, status, finished_at)
   VALUES ('uber', 'incremental', 'ok', now())`);

const after = await get('/api/thing');
check('a finished collection run is noticed', after.cache === 'stale', after.cache);
check('and the reader is handed the previous answer rather than made to wait',
  after.body.n === stableN, `${stableN} -> ${after.body.n}`);

// The refresh happens behind them; give it a moment to land.
await new Promise((r) => setTimeout(r, 300));
const fresh = await get('/api/thing');
check('the refresh ran behind the reader and the entry is current afterwards',
  fresh.cache === 'hit' && fresh.body.n > stableN, `${fresh.cache} n=${fresh.body.n}`);

await db.query(
  `INSERT INTO rollup_state (name, status, finished_at) VALUES ('rollup_day','ok', now())
   ON CONFLICT (name) DO UPDATE SET finished_at = now()`);
check('a finished rollup is noticed too', (await get('/api/thing')).cache === 'stale');

/* A burst of readers on a just-invalidated page must not each start the same
   aggregate — that is the thundering herd the cache exists to prevent,
   arriving one moment later. */
await new Promise((r) => setTimeout(r, 300));
await db.query(`INSERT INTO collection_run (source, mode, status, finished_at)
                VALUES ('uber','incremental','ok', now())`);
const beforeHerd = calls;
await Promise.all(Array.from({ length: 8 }, () => get('/api/thing')));
await new Promise((r) => setTimeout(r, 300));
check('eight simultaneous readers cause one refresh, not eight',
  calls - beforeHerd <= 2, `${beforeHerd} -> ${calls}`);

/* And a reader with NO entry still waits, because there is nothing to hand
   them — a cache that invented an answer would be a different kind of bug. */
const cold = await get('/api/thing?never-seen=1');
check('a page with no entry is served live, not from nothing', cold.cache === 'miss');

console.log('\ncache: it is bounded and observable');

for (let i = 0; i < 450; i++) await get(`/api/thing?days=${i}`);
const st = cache.stats();
check('the store stops growing at its cap rather than until the process dies',
  st.entries <= 400, `entries=${st.entries}`);
check('and the hit rate is visible, so a cache that stopped working can be seen',
  st.hit > 0 && st.miss > 0, JSON.stringify(st));

/* Disabled means disabled — this is the lever for diagnosing a page that looks
   stale, and a lever that does not move is worse than none. */
const app2 = express();
app2.use('/api', responseCache({ pool, enabled: false }));
let n2 = 0;
app2.get('/api/thing', (_q, res) => { n2++; res.json({ n: n2 }); });
const s2 = app2.listen(0);
const p2 = s2.address().port;
await fetch(`http://127.0.0.1:${p2}/api/thing`);
await fetch(`http://127.0.0.1:${p2}/api/thing`);
check('disabled, every request reaches the route', n2 === 2, String(n2));
s2.close();

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
