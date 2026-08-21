/* The commercial analytics layer, against the data shape it will actually meet.
   ──────────────────────────────────────────────────────────────────────────
   These endpoints exist because the fleet was collecting fourteen payment
   labels, six hotel properties, a guest id, an approach distance and a
   per-trip cost — and reading none of them. The risk in surfacing that data is
   not that it will be missing; it is that it will be summarised wrongly, and
   every assertion below is one specific way that could happen:

     - folding a payment PROCESSOR into a settlement ROUTE (braintree and
       zaakpay are both "the card cleared", not two categories);
     - dividing money by trips on a channel that reports no fare, which is how
       the Finance page once claimed an average fare of AED 6.98;
     - counting a complimentary ride as a zero-dirham sale;
     - drawing an unmeasured approach leg as a zero-kilometre one;
     - calling a collection hole a quiet week;
     - and asserting, from a payment label alone, that a trip was corporate. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { analyticsRoutes } from '../api/analytics_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

const trip = (o) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,
                     distance_km,duration_s,status,product,payment_type,price,cost,deadhead_km,
                     partner_id,partner_name,zone,is_scheduled,is_missing,hours,
                     pickup_addr,dropoff_addr,raw)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
  [o.platform, o.id, o.plate ?? null, o.drv ?? null, o.drv ? 'Driver ' + o.drv : null,
   `2026-08-${String(o.day).padStart(2, '0')}T10:00:00+04:00`,
   o.km ?? null, o.secs ?? null, o.status ?? 'completed', o.product ?? null, o.pay ?? null,
   o.price ?? null, o.cost ?? null, o.dead ?? null, o.partner ?? null, o.partnerName ?? null,
   o.zone ?? null, o.sched ?? null, o.missing ?? null, o.hours ?? null,
   o.from ?? null, o.to ?? null, o.raw ? JSON.stringify(o.raw) : null]);

let n = 0;
/* Uber: FOUR payment processors that are all "card cleared", a wallet, cash
   with no fare attached, and `offline`. No row carries a price — that is the
   real export. */
const UBER_PAY = ['braintree', 'zaakpay', 'apple_pay', 'cash', 'offline', 'offline'];
for (let i = 0; i < 60; i++) {
  await trip({ platform: 'uber', id: `u${n++}`, plate: `L${100 + (i % 5)}`, drv: `d${i % 4}`,
    day: 1 + (i % 10), km: 12, secs: 900, pay: UBER_PAY[i % 6],
    product: ['UberX', 'UberX', 'Black', 'Comfort', 'Electric', 'UberX'][i % 6],
    from: `12 Cluster E - Al Thanyah Fifth - Dubai - UAE`,
    to: `9 Marasi Dr - Business Bay - Dubai - UAE` });
}
/* One plate is the same model as another but never carries premium work — the
   only shape from which "this car is under-used" is an honest claim. */
for (let i = 0; i < 30; i++) {
  await trip({ platform: 'uber', id: `up${n++}`, plate: 'L900', drv: 'd9', day: 1 + (i % 10),
    km: 9, pay: 'braintree', product: 'UberX' });
}
for (let i = 0; i < 30; i++) {
  await trip({ platform: 'uber', id: `uq${n++}`, plate: 'L901', drv: 'd8', day: 1 + (i % 10),
    km: 9, pay: 'braintree', product: i < 18 ? 'Black' : 'UberX' });
}
await q(`INSERT INTO vehicle_profile (platform,vehicle_ext_id,plate,make,model,year,colour)
         VALUES ('uber','v900','L900','Lexus','ES',2024,'black'),
                ('uber','v901','L901','Lexus','ES',2024,'black')`);

/* Telematics: no payment type at all. It must never be charted as a settlement
   class, and never counted in the money base. */
for (let i = 0; i < 40; i++) {
  await trip({ platform: 'fms', id: `f${n++}`, plate: `L${100 + (i % 5)}`, day: 1 + (i % 10), km: 20 });
}

/* The hotel channel — the only one with a cost, a property, a guest and an
   approach leg. */
