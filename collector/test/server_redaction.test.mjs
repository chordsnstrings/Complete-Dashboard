/* What the three leaking routes in api/server.js give a caller with no token.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production with curl and no credentials, 2026-09-05, and every
   assertion below is pinned to one of these numbers:

     /api/schema/raw-values  ?table=trip&platform=hotel&key=driver returned 39
                             rows, each the whole provider record — `password`
                             $2b$10$Gx5ViZ06m2p15VqHkOxoc… (bcrypt cost 10),
                             `emiratesId` 784-2001-4740905-4, an
                             `ExponentPushToken[…]`. ?key=driverInfo on
                             telemetry_snapshot returned 60 more.
     /api/compliance/drivers 289 rows: phone 289/289, emirates_id 123/289
                             (784-1977-5137316-4 among them), licence_no 94/289.
     /api/export/trips.csv   200, x-export-rows 262,162 over one year against a
                             400,000 cap, every line carrying pickup_addr and
                             dropoff_addr in full.

   THE REAL CODE, NOT A COPY. Each route is sliced out of api/server.js and
   evaluated with its helpers injected — the same trick test/mount.mjs has used
   since /api/vehicles shipped 500ing on every call, and for the same reason: a
   test that asserts against a transcription of a route passes for ever after
   the route changes underneath it. The slices are taken by marker, so a rename
   fails loudly here rather than silently testing nothing.

   The database is faked, deliberately. Every assertion here is about what the
   BOUNDARY does with rows it has been handed; seeding a Postgres to produce
   those rows would test the seed. The fake dispatches on the SQL it is given
   and each canned answer carries a real secret — a bcrypt hash, an Emirates ID
   in the government's own format, an Expo push token, a Dubai address — so
   that "nothing secret survived" can be asserted by sweeping the whole
   serialised response rather than by checking the fields somebody remembered. */
import express from 'express';
import { readFileSync } from 'node:fs';
import { win, winDays } from '../api/window.js';
import { isAdmin } from '../api/admin_gate.js';
import { secretField, redactSampleValue, IDENTITY_DOCS, stripIdentity, withheldNote } from '../api/redact.js';
import { vehicleLatest } from '../api/custody_sql.js';
import { exportRoutes } from '../api/export_routes.js';
import { responseCache } from '../api/cache.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SRC = readFileSync('api/server.js', 'utf8');
/* Both ends must be found. indexOf returning -1 and slicing from it yields a
   fragment that still parses and tests nothing, which is the failure mode
   test/mount.mjs's own marker guard exists to prevent. */
function slice(start, end, from = 0) {
  const a = SRC.indexOf(start, from);
  const b = a < 0 ? -1 : SRC.indexOf(end, a + start.length);
  if (a < 0 || b < 0) {
    throw new Error(`api/server.js markers not found: ${JSON.stringify(start)} → `
      + `${JSON.stringify(end)} (start=${a}, end=${b}). Update this test to match the source.`);
  }
  return SRC.slice(a, b + end.length);
}

const F_CACHE_GUARD = slice('const VARIES_BY_CALLER', '    : cache(req, res, next)));');
const F_PROVIDER_FILTER = slice('const PROVIDER_COL', 'OR TRUE)`);');
const F_RAW_VALUES = slice("app.get('/api/schema/raw-values'", '\n}));\n');
const F_COMPLIANCE = slice('const CANON_NAME = (col)', '\n}));\n',
  SRC.indexOf('const CANON_NAME = (col)'));
const F_EXPORT = slice('const LOCATION_COLS =', '\n});\n');

/* Evaluated with the injected names bound as parameters, exactly as
   test/mount.mjs does. Anything the fragment reaches for that is not in here
   is a ReferenceError with the missing name in it, which is the message you
   want when a route grows a dependency. */
function mount(app, fragment, injected) {
  const names = Object.keys(injected);
  // eslint-disable-next-line no-new-func
  new Function('app', ...names, fragment)(app, ...names.map((k) => injected[k]));
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(500).json({ error: 'internal', detail: String(e && e.stack || e).slice(0, 400) });
});

async function serve(build) {
  const app = express();
  build(app);
  const server = app.listen(0);
  server.keepAliveTimeout = 0;
  const port = server.address().port;
  const get = async (path, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* csv, or an express error page */ }
    return { status: r.status, headers: r.headers, text, body };
  };
  return { get, close: () => server.close() };
}

