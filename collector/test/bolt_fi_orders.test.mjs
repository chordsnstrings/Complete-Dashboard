/* ── Bolt's trips from the fleet-integration API: the reading and the walk ──
   src/sources/bolt_orders.js reads getFleetOrders — the Bolt route on the
   credential that never expires — so Bolt's trips keep coming when the
   seven-day portal token lapses (both live tokens expire 2026-11-14 15:06Z).
   This file drives everything in it that needs no database: how one answer is
   read, how the windows are walked, how one order becomes this product's
   words, and the rule that decides when an order and a portal row are the
   same ride. test/bolt_fi_orders_db.test.mjs drives the writes.

   The fixtures are SYNTHETIC, in the shape production's probe recorded for
   egari:getFleetOrders on 2026-11-11 (field names, types and fill only — no
   value from a real order is copied here) and in the shape Bolt's own spec
   gives (apidocs.bolt.eu fleetIntegration open-api.json, read 2026-11-12). */
import { createRequire } from 'node:module';
import {
  fiWindows, splitWindow, readFiOrders, harvestFiOrders, orderFacts, keptOrder, distanceUnit,
  priceAgreement, matchOrders, sameOrder, fillPlan, keepFiFills, canon, orderTripRow, fiOrderRow,
  portalCoverage, portalDayEvidence, FI_CODES, FI_ORDER_MAX_DAYS,
} from '../src/sources/bolt_orders.js';
import { portalRow } from '../src/sources/bolt.js';
import { C, T0, fiOrder, portalOrder, okPage as ok } from './bolt_fi_fixtures.mjs';

/* node-postgres's own parameter encoder — what production sends. PGlite
   types a JSONB parameter from the column and accepts what production
   refuses (docs/COVERAGE.md trap, 2026-09-23). */
const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const NOW = Date.parse('2026-11-12T06:00:00Z');
const nap = async () => {};

/* ══ 1. the windows ═══════════════════════════════════════════════════════ */
console.log('\nbolt FI orders: the windows');
{
  const w = fiWindows('2026-09-01', '2026-11-12', { now: NOW });
  check('Dubai days, newest window first',
    w[0].to === '2026-11-12' && w.at(-1).from === '2026-09-01', JSON.stringify(w.map((x) => `${x.from}..${x.to}`)));
  check(`no window longer than ${FI_ORDER_MAX_DAYS} days, so 498806 (31 days) is never asked`,
    w.every((x) => x.end_ts - x.start_ts < 31 * 86400), JSON.stringify(w.map((x) => x.end_ts - x.start_ts)));
  check('a window starts at Dubai midnight, not UTC midnight',
    w.at(-1).start_ts === Date.parse('2026-09-01T00:00:00+04:00') / 1000);
  check('the newest window ends NOW, never in the future',
    w[0].end_ts === Math.floor(NOW / 1000));
  check('windows meet without a gap or an overlap',
    w.slice(1).every((x, i) => w[i].start_ts === x.end_ts + 1), JSON.stringify(w.map((x) => [x.start_ts, x.end_ts])));
  check('a Date is read on the fleet\'s clock — 21:00Z is already tomorrow in Dubai',
    fiWindows(new Date('2026-11-10T21:00:00Z'), new Date('2026-11-10T21:00:00Z'), { now: NOW })[0].from === '2026-11-11');
  check('an end past today is clamped to today', fiWindows('2026-11-12', '2026-12-31', { now: NOW }).length === 1);
  const halves = splitWindow({ from: '2026-10-01', to: '2026-10-30' }, NOW);
  check('a window splits into two halves, newer first',
    halves && halves[0].from === '2026-10-16' && halves[0].to === '2026-10-30'
    && halves[1].from === '2026-10-01' && halves[1].to === '2026-10-15', JSON.stringify(halves));
  check('a single day cannot be split', splitWindow({ from: '2026-10-01', to: '2026-10-01' }, NOW) === null);
}

