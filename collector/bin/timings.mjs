/* What every endpoint costs, measured rather than guessed.
   ─────────────────────────────────────────────────────────────────────────
   "The dashboard is slow" is not actionable: a page issues a dozen requests
   in parallel and is as slow as its slowest one, so the fix is always in a
   handful of queries and never in all of them. This walks the declared route
   list, times each one twice, and reports the second timing — the first pays
   for a cold connection and a cold page cache, which is a real cost but not
   the one an optimisation would change. */
import { declaredRoutes } from '../test/mount.mjs';

const BASE = process.env.BASE || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const DAYS = Number(process.env.DAYS || 30);
const to = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' })
  .format(new Date(Date.now() - (DAYS - 1) * 864e5));

// declaredRoutes returns plain path strings.
const routes = (await declaredRoutes()).map((p) => ({ path: p }));

/* Routes taking an entity id are useless without one, and a 404 is fast in a
   way that hides the real cost. Real ids are pulled from the API first. */
const pick = async (path, key) => {
  try {
    const r = await fetch(`${BASE}${path}?from=${from}&to=${to}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.rows || j.drivers || j.vehicles || []);
    return rows[0]?.[key] ?? null;
  } catch { return null; }
};
const plate = await pick('/api/vehicles/directory', 'plate');
const driver = await pick('/api/drivers/leaderboard', 'driver_ext_id');
console.log(`substituting plate=${plate} driver=${driver}\n`);

const fill = (p) => p
  .replace(/:plate\b/g, plate || 'X').replace(/:id\b/g, driver || 'X')
  .replace(/:day\b/g, to).replace(/:[a-z_]+/g, 'x');

const time = async (url) => {
  const t0 = performance.now();
  try {
    const r = await fetch(url);
    const text = await r.text();
    return { ms: performance.now() - t0, status: r.status, bytes: text.length };
  } catch (e) { return { ms: performance.now() - t0, status: 0, bytes: 0, err: String(e).slice(0, 60) }; }
};

const results = [];
for (const r of routes) {
  let path = fill(r.path);
  const sep = path.includes('?') ? '&' : '?';
  let url = `${BASE}${path}${sep}from=${from}&to=${to}`;
  if (/\/(vehicle|driver)\//.test(path) && !/plate=|id=/.test(path)) {
    url += path.includes('/vehicle/') ? `&plate=${plate}` : `&id=${driver}`;
  }
  await time(url);                       // warm
  const t = await time(url);             // measure
  results.push({ path: r.path, ...t });
  process.stdout.write('.');
}
console.log('\n');

results.sort((a, b) => b.ms - a.ms);
const bad = results.filter((r) => r.status >= 400 || r.status === 0);
console.log('slowest 25:');
for (const r of results.slice(0, 25)) {
  const flag = r.ms > 3000 ? '!!' : r.ms > 1000 ? ' !' : '  ';
  console.log(`${flag} ${String(Math.round(r.ms)).padStart(6)}ms  ${String(r.status).padStart(3)}  ${String(Math.round(r.bytes / 1024)).padStart(5)}kb  ${r.path}`);
}
const tot = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n${results.length} routes | median ${Math.round(results[Math.floor(results.length / 2)].ms)}ms`
  + ` | over 1s: ${results.filter((r) => r.ms > 1000).length}`
  + ` | over 3s: ${results.filter((r) => r.ms > 3000).length}`
  + ` | total ${Math.round(tot)}ms`);
if (bad.length) {
  console.log(`\nnon-200 (${bad.length}):`);
  for (const r of bad) console.log(`   ${r.status} ${r.path} ${r.err || ''}`);
}
