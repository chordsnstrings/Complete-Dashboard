// Central configuration.
// Credentials resolve live from the settings store (DB, editable in the dashboard Settings page),
// falling back to environment variables. Call `loadSettings()` before reading `config` in a loop —
// the collector refreshes it each tick so Settings changes apply without a redeploy.
import 'dotenv/config';
import { get, getInt, SETTING_DEFAULTS as D } from './settings.js';

export { loadSettings } from './settings.js';

// `config` is a getter-based view so every read reflects the latest loaded settings.
export const config = {
  get backfillMonths() { return getInt('BACKFILL_MONTHS', Number(D.BACKFILL_MONTHS)); },
  get incrementalDays() { return getInt('INCREMENTAL_DAYS', Number(D.INCREMENTAL_DAYS)); },
  // CABMAN realtime GPS: fixed 5-minute refresh saved to telemetry_snapshot.
  get cabmanCron() { return get('CABMAN_CRON', D.CABMAN_CRON); },
  // Other live pollers (Uber online/on-trip status, FMS live) — lighter cadence.
  get liveStatusSeconds() { return getInt('LIVE_STATUS_SECONDS', 120); },

  // LLM used to judge whether a news headline can plausibly move a Dubai fleet.
  get modelark() {
    return {
      baseUrl: get('ARK_BASE_URL', D.ARK_BASE_URL),
      apiKey: get('ARK_API_KEY'),
      model: get('ARK_MODEL', D.ARK_MODEL),
    };
  },

  get fms() {
    return {
      base: get('FMS_BASE', D.FMS_BASE),
      fleets: [
        { fleet: 'ecosine', username: get('FMS_ECOSINE_USER', D.FMS_ECOSINE_USER), password: get('FMS_ECOSINE_PASS') },
        { fleet: 'egari', username: get('FMS_EGARI_USER', D.FMS_EGARI_USER), password: get('FMS_EGARI_PASS') },
      ],
    };
  },

  get cabman() {
    return {
      url: get('CABMAN_URL', D.CABMAN_URL),
      fleets: [
        { fleet: 'ecosine', interfaceId: get('CABMAN_ECOSINE_ID', D.CABMAN_ECOSINE_ID), user: get('CABMAN_ECOSINE_USER', D.CABMAN_ECOSINE_USER), pass: get('CABMAN_ECOSINE_PASS') },
        // Egari DT credentials can be added here once provided
      ],
    };
  },

  get uber() {
    /* Two Uber businesses, one collector. Each fleet is a separate Uber org
       with its own supplier session — the reconciliation against the
       operator's own ledger showed Egari as ~27% of Uber trips and a third of
       the money, all invisible while only Ecosine's org was configured. An org
       missing either its uuid or its cookie is simply not collected (and the
       run for it never starts), so a half-pasted credential cannot produce a
       half-collected fleet. The unsuffixed keys stay Ecosine's: they predate
       the second fleet and every probe reads them. */
    /* TWO LOGINS, and they are two different KINDS of login.
       ─────────────────────────────────────────────────────────────────────
       The supplier session (webCookie) is a browser login, and each org has
       always had its own — that is why trips and the GraphQL earnings work
       for both fleets today.

       The OAuth client is not a login at all: it is a registered application,
       and an application is registered UNDER one org. One client pair was
       shared by both fleets here, and Uber answers 403 for every Egari call
       through it — `/v1/vehicle-suppliers/orgs` on that client returns exactly
       one org, ECOSINE TRANSPORTS, so no org id makes it work. That is not a
       credential that expired; it is a client that was never scoped to the
       second business.

       So the client is per-fleet too, falling back to the shared pair when a
       fleet has none of its own — which is exactly today's behaviour, and
       stays exactly today's behaviour until an Egari-scoped client exists. */
    const oauthFor = (suffix) => ({
      clientId: get(`UBER_CLIENT_ID${suffix}`) || get('UBER_CLIENT_ID'),
      clientSecret: get(`UBER_CLIENT_SECRET${suffix}`) || get('UBER_CLIENT_SECRET'),
      /* Whether this fleet has a client of its OWN, which is what decides
         whether a 403 means "re-register" or "wrong org id". The banner says
         different things for the two and cannot tell them apart otherwise. */
      own: Boolean(get(`UBER_CLIENT_ID${suffix}`) && get(`UBER_CLIENT_SECRET${suffix}`)),
      idKey: get(`UBER_CLIENT_ID${suffix}`) ? `UBER_CLIENT_ID${suffix}` : 'UBER_CLIENT_ID',
      secretKey: get(`UBER_CLIENT_SECRET${suffix}`) ? `UBER_CLIENT_SECRET${suffix}` : 'UBER_CLIENT_SECRET',
    });
    const orgs = [
      { fleet: 'ecosine', orgUuid: get('UBER_ORG_UUID'), org: get('UBER_ORG_ENCRYPTED'),
        webCookie: get('UBER_WEB_COOKIE'), oauth: oauthFor('') },
      { fleet: 'egari', orgUuid: get('UBER_ORG_UUID_EGARI'), org: get('UBER_ORG_ENCRYPTED_EGARI'),
        webCookie: get('UBER_WEB_COOKIE_EGARI'), oauth: oauthFor('_EGARI') },
    ].filter((o) => o.orgUuid && o.webCookie);
    return {
      orgs,
      org: get('UBER_ORG_ENCRYPTED'),
      orgUuid: get('UBER_ORG_UUID'),
      oauth: {
        tokenUrl: get('UBER_TOKEN_URL', D.UBER_TOKEN_URL),
        clientId: get('UBER_CLIENT_ID'),
        clientSecret: get('UBER_CLIENT_SECRET'),
        scope: 'solutions.suppliers.metrics.read solutions.suppliers.drivers.status.read supplier.partner.payments vehicle_suppliers.organizations.read vehicle_suppliers.vehicles.read solutions.suppliers.reports',
      },
      webCookie: get('UBER_WEB_COOKIE'),
      reportMaxConcurrent: 3,   // hard server limit
      reportRangeDays: 31,      // hard server limit
      fleet: 'ecosine',
    };
  },

  get yango() {
    return {
      base: get('YANGO_BASE', D.YANGO_BASE),
      parkId: get('YANGO_PARK_ID'),
      apiKey: get('YANGO_API_KEY'),
      cookie: get('YANGO_COOKIE'),
      fleet: 'ecosine',
      pageSize: 40,
    };
  },

  get hotel() {
    return {
      base: get('HOTEL_BASE', D.HOTEL_BASE),
      domain: get('HOTEL_DOMAIN', D.HOTEL_DOMAIN),
      token: get('HOTEL_TOKEN'),
      fleet: 'ecosine',
    };
  },

  get bolt() {
    return {
      oidc: 'https://oidc.bolt.eu/token',
      clientId: get('BOLT_CLIENT_ID'),
      clientSecret: get('BOLT_CLIENT_SECRET'),
      fiGateway: 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1',
      portalBase: 'https://fleetownerportal.live.boltsvc.net/fleetOwnerPortal',
      refreshToken: get('BOLT_REFRESH_TOKEN'),
      companies: [
        { fleet: 'egari', companyId: 142897, userId: 174036 },
        { fleet: 'ecosine', companyId: 142868, userId: 173999 },
      ],
    };
  },
};

// Normalize a license plate for cross-platform joins: uppercase, strip spaces/dashes.
/* A plate, or null — never the empty string.
   ─────────────────────────────────────────────────────────────────────────
   This returned `''` for anything that normalised away: a missing "Number
   plate" column in an Uber export, a booking with no vehicle attached, a value
   that was only spaces or a dash. So `trip.plate` recorded "no vehicle" two
   different ways, and every guard downstream had been written for one of them.

   Measured over a year on /api/drivers/cross-platform: 47 of 150 people
   carried '' in their plate list. array_agg(DISTINCT …) sorts ascending, so ''
   sorted FIRST and always took one of the three slots the query keeps — "the
   three cars they drove" was two cars and a blank — count(DISTINCT plate)
   counted it as a vehicle, and mode() WITHIN GROUP could return it as the car
   somebody mostly drives. /api/kpis guarded with `AND n.plate <> ''` and the
   rest did not, so two endpoints answering the same question about the same
   day could disagree by one, each looking right on its own page.

   Fixed here, at the one function all seven collectors pass a plate through,
   rather than at the thirty aggregates that consume it. sql/schema_v32.sql
   cleans the rows already written. */
export const normPlate = (p) => (p || '').toUpperCase().replace(/[\s-]+/g, '') || null;