/* ══ 2. one answer, read ══════════════════════════════════════════════════ */
console.log('\nbolt FI orders: reading one answer');
{
  check('code 0 with an orders array is an answer', readFiOrders(ok([fiOrder(1)])).kind === 'ok');
  check('…and total_orders is read as the window\'s count', readFiOrders(ok([fiOrder(1)], 7)).total === 7);
  /* The probe's lesson: an array that is not `orders` is not data. */
  check('a 200 with validation_errors is a refusal, not one row of data',
    readFiOrders({ status: 200, data: { code: 702, message: 'INVALID_REQUEST',
      validation_errors: [{ property: 'company_ids', error: 'Is not array' }] } }).kind === 'invalid');
  check('code 0 with some OTHER array is not read as orders',
    readFiOrders({ status: 200, data: { code: 0, data: { drivers: [{ a: 1 }] } } }).kind !== 'ok');
  const eco = readFiOrders({ status: 200, data: { code: 503, message: 'NOT_AUTHORIZED', error_hint: 'COMPANIES_NOT_ALLOWED' } });
  check('the production refusal for Ecosine reads as NOT ENTITLED (measured 2026-11-11)',
    eco.kind === 'not-entitled' && /COMPANIES_NOT_ALLOWED/.test(eco.says), JSON.stringify(eco));
  check('…and so does the spec\'s 498810 COMPANY_NOT_ALLOWED',
    readFiOrders({ data: { code: FI_CODES.COMPANY_NOT_ALLOWED, message: 'COMPANY_NOT_ALLOWED' } }).kind === 'not-entitled');
  check('498805 INVALID_START_DATE is the retention boundary',
    readFiOrders({ data: { code: 498805, message: 'INVALID_START_DATE' } }).kind === 'too-old');
  check('498806 INVALID_DATE_RANGE is a window too long',
    readFiOrders({ data: { code: 498806, message: 'INVALID_DATE_RANGE' } }).kind === 'range-too-long');
  check('498809 COMPANY_NOT_ACTIVE stops the company',
    readFiOrders({ data: { code: 498809, message: 'COMPANY_NOT_ACTIVE' } }).kind === 'inactive');
  check('a refused page size is told apart from other validation errors',
    readFiOrders({ data: { code: 702, validation_errors: [{ property: 'limit', error: 'Integer is not in range' }] } }).kind === 'page-size');
  check('HTTP 429 is a rate limit, not an answer', readFiOrders({ status: 429, data: 'Too Many Requests' }).kind === 'rate-limited');
  check('…and so is the portal\'s 1005', readFiOrders({ status: 200, data: { code: 1005, message: 'x' } }).kind === 'rate-limited');
  check('an HTML error page is unrecognisable, never an empty window',
    /unrecognisable/.test(readFiOrders({ status: 200, data: '<html>502 Bad Gateway</html>' }).says));
  check('a 404 route says HTTP 404',
    readFiOrders({ status: 404, data: { message: 'Route not found', statusCode: 404 } }).says === 'HTTP 404');
}

/* ══ 3. one order, in this product's words ════════════════════════════════ */
console.log('\nbolt FI orders: one order');
{
  const f = orderFacts(fiOrder(2));
  check('Bolt\'s order id and creation second are the order\'s identity',
    f.ref === 'ref-2' && f.createdS === T0 + 1200 && f.requestedAt === new Date((T0 + 1200) * 1000).toISOString());
  check('the plate is normalised like every other plate', f.plate === 'L10002' && f.plateDigits === '10002', f.plate);
  check('coordinates come from order_stops — the portal sends none',
    f.pickup.lat === 25.1001 && f.pickup.lng === 55.2001 && f.dropoff.lat === 25.2002, JSON.stringify(f.pickup));
  check('…preferring where the stop happened, and saying so', f.pickup.basis === 'real');
  const asked = orderFacts(fiOrder(2, { order_stops: [{ type: 'pickup', lat: 25.1, lng: 55.2, real_lat: null, real_lng: null }] }));
  check('…else the stop as requested', asked.pickup.lat === 25.1 && asked.pickup.basis === 'requested');
  const zero = orderFacts(fiOrder(2, { order_stops: [{ type: 'pickup', lat: 0, lng: 0, real_lat: null, real_lng: null }] }));
  check('(0, 0) is a sentinel, not a place', zero.pickup.lat === null);
  const multi = orderFacts(fiOrder(2, { order_stops: [
    { type: 'pickup', lat: 25.1, lng: 55.2 }, { type: 'dropoff', lat: 25.3, lng: 55.4 },
    { type: 'waypoint', lat: 25.5, lng: 55.6 }, { type: 'dropoff', lat: 25.7, lng: 55.8 }] }));
  check('a multi-stop ride ends at its LAST drop-off', multi.dropoff.lat === 25.7, JSON.stringify(multi.dropoff));
  check('the ride ends at the drop-off', f.endedAt === new Date((T0 + 1200 + 1500) * 1000).toISOString());
  check('duration is with the rider: pick-up to drop-off', f.durationS === 1200);
  const cancelled = orderFacts(fiOrder(2, { order_status: 'client_cancelled', order_pickup_timestamp: null,
    order_drop_off_timestamp: null, order_finished_timestamp: null, order_cancelled_timestamp: T0 + 1300,
    order_price: { ride_price: 0, commission: 0, net_earnings: null }, ride_distance: 0 }));
  check('a cancellation is not an end — a ride that never ran has none', cancelled.endedAt === null);
  check('a zero price is absence, as on the portal (has_fare is price IS NOT NULL)', cancelled.price === null);
  check('…and a zero distance too', cancelled.distanceRaw === null);
  check('the money is kept as Bolt states it: a stated 0 commission stays 0, a null stays null',
    cancelled.money.commission === 0 && cancelled.money.net_earnings === null);
  check('per-ride commission and net earnings are read', f.money.commission === 10 && f.money.net_earnings === 42);
  check('product, payment and scheduling come across',
    f.product === 'Comfort' && f.paymentType === 'in_app' && f.isScheduled === false);
  check('an order with no order_reference is not an order', orderFacts(fiOrder(2, { order_reference: '' })) === null);
  check('…nor one with no creation time', orderFacts(fiOrder(2, { order_created_timestamp: 0 })) === null);
  check('the driver\'s phone is dropped before anything is kept',
    !('driver_phone' in keptOrder(fiOrder(2))) && keptOrder(fiOrder(2)).order_reference === 'ref-2');
}

