// Central configuration. All secrets come from the environment (see .env.example).
// Never hard-code tokens/cookies here — mount them via env / container secrets.
import 'dotenv/config';

const req = (k, d) => (process.env[k] ?? d);

export const config = {
  db: {
    connectionString: process.env.DATABASE_URL
      || `postgres://${req('PGUSER','fleet')}:${req('PGPASSWORD','fleet')}@${req('PGHOST','db')}:${req('PGPORT','5432')}/${req('PGDATABASE','fleet')}`,
  },

  // How far back to backfill, and the trailing window each incremental run re-pulls.
  backfillMonths: parseInt(req('BACKFILL_MONTHS', '12'), 10),
  incrementalDays: parseInt(req('INCREMENTAL_DAYS', '3'), 10),
  cabmanPollSeconds: parseInt(req('CABMAN_POLL_SECONDS', '45'), 10),

  fms: {
    base: req('FMS_BASE', 'http://103.185.74.197/currentinfotest/ItlService.svc'),
    // one entry per fleet — password via env
    fleets: [
      { fleet: 'ecosine', username: req('FMS_ECOSINE_USER', 'ecosinetranspor'), password: process.env.FMS_ECOSINE_PASS },
      { fleet: 'egari',   username: req('FMS_EGARI_USER',   'egariluxury'),      password: process.env.FMS_EGARI_PASS },
    ],
  },

  cabman: {
    url: req('CABMAN_URL', 'https://app.cabman.ae/dtcabmanrestservice/api/trackingServices/GetIVDData'),
    // one entry per fleet that has DT credentials
    fleets: [
      { fleet: 'ecosine', interfaceId: req('CABMAN_ECOSINE_ID','81'), user: req('CABMAN_ECOSINE_USER','admin_ecosine'), pass: process.env.CABMAN_ECOSINE_PASS },
      // add egari here once DT credentials are provided
    ],
  },

  uber: {
    org: process.env.UBER_ORG_ENCRYPTED,      // encrypted org id (api.uber.com)
    orgUuid: process.env.UBER_ORG_UUID,        // plaintext org uuid (graphql / reports)
    oauth: {
      tokenUrl: 'https://login.uber.com/oauth/v2/token',
      clientId: process.env.UBER_CLIENT_ID,
      clientSecret: process.env.UBER_CLIENT_SECRET,
      scope: 'solutions.suppliers.metrics.read solutions.suppliers.drivers.status.read supplier.partner.payments vehicle_suppliers.organizations.read vehicle_suppliers.vehicles.read solutions.suppliers.reports',
    },
    // supplier web session — cookie string + csrf; expires, refresh via supervisor
    webCookie: process.env.UBER_WEB_COOKIE,
    reportMaxConcurrent: 3,               // hard server limit
    reportRangeDays: 31,                  // hard server limit
    fleet: 'ecosine',
  },

  yango: {
    base: req('YANGO_BASE', 'https://fleet.yango.com'),
    parkId: process.env.YANGO_PARK_ID,
    apiKey: process.env.YANGO_API_KEY,
    cookie: process.env.YANGO_COOKIE,     // Yandex session — expires, refresh via supervisor
    fleet: 'ecosine',
    pageSize: 40,
  },

  bolt: {
    oidc: 'https://oidc.bolt.eu/token',
    clientId: process.env.BOLT_CLIENT_ID,
    clientSecret: process.env.BOLT_CLIENT_SECRET,
    fiGateway: 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1',
    // portal (trips/earnings) — needs a live refresh token; leave empty to skip
    portalBase: 'https://fleetownerportal.live.boltsvc.net/fleetOwnerPortal',
    refreshToken: process.env.BOLT_REFRESH_TOKEN,
    companies: [
      { fleet: 'egari',   companyId: 142897, userId: 174036 },
      { fleet: 'ecosine', companyId: 142868, userId: 173999 },
    ],
  },
};

// Normalize a license plate for cross-platform joins: uppercase, strip spaces/dashes.
export const normPlate = (p) => (p || '').toUpperCase().replace(/[\s-]+/g, '');
