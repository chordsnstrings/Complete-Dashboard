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
import { uberOAuthToken, uberWebHeaders } from './auth/uber.js';
import { fiToken } from './sources/bolt.js';
import { dotDate, iso, daysAgo } from './util.js';
import { log } from './log.js';

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
      const f = fields.get(path) || { key: path, present: 0, filled: 0, values: new Set(), type: null };
      f.present++;
      if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) f.filled++;
      f.type = f.type || (Array.isArray(v) ? 'array' : typeof v);
      if (f.values.size <= maxValues + 1 && !Array.isArray(v)) f.values.add(String(v).slice(0, 48));
      fields.set(path, f);
    }
  };
  rows.slice(0, 300).forEach((r) => walk(r));
  return [...fields.values()].map((f) => ({
    key: f.key, type: f.type,
    fill_pct: f.present ? Math.round((f.filled / f.present) * 100) : 0,
    distinct_seen: f.values.size,
    values: f.values.size <= maxValues ? [...f.values] : null,
  })).sort((a, b) => b.fill_pct - a.fill_pct || a.key.localeCompare(b.key));
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
    add('uber', 'trip-report-session', null,
      'The trip export needs a supplier.uber.com session cookie, which expires and has to be re-pasted',
      async () => {
        // Ask for a report over three days and read only whether the session
        // was accepted. Nothing is downloaded.
        const { data, status } = await http(
          'https://supplier.uber.com/api/vs-sp-reports-management/GenerateReport?localeCode=en-GB', {
            method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(),
            body: JSON.stringify({
              orgId: { uuid: { value: config.uber.orgUuid } }, reportType: 'REPORT_TYPE_TRIP_ACTIVITY',
              startDate: { value: iso(new Date(from)) }, endDate: { value: iso(new Date(to)) },
              childOrgUuids: [{ uuid: { value: config.uber.orgUuid } }] }),
          });
        return { data: { accepted: data?.status === 'success' }, status };
      });
  }

  /* FMS / InfoTrack — the surfaces documented at the top of sources/fms.js. */
  const fmsFleet = (config.fms?.fleets || []).find((f) => f.password);
  if (!fmsFleet) skip('fms', 'no FMS fleet has a password set, so no FMS surface can be probed');
  for (const fleet of (fmsFleet ? [fmsFleet] : [])) {
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
    break;   // one fleet is enough to learn the shape
  }

  /* CABMAN DT — the realtime tracking feed. */
  const cab = config.cabman?.fleets?.find((f) => f.pass);
  if (!cab) skip('cabman', 'no CABMAN fleet has a password set, so the realtime feed cannot be probed');
  if (cab) {
    add('cabman', 'GetIVDData', ['plate', 'captured_at', 'lat', 'lng', 'speed', 'status',
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

  /* Bolt — the fleet integration gateway. */
  if (!config.bolt?.clientId) skip('bolt', 'BOLT_CLIENT_ID is not set, so no Bolt surface can be probed');
  else {
    const company = config.bolt.companies?.[0];
    add('bolt', 'getDrivers', DRIVER_COLS, 'driver roster and state', async () => {
      const t = await fiToken();
      const { data, status } = await http(`${config.bolt.fiGateway}/getDrivers`, {
        method: 'POST', timeoutMs: 45000, retries: 0,
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: company?.companyId, offset: 0, limit: 50,
          start_ts: Math.floor(new Date(from).getTime() / 1000),
          end_ts: Math.floor(new Date(to).getTime() / 1000) }) });
      return { data, status };
    }, BOLT_DRIVER_ALIASES);
  }

  return list;
}

/* Run every surface, store the shape. One surface failing never stops the
   others: a provider being down is itself a result worth recording. */
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
      row = {
        provider: s.provider, surface: s.surface, ok: true, http_status: status || 200,
        record_count: Array.isArray(arr) ? arr.length : 0,
        top_keys: data && typeof data === 'object' && !Array.isArray(data)
          ? Object.keys(data).slice(0, 25) : [],
        fields: JSON.stringify(fields),
        unmapped: s.cols ? unmappedAgainst(fields, s.cols, s.aliases || {}) : null,
        error: null, note: s.note || null,
      };
    } catch (e) {
      row = { provider: s.provider, surface: s.surface, ok: false, http_status: null,
        record_count: null, top_keys: null, fields: null, unmapped: null,
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
