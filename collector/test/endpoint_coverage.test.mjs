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
  /* The three Tesla routes were exempted here, and the exemption for
     /api/tesla/status read "the Tesla section renders from it" — describing a
     page that did not exist. An exemption is a claim about the product, and
     that one was false the day it was written: the API and the handshake were
     built and no page, no view and no rail row ever were, so the whole
     integration was reachable only by curl. #tesla now exists and calls all
     three, so all three are ordinary UI routes with ordinary fixtures. */
  '/api/probe/uber/timeline': 'operator tool: returns the raw driver_timeline_event rows for one '
    + 'driver on one day, with that day\u2019s trips beside them and the status vocabulary the '
    + 'feed actually uses \u2014 the spans every page derives are an inference, and when a page '
    + 'and the data disagree the spans cannot settle it',
  '/api/probe/zero-distance': 'operator tool: counts bookings marked COMPLETED that carry a '
    + 'fare and zero distance, by platform and by driver. Found on one driver as six Yango '
    + 'orders in eight minutes — ten seconds of driving each, 0.0000 mileage, 6-12 AED in cash, '
    + 'all marked complete. A trip that went nowhere and still charged is either a provider that '
    + 'does not report distance or a booking that did not happen, and the two have to be told '
    + 'apart before either is acted on. Not a page yet: this exists to size the thing first',
  '/api/probe/tesla/egress': 'operator tool: asks, FROM PRODUCTION, what Tesla\u2019s auth host '
    + 'and data host answer this server and what address the outside world sees us at. A code '
    + 'exchange here comes back as an Akamai block page rather than an OAuth refusal, which is '
    + 'the caller being refused and not the credential \u2014 and whether the data host is also '
    + 'refused decides whether any workaround exists. Sends no credential: an invalid grant and '
    + 'an unauthenticated GET are enough, because the measurement is HTML-versus-JSON',
  '/api/probe/uber/realtime': 'operator tool: asks the live per-trip transaction feed with the verb '
    + 'it documents (POST) rather than the GET all three existing probes send, and reports which '
    + 'parameter shape Uber accepts — the gate on getting Uber money at day grain instead of a '
    + 'weekly statement divided by seven',
  '/api/probe/uber/audit': 'operator tool: re-asks Uber for a window we already hold and compares its '
    + 'Trip UUIDs against ours, by hand and for a week at a time. The PAGE reads /api/coverage/verified, '
    + 'which is where the nightly audit job stores the same comparison for whole months — a report costs '
    + 'minutes at the provider and cannot be produced inside a page load',
  '/api/probe/yango/keyapi': 'operator tool: asks whether Yango\u2019s key-based Fleet API — '
    + 'fleet-api.yango.tech, X-API-Key and X-Client-ID, no cookie — will answer this park, and '
    + 'which of four written-down client id shapes it accepts. It exists because the cookie route '
    + 'is refused at Yandex\u2019s edge from this host and no credential can move that; the key '
    + 'route has no session in it and nothing to re-paste weekly. Not a page: it answers whether a '
    + 'collector COULD be pointed there',
  '/api/probe/yango': 'operator tool: has this HOST report its own request to Yango — the park '
    + 'id\u2019s shape, whether it matches the one the session cookie itself names, and the two '
    + 'status codes with and without the cookie. It exists because the same request answered 200 '
    + 'from one host and 403 from the deployed one on 2026-09-07, and no page can settle which of '
    + 'those two facts is about the credential and which is about the caller. Not a page: it '
    + 'answers a question a person asks once, from a terminal, when a feed goes dark',
  '/api/probe/fms/window': 'operator tool: the same question of FMS, whose history has a 152-day hole. '
    + 'Our records say those windows were asked and answered empty, and an empty list is '
    + 'indistinguishable from a malformed request in a row count — this asks again and reports the shape',
  '/api/driver/vehicles': 'the per-vehicle rollup of /api/driver/custody, which is what the page draws; '
    + 'kept because it is an address somebody may have bookmarked, and it now resolves the whole person '
    + 'and honours the window rather than answering about one account and all of history',
  '/api/vehicle/drivers': 'the day-by-day form of /api/vehicle/drivers-detail, which is what the page draws; '
    + 'kept for the same reason, and it 404s an unknown plate now rather than rendering it as a car that '
    + 'did nothing',
  '/api/driver/photo/:platform/:id': 'the driver photographs, and the one route whose address the pages never spell. It is minted server-side by photoHref() in api/redact.js and reaches the browser as the picture_url field of a driver row, so an <img> asks for it without any file under api/public ever naming it — this check reads the page sources, and there is nothing there to read. Its reachability is proven instead by test/driver_photo.test.mjs, which asserts that the directory and the profile both emit exactly this address and that neither emits Uber\u2019s expiring one',
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