/* ── the real secrets these routes were handing out ──────────────────────
   Verbatim shapes from production. The bcrypt hash and the Emirates ID are
   real formats with invented digits; the push token is the shape Expo issues,
   which is a capability to notify that driver's handset and not a fact about a
   ride. Anything matching these must not appear in any anonymous response. */
const BCRYPT = '$2b$10$Gx5ViZ06m2p15VqHkOxocOXpXRbXsucIF.eiGUY2KE1gefD8hKo3u';
const EMIRATES = '784-2001-4740905-4';
const PUSH = 'ExponentPushToken[U_mydqA-q0vfNoQZ1xHxYs]';
const HOTEL_DRIVER = JSON.stringify({
  _id: '68e368e3ff76a73626e0720e',
  role: 'driver',
  phone: '971566764794',
  email: 'joseph.w@example.ae',
  firstName: 'Joseph',
  lastName: 'Wandera',
  password: BCRYPT,
  emiratesId: EMIRATES,
  notificationToken: PUSH,
  currentStatus: 'offline',
});
const SECRET_RE = new RegExp([
  '\\$2[aby]\\$\\d\\d\\$',          // any bcrypt hash
  'ExponentPushToken',              // any Expo push token
  '\\b784-\\d{4}-\\d{7}-\\d\\b',    // any Emirates ID
].join('|'));

console.log('\n/api/schema/raw-values — a sampler that did not know what it was sampling');
{
  const seen = [];
  const q = async (sql) => {
    seen.push(sql.replace(/\s+/g, ' ').trim());
    if (/GROUP BY raw ->> \$2/.test(sql)) {
      // The secret path: counts only, no value column at all.
      return [{ n: 41 }, { n: 7 }, { n: 1 }];
    }
    return [
      { value: HOTEL_DRIVER, n: 12 },
      { value: 'Dubai Marina', n: 3 },
      { value: null, n: 2 },
      /* A record with nothing secret in it, written the way Postgres writes
         jsonb to text — a space after every colon. redactSampleValue()
         re-serialises without those spaces, so this row's string necessarily
         changes even though nothing was taken out of it. It must still come
         back byte-identical and unflagged, or every field on the page reads as
         redacted and the flag stops meaning anything. */
      { value: '{"email": "wisalm213@example.ae", "phone": "+971508527871", "firstName": "Wisal"}', n: 8 },
    ];
  };
  const injected = { q, wrap, win, secretField, redactSampleValue, IDENTITY_DOCS, stripIdentity, withheldNote };
  const api = await serve((app) => {
    mount(app, `${F_PROVIDER_FILTER}\n${F_RAW_VALUES}`, injected);
  });
  const WIN = 'from=2025-09-05&to=2026-09-05';

  // 1. A secret-shaped key is not sampled at all.
  const secret = await api.get(`/api/schema/raw-values?table=trip&key=password&${WIN}`);
  check('secret key answers 200 rather than refusing', secret.status === 200, secret.text.slice(0, 200));
  check('secret key returns an ARRAY, the shape api/public/providers.js reads',
    Array.isArray(secret.body), JSON.stringify(secret.body).slice(0, 120));
  check('every row of a secret key is marked withheld',
    secret.body.every((r) => r.withheld === true && r.value === '(withheld)'),
    JSON.stringify(secret.body).slice(0, 200));
  // 2. The COUNTS survive — that is what the endpoint is for.
  check('the counts come back unredacted and in order',
    JSON.stringify(secret.body.map((r) => r.n)) === '[41,7,1]',
    JSON.stringify(secret.body.map((r) => r.n)));
  check('the reason names the field and the cardinality',
    /"password"/.test(secret.body[0].withheld_reason)
      && /3 distinct values across 49 stored records/.test(secret.body[0].withheld_reason),
    secret.body[0].withheld_reason);
  // 3. The value never left the database.
  const secretSql = seen[seen.length - 1];
  check('the secret path does not SELECT the value at all',
    !/AS value/.test(secretSql) && /GROUP BY raw ->> \$2/.test(secretSql), secretSql);

  // 4. An innocent key whose VALUE is a whole record.
  seen.length = 0;
  const obj = await api.get(`/api/schema/raw-values?table=trip&platform=hotel&key=driver&${WIN}`);
  const rec = JSON.parse(obj.body[0].value);
  check('a record value keeps phone, email and name — the operator asked for those',
    rec.phone === '971566764794' && rec.email === 'joseph.w@example.ae' && rec.firstName === 'Joseph',
    JSON.stringify(rec));
  check('a record value loses password, emiratesId and notificationToken',
    !('password' in rec) && !('emiratesId' in rec) && !('notificationToken' in rec),
    Object.keys(rec).join(','));
  check('the redacted record row says it was redacted, and why',
    obj.body[0].withheld === true && /credential or an identity document/.test(obj.body[0].withheld_reason),
    JSON.stringify(obj.body[0]).slice(0, 200));
  // 5. A row that lost nothing must not grow a caveat it has not earned.
  check('a plain scalar value is returned unchanged and unflagged',
    obj.body[1].value === 'Dubai Marina' && !('withheld' in obj.body[1]),
    JSON.stringify(obj.body[1]));
  check('a NULL value is left null, not turned into a string',
    obj.body[2].value === null && !('withheld' in obj.body[2]),
    JSON.stringify(obj.body[2]));
  /* The one a string comparison gets wrong: jsonb's text form has a space after
     every colon and JSON.stringify does not, so a record that lost NOTHING
     still comes back as a different string. */
  check('a record with nothing secret in it is byte-identical and unflagged',
    obj.body[3].value === '{"email": "wisalm213@example.ae", "phone": "+971508527871", "firstName": "Wisal"}'
      && !('withheld' in obj.body[3]), JSON.stringify(obj.body[3]));
  // 6. The sweep: nothing secret-shaped anywhere in either payload.
  check('no bcrypt hash, push token or Emirates ID anywhere in the response',
    !SECRET_RE.test(obj.text) && !SECRET_RE.test(secret.text),
    (obj.text.match(SECRET_RE) || secret.text.match(SECRET_RE) || []).join(''));
  api.close();
}