const HOTELS = [['h1', 'Palm Grand'], ['h1', 'Palm Grand'], ['h1', 'Palm Grand'], ['h2', 'Marina Bay']];
const PAYS = ['cash-driver', 'pos-driver', 'room-charge', 'posted-for-salary', 'hotel-charge', 'cash-supervisor'];
for (let i = 0; i < 48; i++) {
  const [pid, pname] = HOTELS[i % 4];
  await trip({ platform: 'hotel', id: `h${n++}`, plate: `L${100 + (i % 5)}`, drv: `hd${i % 3}`,
    day: 1 + (i % 10), km: 20, price: 100, cost: 70, dead: i % 4 === 0 ? 8 : 2,
    pay: PAYS[i % 6], partner: pid, partnerName: pname,
    product: ['pick_and_drop', 'drop_off', 'hourly'][i % 3],
    zone: i % 12 === 0 ? 'outside-dubai' : 'inside-dubai', sched: i % 2 === 0,
    from: `Atlantis - Palm Jumeirah - Dubai - UAE`, to: `T3 - Dubai Airport - Dubai - UAE`,
    raw: { client: `guest${i % 8}`, hotel: pid, roomNumber: `${1000 + i}`,
      overRun: i % 24 === 0, stops: i % 6 === 0 ? [{ a: 1 }] : [],
      authorization: i % 3 === 0 ? { _id: 'a1' } : null, hourlyTripMargin: '10' } });
}
// Two complimentary rides: real cost, no price, and never a zero-dirham sale.
for (let i = 0; i < 2; i++) {
  await trip({ platform: 'hotel', id: `hf${n++}`, plate: 'L100', drv: 'hd0', day: 3, km: 15,
    price: 0, cost: 60, pay: 'foc-complimentary', partner: 'h1', partnerName: 'Palm Grand',
    raw: { client: 'guest0', overRun: false, authorization: null } });
}
// One booking whose approach leg was longer than the ride itself.
await trip({ platform: 'hotel', id: 'hd_bad', plate: 'L102', drv: 'hd1', day: 4, km: 3, dead: 19,
  price: 40, cost: 30, pay: 'pos-driver', partner: 'h2', partnerName: 'Marina Bay',
  raw: { client: 'guest3', authorization: { _id: 'a2' } } });
// A malformed flag: a provider putting a word where a boolean belongs must not
// take the whole view down.
await trip({ platform: 'hotel', id: 'h_bad_flag', plate: 'L103', drv: 'hd2', day: 4, km: 5,
  price: 55, cost: 40, pay: 'cash-driver', partner: 'h2', partnerName: 'Marina Bay',
  raw: { client: 'guest4', overRun: 'sometimes', hourlyTripMargin: 'n/a' } });

/* Two properties. Only one of them runs an approval workflow — which is the
   whole point: a missing authorisation is evidence at h1 and means nothing at
   h2, and without that distinction the category flagged 87% of every live
   booking on the channel. */
await q(`INSERT INTO partner (platform, partner_id, name, approval_required, purpose_required, active)
         VALUES ('hotel','h1','Palm Grand', true, true, true),
                ('hotel','h2','Marina Bay', false, false, true),
                ('hotel','h3','Solo House', false, false, true)`);

/* A collection hole: this source has data on day 1 and day 10, nothing in
   between, and nothing at all before day 1. Only the first is a gap. */
for (const d of [1, 10]) await trip({ platform: 'yango', id: `y${d}`, plate: 'L104', day: d, price: 30, pay: 'cash' });

await q(`INSERT INTO driver_performance
  (platform,fleet_id,driver_ext_id,driver_name,period_start,period_end,raw)
  VALUES ('yango','ecosine','yd1','Yango Driver','2026-08-01','2026-08-31',$1),
         ('bolt','ecosine','bd1','Bolt Driver','2026-08-01','2026-08-31',$2)`,
  [JSON.stringify({ count_orders_all: 200, count_orders_accepted: 150, count_orders_completed: 120,
    count_orders_cancelled_by_driver: 12, count_orders_cancelled_by_client: 18,
    work_time_seconds: 360000, price_cash: 3000, price_cashless: 1000,
    price_platform_commission: -800, state: 'active' }),
   JSON.stringify({ driver_score: 'n/a', state: 'suspended' })]);

