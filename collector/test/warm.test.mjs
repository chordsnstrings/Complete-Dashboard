/* ── warming the cache, so the first reader is not the one who pays ─────────
   The response cache made a repeated page load 0.3s and did nothing for the
   first load after a collection — still 8.3s on the drivers directory, and
   somebody has to wait for it. That somebody is whoever opens the dashboard
   first each half hour, which is the person starting their shift.

   The warmer asks the process for those pages itself, in the background, as
   soon as it notices the data has moved.

   The failure that matters here is a warmer that runs, logs success, and warms
   nothing a browser will ever ask for — because it fetched a different window,
   or a path the cache excludes, or the wrong port. Every one of those looks
   identical from the outside: a cache that is simply never warm. */
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { responseCache } from '../api/cache.js';
import { startWarmer } from '../api/warm.js';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
const pool = { query: (t, p) => db.query(t, p) };

const seen = [];
const app = express();
const cache = responseCache({ pool, ttlMs: 0 });
app.use('/api', cache);
app.use('/api', (req, res) => { seen.push(req.originalUrl); res.json({ ok: true }); });
const server = app.listen(0);
const port = server.address().port;

const warmer = startWarmer({ port, pool, enabled: true });
await warmer.warm();

console.log('\nwarm: it asks for what a browser will ask for');

check('it warmed a substantial number of pages', seen.length > 30, String(seen.length));

/* The window is the part that silently goes wrong. The front end computes
   Dubai dates; a warmer using UTC would populate entries under keys nobody
   requests, and report success doing it. */
const dubai = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const to = dubai(new Date());
const from30 = dubai(new Date(Date.now() - 29 * 864e5));
check('the default window is the Dubai one the front end computes',
  seen.some((u) => u.includes(`from=${from30}&to=${to}`)),
  seen.slice(0, 2).join(' | '));
check('and it covers the other two windows the UI offers',
  seen.some((u) => u.includes(`from=${dubai(new Date(Date.now() - 6 * 864e5))}`))
  && seen.some((u) => u.includes(`from=${dubai(new Date(Date.now() - 89 * 864e5))}`)));

/* A path with an existing query string must gain the window with & and not a
   second ?, or the request is malformed and warms nothing. */
check('a path that already has a query string is extended, not corrupted',
  seen.some((u) => u.startsWith('/api/mix?by=product&from=')),
  seen.filter((u) => u.includes('/api/mix')).join(' | '));

console.log('\nwarm: the pages are actually warm afterwards');

/* The real test. Ask for what a browser would ask for and it must come back
   from the cache — which is only true if the warmer used the same key. */
const r = await fetch(`http://127.0.0.1:${port}/api/kpis?from=${from30}&to=${to}`);
check('a page the warmer touched answers from the cache on the first real request',
  r.headers.get('x-cache') === 'hit', String(r.headers.get('x-cache')));

const st = cache.stats();
check('and the cache holds an entry per page per window',
  st.entries > 30, JSON.stringify(st));

console.log('\nwarm: it does not run away');

/* Two things it must not do: run twice at once, and keep running after stop.
   Both show up as load on a database shared with the collector. */
const before = seen.length;
await Promise.all([warmer.warm(), warmer.warm()]);
check('two overlapping warm passes do not both run',
  seen.length - before < 30 * 2, `${before} -> ${seen.length}`);

warmer.stop();
const afterStop = seen.length;
await warmer.warm();
check('a stopped warmer does not warm', seen.length === afterStop,
  `${afterStop} -> ${seen.length}`);

/* Disabled must mean disabled — it shares the switch with the cache, because
   warming a cache that is off is pure load for no benefit. */
const off = startWarmer({ port, pool, enabled: false });
const n = seen.length;
await new Promise((res) => setTimeout(res, 100));
check('disabled, it warms nothing', seen.length === n);
off.stop();

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