/* ── /api/compliance/drivers ──────────────────────────────────────────── */
const COMPLIANCE_ROWS = [
  { platform: 'hotel', driver_ext_id: 'h-1', full_name: 'SAYED KAMAL SAYED MIR', phone: '971563951581',
    email: null, picture_url: null, licence_no: '123456', licence_expires: '2026-01-01T00:00:00.000Z',
    emirates_id: '784-1977-5137316-4', fleet_id: 'ecosine', days_left: -247, state: 'offline',
    suspension_reason: null, rating: null, last_ever: '2026-08-30T12:00:00.000Z', lifetime_trips: 412,
    activity_by_name: false, days_since_last_trip: 6, licence_placeholder: true,
    licence_no_placeholder: true, vehicle: { plate: 'L39421', day: '2026-08-30' } },
  { platform: 'uber', driver_ext_id: 'u-2', full_name: 'Muhammed Shahab Khan', phone: '971501234567',
    email: 'shahab@example.ae', picture_url: null, licence_no: null, licence_expires: null,
    emirates_id: null, fleet_id: 'egari', days_left: null, state: 'active', suspension_reason: null,
    rating: 4.9, last_ever: '2026-09-04T20:17:23.000Z', lifetime_trips: 1290, activity_by_name: true,
    days_since_last_trip: 1, licence_placeholder: false, licence_no_placeholder: false, vehicle: null },
];
const TOTALS = { total: 289, with_date: 94, expired: 0, within_45: 0, placeholder: 94,
  no_date_at_all: 195, with_emirates_id: 123, with_number: 94, placeholder_numbers: 94,
  real_numbers: 0 };

function complianceApp() {
  const q = async (sql) => {
    if (/GROUP BY licence_expires/.test(sql)) {
      return [{ licence_expires: '2026-01-01', n: 94, with_date: 94, distinct_numbers: 1 }];
    }
    if (/GROUP BY licence_no/.test(sql)) {
      return [{ licence_no: '123456', n: 94, with_number: 94, distinct_numbers: 1 }];
    }
    if (/WITH life AS/.test(sql)) return COMPLIANCE_ROWS.map((r) => ({ ...r }));
    if (/count\(\*\)::int total/.test(sql)) return [TOTALS];
    if (/GROUP BY 1 HAVING/.test(sql)) {
      return [{ platform: 'hotel', n: 123, of_n: 132 }, { platform: 'uber', n: 0, of_n: 157 }];
    }
    throw new Error(`unexpected SQL in the compliance route: ${sql.slice(0, 80)}`);
  };
  return (app) => mount(app, F_COMPLIANCE, { q, wrap, isAdmin, vehicleLatest,
    IDENTITY_DOCS, stripIdentity, withheldNote });
}