/* ── mount the real module ───────────────────────────────────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const asDate = (v, f) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return f;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? f : s;
};
const range = (req) => {
  let from = asDate(req.query.from, '2000-01-01'); let to = asDate(req.query.to, '2100-01-01');
  if (from > to) [from, to] = [to, from];
  return [from, to, req.query.platform || null, req.query.fleet || null];
};
const F = `local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`;
const FB = `${F} AND is_booking`;
analyticsRoutes(app, { q, wrap, range, F, FB });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
const W = 'from=2026-08-01&to=2026-08-31';

/* ── settlement: a route, not a processor ────────────────────────────────── */
{
  const s = await get(`/api/settlement/mix?${W}`);
  const by = Object.fromEntries(s.classes.map((c) => [c.settlement_class, c]));
  // braintree 10 + zaakpay 10 + 60 single-tier Uber rows + 9 hotel POS = 89.
  // Four provider names, one thing that happened: the card cleared.
  check('four card processors fold into one card class', by.card?.trips === 89, `${by.card?.trips}`);
  check('apple_pay is a wallet, not a card', by.wallet?.trips === 10, String(by.wallet?.trips));
  check('offline is its own settlement route', by.off_platform?.trips === 20, String(by.off_platform?.trips));
  check('offline is not described as a business-account label',
    /not, on this evidence, a business-account label/.test(by.off_platform?.meaning || ''));
  // A GPS trace has no payment type because "how was this paid" is not a
  // question about a GPS trace. It is excluded from the base rather than
  // charted as a 40-trip "unknown" slice.
  check('telematics never appears as a settlement class',
    !s.classes.some((c) => c.platforms.includes('fms')), JSON.stringify(s.classes.map((c) => c.platforms)));
  // 120 Uber + 52 hotel + 2 Yango = 174 bookings. The 40 telematics journeys
  // are absent, not present-and-unlabelled.
  check('telematics is not in the settlement base at all',
    s.total_trips === 174, String(s.total_trips));
  // 60 Uber cash-labelled rows carry no fare. Reporting AED 0 would say the
  // fleet took no cash; reporting null says we do not know the value.
  // Uber's 10 cash-labelled trips carry no fare. Reporting AED 0 would say the
  // fleet took no cash that month; reporting null says we do not know.
  const uberOnly = await get(`/api/settlement/mix?${W}&platform=uber`);
  const uCash = uberOnly.classes.find((c) => c.settlement_class === 'cash');
  check('a class with no priced row reports unknown revenue, not zero',
    uCash && uCash.trips === 10 && uCash.revenue === null && uCash.avg_fare === null,
    JSON.stringify(uCash));
  check('a class with priced rows reports its average fare',
    by.on_account && by.on_account.avg_fare === 100, JSON.stringify(by.on_account));
  check('complimentary rides are counted as trips',
    by.complimentary?.trips === 2, String(by.complimentary?.trips));
  check('complimentary rides are kept out of the average fare',
    by.complimentary?.avg_fare === null, String(by.complimentary?.avg_fare));
  check('the shares add up to the labelled population',
    Math.abs(s.classes.reduce((a, c) => a + c.trip_share_pct, 0)
      + (100 * s.unlabelled_trips / s.total_trips) - 100) < 0.6);
}

/* ── cash exposure ───────────────────────────────────────────────────────── */
{
  const c = await get(`/api/settlement/cash-exposure?${W}`);
  // 10 Uber + 8 hotel cash-driver + 1 malformed-flag row + 2 Yango = 21.
  check('cash exposure counts cash trips on channels that report no fare',
    c.total_cash_trips === 21, String(c.total_cash_trips));
  check('the value column is stated as a floor when a channel reports no fare',
    /floor, not the total/.test(c.caveat || ''), String(c.caveat));
  check('a supervisor-collected fare is not counted as cash in a driver’s hands',
    !JSON.stringify(c.drivers).includes('cash-supervisor'));
  check('each driver says how much of their cash is valued',
    c.drivers.every((d) => d.value_known_pct != null));
  /* Counted over the table, not over the returned list. "AED x is in drivers'
     hands" and "n drivers holding cash" are numbers somebody sizes a cash
     control on; both were the length and sum of a list the endpoint caps at
     200 rows, which understates by exactly the tail nobody is watching. */
  check('the driver count is its own number, not the length of the list',
    typeof c.driver_count === 'number' && c.driver_count === c.drivers.length,
    `${c.driver_count} vs ${c.drivers.length}`);
  check('the response says whether the list was cut', c.truncated === false, String(c.truncated));
  check('the cash total is not a sum over the visible page',
    c.total_cash_trips === c.drivers.reduce((a, d) => a + d.cash_trips, 0),
    String(c.total_cash_trips));
}

