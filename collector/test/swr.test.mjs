/* ── paint what we knew, then correct it ───────────────────────────────────
   The server answers in about 150ms and a cached response in 250ms over the
   network. That is fast and it is not instant: a page still shows skeletons
   until five to fifteen requests land, and on a phone the round trips dominate.
   The dashboard is opened repeatedly by the same few people, to the same
   handful of pages, and the numbers move every half hour at most.

   So an answer is kept in the browser and served immediately next time, while
   the real request runs behind it. These tests are about the ways that is worse
   than waiting: a realtime feed served from yesterday, an error held for a day,
   two different questions sharing an answer, or a redraw that throws away the
   reader's place for no reason. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* A localStorage that behaves like the browser's, including throwing when full
   — a private window refuses to store at all, and the page must still work. */
function fakeStorage({ quota = Infinity } = {}) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (v.length > quota) { const e = new Error('QuotaExceededError'); throw e; } m.set(k, v); },
    removeItem: (k) => m.delete(k),
    get size() { return m.size; },
  };
}

global.localStorage = fakeStorage();
global.window = { dispatchEvent() {}, CustomEvent: class {} };
const { swr } = await import('../api/public/swr.js');

console.log('\nswr: it keeps and returns');

swr.clear();
check('nothing is held to begin with', swr.get('/api/kpis?days=30') === null);
swr.put('/api/kpis?days=30', { trips: 100 });
check('what was put is what comes back', swr.get('/api/kpis?days=30')?.body?.trips === 100);
check('and it carries when it was stored, so staleness is knowable',
  typeof swr.get('/api/kpis?days=30')?.at === 'number');

console.log('\nswr: two questions are not one answer');

swr.put('/api/kpis?days=7', { trips: 7 });
check('a different query string is a different entry',
  swr.get('/api/kpis?days=30').body.trips === 100 && swr.get('/api/kpis?days=7').body.trips === 7);

console.log('\nswr: what it must never hold');

/* A position feed or a freshness report served from a previous session is
   wrong in a way the reader cannot see — the page looks current and is not. */
for (const p of ['/api/live', '/api/track?plate=X', '/api/status', '/api/rollups',
  '/api/settings', '/api/cache-stats', '/api/health', '/api/ready', '/api/probe/results']) {
  swr.put(p, { v: 1 });
  check(`a realtime or freshness endpoint is never held (${p})`, swr.get(p) === null);
}
/* The path decides, not the query string: ?days= never makes something
   realtime, and a realtime endpoint with a parameter is still realtime. */
check('and the decision is made on the path, before the query string',
  swr.get('/api/live?from=2026-01-01&to=2026-02-01') === null);

console.log('\nswr: a redraw only when the answer moved');

/* This is what stops the cache being a flicker machine. Redrawing a page that
   is already correct costs the reader their scroll position and their place in
   a table — a worse cost than the wait being saved. */
swr.put('/api/mix', { rows: [1, 2, 3] });
check('storing the same answer again reports no change',
  swr.put('/api/mix', { rows: [1, 2, 3] }).changed === false);
check('storing a different answer reports a change',
  swr.put('/api/mix', { rows: [1, 2, 4] }).changed === true);
/* Key order must not read as a change, or every refresh would redraw. */
swr.put('/api/kpis', { a: 1, b: 2 });
check('the same fields in the same order are not a change',
  swr.put('/api/kpis', { a: 1, b: 2 }).changed === false);

console.log('\nswr: bounded, and survives a storage that refuses');

swr.clear();
// One entry larger than the per-entry cap is not worth a third of the budget.
swr.put('/api/huge', { pad: 'x'.repeat(300 * 1024) });
check('an oversized answer is not held', swr.get('/api/huge') === null);

swr.clear();
for (let i = 0; i < 400; i++) swr.put(`/api/thing?n=${i}`, { pad: 'y'.repeat(12 * 1024) });
const st = swr.stats();
check('the store stays inside its budget rather than growing until the quota throws',
  st.bytes <= 3 * 1024 * 1024, `${Math.round(st.bytes / 1024)}kb in ${st.entries} entries`);
check('and eviction actually ran', st.entries < 400, `${st.entries} entries`);

/* A private window throws on every write. The page must go back to waiting for
   the network, not break. */
global.localStorage = fakeStorage({ quota: 10 });
const mod = await import(`../api/public/swr.js?private=${Date.now()}`);
let threw = false;
try { mod.swr.put('/api/kpis', { trips: 1 }); } catch { threw = true; }
check('a storage that refuses every write does not throw', !threw);
check('and simply holds nothing', mod.swr.get('/api/kpis') === null);

console.log('\nswr: the client is wired to it');

const data = readFileSync('api/public/data.js', 'utf8');
const app = readFileSync('api/public/app.js', 'utf8');
check('a held answer is returned without waiting for the network',
  /if \(held\) \{/.test(data) && /return held\.body;/.test(data));
check('and the real request still runs behind it',
  /const live = \(async \(\) => \{/.test(data));
/* Nobody awaits the background request, so its failure must not surface as an
   unhandled rejection — and a failed refresh should leave the reader with the
   figures they already had. */
check('a failed refresh is swallowed rather than becoming an unhandled rejection',
  /live\.catch\(\(\) => \{\}\);/.test(data));
check('only a POST or a fetch with options bypasses it',
  /method === 'GET' && !opts/.test(data));
check('the redraw is debounced, so fifteen changed answers redraw once',
  /clearTimeout\(refreshTimer\)/.test(app));
check('it is dropped if the reader has navigated since',
  /if \(now !== at\) return;/.test(app));
check('and the scroll position is restored',
  /window\.scrollTo\(\{ top: y \}\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