console.log('\n/api/compliance/drivers — 123 Emirates IDs to anyone who knew the URL');
{
  process.env.ADMIN_TOKEN = 'test-token-not-a-real-one';
  const api = await serve(complianceApp());
  const anon = await api.get('/api/compliance/drivers');
  const admin = await api.get('/api/compliance/drivers', { 'x-admin-token': process.env.ADMIN_TOKEN });
  const wrongToken = await api.get('/api/compliance/drivers', { 'x-admin-token': 'nope' });

  check('anonymous still gets 200 and every row', anon.status === 200 && anon.body.drivers.length === 2,
    anon.text.slice(0, 200));
  // The columns go — the KEY is absent, not merely null, so a page can tell
  // "withheld" from "the provider sent an empty string".
  check('anonymous rows carry no licence_no key at all',
    anon.body.drivers.every((r) => !('licence_no' in r)), JSON.stringify(anon.body.drivers[0]));
  check('anonymous rows carry no emirates_id key at all',
    anon.body.drivers.every((r) => !('emirates_id' in r)), JSON.stringify(anon.body.drivers[0]));
  // Phone and email stay: a feature the operator asked for, not an oversight.
  check('phone survives redaction on every row',
    anon.body.drivers.every((r) => 'phone' in r) && anon.body.drivers[0].phone === '971563951581');
  check('email survives redaction', anon.body.drivers[1].email === 'shahab@example.ae');
  check('the name survives redaction', anon.body.drivers[0].full_name === 'SAYED KAMAL SAYED MIR');
  // The page's whole job survives.
  check('licence_expires survives — "whose licence lapses on Thursday" still answerable',
    anon.body.drivers[0].licence_expires === '2026-01-01T00:00:00.000Z');
  check('days_left and the placeholder flags survive',
    anon.body.drivers[0].days_left === -247
      && anon.body.drivers[0].licence_placeholder === true
      && anon.body.drivers[0].licence_no_placeholder === true,
    JSON.stringify(anon.body.drivers[0]));
  check('the expired / expiring / coverage totals are untouched',
    JSON.stringify(anon.body.totals) === JSON.stringify(TOTALS), JSON.stringify(anon.body.totals));
  check('emirates_id_by_platform — which channel reports one — is untouched',
    anon.body.emirates_id_by_platform[0].n === 123);
  // It says what it withheld.
  check('identity_withheld names both columns',
    JSON.stringify(anon.body.identity_withheld) === '["licence_no","emirates_id"]',
    JSON.stringify(anon.body.identity_withheld));
  check('identity_withheld_reason is a sentence a page can print',
    /withheld/.test(anon.body.identity_withheld_reason || '')
      && /x-admin-token/.test(anon.body.identity_withheld_reason || ''),
    String(anon.body.identity_withheld_reason).slice(0, 120));
  check('the Emirates ID caveat keeps its channel evidence AND says the numbers are withheld',
    /123 of 289 people carry an Emirates ID/.test(anon.body.emirates_id_caveat)
      && /withheld/.test(anon.body.emirates_id_caveat), anon.body.emirates_id_caveat);
  check('the licence caveat keeps the default evidence AND says the numbers are withheld',
    /1 distinct value across all of them/.test(anon.body.licence_no_caveat)
      && /withheld/.test(anon.body.licence_no_caveat), anon.body.licence_no_caveat);
  check('the caveat does not quote the placeholder number to an anonymous reader',
    !/123456/.test(anon.body.licence_no_caveat) && anon.body.placeholder_licence_no === null,
    `${anon.body.placeholder_licence_no} / ${anon.body.licence_no_caveat}`);
  check('the placeholder DATE is still named — it is not an identity document',
    anon.body.placeholder_date === '2026-01-01' && anon.body.placeholder_rows === 94);
  // The sweep, which is what catches a column added back next year.
  check('no Emirates-ID-shaped string anywhere in the anonymous payload',
    !SECRET_RE.test(anon.text) && !/\b123456\b/.test(anon.text),
    (anon.text.match(SECRET_RE) || []).join(''));

  // An administrator gets the whole thing.
  check('an admin token returns licence_no and emirates_id',
    admin.body.drivers[0].licence_no === '123456'
      && admin.body.drivers[0].emirates_id === '784-1977-5137316-4',
    JSON.stringify(admin.body.drivers[0]).slice(0, 200));
  check('an admin is told nothing was withheld',
    JSON.stringify(admin.body.identity_withheld) === '[]'
      && admin.body.identity_withheld_reason === null
      && admin.body.placeholder_licence_no === '123456');
  check('the admin caveat quotes the placeholder so the operator can recognise it',
    /"123456"/.test(admin.body.licence_no_caveat), admin.body.licence_no_caveat);
  check('a WRONG token is treated as anonymous, not as an admin',
    !('emirates_id' in wrongToken.body.drivers[0]) && !SECRET_RE.test(wrongToken.text));
  api.close();
}

