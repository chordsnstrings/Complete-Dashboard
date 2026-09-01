/* What each provider actually sends.
   ──────────────────────────────────────────────────────────────────────────
   Every collector in this repo maps a chosen subset of a response into
   columns, and drops the rest at the door. Six months later "does Uber tell us
   whether a trip was corporate?" cannot be answered from the code, because the
   code only describes what somebody decided to keep.

   For rows we persist, /api/schema/raw-fields answers that from the stored
   payload. For the surfaces we call and do NOT persist — a driver roster, a
   ledger page, a vehicle list, a property list — there has never been anything
   to inspect at all. This closes that gap.

   Three rules make it safe to run on a schedule:

   1. Every surface below is one the collectors already call, with the same
      credentials and the same read-only verb. Nothing here discovers new
      endpoints by guessing at names, and there is no pass-through of a
      caller-supplied URL, so it cannot be turned into a proxy onto the fleet's
      credentials.
   2. The window is deliberately tiny — a few days — because the question is
      what the shape is, not what the numbers are.
   3. Responses are reduced to SHAPE before anything is stored. Field names,
      fill rates, and sample values ONLY for fields narrow enough to be a
      dimension. A field with many distinct values is an identifier, an address
      or free text, and its contents never leave this module. */

import { config, loadSettings } from './config.js';
import { http, qs } from './http.js';
import { upsert } from './db.js';
import { uberOAuthToken, uberWebHeaders, PORTAL } from './auth/uber.js';
import { fiToken } from './sources/bolt.js';
import { dotDate, iso, daysAgo } from './util.js';
import { log } from './log.js';
import { probeEarnerWindow } from './sources/uber.js';

const SRC = 'probe';
const MAX_VALUES = 12;

/* Reduce any JSON to a description of its shape. */
export function describe(records, { maxValues = MAX_VALUES } = {}) {
  const rows = Array.isArray(records) ? records : [records];
  const fields = new Map();
  const walk = (obj, prefix = '', depth = 0) => {
    if (obj == null || typeof obj !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path, depth + 1); continue; }
      const f = fields.get(path)
        || { key: path, present: 0, filled: 0, values: new Set(), all: new Set(), type: null };
      f.present++;
      if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) f.filled++;
      f.type = f.type || (Array.isArray(v) ? 'array' : typeof v);
      if (!Array.isArray(v)) {
        const val = String(v).slice(0, 48);
        /* Two counters, because they answer different questions. `values` is
           the SAMPLE the page may print and stays capped — a field with many
           distinct values is an identifier or free text and its contents never
           leave this module. `all` is the COUNT, and a count is not contents.

           They were one set, capped at maxValues + 2, so distinct_seen
           saturated at exactly 14 for every wide field in the corpus: the page
           reported "14 distinct" for a trip uuid, a plate, a driver name and a
           timestamp alike, and 14 was never once the real answer. Bounded by
           the 300-row sample below, so an uncapped count is at most 300. */
        if (f.values.size <= maxValues + 1) f.values.add(val);
        f.all.add(val);
      }
      fields.set(path, f);
    }
  };
  const sample = rows.slice(0, 300);
  sample.forEach((r) => walk(r));
  return [...fields.values()].map((f) => ({
    key: f.key, type: f.type,
    fill_pct: f.present ? Math.round((f.filled / f.present) * 100) : 0,
    distinct_seen: f.all.size,
    // True where every row in the sample carried a different value, so the
    // count is a floor rather than the field's real cardinality.
    distinct_capped: f.all.size >= sample.length && sample.length > 0,
    values: f.all.size <= maxValues ? [...f.values] : null,
  })).sort((a, b) => b.fill_pct - a.fill_pct || a.key.localeCompare(b.key));
}

/* A payload whose ONLY keys are error keys is a refusal, whatever the HTTP
   status said. FMS answers `{"error":"Authentication failed"}` with a 200, and
   the probe recorded {ok:true, record_count:0, top_keys:["error"]} — then
   offered "error" as an unmapped field we could keep, which reads as "the
   provider sends a field we are not storing" rather than "the provider will
   not talk to us". */