/* ══ 4. the unit of ride_distance, measured ═══════════════════════════════ */
console.log('\nbolt FI orders: the distance unit is measured, not assumed');
{
  const facts = [1, 2, 3, 4, 5].map((n) => orderFacts(fiOrder(n)));
  const km = (n) => ({ distance_km: (12000 + n) / 1000 });
  check('against the portal\'s kilometres on matched rides: metres',
    distanceUnit(facts, facts.slice(0, 3).map((f, i) => [f, km(i + 1)])).unit === 'm');
  check('…and kilometres when the two agree 1:1', distanceUnit(
    [1, 2, 3].map((n) => orderFacts(fiOrder(n, { ride_distance: 12 + n }))),
    [1, 2, 3].map((n) => [orderFacts(fiOrder(n, { ride_distance: 12 + n })), { distance_km: 12 + n }])).unit === 'km');
  const off = distanceUnit(facts, facts.slice(0, 3).map((f) => [f, { distance_km: 3 }]));
  check('…and NO unit when they disagree, with the reason', off.unit === null && /portal/.test(off.says || ''), JSON.stringify(off));
  check('with no portal rides: from the magnitude of finished rides (median 12,003 = metres)',
    distanceUnit(facts, []).unit === 'm' && distanceUnit(facts, []).basis === 'magnitude');
  check('too few rides decides nothing', distanceUnit(facts.slice(0, 2), []).unit === null);
}

/* ══ 5. the match ═════════════════════════════════════════════════════════ */
console.log('\nbolt FI orders: the same ride, on two feeds');
{
  const facts = [1, 2, 3].map((n) => orderFacts(fiOrder(n)));
  const rows = [1, 2, 3].map((n) => portalRow(portalOrder(n), C));
  const m = matchOrders(facts, rows);
  check('same fleet, same creation second, same car: each order finds its portal row',
    [1, 2, 3].every((n) => m.get(`ref-${n}`)?.row?.external_id === rows[n - 1].external_id),
    JSON.stringify([...m.entries()].map(([k, v]) => [k, v.row?.external_id || v])));
  check('the portal\'s digits-only plate matches the lettered plate', rows[0].plate === '10001');
  const elsewhere = portalRow(portalOrder(1, { created: T0 + 600 + 1 }), C);
  check('one second apart is a different ride', !matchOrders([facts[0]], [elsewhere]).get('ref-1'));
  check('the driver matches where the car does not (partner_identifier = partner_uuid)',
    sameOrder(facts[0], { ...rows[0], plate: 'Q999' }, new Map()));
  check('…or by a driver id pair learned from an earlier match',
    sameOrder(facts[0], { ...rows[0], plate: 'Q999', partner_identifier: null }, new Map([['uuid-d1', '900001']])));
  check('…and nothing matches on the second alone',
    !sameOrder(facts[0], { ...rows[0], plate: 'Q999', partner_identifier: 'someone-else' }, new Map()));
  const twin = { ...rows[0], external_id: 'other|1' };
  check('two portal rows that fit are ambiguous, and neither is touched',
    matchOrders([facts[0]], [rows[0], twin]).get('ref-1')?.ambiguous === 2);
  const doubleClaim = orderFacts(fiOrder(1, { order_reference: 'ref-1b' }));
  const dm = matchOrders([facts[0], doubleClaim], [rows[0]]);
  check('two orders on one portal row are ambiguous too',
    dm.get('ref-1')?.ambiguous === 2 && dm.get('ref-1b')?.ambiguous === 2);
}

