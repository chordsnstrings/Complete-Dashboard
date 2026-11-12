/* ── Bolt's two trip feeds, one row per ride — against a real Postgres ─────
   src/sources/bolt_orders.js puts Bolt's fleet-integration orders
   (getFleetOrders) on the SAME trip rows the portal writes. The hard
   requirement is that a ride is never counted twice, whichever feed saw it
   first and whichever is down; the point of the whole thing is that Bolt's
   trips keep flowing when the seven-day portal token lapses.

   Driven here, end to end, on PGlite with every migration the server
   applies:
     A. portal live: the orders fill the portal's rows; only an order newer
        than the portal's answer becomes a row of its own; an order the
        portal answered for and did not return is HELD, not counted.
     B. the portal answers for that day: the stand-in is retired and the
        order re-attaches to the portal's row.
     C. a lapse where the driver's portal id is known: the stand-in is keyed
        exactly as the portal keys it, so the portal's row lands on it, and
        the portal's NULLs do not erase what this feed filled.
     D. Ecosine, which the client is not entitled to: reported as not
        entitled, never as zero trips.
     E. the real collect(): with no portal token at all, Bolt trips still
        arrive and the run row — and /api/status — say which feed served
        them.

   Synthetic orders only (test/bolt_fi_fixtures.mjs). */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { C, T0, fiOrder, portalOrder, okPage } from './bolt_fi_fixtures.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
const { pool, upsertMany } = await import('../src/db.js');
/* upsertMany writes through pool.connect(), everything else through
   pool.query — both point at the throwaway database. */
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim()) ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});

const { applyFiOrders, supersedeFiRows, protectFiFills, portalAnsweredThrough, pullFiOrders, ANSWERED_KEY,
  loadPriceVerdict } = await import('../src/sources/bolt_orders.js');
const { portalRow } = await import('../src/sources/bolt.js');

const writePortal = async (orders) => upsertMany('trip',
  await protectFiFills(orders.map((o) => portalRow(o, C))), ['platform', 'external_id']);
const bolt = (fleet = 'egari') => q(
  `SELECT external_id, plate, driver_ext_id, requested_at, pickup_addr, pickup_lat, pickup_lng, dropoff_lat,
          duration_s, is_scheduled, price, status, distance_km, raw
     FROM trip WHERE platform = 'bolt' AND fleet_id = $1 ORDER BY requested_at, external_id`, [fleet]);
const ledger = (fleet = 'egari') => q(
  `SELECT order_reference, disposition, trip_external_id, portal_driver_id, commission
     FROM bolt_fi_order WHERE fleet_id = $1 ORDER BY order_reference`, [fleet]);
const pass1 = async (orders) => applyFiOrders(C, orders, {
  answeredThrough: await portalAnsweredThrough(C.fleet),
  xref: await loadXrefForTest(), plates: null });
/* The pass's own xref query, through the public surface: a stand-in keyed by
   a portal id proves it was used, so the map is rebuilt here the same way. */
async function loadXrefForTest() {
  const rows = await q(`SELECT driver_uuid, min(portal_driver_id) pid, count(DISTINCT portal_driver_id)::int n
                          FROM bolt_fi_order WHERE fleet_id = $1 AND portal_driver_id IS NOT NULL GROUP BY driver_uuid`, [C.fleet]);
  return new Map(rows.filter((r) => r.n === 1).map((r) => [r.driver_uuid, r.pid]));
}

/* ══ A. the portal is live ════════════════════════════════════════════════ */
console.log('\nA. portal live: this feed fills the portal\'s rows and doubles none');
await writePortal([1, 2, 3].map((n) => portalOrder(n)));
const H0 = await portalAnsweredThrough('egari');
check('before the portal harvest has kept a mark, the newest portal row stands in for it',
  H0 === (T0 + 1800) * 1000, `${H0 && new Date(H0).toISOString()}`);
/* ref-h: created between rides 1 and 2, inside what the portal answered for,
   on a car and driver no portal row has — the order that could be a
   duplicate, and so must not be counted. */
const held = fiOrder(1, { order_reference: 'ref-h', order_created_timestamp: T0 + 900,
  vehicle_license_plate: 'Z 55555', driver_uuid: 'uuid-x', partner_uuid: 'uuid-y' });
