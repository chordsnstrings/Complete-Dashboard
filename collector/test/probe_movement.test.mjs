/* GET /api/probe/movement — shape out, never a record, never a credential.
   ══════════════════════════════════════════════════════════════════════════
   api/probe_movement.js asks four provider surfaces that carry drivers'
   positions over time: FMS GetVehicleActivity, Yango's order track, Bolt's
   getFleetStateLogs and CABMAN's GetIVDData (asked repeatedly for cadence).
   It may be left deployed only if what it returns is SHAPE — field names, fill
   rates, counts, dates, spacing statistics, enumeration distributions — and
   never a coordinate, an id, a plate, a name, a phone, an address or a
   credential, including inside an error.

   So every provider answer below is planted with exactly those things, every
   credential is a planted value, and each probe's whole serialized body is
   searched for every one of them. The provider calls go through the real
   src/http.js; only global fetch is replaced (no network), and the database,
   the settings load, the clock and the sleep are injected.

   REVERSION, run 2026-11-24 with api/probe_movement.js copied aside and
   restored byte for byte (cmp) afterwards: replacing the FMS call's
   `...activityShape(list)` with `sample: list` — the shape reduction removed,
   the provider's rows returned as they came — fails 7 checks in section 1,
   first the leak scan: the planted coordinates (25.1972, 55.2744, 25.2011,
   55.2799), the driver's name and both addresses appear in the body. The
   plate and the phone did NOT appear even then — the final whole-body scrub
   masked them (the plate is a value this request chose, the phone is
   phone-shaped) — which is that second layer doing its job, and also why the
   first layer, the shape reduction, is the one this test must hold. */
import { readFileSync } from 'node:fs';

/* Planted credentials, set before config is first read. Each carries
   "PLANTED", so one substring search finds any of them in a body. */
Object.assign(process.env, {
  FMS_ECOSINE_USER: 'fmsUserPLANTEDeco', FMS_ECOSINE_PASS: 'fmsPassPLANTEDeco1',
  FMS_EGARI_USER: 'fmsUserPLANTEDega', FMS_EGARI_PASS: 'fmsPassPLANTEDega2',
  YANGO_PARK_ID: 'parkPLANTED0001', YANGO_API_KEY: 'yangoKeyPLANTED123456',
  BOLT_CLIENT_ID: 'boltClientPLANTED', BOLT_CLIENT_SECRET: 'boltSecretPLANTEDxyz',
  CABMAN_ECOSINE_USER: 'cabUserPLANTEDe', CABMAN_ECOSINE_PASS: 'cabPassPLANTEDe',
  CABMAN_EGARI_USER: 'cabUserPLANTEDg', CABMAN_EGARI_PASS: 'cabPassPLANTEDg',
});
const BOLT_TOKEN = 'boltTokenPLANTED.sig';

const { runMovement, movementRoutes, scrubber, MOVEMENT_PROBES } = await import('../api/probe_movement.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── what must never leave ─────────────────────────────────────────────── */
const COORDS = ['25.1972', '55.2744', '25.2011', '55.2799', '25.0761', '55.1329', '25.1234', '55.7654',
  '25.3333', '55.4444', '25.5555'];
const PLATES = ['L11111', 'ZZ22222', 'DXB-L-11111', 'L33333', 'L44444', 'L55555'];
const IDS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000',
  'yangoOrderPLANTED1', 'boltOrderPLANTED9', 'abcdefabcdefabcdefabcdefabcdef12'];
const PEOPLE = ['Test Driver', '+97150', '971500000001', 'Planted Street', 'Planted Tower', 'Planted Mall'];
const NEVER = ['PLANTED', ...COORDS, ...PLATES, ...IDS, ...PEOPLE];
const leaks = (body) => {
  const s = JSON.stringify(body);
  return NEVER.filter((v) => s.includes(v));
};

/* ── the providers, faked at fetch ─────────────────────────────────────── */
const realFetch = globalThis.fetch;
const calls = [];
const mode = { fmsThrow: false, yango403: false };
const cabmanTick = new Map();
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const hdr = (h, k) => (h ? Object.entries(h).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1] : undefined);