/* ══ 6. what an order may fill ════════════════════════════════════════════ */
console.log('\nbolt FI orders: filling only what the portal left empty');
{
  const f = orderFacts(fiOrder(1));
  const p = portalRow(portalOrder(1), C);
  const plan = fillPlan(p, f, { unit: 'm' });
  check('coordinates, duration and scheduling are filled — the portal never sends them',
    plan.set.pickup_lat === 25.1001 && plan.set.dropoff_lng === 55.3002 && plan.set.duration_s === 1200
    && plan.set.is_scheduled === false, JSON.stringify(plan.set));
  check('an address the portal left empty is filled', plan.set.pickup_addr === 'Pickup 1');
  check('the portal\'s own price, distance and status are never replaced',
    !('price' in plan.set) && !('distance_km' in plan.set) && !('status' in plan.set), JSON.stringify(plan.set));
  check('a digits-only portal plate gets its letter code back (same digits, better grade)', plan.set.plate === 'L10001');
  check('…but a lettered portal plate is left alone',
    !('plate' in fillPlan({ ...p, plate: 'M10001' }, f, {}).set));
  check('coordinates go in pairs', !('pickup_lat' in fillPlan({ ...p, pickup_lng: 55 }, f, {}).set));
  check('`filled` names every column the row now holds from this feed',
    ['duration_s', 'pickup_addr', 'pickup_lat', 'plate'].every((c) => plan.filled.includes(c)), JSON.stringify(plan.filled));
  const after = { ...p, ...plan.set, fi: { filled: plan.filled } };
  const again = fillPlan(after, f, { unit: 'm' });
  check('a second pass fills nothing new', Object.keys(again.set).length === 0, JSON.stringify(again.set));
  check('…and still names what it filled before, so the portal\'s NULL cannot erase it',
    canon(again.filled) === canon(plan.filled), `${again.filled} vs ${plan.filled}`);
  check('provenance compares without regard to key order (jsonb reorders keys)',
    canon({ b: 1, a: [2, { d: 1, c: 2 }] }) === canon({ a: [2, { c: 2, d: 1 }], b: 1 }));
}

/* ══ 7. the portal may not undo a fill with a NULL ════════════════════════ */
console.log('\nbolt FI orders: the portal\'s write keeps what this feed filled');
{
  const row = portalRow(portalOrder(1), C);   // route [] → pickup_addr null
  const kept = keepFiFills(row, { plate: 'L10001', filled: ['pickup_addr', 'plate', 'pickup_lat'] });
  check('a NULL the portal sends for a filled column is not written', !('pickup_addr' in kept));
  check('the portal\'s digits-only plate does not overwrite the lettered one', !('plate' in kept));
  const withAddr = keepFiFills({ ...row, pickup_addr: 'Portal address' }, { filled: ['pickup_addr'] });
  check('…but a value the portal DOES have still wins', withAddr.pickup_addr === 'Portal address');
  check('a row this feed never touched is written exactly as it came',
    keepFiFills(row, null) === row && keepFiFills(row, { filled: [] }) === row);
}