let st = await pass1([fiOrder(1), fiOrder(2), fiOrder(3), fiOrder(4), held]);
let rows = await bolt();
check('three rides the portal has, one it has not: four rows, not eight',
  rows.length === 4, `${rows.length}: ${rows.map((r) => r.external_id).join(', ')}`);
check('each portal row was matched and filled', st.enriched === 3 && st.changed === 3, JSON.stringify(st));
const r1 = rows.find((r) => r.external_id === `900001|${T0 + 600}`);
check('…with the coordinates the portal never sends',
  r1?.pickup_lat === 25.1001 && r1?.pickup_lng === 55.2001 && r1?.dropoff_lat === 25.2002, JSON.stringify(r1));
check('…the ride\'s duration and whether it was scheduled', r1?.duration_s === 1200 && r1?.is_scheduled === false);
check('…the address the portal left empty', r1?.pickup_addr === 'Pickup 1');
check('…and the plate\'s letter code, where the portal sent the digits alone', r1?.plate === 'L10001', r1?.plate);
check('the portal\'s own price and status are untouched', Number(r1?.price) === 51 && r1?.status === 'finished');
check('the row says this feed filled it, and what it filled — and is still the portal\'s row',
  r1?.raw?.fleet_integration?.served_by === 'portal' && r1.raw.fleet_integration.order_reference === 'ref-1'
  && r1.raw.fleet_integration.filled.includes('pickup_lat') && 'created' in r1.raw,
  JSON.stringify(r1?.raw?.fleet_integration));
const stand = rows.find((r) => r.external_id === 'fi:ref-4');
check('the order created after the portal\'s answer is a row of its own', !!stand, rows.map((r) => r.external_id).join());
check('…marked as served by this feed, and not mistakable for a portal row',
  stand?.raw?.fleet_integration?.served_by === 'fleet-integration' && !('created' in (stand?.raw || {})));
check('…with its distance in kilometres (ride_distance 12,004 measured as metres against the portal)',
  stand?.distance_km === 12, String(stand?.distance_km));
check('…and no driver phone anywhere in it', !JSON.stringify(stand?.raw || {}).includes('synthetic'));
check('the order the portal answered for and did not return is NOT counted', !rows.some((r) => /ref-h/.test(r.external_id)));
let led = await ledger();
check('every order is on the record with what was done with it',
  led.length === 5 && led.filter((l) => l.disposition === 'enriched').length === 3
  && led.find((l) => l.order_reference === 'ref-4')?.disposition === 'inserted'
  && led.find((l) => l.order_reference === 'ref-h')?.disposition === 'held', JSON.stringify(led));
check('a match teaches the driver\'s portal id', led.find((l) => l.order_reference === 'ref-1')?.portal_driver_id === '900001');
check('per-ride commission is kept, which the portal never published', Number(led[0].commission) === 10);

st = await pass1([fiOrder(1), fiOrder(2), fiOrder(3), fiOrder(4), held]);
check('a second pass over the same orders changes nothing and adds nothing',
  st.changed === 0 && st.inserted === 0 && st.refreshed === 1 && (await bolt()).length === 4, JSON.stringify(st));

/* ══ B. the portal answers for the stand-in's day ═════════════════════════ */
console.log('\nB. the portal answers: the stand-in is retired, the order re-attaches');
await writePortal([portalOrder(4)]);
check('the portal\'s own row for ride 4 arrives under its own key', (await bolt()).length === 5);
const win = { start: new Date('2026-11-10T00:00:00Z'), end: new Date('2026-11-10T00:00:00Z') };
const asked = Date.parse('2026-11-12T06:00:00Z');
const sup = await supersedeFiRows(C, win, { askedAt: asked });
rows = await bolt();
check('…and the stand-in for the same ride is retired: one row per ride again',
  sup.removed === 1 && rows.length === 4 && !rows.some((r) => r.external_id === 'fi:ref-4'), JSON.stringify(sup));
check('the order is not lost — it is on the record as superseded',
  (await ledger()).find((l) => l.order_reference === 'ref-4')?.disposition === 'superseded');
const mark = (await q('SELECT value FROM source_state WHERE source = $1 AND fleet_id = $2 AND key = $3',
  ['bolt', 'egari', ANSWERED_KEY]))[0]?.value;
check('the portal\'s "answered through" mark moved to the end of the Dubai day it answered for',
  mark === new Date(Date.parse('2026-11-11T00:00:00+04:00')).toISOString(), mark);
