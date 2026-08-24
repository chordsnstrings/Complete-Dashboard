// Central configuration.
// Credentials resolve live from the settings store (DB, editable in the dashboard Settings page),
// falling back to environment variables. Call `loadSettings()` before reading `config` in a loop —
// the collector refreshes it each tick so Settings changes apply without a redeploy.
import 'dotenv/config';
import { get, getInt } from './settings.js';

export { loadSettings } from './settings.js';

// `config` is a getter-based view so every read reflects the latest loaded settings.
export const config = {
  get backfillMonths() { return getInt('BACKFILL_MONTHS', 12); },
  get incrementalDays() { return getInt('INCREMENTAL_DAYS', 3); },
  // CABMAN realtime GPS: fixed 5-minute refresh saved to telemetry_snapshot.
  get cabmanCron() { return get('CABMAN_CRON', '*/5 * * * *'); },
  // Other live pollers (Uber online/on-trip status, FMS live) — lighter cadence.
  get liveStatusSeconds() { return getInt('LIVE_STATUS_SECONDS', 120); },

  // LLM used to judge whether a news headline can plausibly move a Dubai fleet.
  get modelark() {
    return {
      baseUrl: get('ARK_BASE_URL', 'https://ark.ap-southeast.bytepluses.com/api/v3'),
      apiKey: get('ARK_API_KEY'),
      model: get('ARK_MODEL', 'glm-5-2-260617'),
    };
  },

  get fms() {
    return {
      base: get('FMS_BASE', 'http://103.185.74.197/currentinfotest/ItlService.svc'),
      fleets: [
        { fleet: 'ecosine', username: get('FMS_ECOSINE_USER', 'ecosinetranspor'), password: get('FMS_ECOSINE_PASS') },
        { fleet: 'egari', username: get('FMS_EGARI_USER', 'egariluxury'), password: get('FMS_EGARI_PASS') },
      ],
    };
  },

  get cabman() {
    return {
      url: get('CABMAN_URL', 'https://app.cabman.ae/dtcabmanrestservice/api/trackingServices/GetIVDData'),
      fleets: [
        { fleet: 'ecosine', interfaceId: get('CABMAN_ECOSINE_ID', '81'), user: get('CABMAN_ECOSINE_USER', 'admin_ecosine'), pass: get('CABMAN_ECOSINE_PASS') },
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
    const orgs = [
      { fleet: 'ecosine', orgUuid: get('UBER_ORG_UUID'), org: get('UBER_ORG_ENCRYPTED'),
        webCookie: get('UBER_WEB_COOKIE') },
      { fleet: 'egari', orgUuid: get('UBER_ORG_UUID_EGARI'), org: get('UBER_ORG_ENCRYPTED_EGARI'),
        webCookie: get('UBER_WEB_COOKIE_EGARI') },
    ].filter((o) => o.orgUuid && o.webCookie);
    return {
      orgs,
      org: get('UBER_ORG_ENCRYPTED'),
      orgUuid: get('UBER_ORG_UUID'),
      oauth: {
        tokenUrl: 'https://login.uber.com/oauth/v2/token',
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
      base: get('YANGO_BASE', 'https://fleet.yango.com'),
      parkId: get('YANGO_PARK_ID'),
      apiKey: get('YANGO_API_KEY'),
      cookie: get('YANGO_COOKIE'),
      fleet: 'ecosine',
      pageSize: 40,
    };
  },

  get hotel() {
    return {
      base: get('HOTEL_BASE', 'https://whale-app-iofbt.ondigitalocean.app'),
      domain: get('HOTEL_DOMAIN', 'hotel.ecosine.ae'),
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
export const normPlate = (p) => (p || '').toUpperCase().replace(/[\s-]+/g, '');
