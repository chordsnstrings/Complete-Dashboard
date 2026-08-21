/* Every read endpoint should be reachable from the dashboard.
   ──────────────────────────────────────────────────────────────────────────
   /api/trend/monthly, /api/breaks and /api/events were built, tested, deployed
   — and nothing in the UI ever called them, so the causal analysis they exist
   for was invisible for weeks. Same for product-tier economics, tips, payout
   components and the weather overlay. Nobody noticed because nothing failed.

   This makes that failure loud. An endpoint may be exempt, but only by being
   named here with a reason. */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

// Every module that mounts routes, discovered rather than listed: a new route
// file added to api/ was previously invisible to this check, which is how the
// probe endpoints could be exempted here while not appearing in the route list
// at all.
const server = readdirSync('api')
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(`api/${f}`, 'utf8')).join('\n');
const ui = readdirSync('api/public')
  .filter((f) => f.endsWith('.js') && f !== 'charts.js')
  .map((f) => readFileSync(`api/public/${f}`, 'utf8')).join('\n');

const routes = [...new Set([...server.matchAll(/app\.(?:get|post)\((['"])(\/api\/[^'"]*)\1/g)].map((m) => m[2]))].sort();

/* A plain substring test reports /api/vehicle/drivers as used because
   /api/vehicle/drivers-detail contains it. Require the next character to end
   the path — a quote, a query string, or a template hole. */
const usedInUi = (route) => new RegExp(
  route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(?=['"\`?&]|\\$\\{|$)`, 'm').test(ui);

/* Endpoints that legitimately have no UI consumer. Each needs a reason, so
   adding one is a decision rather than a shrug. */
const EXEMPT = {
  '/api/health': 'liveness probe for the platform, not for people',
  '/api/ready': 'readiness probe for the platform — checks the schema is complete before traffic is routed here',
  '/api/probe/uber/report-types': 'operator tool: asks the provider which reports this org can generate',
  '/api/probe/uber/report-columns': 'operator tool: reports one provider report’s column shape',
  '/api/probe/uber/rest': 'operator tool: reports the shape of the provider REST surfaces',
  '/api/driver/vehicles': 'superseded by /api/driver/custody; kept for external callers',
  '/api/vehicle/drivers': 'superseded by /api/vehicle/drivers-detail; kept for external callers',
  '/api/finance/daily': 'the same series as /api/trips/daily, which the finance view already draws',
  '/api/schema/raw-values': 'drill-down called with a key from /api/schema/raw-fields, not by literal path',
};

check('routes were found to check', routes.length > 40, String(routes.length));

const orphans = routes.filter((r) => !usedInUi(r) && !(r in EXEMPT));
check('every endpoint is reachable from the UI', orphans.length === 0,
  orphans.length ? `\n      orphaned: ${orphans.join('\n      orphaned: ')}` : '');

// An exemption that no longer names a real route is stale bookkeeping.
const stale = Object.keys(EXEMPT).filter((r) => !routes.includes(r));
check('no exemption names a route that no longer exists', stale.length === 0, stale.join(', '));

// An exemption for an endpoint the UI does use should be removed.
const pointless = Object.keys(EXEMPT).filter((r) => usedInUi(r));
check('no endpoint is exempted while also being used', pointless.length === 0, pointless.join(', '));

console.log(`\n  ${routes.length} endpoints, ${Object.keys(EXEMPT).length} exempt`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