/* ── receivables ─────────────────────────────────────────────────────────── */
{
  const r = await get(`/api/settlement/receivables?${W}`);
  const kinds = new Set(r.rows.map((x) => x.settlement_class));
  check('room and hotel charges are receivable', kinds.has('on_account'));
  check('a salary posting is receivable from the employee, not the property',
    r.rows.some((x) => x.settlement_class === 'salary' && /Driver/.test(x.counterparty)));
  check('cash is not a receivable', !kinds.has('cash'));
  check('each debt carries an age', r.rows.every((x) => x.age_days != null));
  // Same rule, and the higher stakes: somebody reconciles against this.
  check('the counterparty count is its own number, not the length of the list',
    typeof r.counterparties === 'number' && r.counterparties === r.rows.length,
    `${r.counterparties} vs ${r.rows.length}`);
  check('the oldest debt is over the whole table, not the visible rows',
    r.oldest_days != null && r.oldest_days >= Math.max(...r.rows.map((x) => x.age_days ?? 0)),
    `${r.oldest_days} vs ${Math.max(...r.rows.map((x) => x.age_days ?? 0))}`);
  check('bookings carrying no fare are counted apart from the amount',
    typeof r.priced_trips === 'number' && r.priced_trips <= r.total_trips,
    `${r.priced_trips} of ${r.total_trips}`);
  check('the outstanding total covers every receivable booking, not the page',
    r.total_trips === r.rows.reduce((a, x) => a + x.trips, 0), String(r.total_trips));
}

/* ── the corporate channel ───────────────────────────────────────────────── */
{
  const s = await get(`/api/corporate/summary?${W}`);
  check('bookings count the hotel channel only', s.bookings === 52, String(s.bookings));
  check('complimentary rides are excluded from revenue', s.revenue === 48 * 100 + 40 + 55, String(s.revenue));
  check('the average fare is over priced, non-complimentary bookings',
    s.avg_fare === Math.round((4800 + 95) / 50 * 100) / 100, String(s.avg_fare));
  check('the approach leg is reported with how much of it was measured',
    s.deadhead_measured_pct != null && s.deadhead_measured_pct < 100, String(s.deadhead_measured_pct));
  check('client concentration is a number, not an impression',
    s.concentration_hhi > 3000 && s.concentration_hhi <= 10000, String(s.concentration_hhi));
  check('the largest property is named with its share',
    s.top_property === 'Palm Grand' && s.top_property_share_pct > 50,
    `${s.top_property} ${s.top_property_share_pct}`);
  check('a malformed boolean in the payload does not break the view', s.bookings > 0);
}

/* ── properties and one property's page ──────────────────────────────────── */
{
  const props = await get(`/api/corporate/properties?${W}`);
  check('properties are listed largest first', props[0].bookings >= props[1].bookings);
  check('repeat business is expressed per property',
    props.every((p) => p.bookings_per_guest == null || p.bookings_per_guest >= 1));
  const one = await get(`/api/corporate/property?${W}&id=h1`);
  check('a property page resolves by id', one.profile?.bookings > 0, JSON.stringify(one.profile));
  check('a property page carries its own daily series, mix and guests',
    one.daily.length && one.types.length && one.payments.length && one.guests.length);
  const missing = await fetch(`http://127.0.0.1:${port}/api/corporate/property?${W}&id=nope`);
  check('an unknown property is a 404, not an empty page', missing.status === 404, String(missing.status));
}

/* ── passengers ──────────────────────────────────────────────────────────
   The live hotel channel issues a NEW client id per booking: 1,254 ids across
   1,254 bookings, none repeated. A repeat rate computed over that is a fact
   about the identifier and not about the customers, and reporting it as a KPI
   would have been the most confidently wrong number on the page. The endpoint
   has to detect the situation and say so. */
{
  const g = await get(`/api/corporate/guests?${W}`);
  check('passengers are identified from the payload', g.total_guests >= 8, String(g.total_guests));
  check('with a reusable id, repeat bookings are counted', g.repeat_guests > 0, String(g.repeat_guests));
  check('and the share of bookings from repeat passengers is stated', g.bookings_from_repeat_pct > 0);
  check('a reusable id is not flagged as per-booking', g.id_is_per_booking === false,
    String(g.id_is_per_booking));

  // Now the live shape: one id per booking, and nothing repeated.
  for (let i = 0; i < 40; i++) {
    await trip({ platform: 'hotel', id: `uniq${i}`, plate: 'L104', drv: 'hd0', day: 25, km: 10,
      price: 90, pay: 'pos-driver', partner: 'h3', partnerName: 'Solo House',
      raw: { client: `booking-only-${i}`, roomNumber: String(700 + (i % 3)) } });
  }
  // A day of its own, so the detection is not diluted by the reusable-id rows above.
  const g2 = await get('/api/corporate/guests?from=2026-08-25&to=2026-08-25');
  check('an id that never repeats is reported as a per-booking record',
    g2.id_is_per_booking === true, `${g2.total_guests} ids / ${g2.total_bookings} bookings`);
  check('the caveat says the repeat rate describes the identifier, not the customers',
    /about the identifier, not about the customers/.test(g2.caveat || ''), String(g2.caveat));
  check('the room number is offered as the only thing that can recur',
    Array.isArray(g2.rooms) && g2.rooms.length > 0, String(g2.rooms?.length));
  check('a room is never described as a person',
    !/guest/i.test(JSON.stringify(g2.rooms)));
}