await supersedeFiRows(C, { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') }, { askedAt: asked });
check('…and an older window answering never pulls it back',
  (await q('SELECT value FROM source_state WHERE key = $1', [ANSWERED_KEY]))[0]?.value === mark);
st = await pass1([fiOrder(4)]);
const r4 = (await bolt()).find((r) => r.external_id === `900001|${T0 + 2400}`);
check('the next pass re-attaches the order to the portal\'s row and fills it',
  st.enriched === 1 && r4?.pickup_lat === 25.1001 && (await ledger()).find((l) => l.order_reference === 'ref-4')?.disposition === 'enriched',
  JSON.stringify(st));

/* ══ C. a lapse, with the driver's portal id known ════════════════════════ */
console.log('\nC. a lapse: a stand-in keyed as the portal will key it');
/* The next day, after the mark: the portal token is dead and only this feed
   answers. Ride 151 is driver uuid-d1, whose portal id (900001) the matches
   above taught. */
const LAPSE = 151;
st = await pass1([fiOrder(LAPSE)]);
const key = `900001|${T0 + LAPSE * 600}`;
let lr = (await bolt()).find((r) => r.external_id === key);
check('the stand-in carries the portal\'s own key and driver id',
  st.inserted === 1 && lr?.driver_ext_id === '900001', JSON.stringify({ st, key, got: (await bolt()).map((r) => r.external_id) }));
const before = (await bolt()).length;
await writePortal([portalOrder(LAPSE)]);
lr = (await bolt()).find((r) => r.external_id === key);
check('when the portal comes back, its row lands ON the stand-in: no second row',
  (await bolt()).length === before && 'created' in (lr?.raw || {}) && lr?.raw?.fleet_integration);
check('the coordinates this feed filled survive the portal\'s write', lr?.pickup_lat === 25.1001);
check('…and so does the address the portal has no value for (its NULL does not erase it)',
  lr?.pickup_addr === `Pickup ${LAPSE}`, String(lr?.pickup_addr));
check('the portal\'s own values win wherever it has one', Number(lr?.price) === 50 + LAPSE);
const sup2 = await supersedeFiRows(C, { start: new Date('2026-11-11T00:00:00Z'), end: new Date('2026-11-11T00:00:00Z') },
  { askedAt: asked });
check('retiring stand-ins never touches a row the portal has written', sup2.removed === 0 && !!(await bolt()).find((r) => r.external_id === key));

/* ══ D. Ecosine: not entitled is not zero ═════════════════════════════════ */
console.log('\nD. a company the client is not entitled to');
const realFetch = globalThis.fetch;
const sent = [];
const ordersFor = (body) => {
  const out = [];
  for (let t = body.start_ts; t <= body.end_ts; t += 86400) {
    out.push(fiOrder(1, { order_reference: `day-${t}`, order_created_timestamp: t + 8 * 3600,
      order_pickup_timestamp: t + 8 * 3600 + 300, order_drop_off_timestamp: t + 8 * 3600 + 1500 }));
  }
  return out;
};
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url);
  let body = {};
  try { body = JSON.parse(opt.body); } catch { /* the OIDC grant is form-encoded */ }
  sent.push({ url: u.split('?')[0], body });
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const refused = { code: 503, message: 'NOT_AUTHORIZED', error_hint: 'COMPANIES_NOT_ALLOWED' };
  if (u.includes('oidc.bolt.eu')) return reply({ access_token: 'fi-access' });
  if (u.includes('/getDrivers')) return body.company_id === 142897 ? reply({ code: 0, message: 'OK', data: { drivers: [] } }) : reply(refused);
  if (u.includes('/getFleetOrders')) {
    if (!Array.isArray(body.company_ids) || body.company_ids[0] !== 142897) return reply(refused);
    const all = ordersFor(body);
    return reply(okPage(all.slice(body.offset, body.offset + body.limit), all.length).data);
  }
  return reply({});
};
process.env.BOLT_CLIENT_ID = 'bolt-client';
process.env.BOLT_CLIENT_SECRET = 'bolt-secret';
delete process.env.BOLT_REFRESH_TOKEN; delete process.env.BOLT_REFRESH_TOKEN_EGARI; delete process.env.BOLT_REFRESH_TOKEN_ECOSINE;
const { fiToken } = await import('../src/sources/bolt.js');
{
  const fails = [], chunks = [], rowsByFleet = new Map();
  const out = await pullFiOrders('2026-11-11', '2026-11-11', { fails, chunks, rowsByFleet, mint: fiToken,
    companies: [{ fleet: 'ecosine', companyId: 142868, userId: 173999 }], now: Date.parse('2026-11-12T06:00:00Z') });
  const eco = fails.filter((f) => f.fleet === 'ecosine').map((f) => f.text).join(' | ');
  check('the run says Ecosine is NOT ENTITLED, and that its trips have no second source',
    /not entitled to company_id 142868/.test(eco) && /COMPANIES_NOT_ALLOWED/.test(eco) && /no second source/.test(eco), eco);
  check('…and records no window for it — a "0 rows, ok" window would read as zero trips',
    !chunks.some((ch) => ch.fleet === 'ecosine'), JSON.stringify(chunks));
  check('…writes nothing, and asks once, not once per window',
    (await bolt('ecosine')).length === 0 && sent.filter((s) => s.url.includes('getFleetOrders')).length === 1
    && out.get('ecosine').stop?.kind === 'not-entitled');
  check('the request carries company_ids as an ARRAY and a limit Bolt allows (1..1000)',
    sent.filter((s) => s.url.includes('getFleetOrders')).every((s) => Array.isArray(s.body.company_ids)
      && s.body.limit >= 1 && s.body.limit <= 1000));
}

