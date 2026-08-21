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
import express from 'express';
import { readFileSync } from 'node:fs';
import { analyticsRoutes } from '../api/analytics_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
                 'schema_v6.sql', 'schema_v7.sql', 'schema_v9.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

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

/* ── guests ──────────────────────────────────────────────────────────────── */
{
  const g = await get(`/api/corporate/guests?${W}`);
  check('guests are identified from the payload', g.total_guests >= 8, String(g.total_guests));
  check('repeat guests are counted', g.repeat_guests > 0, String(g.repeat_guests));
  check('the share of bookings that came from repeat guests is stated',
    g.bookings_from_repeat_pct > 0);
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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