const ERROR_KEYS = new Set(['error', 'message', 'errormessage', 'fault', 'errors', 'status_message']);
export function payloadError(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (!keys.length || !keys.every((k) => ERROR_KEYS.has(norm(k)))) return null;
  const said = keys.map((k) => String(data[k])).filter((v) => v && v !== 'null').join('; ');
  return said ? said.slice(0, 300) : null;
}

/* Find the first array of objects in a response — providers wrap their lists
   under whatever key they like, and the shape is what matters. */
export function firstList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object') { const inner = firstList(v); if (inner) return inner; }
  }
  return null;
}

/* Which of a surface's fields have no column on our side.
   ──────────────────────────────────────────────────────────────────────────
   Name-matching alone is not good enough here, and the first live pass proved
   it: FMS sends "Start Location", "StartLat", "Total Travel Distance" and
   "Trip Duration", every one of which the collector maps — to pickup_addr,
   pickup_lat, distance_km and duration_s. All twelve came back flagged as "not
   kept", which makes the single most useful column on the page worthless.

   So each surface declares its own aliases. A field is unmapped only when it
   matches no column name AND no declared alias. A false "unmapped" costs a
   reader's glance; a false "mapped" hides a field forever, so where the two
   trade off this still errs toward flagging. */
export const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

export function unmappedAgainst(fields, columns, aliases = {}) {
  const have = new Set(columns.map(norm));
  const aliased = new Set(Object.keys(aliases).map(norm));
  return fields.filter((f) => {
    if (!f.fill_pct) return false;
    const leaf = norm(f.key.split('.').pop());
    const full = norm(f.key);
    return !have.has(leaf) && !have.has(full) && !aliased.has(leaf) && !aliased.has(full);
  }).map((f) => f.key);
}

// The columns each surface's data would land in, so "unmapped" means something.
const TRIP_COLS = ['platform', 'external_id', 'fleet_id', 'plate', 'driver_ext_id', 'driver_name',
  'requested_at', 'ended_at', 'pickup_addr', 'pickup_lat', 'pickup_lng', 'dropoff_addr', 'dropoff_lat',
  'dropoff_lng', 'distance_km', 'duration_s', 'status', 'product', 'payment_type', 'seat_count',
  'price', 'currency', 'deadhead_km', 'cost', 'margin', 'hours', 'zone', 'partner_id', 'partner_name',
  'is_scheduled', 'is_missing', 'driver_own', 'authorized', 'service_type', 'vehicle_ext_id'];
const DRIVER_COLS = ['platform', 'driver_ext_id', 'fleet_id', 'full_name', 'phone', 'emirates_id',
  'licence_no', 'licence_expires', 'state', 'device_brand', 'device_model', 'rating',
  'acceptance_rate', 'cancellation_rate', 'completion_rate', 'trips', 'earnings'];
const VEHICLE_COLS = ['platform', 'vehicle_ext_id', 'plate', 'fleet_id', 'make', 'model', 'year',
  'colour', 'colour_hex', 'vin', 'image_url', 'owner_ext_id', 'assigned_driver_ext_id', 'compliance_status'];

/* ── the surfaces ─────────────────────────────────────────────────────────
   Each is a call one of the collectors already makes. `cols` names the table
   its data lands in, so the probe can report what the provider sends that we
   have nowhere to put. */

/* What each provider's oddly-named fields actually land in. Written from the
   collector's own mapping, so if a collector stops mapping a field the alias
   here is what makes the probe say so. */