const fmsRow = (start, end, act) => ({
  'Vehicle No': 'DXB-L-11111', 'Driver Name': 'Test Driver Alpha', DriverMobile: '+971500000001',
  StartTime: start, EndTime: end, Duration: '00:25:00',
  StartLocation: '12 Planted Street, Dubai', EndLocation: 'Planted Tower',
  StartLat: 25.1972345, StartLon: 55.2744123, EndLat: 25.2011987, EndLon: 55.2799456,
  acttype: act, distancetravelled: '7.4',
});

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
  if (url.includes('/GetVehicleActivity?')) {
    if (mode.fmsThrow) {
      /* A transport failure whose message quotes the whole URL — password and
         all — which is what an undici error or a proxy page can do. */
      throw new TypeError(`fetch failed for ${url} (vehicle ${new URL(url).searchParams.get('vehicleno')})`);
    }
    return json({ Data: [
      fmsRow('23/11/2026 08:00:00', '23/11/2026 08:25:00', 'TRAVEL'),
      fmsRow('23/11/2026 08:30:00', '23/11/2026 08:40:00', 'IDLE'),
      fmsRow('23/11/2026 08:40:00', '23/11/2026 09:40:00', 'STOP'),
      { ...fmsRow('23/11/2026 10:00:00', '23/11/2026 10:30:00', 'Test Driver Alpha'), StartLat: '', StartLon: '' },
    ] });
  }
  if (url.includes('/v1/parks/orders/track?')) {
    if (mode.yango403) return json({ code: '403', message: 'invalid client id or api key yangoKeyPLANTED123456 for order yangoOrderPLANTED1' }, 403);
    const base = Date.parse('2026-11-24T08:00:00+04:00');
    return json({ track: Array.from({ length: 6 }, (_, i) => ({
      tracked_at: new Date(base + i * 5000).toISOString(),
      location: { lat: 25.0761234 + i / 1e5, lon: 55.1329876 },
      speed: 32.5, direction: 180, order_status: i < 3 ? 'driving' : 'transporting',
    })) });
  }
  if (url === 'https://oidc.bolt.eu/token') return json({ access_token: BOLT_TOKEN, expires_in: 600 });
  if (url.endsWith('/getFleetStateLogs')) {
    const body = JSON.parse(init.body);
    if (body.company_id === 142868) {
      return json({ code: 503, message: 'NOT_AUTHORIZED', error_hint: 'COMPANIES_NOT_ALLOWED' });
    }
    const t0 = body.start_ts;
    const mk = (drv, k, state) => ({
      driver_uuid: drv, vehicle_uuid: 'abcdefabcdefabcdefabcdefabcdef12', created: t0 + k * 60, state,
      lat: 25.1234567, lng: 55.7654321, active_order_reference: state === 'has_order' ? 'boltOrderPLANTED9' : null,
      driver_name: 'Test Driver Beta', driver_phone: '+971500000002',
    });
    return json({ code: 0, message: 'OK', data: { state_logs: [
      mk(IDS[0], 0, 'waiting_orders'), mk(IDS[0], 1, 'has_order'), mk(IDS[0], 3, 'busy'),
      mk(IDS[1], 0, 'inactive'), mk(IDS[1], 2, 'waiting_orders'),
    ] } });
  }
  if (url.includes('GetIVDData')) {
    const who = hdr(init.headers, 'InterfacePassword');
    const k = cabmanTick.get(who) || 0;
    cabmanTick.set(who, k + 1);
    const g = (sec) => new Date(Date.parse('2026-11-24T06:00:00Z') + sec * 1000).toISOString().replace('T', ' ').slice(0, 19);
    return json({ IVDDataResult: [
      /* moving, and its fix time advances 15 s per call */
      { VehicleID: 'L33333', gmt: g(k * 15), lat: 25.3333333, lng: 55.4444444, speed: 40, DriverName: 'Test Driver Gamma' },
      /* moving, and its fix time does not move */
      { VehicleID: 'L44444', gmt: g(0), lat: 25.5555555, lng: 55.4444444, speed: 30, DriverName: 'Test Driver Delta' },
      /* parked */
      { VehicleID: 'L55555', gmt: g(-600), lat: 25.5555555, lng: 55.4444444, speed: 0 },
    ] });
  }
  return new Response('not faked', { status: 599 });
};