console.log('\nthe response cache must not hand an admin body to the next anonymous GET');
{
  process.env.ADMIN_TOKEN = 'test-token-not-a-real-one';
  /* The real cache, not a stub. Its whole key is req.originalUrl, so this is
     the exact sequence that would undo the redaction above: an operator opens
     the page with their token, and the next anonymous reader is served their
     body out of the map without the route ever running. */
  const cache = responseCache({
    pool: { query: async () => ({ rows: [{ c: 'v1', r: 'v1' }] }) },
    port: 0,
  });
  const api = await serve((app) => {
    mount(app, F_CACHE_GUARD, { cache });
    app.get('/api/anything-else', (_req, res) => res.json({ n: Date.now() }));
    complianceApp()(app);
  });
  const admin = await api.get('/api/compliance/drivers', { 'x-admin-token': process.env.ADMIN_TOKEN });
  const anon = await api.get('/api/compliance/drivers');
  check('the admin request really did get the identity numbers',
    admin.body.drivers[0].emirates_id === '784-1977-5137316-4');
  check('the anonymous request AFTER it is still redacted',
    !('emirates_id' in anon.body.drivers[0]) && !SECRET_RE.test(anon.text),
    anon.text.slice(0, 200));
  check('/api/compliance/drivers bypasses the cache entirely (no x-cache header)',
    !anon.headers.get('x-cache'), String(anon.headers.get('x-cache')));
  // Proof the guard is narrow: everything else is still cached.
  const other = await api.get('/api/anything-else');
  check('every other /api route is still cached', other.headers.get('x-cache') === 'miss',
    String(other.headers.get('x-cache')));
  api.close();
}

