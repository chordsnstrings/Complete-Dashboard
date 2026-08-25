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
import { readFileSync, readdirSync } from 'node:fs';

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

/* The multiplier is READ OFF the front end, not restated here.
   ─────────────────────────────────────────────────────────────────────────
   This check used to hardcode `29 * 864e5` — which is api/warm.js's own
   arithmetic, not the browser's. api/public/data.js:117 sends
   `now - days * 864e5`, one day wider, so for every windowed path the warmer
   had been filling a key no page would ever request, and this test confirmed
   only that warm.js agreed with itself. It passed for as long as the warmer
   warmed nothing. Both files are read now, so the two can no longer drift
   apart without something failing. */
const uiSrc = readFileSync('api/public/data.js', 'utf8');
check('the front end still computes its window the way this test reads it',
  /dubaiDay\(new Date\(now - state\.days \* 864e5\)\)/.test(uiSrc),
  'api/public/data.js windowDates() has changed shape — re-read it before trusting the checks below');
const uiFrom = (days) => dubai(new Date(Date.now() - days * 864e5));

check('the default window is the Dubai one the front end computes',
  seen.some((u) => u.includes(`from=${uiFrom(30)}&to=${to}`)),
  seen.slice(0, 2).join(' | '));
check('and it covers the other windows the UI offers',
  [7, 90, 365].every((d) => seen.some((u) => u.includes(`from=${uiFrom(d)}&to=${to}`))),
  [7, 90, 365].map((d) => `${d}:${uiFrom(d)}`).join(' '));

/* A path with an existing query string must gain the window with & and not a
   second ?, or the request is malformed and warms nothing. */
check('a path that already has a query string is extended, not corrupted',
  seen.some((u) => u.startsWith('/api/mix?by=product&from=')),
  seen.filter((u) => u.includes('/api/mix')).join(' | '));

console.log('\nwarm: the pages are actually warm afterwards');

/* The real test. Ask for what a browser would ask for and it must come back
   from the cache — which is only true if the warmer used the same key. */
const r = await fetch(`http://127.0.0.1:${port}/api/kpis?from=${uiFrom(30)}&to=${to}`);
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

console.log('\nit warms the keys the pages actually ask for');

/* The bug this exists to prevent, found on a 504.
   ─────────────────────────────────────────────────────────────────────────
   The response cache keys on the full URL, so /api/coverage and
   /api/coverage?from=…&to=… are two different entries. Five endpoints answer
   a question with no window — how much data do we hold, what does the whole
   record look like — and the UI calls them BARE. They were in the windowed
   list, so every pass warmed four keys nobody would ever request and left the
   one key every reader hits permanently cold. /api/coverage is a twenty-second
   query; a reader opening Data sources during a backfill waited on it until
   the platform's gateway gave up.

   Grepping the UI is the check, because the failure is a DISAGREEMENT between
   two files: warm.js is right only relative to how data.js asks. */
{
  const warmSrc = readFileSync('api/warm.js', 'utf8');
  /* Only strings that look like a path. Written as /'([^']+)'/ this matched
     the apostrophe in any prose comment inside the array and read the rest of
     the sentence as an endpoint — which then shifted every following entry by
     one and reported a real path as unwarmed. */
  const declared = (block) => [...block.matchAll(/'(\/api\/[^']*)'/g)].map((x) => x[1]);
  const bare = [...warmSrc.matchAll(/const BARE_PATHS = \[([^\]]+)\]/gs)]
    .flatMap((m) => declared(m[1]));
  const windowed = [...warmSrc.matchAll(/const PATHS = \[([^\]]+)\]/gs)]
    .flatMap((m) => declared(m[1]));
  check('the warmer declares both kinds of key', bare.length > 0 && windowed.length > 0);

  /* How each path is CALLED in the UI: api() sends no window, q()/qAll() do. */
  const ui = readdirSync('api/public').filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(`api/public/${f}`, 'utf8')).join('\n');
  const calledBare = (path) => new RegExp(`\\bapi\\('${path.replace(/[/?]/g, '\\$&')}'`).test(ui);
  const calledWindowed = (path) => new RegExp(`\\b(?:q|qAll)\\('${path.replace(/[/?]/g, '\\$&')}'`).test(ui);

  /* Called bare ⇒ warmed bare, whether or not it is ALSO called with a window.
     The first version of this check asked "is it called bare and never
     windowed", and /api/coverage — the endpoint that caused the 504 — is
     called both ways, so the check passed while the bare key stayed cold.
     Each way of asking is its own cache key; every key a page requests has to
     be warmed. */
  const allWarmed = new Set([...bare, ...windowed]);
  const miswarmed = [...allWarmed].filter((p) => calledBare(p) && !bare.includes(p));
  check('every endpoint the UI asks for bare is warmed bare',
    miswarmed.length === 0,
    `${miswarmed.join(', ')} — the UI asks bare, so that key is never warmed`);
  const misWindowed = [...allWarmed].filter((p) => calledWindowed(p) && !windowed.includes(p));
  check('and every one it asks for with a window is warmed with one',
    misWindowed.length === 0, misWindowed.join(', '));

  const overwarmed = bare.filter((p) => !calledBare(p));
  check('and nothing is warmed bare that the UI never asks for bare',
    overwarmed.length === 0, overwarmed.join(', '));

  /* And the pass really does request them without a window. */
  const paths = seen.map((u) => u.split('127.0.0.1:')[1]?.replace(/^\d+/, '') || u);
  for (const b of bare) {
    check(`${b} is warmed with no window`, paths.includes(b),
      paths.filter((x) => x.startsWith(b)).slice(0, 2).join(' '));
  }
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