const FMS_TRIP_ALIASES = {
  'Plate No': 'plate', 'Start Time': 'requested_at', 'End Time': 'ended_at',
  'Start Location': 'pickup_addr', 'End Location': 'dropoff_addr',
  StartLat: 'pickup_lat', StartLon: 'pickup_lng', EndLat: 'dropoff_lat', EndLon: 'dropoff_lng',
  'Total Travel Distance': 'distance_km', 'Trip Duration': 'duration_s',
  'Seat Count': 'seat_count', Slno: 'external_id',
};
const HOTEL_TRIP_ALIASES = {
  _id: 'external_id', startTime: 'requested_at', endTime: 'ended_at',
  pickLocation: 'pickup_addr', dropOffLocation: 'dropoff_addr',
  startLat: 'pickup_lat', startLon: 'pickup_lng', endLat: 'dropoff_lat', endLon: 'dropoff_lng',
  totalDistance: 'distance_km', paymentMethod: 'payment_type', type: 'product',
  tripZone: 'zone', isScheduled: 'is_scheduled', isMissingTrip: 'is_missing',
  driverOwnTrip: 'driver_own', hotel: 'partner_id',
  'car.licenseNumber': 'plate', 'driver._id': 'driver_ext_id', 'driver.firstName': 'driver_name',
  'driver.lastName': 'driver_name', driverStartLat: 'deadhead_km', driverStartLon: 'deadhead_km',
};
const YANGO_TRIP_ALIASES = {
  id: 'external_id', car_license_number: 'plate', driver_id: 'driver_ext_id',
  driver_full_name: 'driver_name', booked_at: 'requested_at', ended_at: 'ended_at',
  address_from: 'pickup_addr', address_to: 'dropoff_addr', mileage: 'distance_km',
  category: 'product', payment_method: 'payment_type', currency_code: 'currency',
};
const BOLT_DRIVER_ALIASES = {
  driver_uuid: 'driver_ext_id', first_name: 'full_name', last_name: 'full_name',
  phone: 'phone', state: 'state',
};
/* Uber's trip export names every column in English prose, so norm() — which
   strips non-alphanumerics and compares against information_schema — can never
   match "Trip request time" to requested_at. /api/schema/raw-fields did
   exactly that comparison and reported THIRTEEN of Uber's fifteen fields as
   "RAW ONLY", including Trip UUID, Number plate, Driver UUID, Trip distance,
   Trip request time, Trip drop-off time, Trip status, both addresses and
   Product type — every one of which the collector maps. The single most useful
   column on the Data sources page said the opposite of the truth. */
const UBER_TRIP_ALIASES = {
  'Trip UUID': 'external_id', 'Trip ID': 'external_id',
  'Number plate': 'plate', 'Vehicle plate': 'plate', 'License plate': 'plate',
  'Driver UUID': 'driver_ext_id', 'Driver ID': 'driver_ext_id',
  'Driver First Name': 'driver_name', 'Driver Last Name': 'driver_name',
  'Driver name': 'driver_name',
  'Trip request time': 'requested_at', 'Request time': 'requested_at',
  'Trip drop-off time': 'ended_at', 'Drop-off time': 'ended_at',
  'Trip distance': 'distance_km', 'Distance (km)': 'distance_km',
  'Trip duration': 'duration_s', 'Trip Duration': 'duration_s',
  'Trip status': 'status', 'Product type': 'product',
  'Pick-up address': 'pickup_addr', 'Drop-off address': 'dropoff_addr',
  'Payment type': 'payment_type', 'Organization': 'fleet_id',
  'Vehicle UUID': 'vehicle_ext_id',
};

/* The alias tables, by the shape they describe, so a reader OTHER than the
   probe can use them. /api/schema/raw-fields answers the same question about
   the same payloads — "what does this provider send that we have nowhere to
   put" — and was matching on names alone, so it disagreed with the probe about
   thirteen Uber fields. One table, two readers. */
export const RAW_ALIASES = {
  trip: {
    uber: UBER_TRIP_ALIASES, fms: FMS_TRIP_ALIASES,
    hotel: HOTEL_TRIP_ALIASES, yango: YANGO_TRIP_ALIASES,
  },
  driver_performance: { bolt: BOLT_DRIVER_ALIASES, yango: {} },
  alert: { fms: { 'Plate No': 'plate', 'Alert Name': 'alert_type',
    'Alert Date Time': 'occurred_at', Slno: 'external_id' } },
  telemetry_snapshot: { cabman: { VehicleID: 'plate', gmt: 'captured_at', state: 'ignition',
    SeatSensorValue: 'seat_occupied', Status: 'status' } },
  vehicle_profile: {},
};