/* ── a cost that is the fare is not a cost ────────────────────────────────
   The hotel report returns one money figure per booking. The collector wrote
   it to price AND cost, which made gross margin exactly zero on every property
   across a full year — a claim about the business that was really a claim
   about the column. */
{
  const s2 = await get(`/api/corporate/summary?${W}`);
  check('a cost equal to the fare is not reported as a cost',
    s2.cost == null || s2.has_cost === false || s2.cost !== s2.revenue,
    `cost ${s2.cost} revenue ${s2.revenue} has_cost ${s2.has_cost}`);
}

/* ── leakage ─────────────────────────────────────────────────────────────── */
{
  const l = await get(`/api/corporate/leakage?${W}`);
  const by = Object.fromEntries(l.kinds.map((k) => [k.kind, k]));
  check('rides given away are counted', by.complimentary.n === 2, String(by.complimentary.n));
  check('what the giveaway cost is stated', l.summary.foc_cost === 120, String(l.summary.foc_cost));
  check('an approach longer than the ride is flagged',
    by.deadhead_exceeds_fare.n === 1, String(by.deadhead_exceeds_fare.n));
  check('every leakage kind explains why it matters', l.kinds.every((k) => k.why && k.label));
  // 48 bookings alternate across h1/h1/h1/h2, so h1 holds 36 of them; a third
  // of those carry an authorisation. Only h1 requires one, so h2's bookings —
  // and h3's — must not be accused.
  check('a missing authorisation is only counted where the property requires one',
    by.unauthorized.n > 0 && by.unauthorized.n < 30, String(by.unauthorized.n));
  check('the count of properties that require approval is reported',
    l.summary.properties_requiring_approval === 1 && l.summary.properties === 3,
    `${l.summary.properties_requiring_approval} of ${l.summary.properties}`);
  const accused = await get(`/api/corporate/leakage?${W}&kind=unauthorized`);
  check('no booking at a property without an approval workflow is accused',
    accused.rows.every((r) => r.partner_id === 'h1'),
    [...new Set(accused.rows.map((r) => r.partner_id))].join(','));
  check('a giveaway is measured in the units this channel actually reports',
    l.summary.foc_km != null || l.summary.foc_cost != null, JSON.stringify(l.summary));
  const rows = await get(`/api/corporate/leakage?${W}&kind=deadhead_exceeds_fare`);
  check('a leakage kind opens onto the named, dated bookings behind it',
    rows.rows.length === 1 && rows.rows[0].external_id === 'hd_bad', JSON.stringify(rows.rows[0]?.external_id));
  check('an unknown leakage kind returns no rows rather than all of them',
    (await get(`/api/corporate/leakage?${W}&kind=;drop`)).rows.length === 0);
}

/* ── the unpaid approach leg ─────────────────────────────────────────────── */
{
  const a = await get(`/api/corporate/approach?${W}&by=property`);
  check('the approach leg is broken down by property', a.length >= 2);
  check('a group with nothing measured is left out rather than shown as zero',
    a.every((r) => r.measured > 0));
  check('approach km is expressed against paid km', a.every((r) => r.ratio_pct != null));
  check('the breakdown dimension is allowlisted',
    JSON.stringify(await get(`/api/corporate/approach?${W}&by=;drop table trip`)).length > 2);
}

/* ── product tiers ───────────────────────────────────────────────────────── */
{
  const t = await get(`/api/tiers/by-vehicle?${W}`);
  const l900 = t.vehicles.find((v) => v.plate === 'L900');
  const l901 = t.vehicles.find((v) => v.plate === 'L901');
  check('premium share is per vehicle', l900.premium_pct === 0 && l901.premium_pct === 60,
    `${l900.premium_pct} / ${l901.premium_pct}`);
  check('a car is compared against its own model, not the fleet average',
    l900.model_key === 'Lexus ES' && l900.premium_gap_pct === 60, JSON.stringify(l900.premium_gap_pct));
  check('the car already carrying the premium work is not accused of a shortfall',
    l901.premium_gap_pct === null, String(l901.premium_gap_pct));
  check('tier analysis carries no invented revenue',
    !('revenue' in l900) && !('avg_fare' in l900), Object.keys(l900).join(','));
  const mix = await get(`/api/tiers/mix?${W}&by=daypart`);
  check('tier mix is available by daypart', mix.length > 0 && mix[0].tier);
}