/* ══ E. collect(), with no portal token at all ════════════════════════════ */
console.log('\nE. the real collect(): no portal token, and Bolt trips still arrive');
await q(`DELETE FROM trip WHERE platform = 'bolt'`);
await q('DELETE FROM bolt_fi_order');
await q(`DELETE FROM source_state WHERE source = 'bolt'`);
await q('DELETE FROM collection_run');
sent.length = 0;
const { collect } = await import('../src/sources/bolt.js');
await collect({ from: '2026-11-09', to: '2026-11-11', mode: 'incremental' });
const runs = await q(`SELECT fleet_id, status, rows_written, error, detail FROM collection_run WHERE source = 'bolt'`);
const eg = runs.find((r) => r.fleet_id === 'egari');
const ec = runs.find((r) => r.fleet_id === 'ecosine');
const egTrips = await bolt('egari');
check('Egari\'s Bolt trips arrive with no portal token configured', egTrips.length === 3, `${egTrips.length}`);
check('…every one a stand-in from this feed', egTrips.every((r) => r.raw?.fleet_integration?.served_by === 'fleet-integration'));
check('the run row says the portal failed AND which feed served the window',
  /portal egari: no refresh token/.test(eg?.error || '')
  && /fleet-integration getFleetOrders answered 2026-11-09\.\.2026-11-11: 3 trip rows/.test(eg?.error || ''), eg?.error);
check('…and is partial — something was collected — not error', eg?.status === 'partial' && eg?.rows_written >= 3,
  JSON.stringify({ status: eg?.status, rows: eg?.rows_written }));
const egDetail = typeof eg?.detail === 'string' ? JSON.parse(eg.detail) : eg?.detail;
check('each window on the run is named by the feed that served it',
  Array.isArray(egDetail) && egDetail.some((w) => w.kind === 'fleet-integration' && w.rows === 3 && !w.error),
  JSON.stringify(egDetail));
check('Ecosine\'s row says it is not entitled — never zero trips',
  /not entitled to company_id 142868/.test(ec?.error || '') && ec?.status === 'error'
  && !(typeof ec?.detail === 'string' ? JSON.parse(ec.detail) : ec?.detail || []).some((w) => w.kind === 'fleet-integration'),
  JSON.stringify({ status: ec?.status, error: ec?.error }));
globalThis.fetch = realFetch;

/* /api/status, the page's view of the same row. */
const { get } = await mountAll(db);
const status = (await get(`/api/status?_=${Date.now()}`)).body || [];
const egStatus = status.find((r) => r.source === 'bolt' && r.fleet_id === 'egari');
check('/api/status says which feed served each window',
  (egStatus?.windows || []).some((w) => w.kind === 'fleet-integration' && w.rows === 3 && w.ok),
  JSON.stringify(egStatus?.windows));
const other = status.find((r) => r.source !== 'bolt');
check('…and a window with no feed named is projected exactly as before', !other || (other.windows || []).every((w) => !('kind' in w)));