export function surfaces({ from, to }) {
  const list = [];
  const add = (provider, surface, cols, note, run, aliases) =>
    list.push({ provider, surface, cols, note, run, aliases: aliases || null });

  /* A provider that is not configured must produce a VISIBLE row, never
     silence. The first live pass returned no Uber surfaces at all — not an
     error, an absence — because the guard tested config.uber.clientId when the
     real path is config.uber.oauth.clientId. Zero rows and "this provider has
     nothing to offer" looked identical, which is the exact confusion this whole
     module exists to remove. */
  const skip = (provider, why) =>
    list.push({ provider, surface: '(not configured)', cols: null, note: why, aliases: null,
      run: async () => { throw new Error(why); } });

  /* Uber — OAuth REST. The trip report itself needs the web session cookie and
     is probed separately, because that cookie expires and its absence is worth
     reporting as its own finding rather than as a failure of everything. */
  if (!config.uber?.oauth?.clientId) skip('uber', 'UBER_CLIENT_ID is not set, so no Uber surface can be probed');
  else {
    const rest = {
      drivers: (org) => `https://api.uber.com/v1/vehicle-suppliers/drivers?org_id=${encodeURIComponent(org)}&limit=50`,
      'driver-actions': (org) => `https://api.uber.com/v1/vehicle-suppliers/drivers/actions?org_id=${encodeURIComponent(org)}&limit=50`,
      vehicles: (org) => `https://api.uber.com/v1/vehicle-suppliers/vehicles?org_id=${encodeURIComponent(org)}&limit=50`,
      transactions: (org) => `https://api.uber.com/v1/vehicle-suppliers/transactions?${qs({ org_id: org, limit: 50,
        start_time: new Date(from).getTime(), end_time: new Date(to).getTime() })}`,
      // The one surface that might carry the money the trip export omits.
      'earner-payments': (org) => `https://api.uber.com/v1/vehicle-suppliers/earners/payments?${qs({ org_id: org,
        start_time: new Date(from).getTime(), end_time: new Date(to).getTime(), page_size: 50 })}`,
    };
    const cols = { drivers: DRIVER_COLS, 'driver-actions': DRIVER_COLS, vehicles: VEHICLE_COLS,
      transactions: TRIP_COLS, 'earner-payments': ['category', 'amount', 'parent', 'driver_ext_id'] };
    for (const [name, url] of Object.entries(rest)) {
      add('uber', name, cols[name], 'OAuth REST', async () => {
        const token = await uberOAuthToken();
        const { data, status } = await http(url(config.uber.org), {
          timeoutMs: 45000, retries: 0, headers: { authorization: `Bearer ${token}` } });
        return { data, status };
      });
    }

    /* Does the provider still hold what we are missing?
       ─────────────────────────────────────────────────────────────────────
       Uber earnings are absent for every month before about March 2026 —
       20,016 bookings in September 2025 with no payout row against any of them.
       The backfill asked for those windows, none failed, and all came back
       empty. Either the provider will not serve data that old, in which case
       the half-year is gone and the product should say so, or we asked wrongly
       and re-collecting recovers it.

       An API route was written for this first and could not answer: it runs in
       the web service, and UBER_WEB_COOKIE is set on the collector alone. This
       is the process that holds it. Two windows — one known to be present and
       one known to be missing — because "the old window returned nothing" only
       means anything beside a window that returns something. */
    for (const [label, w] of Object.entries(HISTORY_PROBE)) {
      add('uber', `earner-history:${label}`, ['earnerUuid', 'netOutstanding'],
        'does the provider still serve this window', async () => {
          const r = await probeEarnerWindow(new Date(w.from), new Date(w.to));
          if (r.err) throw new Error(r.err);
          /* An ARRAY of one entry per row the provider returned, because
             record_count is the length of the first array found in the payload
             — and returning an object whose first array was the two-element
             window made every result read "2 records". Both windows reported
             the same number, I read it as two rows of earnings, and told
             somebody the missing months were recoverable on that basis. They
             were the two ends of a date range.

             One field, and it carries no identifier: the whole question is
             whether ANY row came back and whether any of it was money. */
          return {
            data: Array.from({ length: r.rows }, (_, i) => ({
              money: i < r.rows_with_money ? 'yes' : 'no',
            })),
            status: 200,
          };
        });
    }

    add('uber', 'trip-report-session', null,
      'The trip export needs a fleethub.uber.com session cookie, which expires and has to be re-pasted',
      async () => {
        // Ask for a report over three days and read only whether the session
        // was accepted. Nothing is downloaded.
        const { data, status } = await http(
          `${PORTAL}/api/vs-sp-reports-management/GenerateReport?localeCode=en-GB`, {
            method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(),
            body: JSON.stringify({
              orgId: { uuid: { value: config.uber.orgUuid } }, reportType: 'REPORT_TYPE_TRIP_ACTIVITY',
              startDate: { value: iso(new Date(from)) }, endDate: { value: iso(new Date(to)) },
              childOrgUuids: [{ uuid: { value: config.uber.orgUuid } }] }),
          });
        return { data: { accepted: data?.status === 'success' }, status };
      });
  }

  /* FMS / InfoTrack — the surfaces documented at the top of sources/fms.js.
     ─────────────────────────────────────────────────────────────────────────
     EVERY configured fleet, not the first one with a password. This took
     `.find(...)` and then `break`, so the page described Ecosine's InfoTrack
     account and said nothing at all about Egari's — two separate logins to the
     same service, which fail separately, on a page whose subject is whether
     each credential still works. A fleet with no password gets a visible
     "(not probed)" row naming the credential, the same treatment an
     unconfigured provider already gets. */
  const fmsFleets = config.fms?.fleets || [];
  if (!fmsFleets.some((f) => f.password)) skip('fms', 'no FMS fleet has a password set, so no FMS surface can be probed');
  for (const f of fmsFleets.filter((x) => !x.password)) {
    list.push({ provider: 'fms', surface: `${f.fleet}:(not probed)`, cols: null, aliases: null,
      note: `the ${f.fleet} InfoTrack account has no stored credential`,
      run: async () => { throw new Error(`FMS_${f.fleet.toUpperCase()}_PASS is not set`); } });
  }
  for (const fleet of fmsFleets.filter((x) => x.password)) {
    const call = async (op, extra = {}) => {
      const { data, status } = await http(
        `${config.fms.base}/${op}?${qs({ username: fleet.username, Password: fleet.password, ...extra })}`,
        { timeoutMs: 120000, retries: 0 });
      return { data, status };
    };
    add('fms', `${fleet.fleet}:GetTripPassenger`, TRIP_COLS, 'historical journeys', () =>
      call('GetTripPassenger', { vehicleno: 'ALL', fromdate: dotDate(new Date(from)), todate: dotDate(new Date(to)) }),
      FMS_TRIP_ALIASES);
    add('fms', `${fleet.fleet}:GetAlertData`, ['platform', 'external_id', 'plate', 'alert_type', 'occurred_at', 'lat', 'lng'],
      'harsh-driving and power events', () =>
      call('GetAlertData', { vehicleno: 'ALL', fromdate: dotDate(new Date(from)), todate: dotDate(new Date(to)) }),
      { 'Plate No': 'plate', 'Alert Name': 'alert_type', 'Alert Date Time': 'occurred_at',
        'Start Location': 'pickup_addr', Slno: 'external_id' });
    add('fms', `${fleet.fleet}:GetVehicleCurrentDetails`,
      ['plate', 'captured_at', 'lat', 'lng', 'speed', 'status', 'ignition', 'odometer'],
      'live position', () => call('GetVehicleCurrentDetails', {}));
  }

  /* CABMAN DT — the realtime tracking feed. One interface account per fleet,
     and the surface is named with the fleet: a panel headed "GetIVDData" over a
     two-fleet operator does not say whose feed it describes. */
  const cabFleets = config.cabman?.fleets || [];
  if (!cabFleets.some((f) => f.pass)) skip('cabman', 'no CABMAN fleet has a password set, so the realtime feed cannot be probed');
  for (const f of cabFleets.filter((x) => !x.pass)) {
    list.push({ provider: 'cabman', surface: `${f.fleet}:(not probed)`, cols: null, aliases: null,
      note: `the ${f.fleet} CABMAN interface account has no stored credential`,
      run: async () => { throw new Error(`CABMAN_${f.fleet.toUpperCase()}_PASS is not set`); } });
  }
  for (const cab of cabFleets.filter((x) => x.pass)) {
    add('cabman', `${cab.fleet}:GetIVDData`, ['plate', 'captured_at', 'lat', 'lng', 'speed', 'status',
      'seat_occupied', 'ignition', 'odometer'], 'realtime seat and position feed', async () => {
      // Credentials go in HEADERS on this service, not in a JSON body — the
      // collector has always done it this way and the probe must match it, or
      // it describes a 401 instead of the feed.
      const { data, status } = await http(config.cabman.url, {
        timeoutMs: 60000, retries: 0,
        headers: { InterfaceUniqueId: cab.interfaceId, InterfaceUserName: cab.user, InterfacePassword: cab.pass },
      });
      return { data, status };
    }, { VehicleID: 'plate', gmt: 'captured_at', state: 'ignition', SeatSensorValue: 'seat_occupied',
      Status: 'status' });
  }

  /* Hotel — the corporate channel. */
  if (!config.hotel?.token) skip('hotel', 'HOTEL_TOKEN is not set, so the corporate channel cannot be probed');
  else {
    const h = config.hotel;
    const get = async (path) => {
      const { data, status } = await http(`${h.base}${path}`, {
        timeoutMs: 60000, retries: 0,
        headers: { authorization: `Bearer ${h.token}`, 'x-domain': h.domain } });
      return { data, status };
    };
    add('hotel', 'hotels', ['partner_id', 'partner_name'], 'the property list', () =>
      get('/api/operation-managers/hotels'));
    add('hotel', 'trip-report', TRIP_COLS, 'the bookings themselves', () =>
      get(`/api/operation-managers/report/get-trip-report?startDate=${iso(new Date(from))}&endDate=${iso(new Date(to))}`),
      HOTEL_TRIP_ALIASES);
  }

  /* Yango — trips, drivers and the park ledger. */
  if (!config.yango?.apiKey) skip('yango', 'YANGO_API_KEY is not set, so no Yango surface can be probed');
  else {
    const post = async (path, body) => {
      const { data, status } = await http(`${config.yango.base}${path}`, {
        method: 'POST', timeoutMs: 60000, retries: 0,
        headers: { 'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
          'content-type': 'application/json', 'Accept-Language': 'en', cookie: config.yango.cookie },
        body: JSON.stringify(body) });
      return { data, status };
    };
    const dubai = (d, end) => `${iso(new Date(d))}T${end ? '23:59:59' : '00:00:00'}+04:00`;
    add('yango', 'orders/list', TRIP_COLS, 'trips', () =>
      post('/api/reports-api/v1/orders/list', { date_type: 'booked_at', date_from: dubai(from), date_to: dubai(to, true) }),
      YANGO_TRIP_ALIASES);
    add('yango', 'summary/drivers/list', DRIVER_COLS, 'per-driver period summary', () =>
      post('/api/reports-api/v2/summary/drivers/list', { date_from: dubai(from), date_to: dubai(to, true) }));
    add('yango', 'transactions/park/list', ['platform', 'external_id', 'occurred_at', 'category', 'amount'],
      'the park ledger', () =>
      post('/api/v1/reports/transactions/park/list', { query: { park: { id: config.yango.parkId },
        transaction: { event_at: { from: dubai(from), to: dubai(to, true) } } }, limit: 50 }));
  }

  /* Bolt — the fleet integration gateway.
     ─────────────────────────────────────────────────────────────────────────
     Both companies, and three surfaces each rather than one. The probe offered
     exactly `getDrivers` for exactly the first company, while /api/status
     reports COMPANIES_NOT_ALLOWED for Ecosine and REFRESH_TOKEN_INVALID for
     Egari — two different failures on two different accounts, described by one
     row that named neither. And the two surfaces that would carry the trips
     and the money this channel has never delivered were not probed at all, so
     the page could not say whether they exist. */
  if (!config.bolt?.clientId) skip('bolt', 'BOLT_CLIENT_ID is not set, so no Bolt surface can be probed');
  else {
    const boltCall = (path, company, body) => async () => {
      const t = await fiToken();
      const { data, status } = await http(`${config.bolt.fiGateway}/${path}`, {
        method: 'POST', timeoutMs: 45000, retries: 0,
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: company?.companyId,
          start_ts: Math.floor(new Date(from).getTime() / 1000),
          end_ts: Math.floor(new Date(to).getTime() / 1000), ...body }) });
      return { data, status };
    };
    for (const company of (config.bolt.companies || [])) {
      add('bolt', `${company.fleet}:getDrivers`, DRIVER_COLS, 'driver roster and state',
        boltCall('getDrivers', company, { offset: 0, limit: 50 }), BOLT_DRIVER_ALIASES);
      add('bolt', `${company.fleet}:getFleetOrders`, TRIP_COLS, 'the trips this channel has never delivered',
        boltCall('getFleetOrders', company, { offset: 0, limit: 50 }));
      add('bolt', `${company.fleet}:getCompanyEarnings`,
        ['platform', 'driver_ext_id', 'period_start', 'period_end', 'earnings', 'cash_earnings'],
        'the money this channel has never delivered',
        boltCall('getCompanyEarnings', company, {}));
    }
  }

  return list;
}