/* ── coverage: a hole is not a quiet week ────────────────────────────────── */
{
  const c = await get(`/api/coverage/calendar?${W}`);
  const y = c.sources.find((s) => s.source === 'yango');
  check('a source with two days of data and eight missing between them shows the gap',
    y.missing_days === 8, String(y.missing_days));
  check('the gap is dated, not just counted',
    y.gaps[0]?.from === '2026-08-02' && y.gaps[0]?.to === '2026-08-09', JSON.stringify(y.gaps[0]));
  check('no gap is claimed before a source started collecting',
    !y.gaps.some((g) => g.from < y.first_day), JSON.stringify(y.gaps));
  const u = c.sources.find((s) => s.source === 'uber');
  check('a source collecting every day reports no hole', u.missing_days === 0, String(u.missing_days));
}

/* ── corridors ───────────────────────────────────────────────────────────── */
{
  const c = await get(`/api/geo/corridors?${W}`);
  check('a corridor is keyed on the community, not the street number',
    c.corridors.some((r) => r.from_area === 'Al Thanyah Fifth' && r.to_area === 'Business Bay'),
    JSON.stringify(c.corridors[0]));
  check('the airport run is visible as its own corridor',
    c.corridors.some((r) => r.to_area === 'Dubai Airport'));
  check('the response says the area was parsed, not looked up', /parsed from the address/.test(c.note));
  check('origins carry the morning and evening split',
    c.origins.every((o) => o.morning != null && o.evening != null));
}

/* ── the acceptance funnel ───────────────────────────────────────────────── */
{
  const f = await get(`/api/funnel/drivers?${W}`);
  const y = f.find((r) => r.platform === 'yango');
  check('offers, acceptances and completions are separate numbers',
    y.offered === '200' || +y.offered === 200, String(y.offered));
  check('acceptance is over offers and completion is over acceptances',
    y.accept_pct === 75 && y.complete_pct === 80, `${y.accept_pct} / ${y.complete_pct}`);
  check('platform commission is reported as a positive cost', y.commission_cost === 800, String(y.commission_cost));
  check('the cash share of gross is stated', y.cash_pct === 75, String(y.cash_pct));
  check('a non-numeric value in the payload is null, not a crash',
    f.find((r) => r.platform === 'bolt')?.driver_score == null);
}