/* ══ 8. what is written, on the wire production uses ══════════════════════ */
console.log('\nbolt FI orders: the rows written');
{
  const f = orderFacts(fiOrder(4));
  const t = orderTripRow(f, fiOrder(4), C, { key: 'fi:ref-4', unit: 'm' });
  const wire = prepareValue(t.raw);
  let parsed = null;
  try { parsed = JSON.parse(wire); } catch { /* checked below */ }
  check('trip.raw is valid JSON on the node-postgres wire', !!parsed, String(wire).slice(0, 80));
  check('…carrying the provenance: which order, served by this feed, what it filled',
    parsed?.fleet_integration?.order_reference === 'ref-4' && parsed.fleet_integration.served_by === 'fleet-integration'
    && parsed.fleet_integration.filled.includes('pickup_lat'), JSON.stringify(parsed?.fleet_integration).slice(0, 200));
  check('…and the order, without the driver\'s phone', parsed?.fleet_integration?.order
    && !('driver_phone' in parsed.fleet_integration.order));
  check('a stand-in row has no top-level `created` — that key is how a portal row is told apart',
    parsed && !('created' in parsed));
  check('ride_distance in metres becomes kilometres', t.distance_km === 12.0, String(t.distance_km));
  check('the price is Bolt\'s ride_price', t.price === 54);
  check('the driver is the roster\'s uuid until a portal id is known', t.driver_ext_id === 'uuid-d1');
  check('no unit decided means no distance, never a guess',
    orderTripRow(f, fiOrder(4), C, { key: 'k', unit: null }).distance_km === null);
  const l = fiOrderRow(C, f, fiOrder(4), { disposition: 'inserted', tripKey: 'fi:ref-4' });
  let lp = null;
  try { lp = JSON.parse(prepareValue(l.raw)); } catch { /* checked below */ }
  check('bolt_fi_order.raw is valid JSON on the wire, phone dropped', lp && !('driver_phone' in lp));
  check('…with the per-ride money in its own columns', l.commission === 10 && l.net_earnings === 44 && l.ride_price === 54);
}

/* ══ 9. what the portal covered, and the evidence of its clock ═══════════ */
console.log('\nbolt FI orders: what a portal window answered for');
{
  const win = { start: new Date('2026-11-09T00:00:00Z'), end: new Date('2026-11-10T00:00:00Z') };
  const asked = Date.parse('2026-11-12T00:00:00Z');
  const cov = portalCoverage(win, asked);
  check('its Dubai days', cov.lo === Date.parse('2026-11-09T00:00:00+04:00')
    && cov.hi === Date.parse('2026-11-11T00:00:00+04:00'));
  check('…and never later than the moment it was asked',
    portalCoverage({ start: win.start, end: new Date('2026-11-12T00:00:00Z') }, asked).hi === asked);
  const utc = portalDayEvidence(win, null, '2026-11-10T21:00:00.000Z');
  check('an order after the last Dubai day ended is evidence of UTC days, said in words',
    utc?.basis === 'utc' && /UTC days/.test(utc.says), JSON.stringify(utc));
  check('an order before UTC midnight of the first day is evidence of Dubai days',
    portalDayEvidence(win, '2026-11-08T21:00:00.000Z', null)?.basis === 'dubai');
  check('rows inside both readings prove nothing',
    portalDayEvidence(win, '2026-11-09T08:00:00.000Z', '2026-11-10T08:00:00.000Z') === null);
}