/* ── the database and the rest of the seams ────────────────────────────── */
const NOW = Date.parse('2026-11-24T10:00:00Z');
const query = async (text, params = []) => {
  if (/telemetry_snapshot/.test(text)) {
    return { rows: params[0] === 'ecosine'
      ? [{ plate: 'L11111', vno: 'DXB-L-11111', fixes: 230 }]
      : [{ plate: 'ZZ22222', vno: null, fixes: 120 }] };
  }
  if (/make_interval/.test(text)) return { rows: [{ external_id: 'yangoOrderPLANTED1', requested_at: new Date(NOW - 70 * 864e5) }] };
  if (/platform = 'yango'/.test(text)) {
    return { rows: [
      { external_id: 'abcdefabcdefabcdefabcdefabcdef12', requested_at: new Date(NOW - 3600e3) },
      { external_id: 'yangoOrderPLANTED1', requested_at: new Date(NOW - 7200e3) },
    ] };
  }
  return { rows: [] };
};
const deps = { query, loadSettings: async () => {}, sleep: async () => {}, now: () => NOW };
const run = (which, q = {}) => runMovement(which, q, deps);
const callsTo = (frag) => calls.filter((c) => c.url.includes(frag));

/* ── 1. fms_activity ───────────────────────────────────────────────────── */
console.log('\n1. fms_activity');
{
  calls.length = 0;
  const b = await run('fms_activity', { plates: '3', url: 'http://evil.example/steal' });
  check('nothing planted leaves — no coordinate, plate, name, phone, address, id or credential',
    leaks(b).length === 0, leaks(b).join(', '));
  check('the contract keys are present', b.which === 'fms_activity' && typeof b.ran_at === 'string'
    && Number.isFinite(b.elapsed_ms) && Array.isArray(b.fleets) && Array.isArray(b.notes), JSON.stringify(Object.keys(b)));
  const eco = b.fleets.find((f) => f.fleet === 'ecosine');
  const car = eco?.cars?.[0];
  check('cars are indexed, not named', car?.car === 'car 1' && car.fixes_yesterday === 230, JSON.stringify(car)?.slice(0, 200));
  check('four windows per car, in order: yesterday, last 7 days, 90 and 400 days back',
    car?.calls?.map((c) => c.window).join() === 'yesterday,last_7_days,depth_90_days,depth_400_days',
    car?.calls?.map((c) => c.window).join());
  const y = car?.calls?.[0] || {};
  check('rows, http and elapsed are reported', y.rows === 4 && y.http === 200 && Number.isFinite(y.elapsed_ms), JSON.stringify(y).slice(0, 200));
  check('acttype is a distribution, and a name in it is counted, not echoed',
    y.acttype?.TRAVEL === 1 && y.acttype?.IDLE === 1 && y.acttype?.STOP === 1
    && y.acttype['(not enumeration-shaped, withheld)'] === 1, JSON.stringify(y.acttype));
  check('segment duration stats in minutes from start/end', y.segment_minutes?.median === 27.5
    && y.segment_minutes?.max === 60 && y.duration_basis?.[0] === 'start/end', JSON.stringify(y.segment_minutes));
  check('start/end lat-lon are fill rates only', y.start_latlon_fill_pct === 75 && y.end_latlon_fill_pct === 100,
    `${y.start_latlon_fill_pct} ${y.end_latlon_fill_pct}`);
  check('distance is a presence and a median', y.distance?.fill_pct === 100 && y.distance?.median === 7.4, JSON.stringify(y.distance));
  check('the time span is dates only', y.earliest_day === '2026-11-23' && y.latest_day === '2026-11-23', `${y.earliest_day} ${y.latest_day}`);
  check('field names with fill rates, no values', y.fields?.some((f) => f.key === 'Driver Name' && f.fill_pct === 100)
    && y.fields.every((f) => !('values' in f)), JSON.stringify(y.fields?.slice(0, 3)));
  const fmsCalls = callsTo('/GetVehicleActivity?');
  check('only GetVehicleActivity was asked, 4 windows × 1 car × 2 fleets', fmsCalls.length === 8, String(fmsCalls.length));
  check('the device\'s own vehicleno is asked for where the poll kept it, normPlate\'s form otherwise',
    fmsCalls.some((c) => c.url.includes('vehicleno=DXB-L-11111')) && fmsCalls.some((c) => c.url.includes('vehicleno=ZZ22222')));
  check('the yesterday window spans two dates and uses FMS\'s dotted form',
    fmsCalls.some((c) => c.url.includes('fromdate=2026.11.23&todate=2026.11.24')));
  check('a caller-supplied url is never fetched', !calls.some((c) => c.url.includes('evil')));
  check('read-only verbs: every FMS call is a GET', fmsCalls.every((c) => c.method === 'GET'));
}