/* ══ F. collect(), both feeds live, the same rides on both ════════════════ */
console.log('\nF. the real collect(): portal and fleet-integration both answer — one row per ride');
await q(`DELETE FROM trip WHERE platform = 'bolt'`);
await q('DELETE FROM bolt_fi_order');
await q(`DELETE FROM source_state WHERE source = 'bolt'`);
await q('DELETE FROM collection_run');
{
  const dubai0 = (d) => Date.parse(`${d}T00:00:00+04:00`) / 1000;
  const days = ['2026-11-09', '2026-11-10', '2026-11-11'];
  const rideAt = (d) => dubai0(d) + 8 * 3600;
  /* The portal files each day's ride; the gateway files the same rides, plus
     one ride on the 10th the portal never returned (another car, another
     driver) — the order that must be HELD, not counted. */
  const portalFor = (start, end) => days.filter((d) => d >= start && d <= end)
    .map((d, i) => portalOrder(1, { created: rideAt(d), fare_finalised: rideAt(d) + 1510,
      arrived_to_destinations: [rideAt(d) + 1500], price: 60 + i }));
  const fiFor = (s, e) => [
    ...days.filter((d) => rideAt(d) >= s && rideAt(d) <= e).map((d) => fiOrder(1, { order_reference: `live-${d}`,
      order_created_timestamp: rideAt(d), order_pickup_timestamp: rideAt(d) + 300, order_drop_off_timestamp: rideAt(d) + 1500 })),
    ...(dubai0('2026-11-10') + 15 * 3600 >= s && dubai0('2026-11-10') + 15 * 3600 <= e
      ? [fiOrder(2, { order_reference: 'live-orphan', order_created_timestamp: dubai0('2026-11-10') + 15 * 3600,
        vehicle_license_plate: 'Z 77777', driver_uuid: 'uuid-z', partner_uuid: 'uuid-zz' })] : []),
  ];
  const jwt = (payload) =>
    `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  process.env.BOLT_REFRESH_TOKEN_EGARI = jwt({ data: { type: 'base', fleet_owner_id: 174036, jti: 'eg' },
    iat: 1, exp: Math.floor(Date.now() / 1000) + 5 * 86400 });
  globalThis.fetch = async (url, opt = {}) => {
    const u = String(url);
    let body = {};
    try { body = JSON.parse(opt.body); } catch { /* form-encoded */ }
    const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('oidc.bolt.eu')) return reply({ access_token: 'fi-access' });
    if (u.includes('/getDrivers')) return reply({ code: 0, message: 'OK', data: { drivers: [] } });
    if (u.includes('/getAccessToken')) return reply({ code: 0, data: { access_token: 'portal-at' } });
    if (u.includes('/orderHistory/getTable')) {
      const orders = portalFor(body.start_date, body.end_date);
      const page = orders.slice(body.offset, body.offset + body.limit);
      return reply({ code: 0, message: 'OK', data: { total_rows: orders.length,
        columns: Object.keys(portalOrder(1)).map((k) => ({ key: k, cells: page.map((o) => o[k]) })) } });
    }
    if (u.includes('/getFleetOrders')) {
      if (body.company_ids?.[0] !== 142897) return reply({ code: 503, message: 'NOT_AUTHORIZED', error_hint: 'COMPANIES_NOT_ALLOWED' });
      const all = fiFor(body.start_ts, body.end_ts);
      return reply(okPage(all.slice(body.offset, body.offset + body.limit), all.length).data);
    }
    if (u.includes('/getPayouts')) return reply({ code: 0, data: { list: [] } });
    return reply({});
  };
  await collect({ from: '2026-11-09', to: '2026-11-11', mode: 'incremental' });
  globalThis.fetch = realFetch;
  const trips = await bolt('egari');
  check('three rides on both feeds are three rows, not six', trips.length === 3,
    trips.map((t) => t.external_id).join(', '));
  check('…every one the portal\'s row', trips.every((t) => 'created' in (t.raw || {})));
  check('…filled by this feed with what the portal never sends',
    trips.every((t) => t.pickup_lat === 25.1001 && t.duration_s === 1200 && t.raw?.fleet_integration?.served_by === 'portal'),
    JSON.stringify(trips.map((t) => [t.pickup_lat, t.duration_s])));
  check('the ride the portal answered for and did not return is held, not counted',
    !trips.some((t) => /orphan/.test(t.external_id))
    && (await ledger()).find((l) => l.order_reference === 'live-orphan')?.disposition === 'held');
  const run = (await q(`SELECT error, detail FROM collection_run WHERE source = 'bolt' AND fleet_id = 'egari'`))[0];
  const detail = typeof run?.detail === 'string' ? JSON.parse(run.detail) : run?.detail || [];
  check('the run names both feeds\' windows',
    detail.some((w) => w.kind === 'portal' && w.rows === 3) && detail.some((w) => w.kind === 'fleet-integration' && w.rows === 4),
    JSON.stringify(detail));
  check('…and, the portal having answered, does not claim the second feed served the window',
    !/fleet-integration getFleetOrders answered/.test(run?.error || ''), run?.error);
  const markF = (await q('SELECT value FROM source_state WHERE source = $1 AND fleet_id = $2 AND key = $3',
    ['bolt', 'egari', ANSWERED_KEY]))[0]?.value;
  check('the portal\'s harvest moved the "answered through" mark itself',
    !!markF && Date.parse(markF) >= Date.parse('2026-11-12T00:00:00+04:00') - 1, markF);
  delete process.env.BOLT_REFRESH_TOKEN_EGARI;
}

/* ══ G. a SHORT portal answer still retires the stand-ins ═════════════════ */
console.log('\nG. the portal answers short, and the match rule does not hold: still one row per ride');
await q(`DELETE FROM trip WHERE platform = 'bolt'`);
await q('DELETE FROM bolt_fi_order');
await q(`DELETE FROM source_state WHERE source = 'bolt'`);
{
  const { harvestPortal } = await import('../src/sources/bolt.js');
  const at = Date.parse('2026-11-11T10:00:00+04:00') / 1000;
  /* The lapse: only this feed has the ride, so it stands in. */
  await pass1([fiOrder(1, { order_reference: 'ref-g', order_created_timestamp: at })]);
  check('the ride stands in while the portal is dark', (await bolt()).map((r) => r.external_id).join() === 'fi:ref-g');
  /* The portal comes back with the same ride ONE SECOND off — the match rule's
     premise failing — in a window that declares one more row than it serves
     (offset paging lost a tie). Wired exactly as oneFleet wires it. */
  const ride = portalOrder(1, { created: at + 1, fare_finalised: at + 1511, arrived_to_destinations: [at + 1501] });
  await harvestPortal({ from: '2026-11-11', to: '2026-11-11', sleep: async () => {},
    row: (o) => portalRow(o, C),
    ask: async () => ({ code: 0, message: 'OK', data: { total_rows: 2,
      columns: Object.keys(ride).map((k) => ({ key: k, cells: [ride[k]] })) } }),
    sink: async (batch) => upsertMany('trip', await protectFiFills(batch), ['platform', 'external_id']),
    answered: (win, meta) => supersedeFiRows(C, win, meta) });
  const after = await bolt();
  check('the short answer still retires the stand-in: one row for one ride, the portal\'s',
    after.length === 1 && 'created' in (after[0].raw || {}), after.map((r) => r.external_id).join());
}

/* ══ I. the ride_price verdict outlives the batch that measured it ═════════
   Review, 2026-11-12. Measured once, while the portal answered; then the
   lapse, when no batch has a matched ride to compare — the moment the check
   exists for, and the moment the first version dropped it. */
console.log('\nI. a ride_price disagreement measured before a lapse still holds during it');
await q(`DELETE FROM trip WHERE platform = 'bolt'`);
await q('DELETE FROM bolt_fi_order');
await q(`DELETE FROM source_state WHERE source = 'bolt'`);
{
  const at = (d, k) => Date.parse(`${d}T10:00:00+04:00`) / 1000 + k * 3600;
  const rideOn = (d, k, over = {}) => fiOrder(k, { order_reference: `pv-${d}-${k}`, order_created_timestamp: at(d, k),
    order_pickup_timestamp: at(d, k) + 300, order_drop_off_timestamp: at(d, k) + 1500,
    order_finished_timestamp: at(d, k) + 1510, ...over });
  const portalOn = (d, k, price) => portalOrder(k, { created: at(d, k), fare_finalised: at(d, k) + 1510,
    arrived_to_destinations: [at(d, k) + 1500], price });
  const H = Date.parse('2026-11-06T00:00:00+04:00');
  check('nothing is kept before anything is measured', (await loadPriceVerdict('egari')) === null);
  /* Five rides on both feeds, the portal's price 30 above Bolt's ride_price. */
  await writePortal([1, 2, 3, 4, 5].map((k) => portalOn('2026-11-05', k, 80 + k)));
  await applyFiOrders(C, [1, 2, 3, 4, 5].map((k) => rideOn('2026-11-05', k)),
    { answeredThrough: H, priceKept: { v: await loadPriceVerdict('egari') } });
  const kept = await loadPriceVerdict('egari');
  check('five matched rides that disagree keep their verdict', kept?.ok === false && kept?.n === 5 && kept?.agree === 0,
    JSON.stringify(kept));
  /* The lapse: an order after the portal's last answer, nothing to compare. */
  const lapse = await applyFiOrders(C, [rideOn('2026-11-08', 1, { order_reference: 'pv-lapse' })],
    { answeredThrough: H, priceKept: { v: await loadPriceVerdict('egari') } });
  const standIn = (await bolt()).find((r) => r.external_id === 'fi:pv-lapse');
  check('a stand-in during the lapse takes no ride_price the kept verdict refused',
    !!standIn && standIn.price == null && lapse.price?.basis === 'kept' && lapse.price?.ok === false,
    JSON.stringify({ price: standIn?.price, verdict: lapse.price }));
  /* An OLDER window measuring agreement — a backfill walks newest first —
     must not overwrite the newer measurement. */
  await writePortal([1, 2, 3, 4, 5].map((k) => portalOn('2026-10-20', k, 50 + k)));
  await applyFiOrders(C, [1, 2, 3, 4, 5].map((k) => rideOn('2026-10-20', k)),
    { answeredThrough: H, priceKept: { v: await loadPriceVerdict('egari') } });
  check('…and an older window\'s agreement does not replace the newer verdict',
    (await loadPriceVerdict('egari'))?.ok === false, JSON.stringify(await loadPriceVerdict('egari')));
}

/* ══ J. an ambiguous order gives up its stand-in ══════════════════════════
   Review, 2026-11-12: kept "on the key it already has", the stand-in sat
   beside the portal's rows for the same second — one ride, three rows. */
console.log('\nJ. an order that becomes ambiguous does not keep a stand-in beside the portal\'s rows');
await q(`DELETE FROM trip WHERE platform = 'bolt'`);
await q('DELETE FROM bolt_fi_order');
await q(`DELETE FROM source_state WHERE source = 'bolt'`);
{
  const at = Date.parse('2026-11-07T10:00:00+04:00') / 1000;
  const order = fiOrder(1, { order_reference: 'amb-1', order_created_timestamp: at });
  await applyFiOrders(C, [order], { answeredThrough: null });
  check('the order stands in while the portal has nothing for it',
    (await bolt()).map((r) => r.external_id).join() === 'fi:amb-1');
  /* The portal then writes TWO rows for that second, both on the order's car
     (same plate digits) — e.g. a window whose later page failed, so its
     `answered` callback never ran. */
  await writePortal([portalOrder(1, { created: at, driver: { id: 910001, name: 'A' } }),
    portalOrder(1, { created: at, driver: { id: 910002, name: 'B' } })]);
  const amb = await applyFiOrders(C, [order], { answeredThrough: null });
  const after = await bolt();
  check('…and once ambiguous, it gives the stand-in up: the portal\'s two rows, no third',
    amb.ambiguous === 1 && after.length === 2 && !after.some((r) => r.external_id === 'fi:amb-1'),
    after.map((r) => r.external_id).join());
  const led = (await ledger()).find((l) => l.order_reference === 'amb-1');
  check('…on the record as ambiguous, on no trip row', led?.disposition === 'ambiguous' && led?.trip_external_id == null,
    JSON.stringify(led));
}

/* ══ H. no fleet-integration client configured ════════════════════════════ */
console.log('\nH. no fleet-integration client: the roster says so once, the orders pass adds nothing');
{
  delete process.env.BOLT_CLIENT_ID; delete process.env.BOLT_CLIENT_SECRET;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 200,
    headers: { 'content-type': 'application/json' } }); };
  await q('DELETE FROM collection_run');
  await collect({ from: '2026-11-09', to: '2026-11-11', mode: 'incremental' });
  globalThis.fetch = realFetch;
  const rr = await q(`SELECT fleet_id, error FROM collection_run WHERE source = 'bolt'`);
  check('nothing is asked of getFleetOrders, and no second failure per fleet is written',
    !calls.some((u) => u.includes('getFleetOrders')) && rr.length === 2
    && rr.every((r) => !/fleet-integration orders/.test(r.error || '')), JSON.stringify(rr.map((r) => r.error)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
