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
/* swr.js is excluded because it lists the endpoints the client must NOT serve
   from its cache — a realtime feed, a freshness report. Those are references to
   endpoints in order to avoid them, which is the opposite of using one, and
   counting them made /api/health and /api/ready look reachable from the UI
   while also being exempted. */
const ui = readdirSync('api/public')
  .filter((f) => f.endsWith('.js') && f !== 'charts.js' && f !== 'swr.js')
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
  '/api/import/statement-days': 'operator tool: batched import of the daily ledger — driven by '
    + 'bin/import-ledger.mjs, not by a page',
  '/api/ready': 'readiness probe for the platform — checks the schema is complete before traffic is routed here',
  '/api/probe/uber/report-types': 'operator tool: asks the provider which reports this org can generate',
  '/api/probe/uber/report-columns': 'operator tool: reports one provider report’s column shape',
  '/api/probe/uber/rest': 'operator tool: reports the shape of the provider REST surfaces',
  '/api/probe/uber/driver': 'operator tool: asks Uber for one driver’s profile, to settle whether the '
    + 'provider publishes a rating at all. The roster has shown a column of dashes under a sentence '
    + 'saying no channel reports one; GetDriver returns recognitionRating and nothing here had asked',
  '/api/probe/uber/window': 'operator tool: asks the provider what it still holds for one window, '
    + 'to settle whether a gap in our history is recoverable or gone',
  '/api/probe/uber/tier': 'operator tool: asks the Uber GraphQL surface whether it names a driver reward '
    + 'tier — Blue, Gold, Platinum, Diamond — by trying introspection, then a fixed list of candidate fields '
    + 'on GetDriver, then a fixed list of candidate operations. Every candidate is written in the file; nothing '
    + 'the caller sends becomes part of a query. Not a page: it answers whether a page COULD exist',
  '/api/probe/uber/audit': 'operator tool: re-asks Uber for a window we already hold and compares its '
    + 'Trip UUIDs against ours, by hand and for a week at a time. The PAGE reads /api/coverage/verified, '
    + 'which is where the nightly audit job stores the same comparison for whole months — a report costs '
    + 'minutes at the provider and cannot be produced inside a page load',
  '/api/probe/fms/window': 'operator tool: the same question of FMS, whose history has a 152-day hole. '
    + 'Our records say those windows were asked and answered empty, and an empty list is '
    + 'indistinguishable from a malformed request in a row count — this asks again and reports the shape',
  '/api/driver/vehicles': 'the per-vehicle rollup of /api/driver/custody, which is what the page draws; '
    + 'kept because it is an address somebody may have bookmarked, and it now resolves the whole person '
    + 'and honours the window rather than answering about one account and all of history',
  '/api/vehicle/drivers': 'the day-by-day form of /api/vehicle/drivers-detail, which is what the page draws; '
    + 'kept for the same reason, and it 404s an unknown plate now rather than rendering it as a car that '
    + 'did nothing',
  '/api/vehicles': 'the busiest-first form of /api/vehicles/directory, which is what both panels on '
    + '#vehicles now read — the directory already returns plate and trips for every vehicle, and asking '
    + 'the same question twice cost 12s of a 44s cold load at a 365-day window. Kept as a route because '
    + 'it is an address somebody may have bookmarked',
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