/* ── one source dark is a bug; every source dark is a fact ────────────────
   A gap in one provider means the collector failed and the fix is to re-run
   it. The same gap in two independent providers, over the same days, resuming
   on the same day, means the fleet was not working and the fix is to stop
   trying. The live data has exactly that shape: Uber dark 2025-10-23 to
   2026-02-22, FMS dark 2025-09-21 to 2026-02-22, both resuming on the same
   day. An Uber report API and a telematics box do not share an outage.

   The two readings lead to opposite actions, so the distinction has to be made
   by the endpoint rather than left to whoever is looking at the calendar. */
{
  await q(`DELETE FROM trip`);
  let sn = 0;
  const mk = (platform, day) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_name, requested_at, status, distance_km)
     VALUES ($1, $2, 'ecosine', 'L1', 'D', $3, 'completed', 10)`,
    [platform, `sq${sn++}`, `${day}T10:00:00+04:00`]);

  // Both sources run 01-05, both dark 06-12, both back 13-16.
  for (const d of ['01', '02', '03', '04', '05', '13', '14', '15', '16']) {
    await mk('uber', `2026-06-${d}`);
    await mk('bolt', `2026-06-${d}`);
  }
  // A third source is dark 20-24 ALONE, while uber keeps reporting.
  for (const d of ['17', '18', '19', '20', '21', '22', '23', '24']) await mk('uber', `2026-06-${d}`);
  for (const d of ['17', '18', '19', '25']) await mk('hotel', `2026-06-${d}`);

  const cov = await get('/api/coverage/calendar?from=2026-06-01&to=2026-06-25');
  const shared = cov.shared_silence || [];
  check('a window where every source went quiet at once is reported',
    shared.length === 1, JSON.stringify(shared));
  check('it names the days, not just the length',
    shared[0]?.from === '2026-06-06' && shared[0]?.to === '2026-06-12',
    `${shared[0]?.from}..${shared[0]?.to}`);
  check('it names which sources were dark together',
    (shared[0]?.sources || []).join(',') === 'bolt,uber', String(shared[0]?.sources));
  check('the window length is counted', shared[0]?.days === 7, String(shared[0]?.days));

  /* The false positive that would make this useless: one source dark while
     another is reporting normally is a collection failure, not a quiet fleet,
     and must NOT appear here. */
  check('a single source going dark alone is NOT reported as fleet-wide silence',
    !shared.some((g) => g.from >= '2026-06-20' && g.to <= '2026-06-24'),
    JSON.stringify(shared));

  /* And the days are still counted as missing per source, because from the
     collector's point of view they genuinely were not collected. Reporting
     them twice with two different meanings is the point. */
  const uber = cov.sources.find((s2) => s2.source === 'uber');
  check('the shared window is still counted in the source’s own missing days',
    uber.missing_days >= 7, String(uber.missing_days));

  /* A source with no span at all cannot be "dark inside its span", and a
     one-day source has no interior. Neither may drag a window into the
     shared-silence list. */
  await q(`DELETE FROM trip WHERE platform = 'hotel'`);
  await mk('yango', '2026-06-11');
  const cov2 = await get('/api/coverage/calendar?from=2026-06-01&to=2026-06-25');
  check('a source that reported on exactly one day is not treated as having a span',
    (cov2.shared_silence || []).every((g) => !(g.sources || []).includes('yango')),
    JSON.stringify(cov2.shared_silence));
  /* And that single yango row falls INSIDE the shared window, so the window is
     no longer a day nothing was seen — it must break. */
  check('a window stops being fleet-wide silence the moment anything is seen in it',
    !(cov2.shared_silence || []).some((g) => g.from <= '2026-06-11' && g.to >= '2026-06-11'),
    JSON.stringify(cov2.shared_silence));
}


/* ── the half of the empty running nobody was measuring ───────────────────
   deadhead_km is the APPROACH leg: driver start to pickup. The hotel API also
   returns driverEndLat/driverEndLon on most bookings — where the driver
   actually was when the job closed — and it was never stored. So every
   deadhead figure in this product described half the unpaid distance, and the
   forgivable half: sending a car 5 km to collect somebody is the cost of doing
   the job; leaving a driver 30 km from the next one is not.

   The rule that matters here is that the two are never silently added. A
   measured approach plus an unmeasured return, divided by every booking, is a
   confident understatement — which is precisely what the single-leg version
   was. */
{
  await q(`DELETE FROM trip`);
  let dn = 0;
  const leg = (partner, dist, out2, back) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_name, partner_name,
       requested_at, status, distance_km, price, payment_type, deadhead_km, return_deadhead_km,
       dropoff_addr)
     VALUES ('hotel', $1, 'ecosine', 'L1', 'D', $2, '2026-08-10T10:00:00+04:00', 'completed',
             $3, 100, 'room-charge', $4, $5, $6)`,
    [`dh${dn++}`, partner, dist, out2, back, `${partner} Gate, Dubai - UAE`]);

  // Alpha: both legs on every booking, and the return is the LARGER one.
  for (let i = 0; i < 4; i++) await leg('Alpha', 20, 3, 9);
  // Beta: approach measured, return never reported.
  for (let i = 0; i < 4; i++) await leg('Beta', 20, 5, null);
  // Gamma: one booking ends a very long way from anywhere.
  await leg('Gamma', 10, 2, 42);
  await leg('Gamma', 10, 2, 3);
  await leg('Gamma', 10, 2, 3);

  const rows = await get(`/api/corporate/approach?from=2026-08-01&to=2026-08-31&by=property`);
  const alpha = rows.find((r) => r.label === 'Alpha');
  const beta = rows.find((r) => r.label === 'Beta');

  check('the return leg is reported as its own number',
    Number(alpha.return_km) === 36, String(alpha.return_km));
  check('and it can exceed the approach, which is why omitting it understated everything',
    Number(alpha.return_km) > Number(alpha.deadhead_km),
    `${alpha.return_km} vs ${alpha.deadhead_km}`);
  check('a booking measured on only one leg is counted on that leg alone',
    beta.measured === 4 && beta.measured_return === 0,
    `${beta.measured} / ${beta.measured_return}`);
  check('a combined total is only computed where BOTH legs were measured',
    beta.measured_both === 0 && (beta.both_km == null || Number(beta.both_km) === 0),
    `${beta.measured_both} / ${beta.both_km}`);
  check('the combined ratio is null rather than an understatement when a leg is missing',
    beta.both_ratio_pct == null, String(beta.both_ratio_pct));
  check('where both legs exist the combined total is their sum',
    Number(alpha.both_km) === 48, String(alpha.both_km));
  check('the combined ratio is over paid distance on those same bookings',
    Number(alpha.both_ratio_pct) === 60, String(alpha.both_ratio_pct));
  check('a job that ends far from anywhere is counted, not averaged away',
    rows.find((r) => r.label === 'Gamma').stranded_15km === 1,
    String(rows.find((r) => r.label === 'Gamma').stranded_15km));

  /* And the operational counterpart: which drop-off points cost the most to
     walk away from. A short paid trip ending somewhere remote is worse than a
     long one ending on a rank, and no per-property average can show it. */
  const strand = await get(`/api/corporate/stranding?from=2026-08-01&to=2026-08-31`);
  check('drop-off points are ranked by how far the driver had to go afterwards',
    strand.length >= 1 && strand[0].place.startsWith('Gamma'),
    JSON.stringify(strand.map((x) => x.place)));
  check('the worst single return is kept, not just the average',
    Number(strand[0].worst_km) === 42, String(strand[0].worst_km));
  check('a drop-off area with too few measured returns is left out rather than ranked on one trip',
    !strand.some((x) => x.measured < 3), JSON.stringify(strand.map((x) => x.measured)));
}