/* ── /api/export/trips.csv ────────────────────────────────────────────── */
console.log('\n/api/export/trips.csv — 262,162 rows of pickup and drop-off to one anonymous GET');
{
  process.env.ADMIN_TOKEN = 'test-token-not-a-real-one';
  const PICKUP = 'Al Jadaf - Dubai - United Arab Emirates';
  const DROPOFF = 'Garhoud Area - opposite to Airport Terminal 3 - Al Garhoud - Dubai';
  const TRIPS = [
    { day: '2026-08-05', fleet: 'ecosine', channel: 'uber', trip_id: 'cacd83fd-89c9-11f0',
      requested_at: '2025-09-04T20:00:46.000Z', ended_at: '2025-09-04T20:17:23.000Z',
      driver_name: 'Muhammed Shahab Khan', driver_ext_id: 'c35f5806', plate: 'L39421',
      pickup_addr: PICKUP, dropoff_addr: DROPOFF, distance_km: 8.08, product: 'UberX',
      payment_type: 'offline', status: 'completed', outcome: 'completed', price: 33.1, currency: 'AED' },
    // A booking the provider recorded no address for. It must stay EMPTY, so
    // the file distinguishes "withheld" from "never sent" — the distinction
    // this whole fix exists to preserve.
    { day: '2026-08-05', fleet: 'egari', channel: 'bolt', trip_id: 'b-2',
      requested_at: '2026-08-05T09:00:00.000Z', ended_at: '2026-08-05T09:12:00.000Z',
      driver_name: 'Wisal Muhammad', driver_ext_id: 'b-77', plate: 'L45240',
      pickup_addr: null, dropoff_addr: '', distance_km: 4.2, product: 'Bolt',
      payment_type: 'card', status: 'finished', outcome: 'completed', price: 19, currency: 'AED' },
  ];
  const q = async (sql) => {
    if (/count\(\*\)::int n FROM trip_norm/.test(sql)) return [{ n: TRIPS.length }];
    if (/SELECT DISTINCT local_day/.test(sql)) return [{ d: '2026-08-05' }];
    if (/external_id AS trip_id/.test(sql)) return TRIPS.map((r) => ({ ...r }));
    if (/GROUP BY 1, 2, 3/.test(sql)) {
      return [{ day: '2026-08-05', fleet: 'ecosine', channel: 'uber', bookings: 2, completed: 2,
        drivers: 2, vehicles: 2, km: 12.3, priced_bookings: 2, fares: 52.1, currency: 'AED' }];
    }
    throw new Error(`unexpected SQL in the export: ${sql.slice(0, 80)}`);
  };
  const api = await serve((app) => {
    mount(app, F_EXPORT, { express, exportRoutes, q, wrap, winDays, log: null, isAdmin });
  });
  const WIN = 'from=2026-08-01&to=2026-08-31';
  const anon = await api.get(`/api/export/trips.csv?grain=trip&${WIN}`);
  const admin = await api.get(`/api/export/trips.csv?grain=trip&${WIN}`,
    { 'x-admin-token': process.env.ADMIN_TOKEN });

  check('the export is still SERVED to an anonymous caller, not refused',
    anon.status === 200 && anon.text.split('\n').filter(Boolean).length === 3,
    `${anon.status} / ${anon.text.slice(0, 120)}`);
  check('no pickup or drop-off address survives an anonymous export',
    !anon.text.includes(PICKUP) && !anon.text.includes(DROPOFF), anon.text.slice(0, 300));
  const cells = anon.text.trim().split('\n').map((l) => l.split(','));
  const head = cells[0];
  const iPick = head.indexOf('pickup_addr'), iDrop = head.indexOf('dropoff_addr');
  check('the address columns are still declared, so the file shape is unchanged',
    iPick === 9 && iDrop === 10, head.join(','));
  check('a recorded address reads (withheld) rather than blank',
    cells[1][iPick] === '(withheld)' && cells[1][iDrop] === '(withheld)', cells[1].join(','));
  check('an address the provider never sent stays EMPTY, not "(withheld)"',
    cells[2][iPick] === '' && cells[2][iDrop] === '', cells[2].join(','));
  check('the response names the withheld columns',
    anon.headers.get('x-export-withheld') === 'pickup_addr,dropoff_addr'
      && /x-admin-token/.test(anon.headers.get('x-export-withheld-reason') || ''),
    String(anon.headers.get('x-export-withheld')));
  check('the row count and window headers still describe the file',
    anon.headers.get('x-export-rows') === '2'
      && anon.headers.get('x-export-window') === '2026-08-01..2026-08-31');
  // Everything else must be byte-identical, or this is a feature removal
  // dressed as a security fix.
  const admCells = admin.text.trim().split('\n').map((l) => l.split(','));
  const others = head.map((_, i) => i).filter((i) => i !== iPick && i !== iDrop);
  check('every other column is byte-identical to the admin export',
    admCells.every((row, r) => others.every((i) => row[i] === cells[r][i])),
    `${admCells[1].join(',')}\n${cells[1].join(',')}`);
  check('an admin export carries the real addresses and no withheld header',
    admin.text.includes(PICKUP) && admin.text.includes(DROPOFF)
      && !admin.headers.get('x-export-withheld'), admin.text.slice(0, 300));

  // grain=day never had an address in it, and must be untouched for everybody.
  const dayAnon = await api.get(`/api/export/trips.csv?grain=day&${WIN}`);
  const dayAdmin = await api.get(`/api/export/trips.csv?grain=day&${WIN}`,
    { 'x-admin-token': process.env.ADMIN_TOKEN });
  check('grain=day is identical for both callers', dayAnon.text === dayAdmin.text
    && dayAnon.text.includes('2026-08-05,ecosine,uber,2,2,2,2,12.3,2,52.1,AED'),
  dayAnon.text.slice(0, 200));
  api.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