/* ══ 10. the walk ═════════════════════════════════════════════════════════ */
console.log('\nbolt FI orders: the walk');
{
  /* A gateway with N orders a day, paged by offset, honouring limit. */
  const gateway = ({ perDay = 2, keepFrom = '2000-01-01', maxLimit = 1000, total = null } = {}) =>
    async (win, offset, limit) => {
      if (limit > maxLimit) return { status: 200, data: { code: 702, message: 'INVALID_REQUEST',
        validation_errors: [{ property: 'limit', error: 'Integer is not in range' }] } };
      if (win.from < keepFrom) return { status: 200, data: { code: 498805, message: 'INVALID_START_DATE' } };
      const all = [];
      for (let t = win.start_ts; t <= win.end_ts; t += 86400) {
        for (let k = 0; k < perDay; k++) all.push(fiOrder(0, { order_reference: `r${t}-${k}`, order_created_timestamp: t + k * 60 }));
      }
      return ok(all.slice(offset, offset + limit), total ?? all.length);
    };
  const seen = [];
  const h = await harvestFiOrders({ from: '2026-10-01', to: '2026-11-11', ask: gateway(), now: NOW, sleep: nap,
    pageSteps: [5], sink: async (orders) => { seen.push(...orders); } });
  check('every order of every window arrives, across pages',
    seen.length === 42 * 2 && new Set(seen.map((o) => o.order_reference)).size === 84, `${seen.length}`);
  check('one record per window, in the shape logRun stores, rows = orders Bolt returned',
    h.chunks.length === 2 && h.chunks.every((c) => c.from && c.to && typeof c.rows === 'number' && c.error === null)
    && h.chunks.reduce((a, c) => a + c.rows, 0) === 84, JSON.stringify(h.chunks));

  let calls = 0;
  const limitedTwice = async (win, offset, limit) => (++calls <= 2 ? { status: 429, data: 'slow down' } : gateway()(win, offset, limit));
  const waited = [];
  const rl = await harvestFiOrders({ from: '2026-11-10', to: '2026-11-11', ask: limitedTwice, now: NOW,
    sleep: async (ms) => { waited.push(ms); } });
  check('a rate limit is waited out, not recorded as an answer',
    rl.limited === 2 && waited.length === 2 && rl.chunks.length === 1 && rl.chunks[0].error === null && rl.orders === 4,
    JSON.stringify({ limited: rl.limited, waited, chunks: rl.chunks }));

  const refused = await harvestFiOrders({ from: '2026-09-01', to: '2026-11-11', now: NOW, sleep: nap,
    ask: async () => ({ status: 200, data: { code: 503, message: 'NOT_AUTHORIZED', error_hint: 'COMPANIES_NOT_ALLOWED' } }) });
  check('a company the client is not entitled to stops the walk at once',
    refused.stop?.kind === 'not-entitled' && refused.asked === 1, JSON.stringify(refused.stop));
  check('…and records NO window: "0 rows, ok" would read as zero trips', refused.chunks.length === 0);

  const old = await harvestFiOrders({ from: '2026-08-01', to: '2026-11-11', now: NOW, sleep: nap,
    ask: gateway({ keepFrom: '2026-09-13' }) });
  check('the retention boundary is found to the day, and nothing older is kept asking',
    old.tooOld?.from === '2026-09-12' && old.chunks.every((c) => c.to >= '2026-09-13') && old.chunks.every((c) => !c.error),
    JSON.stringify({ tooOld: old.tooOld, chunks: old.chunks.map((c) => `${c.from}..${c.to}`) }));
  check('…and the days Bolt does keep in the boundary window are not lost to it',
    old.chunks.some((c) => c.from === '2026-09-13'), JSON.stringify(old.chunks.map((c) => c.from)));

  let tooLong = 0;
  const strict = async (win, offset, limit) => {
    if (win.end_ts - win.start_ts > 10 * 86400) { tooLong++; return { status: 200, data: { code: 498806, message: 'INVALID_DATE_RANGE' } }; }
    return gateway()(win, offset, limit);
  };
  const split = await harvestFiOrders({ from: '2026-10-01', to: '2026-10-30', ask: strict, now: NOW, sleep: nap });
  check('a window the gateway calls too long is split, not lost',
    tooLong >= 1 && split.orders === 60 && split.chunks.every((c) => !c.error), JSON.stringify(split.chunks));

  const stepped = await harvestFiOrders({ from: '2026-11-10', to: '2026-11-11', ask: gateway({ maxLimit: 200 }), now: NOW, sleep: nap });
  check('a refused page size steps down and the window is still collected',
    stepped.orders === 4 && stepped.chunks[0].error === null, JSON.stringify(stepped.chunks));

  let n = 0;
  const resetOnce = async (win, offset, limit) => { if (++n === 1) throw new Error('fetch failed (ECONNRESET)'); return gateway()(win, offset, limit); };
  const reset = await harvestFiOrders({ from: '2026-09-01', to: '2026-11-11', ask: resetOnce, now: NOW, sleep: nap });
  check('a thrown request fails its window, and the windows after it are still asked',
    reset.chunks[0].error && /ECONNRESET/.test(reset.chunks[0].error) && reset.chunks.slice(1).every((c) => !c.error),
    JSON.stringify(reset.chunks));

  const html = await harvestFiOrders({ from: '2026-11-10', to: '2026-11-11', now: NOW, sleep: nap,
    ask: async () => ({ status: 200, data: '<html>bad gateway</html>' }) });
  check('an HTML page is a failed window that says what arrived', /unrecognisable/.test(html.chunks[0]?.error || ''));

  const short = await harvestFiOrders({ from: '2026-11-10', to: '2026-11-11', ask: gateway({ total: 9 }), now: NOW, sleep: nap });
  check('a window short of Bolt\'s declared total says so',
    short.short === 5 && /collected 4 of 9 declared/.test(short.chunks[0].error || ''), JSON.stringify(short.chunks));

  const broken = await harvestFiOrders({ from: '2026-11-10', to: '2026-11-11', ask: gateway(), now: NOW, sleep: nap,
    sink: async () => { throw new Error('invalid input syntax for type json'); } });
  check('a window read and not stored says so — it was not Bolt that refused',
    /read 4 orders, stored none/.test(broken.chunks[0].error || ''), JSON.stringify(broken.chunks));

  const nokey = await harvestFiOrders({ from: '2026-11-11', to: '2026-11-11', now: NOW, sleep: nap,
    ask: async () => ok([fiOrder(1), fiOrder(2, { order_reference: null })]) });
  check('an order with no order_reference is counted, never silently dropped', nokey.dropped === 1 && nokey.orders === 1);
}