/* ── 2. a provider error: reported in the body, scrubbed, not thrown ───── */
console.log('\n2. a provider error');
{
  mode.fmsThrow = true;
  const b = await run('fms_activity', { fleet: 'ecosine', plates: '1' });
  mode.fmsThrow = false;
  const c = b.fleets?.[0]?.cars?.[0]?.calls?.[0] || {};
  check('the error is reported on the call', typeof c.error === 'string' && /fetch failed/.test(c.error), JSON.stringify(c));
  check('and scrubbed — no password, user, plate or query string survives',
    leaks(b).length === 0 && !/Password=|username=/.test(c.error || ''), `${leaks(b).join(', ')} | ${c.error}`);
  check('the URL\'s host and path are kept so the call can be identified', /GetVehicleActivity\?\(query withheld\)/.test(c.error || ''), c.error);

  mode.yango403 = true;
  const y = await run('yango_track');
  mode.yango403 = false;
  const o = y.fleets?.[0]?.orders?.[0] || {};
  check('a provider refusal is reported with its own words', o.http === 403 && /invalid client id or api key/.test(o.provider_said?.message || ''),
    JSON.stringify(o).slice(0, 300));
  check('and those words are scrubbed of the key and the order id', leaks(y).length === 0, leaks(y).join(', '));

  const s = scrubber(['s3cretPassw0rd', 'L11111']);
  const t = s('GET http://h/x?username=u&Password=s3cretPassw0rd failed; Bearer eyJabcdefgh.ijklmnopq.rst on L11111 at 25.1972345,55.2744123 +971500000001 '
    + '11111111-2222-3333-4444-555555555555');
  check('the scrubber cuts the query, the values, tokens, coordinates, phones and uuids',
    !/s3cret|username=|eyJ|L11111|25\.1972|55\.2744|971500000001|1111-2222/.test(t), t);
}

/* ── 3. yango_track ────────────────────────────────────────────────────── */
console.log('\n3. yango_track');
{
  calls.length = 0;
  const b = await run('yango_track', { back: '60' });
  check('nothing planted leaves', leaks(b).length === 0, leaks(b).join(', '));
  const orders = b.fleets?.[0]?.orders || [];
  check('two recent orders and one older, indexed', orders.map((o) => `${o.order}:${o.kind}`).join()
    === 'order 1:recent,order 2:recent,order 3:older than 60 days', orders.map((o) => `${o.order}:${o.kind}`).join());
  const o = orders[0] || {};
  check('points, spacing (s), span (min) and status distribution', o.points === 6 && o.spacing_seconds?.median === 5
    && o.span_minutes === 0.4 && o.order_status?.driving === 3 && o.order_status?.transporting === 3, JSON.stringify(o).slice(0, 400));
  check('location, speed and direction are fill rates', o.location_fill_pct === 100 && o.speed_fill_pct === 100
    && o.direction_fill_pct === 100);
  check('the old order\'s age is reported, its id is not', orders[2]?.age_days === 70);
  const yc = callsTo('/v1/parks/orders/track?');
  check('POST to the documented path with the collector\'s key pair', yc.length === 3 && yc.every((c) => c.method === 'POST'
    && hdr(c.headers, 'X-API-Key') === 'yangoKeyPLANTED123456' && hdr(c.headers, 'X-Client-ID') === 'taxi/park/parkPLANTED0001'
    && c.url.startsWith('https://fleet-api.yango.tech/v1/parks/orders/track?park_id=parkPLANTED0001&order_id=')));
}

/* ── 4. bolt_states ────────────────────────────────────────────────────── */
console.log('\n4. bolt_states');
{
  calls.length = 0;
  const b = await run('bolt_states', { back: '90', limit: '5000' });
  check('nothing planted leaves (the bearer token included)', leaks(b).length === 0, leaks(b).join(', '));
  const eg = b.fleets.find((f) => f.fleet === 'egari');
  const c = eg?.calls?.[0] || {};
  check('three Egari windows: 24 h, 30 and 90 days back', eg?.calls?.map((x) => x.window).join() === 'last_24h,depth_30_days,depth_90_days');
  check('rows, states, distinct drivers (a count) and per-driver spacing', c.rows === 5 && c.states?.waiting_orders === 2
    && c.states?.busy === 1 && c.distinct_drivers === 2 && c.spacing_seconds_per_driver?.median === 120
    && c.spacing_seconds_per_driver?.n === 3, JSON.stringify(c).slice(0, 500));
  check('lat/lng are fill rates only', c.lat_fill_pct === 100 && c.lng_fill_pct === 100);
  check('limit is clamped to 1000, and a short page is not called full', c.limit === 1000 && c.page_full === false);
  check('the time span is dates and hours', c.earliest_day === '2026-11-23' && c.span_hours === 0.1, `${c.earliest_day} ${c.span_hours}`);
  const eco = b.fleets.find((f) => f.fleet === 'ecosine');
  check('Ecosine\'s refusal is on record, in Bolt\'s words', eco?.calls?.[0]?.provider_said?.error_hint === 'COMPANIES_NOT_ALLOWED'
    && eco.calls[0].provider_said.code === 503 && !eco.calls[0].first_body_refused, JSON.stringify(eco?.calls?.[0]));
  const bc = callsTo('/getFleetStateLogs');
  const body = JSON.parse(bc[0]?.body || '{}');
  check('the gateway is asked with the collector\'s body shape and the borrowed token',
    Array.isArray(body.company_ids) && body.company_id === 142897 && body.limit === 1000
    && hdr(bc[0].headers, 'authorization') === `Bearer ${BOLT_TOKEN}`, JSON.stringify(body));
}