/* ── "we asked and got nothing" is not "we never asked" ───────────────────
   These look identical on a calendar and lead to opposite actions. The live
   case: FMS is dark for 155 days over a period Uber shows as busy, which reads
   as a broken collector — and the chunk records say every window covering it
   was requested and came back with zero rows and no error. The provider was
   asked and answered nothing, so that hole is the date the telematics boxes
   started reporting, and re-running the collector will never change it.

   A window that ERRORED is a different thing again and stays an open
   question. */
{
  await q(`DELETE FROM trip`);
  await q(`DELETE FROM collection_run`);
  let gn = 0;
  const day = (plat, d) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_name, requested_at, status, distance_km)
     VALUES ($1, $2, 'ecosine', 'L1', 'D', $3, 'completed', 10)`,
    [plat, `g${gn++}`, `${d}T10:00:00+04:00`]);

  // asked: data on the 1st and the 20th, nothing between.
  await day('asked', '2026-06-01'); await day('asked', '2026-06-20');
  // failed: same shape.
  await day('failed', '2026-06-01'); await day('failed', '2026-06-20');
  // silent: same shape, and no chunk record at all.
  await day('silent', '2026-06-01'); await day('silent', '2026-06-20');

  const run = (source, chunks) => q(
    `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at, detail)
     VALUES ($1, 'ecosine', 'backfill', 'ok', 0, now(), $2::jsonb)`,
    [source, JSON.stringify({ chunks })]);
  await run('asked', [{ from: '2026-05-25', to: '2026-06-25', rows: 0, error: null }]);
  await run('failed', [{ from: '2026-05-25', to: '2026-06-25', rows: 0, error: 'timeout after 600s' }]);

  const cov = await get('/api/coverage/calendar?from=2026-06-01&to=2026-06-25');
  const by = Object.fromEntries(cov.sources.map((x) => [x.source, x]));

  check('a gap the provider answered with nothing is marked as answered',
    by.asked.gaps[0]?.verdict === 'asked_and_empty', String(by.asked.gaps[0]?.verdict));
  check('a gap whose request failed is a different verdict, and still an open question',
    by.failed.gaps[0]?.verdict === 'window_failed', String(by.failed.gaps[0]?.verdict));
  check('a gap nobody ever requested is neither of the above',
    by.silent.gaps[0]?.verdict === 'never_asked', String(by.silent.gaps[0]?.verdict));
  check('the days are totalled per verdict, so the page can say what to do',
    by.asked.gaps_asked_and_empty === by.asked.missing_days
    && by.asked.gaps_never_asked === 0,
    `${by.asked.gaps_asked_and_empty} / ${by.asked.gaps_never_asked} of ${by.asked.missing_days}`);
  check('a failed window is never counted as an answer',
    by.failed.gaps_asked_and_empty === 0 && by.failed.gaps_window_failed > 0,
    `${by.failed.gaps_asked_and_empty} / ${by.failed.gaps_window_failed}`);

  /* A chunk that only PARTLY covers a gap does not answer it. Claiming a hole
     is answered because one of its days was requested is exactly the kind of
     confident wrong statement this whole endpoint exists to avoid. */
  await q(`DELETE FROM collection_run WHERE source = 'asked'`);
  await run('asked', [{ from: '2026-06-02', to: '2026-06-10', rows: 0, error: null }]);
  const cov2 = await get('/api/coverage/calendar?from=2026-06-01&to=2026-06-25');
  const partial = cov2.sources.find((x) => x.source === 'asked');
  check('a window covering only part of a gap does not count as having answered it',
    partial.gaps[0]?.verdict === 'never_asked', String(partial.gaps[0]?.verdict));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