/* ══ 11. the portal harvest tells this feed what it answered for ══════════ */
console.log('\nbolt FI orders: the portal harvest reports only complete answers');
{
  const { harvestPortal } = await import('../src/sources/bolt.js');
  const asCols = (orders, total) => ({ code: 0, message: 'OK', data: { total_rows: total ?? orders.length,
    columns: Object.keys(orders[0] || { created: 0 }).map((k) => ({ key: k, cells: orders.map((o) => o[k]) })) } });
  const day = (d, h = 9) => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00+04:00`) / 1000;
  const portal = (mode) => async (win) => {
    const d = new Date(win.start).toISOString().slice(0, 10);
    if (mode === 'refuse' && d < '2026-10-01') return { code: 702, message: 'INVALID_REQUEST' };
    const orders = [portalOrder(0, { created: day(d) }), portalOrder(1, { created: day(d, 10) })];
    return asCols(orders, mode === 'short' && d >= '2026-10-01' ? 5 : orders.length);
  };
  const told = [];
  const t0 = Date.now();
  await harvestPortal({ from: '2026-09-01', to: '2026-10-30', ask: portal('ok'), row: (o) => portalRow(o, C), sleep: nap,
    answered: async (win, meta) => { told.push({ win, ...meta }); } });
  check('every window the portal answered is reported', told.length === 2, `${told.length}`);
  check('…with the moment it was asked, the first and last order it returned',
    told.every((t) => t.askedAt >= t0 && t.askedAt <= Date.now() && t.first && t.last && t.first <= t.last),
    JSON.stringify(told.map((t) => [t.askedAt, t.first, t.last])));
  told.length = 0;
  await harvestPortal({ from: '2026-09-01', to: '2026-10-30', ask: portal('short'), row: (o) => portalRow(o, C), sleep: nap,
    answered: async (win, meta) => { told.push({ win, ...meta }); } });
  /* Withholding a short answer would leave a stand-in beside the portal's
     own row for the same ride — its rows are written either way. */
  check('a window short of its declared count IS reported, with its shortfall, so its stand-ins are still retired',
    told.length === 2 && told.find((t) => new Date(t.win.start).toISOString().slice(0, 10) >= '2026-10-01')?.short === 3
    && told.find((t) => new Date(t.win.start).toISOString().slice(0, 10) < '2026-10-01')?.short === 0,
    JSON.stringify(told.map((t) => [new Date(t.win.start).toISOString().slice(0, 10), t.short])));
  told.length = 0;
  await harvestPortal({ from: '2026-09-01', to: '2026-10-30', ask: portal('refuse'), row: (o) => portalRow(o, C), sleep: nap,
    answered: async (win) => { told.push(win); } });
  check('a refused window is NOT reported', told.length === 1, `${told.length}`);
  told.length = 0;
  await harvestPortal({ from: '2026-09-01', to: '2026-10-30', row: (o) => portalRow(o, C), sleep: nap,
    ask: async () => ({ code: 25809, message: 'START_DATE_TOO_FAR_IN_THE_PAST' }),
    answered: async (win) => { told.push(win); } });
  check('the retention boundary is NOT reported as an answer', told.length === 0);
  const plain = await harvestPortal({ from: '2026-10-01', to: '2026-10-30', ask: portal('ok'), row: (o) => portalRow(o, C), sleep: nap });
  check('a caller that passes no `answered` is unaffected', plain.rows.length === 2 && plain.refused === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