/* ── 5. cabman_cadence ─────────────────────────────────────────────────── */
console.log('\n5. cabman_cadence');
{
  calls.length = 0;
  cabmanTick.clear();
  const b = await run('cabman_cadence');
  check('nothing planted leaves', leaks(b).length === 0, leaks(b).join(', '));
  const e = b.fleets.find((f) => f.fleet === 'ecosine');
  check('five calls per fleet, both fleets', callsTo('GetIVDData').length === 10 && e?.per_call?.length === 5);
  check('per call: vehicles and moving are counts', e?.per_call?.[0]?.vehicles === 3 && e.per_call[0].moving === 2);
  check('moving pairs, advanced and not, and the advance in seconds', e?.pairs?.moving_vehicle_pairs === 8
    && e.pairs.advanced === 4 && e.pairs.did_not_advance === 4 && e.pairs.advance_seconds?.min === 15
    && e.pairs.advance_seconds?.median === 15, JSON.stringify(e?.pairs));
  check('a reading in words', /faster than/.test(e?.reading || ''), e?.reading);
  check('read-only: every CABMAN call is a GET with the collector\'s headers', callsTo('GetIVDData')
    .every((c) => c.method === 'GET' && hdr(c.headers, 'InterfacePassword')?.startsWith('cabPassPLANTED')));
}

/* ── 6. the route ──────────────────────────────────────────────────────── */
console.log('\n6. the route');
{
  let handler = null, path = null;
  movementRoutes({ get: (p, h) => { path = p; handler = h; } }, { wrap: (f) => f, deps });
  const hit = async (query) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } };
    await handler({ query }, res);
    return res;
  };
  check('it is GET /api/probe/movement', path === '/api/probe/movement');
  const bad = await hit({ which: 'anything_else' });
  check('an unknown which is refused 400, naming the four', bad.statusCode === 400
    && MOVEMENT_PROBES.every((w) => bad.body.allowed.includes(w)), JSON.stringify(bad.body));
  check('a missing which is refused 400', (await hit({})).statusCode === 400);
  check('an unknown fleet is refused 400', (await hit({ which: 'fms_activity', fleet: 'other' })).statusCode === 400);
  mode.fmsThrow = true;
  const err = await hit({ which: 'fms_activity', fleet: 'egari', plates: '1' });
  mode.fmsThrow = false;
  check('a provider error answers 200 with the error in the body', err.statusCode === 200
    && typeof err.body?.fleets?.[0]?.cars?.[0]?.calls?.[0]?.error === 'string' && leaks(err.body).length === 0,
  JSON.stringify(err.body).slice(0, 400));
  const failing = await runMovement('fms_activity', {}, { ...deps, query: async () => { throw new Error('db down for fmsPassPLANTEDeco1'); } });
  check('a database error is reported per fleet, scrubbed, not thrown',
    /choosing cars/.test(failing.fleets?.[0]?.error || '') && leaks(failing).length === 0, JSON.stringify(failing.fleets?.[0]));

  /* Mounted where every sibling is mounted, so the deployed app serves it. */
  const { probeRoutes } = await import('../api/probe.js');
  const paths = [];
  probeRoutes({ get: (p) => paths.push(p) }, { wrap: (f) => f });
  check('probeRoutes mounts it beside the other probes', paths.includes('/api/probe/movement'));
  const manifest = JSON.parse(readFileSync(new URL('../api/access/manifest.json', import.meta.url), 'utf8'));
  const m = manifest.find((e) => e.path === '/api/probe/movement');
  check('declared as a probe: an action, the CRED subject, mixed fleets',
    m?.cap === 'collector.probe' && m.subject === 'CRED' && m.fleet === 'mixed');
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