/* Run every surface, store the shape. One surface failing never stops the
   others: a provider being down is itself a result worth recording. */
/* One window the record has and one it does not. A window returning nothing
   says nothing on its own — it has to be read beside one that returns
   something, or "the provider is empty" and "our request is wrong" look
   identical. Dates rather than offsets: these name specific known facts about
   this fleet's history, and a rolling window would stop meaning them. */
const HISTORY_PROBE = {
  present: { from: '2026-08-01', to: '2026-08-07' },
  missing: { from: '2025-11-01', to: '2025-11-07' },
};

export async function probeAll({ days = 3 } = {}) {
  await loadSettings(true);
  const to = new Date();
  const from = daysAgo(days);
  const list = surfaces({ from, to });
  log.info(SRC, 'probing', { surfaces: list.length });

  const out = [];
  for (const s of list) {
    let row;
    try {
      const { data, status } = await s.run();
      const arr = firstList(data);
      const fields = describe(arr || data || {});
      /* ok meant "the call returned without throwing", which is not the same
         as "the provider answered". Yango's orders/list, summary/drivers/list
         and transactions/park/list all came back {http_status: 403, ok: true},
         Uber's transactions {404, ok: true}, and the page counted every one of
         them under "ANSWERING 18 / NOT ANSWERING 0" with failing:[]. A 403 is
         the single most actionable thing a probe can find and it was being
         reported as a success. */
      const good = status == null || (status >= 200 && status < 300);
      const refusal = arr ? null : payloadError(data);
      row = {
        provider: s.provider, surface: s.surface,
        ok: good && !refusal,
        http_status: status || 200,
        record_count: Array.isArray(arr) ? arr.length : 0,
        // How many of those rows the shape below was actually read from —
        // describe() samples the first 300, and record_count was 10,423 beside
        // a description of 300.
        described_n: Math.min(Array.isArray(arr) ? arr.length : 0, 300),
        top_keys: data && typeof data === 'object' && !Array.isArray(data)
          ? Object.keys(data).slice(0, 25) : [],
        fields: JSON.stringify(fields),
        // A refused surface has no fields worth keeping, and offering its
        // "error" key as an unmapped column is worse than offering nothing.
        unmapped: s.cols && good && !refusal
          ? unmappedAgainst(fields, s.cols, s.aliases || {}) : null,
        error: refusal || (good ? null : `HTTP ${status}`),
        note: s.note || null,
      };
    } catch (e) {
      row = { provider: s.provider, surface: s.surface, ok: false, http_status: null,
        record_count: null, described_n: null, top_keys: null, fields: null, unmapped: null,
        error: String(e).slice(0, 300), note: s.note || null };
    }
    await upsert('provider_probe', { ...row, probed_at: new Date().toISOString() },
      ['provider', 'surface']);
    out.push(row);
    log.info(SRC, `${row.provider}/${row.surface}`,
      { ok: row.ok, records: row.record_count, unmapped: row.unmapped?.length ?? null,
        err: row.error?.slice(0, 90) });
  }
  return out;
}
