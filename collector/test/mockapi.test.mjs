/* Does the mock answer in the same shape as the thing it stands in for?
   ─────────────────────────────────────────────────────────────────────────
   mockapi.mjs is what the browser smoke test runs against. A fixture whose
   shape differs from production makes that test lie, and it did:
   /api/drivers/cross-platform returns {platforms, drivers, …}, the mock had no
   fixture for it and fell through to a catch-all returning [], and the UI
   called .filter on it. `[].filter` works; `{}.filter` throws. The Drivers page
   — directory included — rendered "Could not load this view" in production
   while 76 of 76 views passed in the smoke run.

   For a while this was a paragraph explaining that comparing top-level shape
   catches exactly that class, above code that only checked a fixture EXISTED —
   which would not have caught it, since the fixture was added in the same
   change as the check. Then it was a real comparison living in route_smoke,
   whose fixture is deliberately tiny: every per-entity route there 404s for
   want of an id, 404s are skipped, and so it silently compared only the list
   routes while reporting on all of them.

   Here it runs against the shared fixture, where every route resolves.

   Deliberately shallow, and one level into rows: array vs object, and the keys
   the real route returns must exist in the fixture. Everything a table renders
   lives in a row, so a fixture whose ROWS lack a field is exactly as
   misleading as one whose top level does. Values are never compared — the mock
   is meant to differ in values; that is what it is for. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll, declaredRoutes } from './mount.mjs';
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
const { get, port, server } = await mountAll(db);

const { app: mockApp } = await import('../mockapi.mjs');
const mockServer = mockApp.listen(0);
const mockPort = mockServer.address().port;

const WIN = 'from=2026-08-01&to=2026-08-31';
const ARGS = {
  '/api/driver/profile': 'id=u-khalid', '/api/driver/kpis': 'id=u-khalid',
  '/api/driver/daily': 'id=u-khalid', '/api/driver/heatmap': 'id=u-khalid',
  '/api/driver/standing': 'id=u-khalid', '/api/driver/territory': 'id=u-khalid',
  '/api/driver/mix': 'id=u-khalid', '/api/driver/earnings': 'id=u-khalid',
  '/api/driver/quality': 'id=u-khalid', '/api/driver/trips': 'id=u-khalid',
  '/api/driver/custody': 'id=u-khalid', '/api/driver/vehicles': 'id=u-khalid',
  '/api/vehicle/profile': `plate=${PLATES[0]}`, '/api/vehicle/kpis': `plate=${PLATES[0]}`,
  '/api/vehicle/daily': `plate=${PLATES[0]}`, '/api/vehicle/drivers-detail': `plate=${PLATES[0]}`,
  '/api/vehicle/movement': `plate=${PLATES[0]}`, '/api/vehicle/safety': `plate=${PLATES[0]}`,
  '/api/vehicle/trips': `plate=${PLATES[0]}`, '/api/vehicle/mix': `plate=${PLATES[0]}`,
  '/api/vehicle/drivers': `plate=${PLATES[0]}`, '/api/track': `plate=${PLATES[0]}`,
  '/api/map/journey': `plate=${PLATES[0]}&day=2026-08-05`,
  '/api/mix': 'by=payment', '/api/mix/detail': 'by=product',
  '/api/schema/raw-values': 'key=client&platform=hotel',
  '/api/corporate/property': 'id=p-marina', '/api/corporate/leakage': 'kind=complimentary',
  '/api/corporate/approach': 'by=driver', '/api/tiers/mix': 'by=daypart',
  '/api/day': 'day=2026-08-05', '/api/slot': 'dow=2&hour=19',
};

const mockSrc = readFileSync('mockapi.mjs', 'utf8');
const mockRoutes = new Set([...mockSrc.matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1]));
const uiSrc = readdirSync('api/public').filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(`api/public/${f}`, 'utf8')).join('\n');
const all = declaredRoutes();
const usedByUi = all.filter((r) => new RegExp(
  r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(?=['"\`?&]|\\$\\{|$)`, 'm').test(uiSrc));

check('the UI calls routes this test can compare', usedByUi.length > 30, String(usedByUi.length));
const unfixtured = usedByUi.filter((r) => !mockRoutes.has(r));
check('every route the UI calls has a mock fixture',
  unfixtured.length === 0, unfixtured.join('\n      '));

const shapeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const drift = [];
let compared = 0, skipped = 0;
for (const route of usedByUi) {
  if (route.includes(':') || !mockRoutes.has(route)) continue;
  const extra = ARGS[route] ? `&${ARGS[route]}` : '';
  const path = `${route}?${WIN}${extra}`;
  const [realRes, mockRes] = await Promise.all([
    fetch(`http://127.0.0.1:${port}${path}`), fetch(`http://127.0.0.1:${mockPort}${path}`),
  ]);
  const [realTxt, mockTxt] = await Promise.all([realRes.text(), mockRes.text()]);
  /* A 4xx body is a different response shape by design ({error}), and a
     deliberate refusal ({reason}) is another — /api/forecast and /api/retention
     answer one when there is not enough history, and the mock fixtures the
     happy path on purpose. Counted, so a fixture that stops being compared
     because a route started 404ing is visible rather than silent. */
  if (realRes.status >= 400) { skipped++; continue; }
  let real; let mock;
  try { real = JSON.parse(realTxt); mock = JSON.parse(mockTxt); } catch { skipped++; continue; }
  if (real && typeof real === 'object' && ('error' in real || 'reason' in real)) { skipped++; continue; }
  compared++;

  if (shapeOf(real) !== shapeOf(mock)) {
    drift.push(`${route}: real is ${shapeOf(real)}, mock is ${shapeOf(mock)}`);
    continue;
  }
  const rowDrift = (realArr, mockArr, at) => {
    const realKeys = new Set(realArr.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .flatMap(Object.keys));
    if (!realKeys.size) return;
    const mockRows = (mockArr || []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (!mockRows.length) return;                        // an empty fixture list says nothing
    const mockKeys = new Set(mockRows.flatMap(Object.keys));
    const missing = [...realKeys].filter((k) => !mockKeys.has(k));
    if (missing.length) drift.push(`${route}${at}: fixture rows lack ${missing.join(', ')}`);
  };
  if (shapeOf(real) === 'array') { rowDrift(real, mock, '[]'); continue; }
  if (shapeOf(real) !== 'object') continue;
  const missingKeys = Object.keys(real).filter((k) => !(k in mock));
  if (missingKeys.length) drift.push(`${route}: fixture lacks ${missingKeys.join(', ')}`);
  for (const [k, v] of Object.entries(real)) {
    if (Array.isArray(v) && Array.isArray(mock[k])) rowDrift(v, mock[k], `.${k}`);
  }
}
check('the mock answers in the same shape as the real API, one level into rows',
  drift.length === 0, drift.length ? `\n      ${drift.join('\n      ')}` : '');
/* The comparison is worth nothing if most routes fell into the skip branch.
   In route_smoke's fixture every per-entity route 404s, which is how that
   version of this check ended up comparing only the list routes. */
check('and it compared most of the routes rather than skipping them',
  compared > skipped * 3, `${compared} compared, ${skipped} skipped`);

console.log(`\n  ${compared} routes compared, ${skipped} skipped`);
console.log(`\n${pass} passed, ${fail} failed`);
mockServer.close(); server.close(); await db.close();
process.exit(fail ? 1 : 0);
