/* #feeds' CABMAN table — the seat sensor held against the car's own movement
   and its bookings (GET /api/vehicles/feeds/cabman).
   ─────────────────────────────────────────────────────────────────────────
   Asked for on 2026-10-20 after an audit of the 46 cars on CABMAN's list
   found the pad reading occupied during only 68% of their bookings, five
   pads reading nobody all week, a unit silent since 2024 on a working car,
   and a unit standing still through its car's bookings. Every verdict the
   table prints is a claim about a device in a car somebody will be asked to
   check, so this seeds one synthetic car per verdict and runs the real route
   over a real Postgres, pinning:
     - which cars: CABMAN's roster members only — never a plate it stopped
       listing or has not yet listed often enough — and, with no roster
       written, the cars with a CABMAN reading in the window, said so;
     - movement along CABMAN's OWN readings: an FMS fix on the same plate,
       a 70 km jump and a 35-minute gap add nothing;
     - bookings: completed, on a booking channel, in the window — an FMS
       journey, a cancelled booking and one from nine days ago are not;
     - each verdict and its sentence, and the order (a silent unit on a
       working car first, a silent unit on an idle car last);
     - absent, never zero: a unit with no seat value has no passenger
       distance and is "sends no seat reading", not "reads nobody";
     - a reading dated in the future is not the unit's newest reading;
     - the plates CABMAN stopped listing, counted, with whether any was ours.
   All data is synthetic: Q-prefixed plates nobody registers. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { CAB_DAYS, CAB_GAP_MIN, CAB_HOP_KM, cabmanSeat, hotelEndMs } from '../api/feed_routes.js';
import { bookingWindow } from '../src/reconcile.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p);

const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const fix = (plate, min, { lat = 25.2, lng = 55.3, speed = 40, seat = false, status = null, source = 'cabman', fleet = 'ecosine' } = {}) => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status, seat_occupied)
   VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)`,
  [source, fleet, plate, ago(min), lat, lng, speed, status ?? (seat === true ? 'Engaged' : 'Active'), seat]);
let nTrip = 0;
const book = (plate, fromMin, toMin, { platform = 'uber', status = 'completed', km = 6, fleet = 'ecosine' } = {}) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, distance_km, status)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [platform, `t-${++nTrip}`, fleet, plate, ago(fromMin), ago(toMin), km, status]);
/* A booking of 20 minutes `startMin` ago, with a CABMAN reading every five
   minutes inside it that moves 0.01° of latitude (≈1.1 km) a reading unless
   `still`, the seat reading `seat`. Returns the km the readings span. */
const R = 6371, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b - a) / 2) ** 2));
const ride = async (plate, startMin, { seat = true, still = false, fleet = 'ecosine', km = 6, platform = 'uber', lat0 = 25.2 } = {}) => {
  for (let k = 0; k <= 4; k++) await fix(plate, startMin - k * 5, { lat: still ? lat0 : lat0 + k * 0.01, seat, fleet, speed: still ? 0 : 40 });
  await book(plate, startMin, startMin - 20, { fleet, km, platform });
  return still ? 0 : 4 * hav(0, 0.01);
};

/* ── CABMAN's roster, as src/sources/cabman.js writes it ─────────────────── */
const roster = async (fleet, plates) => q(
  `INSERT INTO source_state (source, fleet_id, key, value) VALUES ('cabman', $1, 'roster', $2)`,
  [fleet, JSON.stringify({ polls: 500, plates })]);
const member = { admitted: true, departed: false };
await roster('ecosine', {
  QA0001: member, QB0001: member, QC0001: member, QE0001: member, QF0001: member, QG0001: member, QH0001: member,
  QX0001: { admitted: true, departed: true, last_seen: ago(60 * 24 * 5), departed_at: ago(60 * 24 * 4) },
  QX0002: { admitted: true, departed: true, last_seen: ago(60 * 24 * 5), departed_at: ago(60 * 24 * 4) },
  QP0001: { admitted: false, departed: false },
});
await roster('egari', { QD0001: member });

/* A — the pad working: four bookings, the seat occupied through each. Then
   three readings the walk must refuse: a 70 km jump inside five minutes and
   a step after a 35-minute silence. And FMS readings on the same plate far
   away, which are another tracker's and must add nothing. */
let kmA = 0;
for (const h of [11, 8, 5, 2]) kmA += await ride('QA0001', h * 60);
await fix('QA0001', 60, { lat: 25.0 });
await fix('QA0001', 55, { lat: 25.7 });
await fix('QA0001', 20, { lat: 25.71 });
for (const m of [600, 595, 590]) await fix('QA0001', m, { source: 'fms', lat: 24.0 + m / 1000, seat: null });
/* B — reads nobody: four bookings driven, the seat empty through each, and
   one occupied reading outside every booking. */
for (const h of [11, 8, 5, 2]) await ride('QB0001', h * 60, { seat: false });
await fix('QB0001', 30, { seat: true, lat: 26 });
/* C — misses passengers: occupied during two of five. */
for (const [i, h] of [12, 10, 8, 6, 4].entries()) await ride('QC0001', h * 60, { seat: i < 2 });
/* D (Egari) — the unit stood still through three bookings of 6 km. */
for (const h of [9, 6, 3]) await ride('QD0001', h * 60, { still: true, fleet: 'egari' });
/* E — silent three days, while two bookings were completed today; one
   reading eight days ago is outside the window. */
await fix('QE0001', 60 * 72, { lat: 25.3 });
await fix('QE0001', 60 * 72 - 5, { lat: 25.31 });
await fix('QE0001', 60 * 24 * 8, { lat: 25.4 });
await book('QE0001', 300, 280, { platform: 'hotel' });
await book('QE0001', 200, 180, { platform: 'hotel' });
/* F — moving, nothing to check against: its FMS journey is the tracker's own
   record, its cancelled booking was not a ride, and its last booking was nine
   days ago. A reading dated tomorrow is a clock running ahead. */
for (let k = 0; k <= 6; k++) await fix('QF0001', 400 - k * 5, { lat: 25.5 + k * 0.01 });
await fix('QF0001', -60 * 24, { lat: 25.6 });
await book('QF0001', 390, 370, { platform: 'fms' });
await book('QF0001', 380, 375, { status: 'rider_cancelled' });
await book('QF0001', 60 * 24 * 9, 60 * 24 * 9 - 20);
/* G — silent forty days, no booking: an idle car, so it goes last. */
await fix('QG0001', 60 * 24 * 40, { lat: 25.8 });
/* H — readings arrive, none carries a seat value; three bookings. */
for (const h of [9, 6, 3]) {
  for (let k = 0; k <= 4; k++) await fix('QH0001', h * 60 - k * 5, { lat: 25.9 + k * 0.01, seat: null });
  await book('QH0001', h * 60, h * 60 - 20);
}
/* The departed QX0001 had a booking with us once; QX0002 never did. */
await book('QX0001', 60 * 24 * 20, 60 * 24 * 20 - 20);

const { get } = await mountAll(db, { serverRoutes: false });
const res = await get('/api/vehicles/feeds/cabman');
const d = res.body || {};
const by = Object.fromEntries((d.rows || []).map((r) => [r.plate, r]));

console.log('\n1. which cars');
check('the route answers', res.status === 200, String(res.status));
check('CABMAN’s roster members, both fleets — never a departed or a not-yet-admitted plate',
  JSON.stringify(Object.keys(by).sort()) === JSON.stringify(['QA0001', 'QB0001', 'QC0001', 'QD0001', 'QE0001', 'QF0001', 'QG0001', 'QH0001']),
  JSON.stringify(Object.keys(by)));
check('the basis is the roster, and the window is a week', d.roster?.known === true && d.roster.basis === 'roster' && d.days === CAB_DAYS && CAB_DAYS === 7);
check('each car carries its fleet', by.QD0001?.fleet_id === 'egari' && by.QA0001?.fleet_id === 'ecosine');

console.log('\n2. movement, along CABMAN’s own readings');
check(`A: the four bookings' readings, ${kmA.toFixed(1)} km — not the 70 km jump, not the step after ${CAB_GAP_MIN}+ minutes, not FMS's readings`,
  Math.abs(by.QA0001.km - Math.round(kmA * 10) / 10) < 0.11 && CAB_HOP_KM === 60, String(by.QA0001?.km));
check('A: every kilometre of it with the seat occupied, measured from the occupied reading before each step',
  by.QA0001.occupied_km === by.QA0001.km && by.QA0001.occupied_km_pct === 100, JSON.stringify([by.QA0001.occupied_km, by.QA0001.occupied_km_pct]));
check('D: stood still — 0 km, and "moved on 0 days"', by.QD0001.km === 0 && by.QD0001.days_moved === 0, JSON.stringify([by.QD0001.km, by.QD0001.days_moved]));
check('E: its readings three days ago count, the one eight days ago does not', by.QE0001.readings === 2, String(by.QE0001.readings));
check('F: a reading dated tomorrow is not its newest reading', Date.parse(by.QF0001.last_at) <= Date.now(), by.QF0001.last_at);
check('G: no reading in the window — no distance measured, absent rather than 0, and the reason', by.QG0001.km === null && by.QG0001.days_moved === null
  && by.QG0001.km_reason === 'no CABMAN reading in 7 days', JSON.stringify([by.QG0001.km, by.QG0001.days_moved, by.QG0001.km_reason]));

console.log('\n3. bookings');
check('A: four completed Uber bookings, the seat occupied during all four', by.QA0001.bookings.total === 4
  && by.QA0001.bookings.read === 4 && by.QA0001.bookings.seat_seen === 4 && by.QA0001.bookings.platforms.uber === 4,
  JSON.stringify(by.QA0001.bookings));
check('F: the FMS journey, the cancelled booking and the one nine days ago are not bookings to check', by.QF0001.bookings.total === 0,
  JSON.stringify(by.QF0001.bookings));
check('E: two hotel bookings, no reading inside either', by.QE0001.bookings.total === 2 && by.QE0001.bookings.read === 0
  && by.QE0001.bookings.no_reading === 2 && by.QE0001.bookings.platforms.hotel === 2, JSON.stringify(by.QE0001.bookings));
check('D: standing still through all three bookings of 6 km', by.QD0001.bookings.standing_still === 3, JSON.stringify(by.QD0001.bookings));
check('H: readings inside its bookings but no seat value — not bookings the pad can be judged on', by.QH0001.bookings.read === 0
  && by.QH0001.bookings.no_reading === 3, JSON.stringify(by.QH0001.bookings));

console.log('\n4. verdicts, and the sentence true of each');
const V = Object.fromEntries(Object.entries(by).map(([p, r]) => [p, r.verdict]).sort(([x], [y]) => x.localeCompare(y)));
check('A working, B reading nobody, C missing passengers, D not moving with the car, E and G silent, F nothing to check, H no seat reading',
  JSON.stringify(V) === JSON.stringify({ QA0001: 'ok', QB0001: 'pad_dead', QC0001: 'pad_misses', QD0001: 'elsewhere',
    QE0001: 'silent', QF0001: 'no_bookings', QG0001: 'silent', QH0001: 'no_seat' }), JSON.stringify(V));
check('A: "the seat read occupied during 4 of 4 bookings"', by.QA0001.verdict_text === 'the seat read occupied during 4 of 4 bookings', by.QA0001.verdict_text);
check('B: never during any of its 4 bookings, and its one occupied reading named as outside them',
  /never read occupied during any of 4 bookings — the pad is not reporting passengers/.test(by.QB0001.verdict_text)
  && by.QB0001.notes.some((n) => /read occupied 1 time in the window, never during a booking/.test(n)),
  JSON.stringify([by.QB0001.verdict_text, by.QB0001.notes]));
check('C: "only 2 of 5"', by.QC0001.verdict_text === 'the seat read occupied during only 2 of 5 bookings' && by.QC0001.bookings.seat_pct === 40,
  by.QC0001.verdict_text);
check('D: the unit may be in, or filed under, another car', /standing still through 3 of the 3 bookings long enough to measure — the unit may be fitted to, or filed under, another car/.test(by.QD0001.verdict_text),
  by.QD0001.verdict_text);
check('E: silent — and the car worked while it was: two bookings since its last reading', /no CABMAN reading in the last 24 hours — the unit is silent, while the car completed 2 bookings since its last reading/.test(by.QE0001.verdict_text)
  && by.QE0001.receiving === false, by.QE0001.verdict_text);
check('H: a unit with no seat value is "no pad reported", never "reads nobody", and has no passenger distance',
  /none carries a seat value — CABMAN reports no pad on this car/.test(by.QH0001.verdict_text)
  && by.QH0001.occupied_km === null && by.QH0001.seat_readings === 0 && by.QH0001.occupied_pct === null,
  JSON.stringify([by.QH0001.verdict_text, by.QH0001.occupied_km]));
const order = (d.rows || []).map((r) => r.plate);
check('worst first: the silent unit on a working car leads, the silent unit on an idle car is last',
  order[0] === 'QE0001' && order[order.length - 1] === 'QG0001' && order.indexOf('QD0001') < order.indexOf('QH0001')
  && order.indexOf('QH0001') < order.indexOf('QB0001') && order.indexOf('QB0001') < order.indexOf('QC0001')
  && order.indexOf('QC0001') < order.indexOf('QA0001'), JSON.stringify(order));
/* 21 bookings: A 4, B 4, C 5, D 3, E 2, H 3. With a seat reading inside:
   A, B, C and D's 16 (E has no reading, H no seat value); occupied during
   A's 4, C's 2 and D's 3 — D's pad reads a passenger in a car standing still. */
check('totals: the verdicts counted, and the seat during 9 of the 16 bookings with a seat reading',
  d.totals.cars === 8 && d.totals.verdicts.silent === 2 && d.totals.verdicts.ok === 1 && d.totals.verdicts.no_seat === 1
  && d.totals.bookings === 21 && d.totals.bookings_read === 16 && d.totals.bookings_seat_seen === 9, JSON.stringify(d.totals));

console.log('\n5. the plates CABMAN stopped listing');
check('two departed, one of which once had a booking with us — counted, never silently dropped',
  d.departed?.plates === 2 && d.departed.with_bookings === 1 && d.departed.groups?.[0]?.plates === 2, JSON.stringify(d.departed));

console.log('\n6. no roster written yet');
await q(`DELETE FROM source_state WHERE source = 'cabman'`);
const res2 = await get(`/api/vehicles/feeds/cabman?_=no-roster-${Date.now()}`);
const d2 = res2.body || {};
const p2 = (d2.rows || []).map((r) => r.plate).sort();
check('the cars with a CABMAN reading in the window stand in — G, silent forty days, is not one — and the answer says so',
  d2.roster?.known === false && d2.roster.basis === 'readings' && /has not been read yet/.test(d2.roster.basis_reason || '')
  && JSON.stringify(p2) === JSON.stringify(['QA0001', 'QB0001', 'QC0001', 'QD0001', 'QE0001', 'QF0001', 'QH0001']),
  JSON.stringify([d2.roster, p2]));

console.log('\n7. the function the mock runs is the function the route runs');
const mockShape = cabmanSeat({ rosterRows: [], now: new Date().toISOString() });
check('an empty week answers with every key the page reads', ['as_of', 'days', 'window_hours', 'roster', 'rules', 'totals', 'departed', 'rows']
  .every((k) => k in mockShape) && mockShape.rows.length === 0, JSON.stringify(Object.keys(mockShape)));

/* ── 8. what the independent review of 2026-10-20 found ──────────────────
   Eleven defects, five of them sentences that were false for an input the
   code accepted. Each is pinned here on the function itself, one car per
   case, so they cannot disturb the scenario above. */
console.log('\n8. the review of 2026-10-20');
const NOW = Date.parse('2026-10-20T06:00:00Z');              // 10:00 Dubai, not midnight
const at = (min) => new Date(NOW - min * 60e3).toISOString();
const run = (fixes, bookings, { last = null, rosters = null } = {}) => {
  const plates = [...new Set([...fixes, ...bookings].map((x) => x.plate))];
  const lastRows = last || plates.map((p) => {
    const mine = fixes.filter((f) => f.plate === p).sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
    return { plate: p, captured_at: mine[0]?.captured_at ?? null, status: 'Active', speed: 0 };
  });
  return cabmanSeat({ rosterRows: rosters || [{ fleet_id: 'ecosine', value: JSON.stringify({ plates: Object.fromEntries(plates.map((p) => [p, { admitted: true, departed: false }])) }) }],
    last: lastRows, fixes, bookings, now: new Date(NOW).toISOString(), days: 7 });
};
const F = (plate, min, lat, seat = true, lng = 55.3) => ({ plate, captured_at: at(min), lat, lng, speed: 30, status: seat ? 'Engaged' : 'Active', seat_occupied: seat });
const B = (plate, from, to, km = 6, platform = 'uber') => ({ plate, platform, requested_at: at(from), ended_at: at(to), distance_km: km });
{
  /* 1. A car that drove every day: the window is 7 × 24 hours and touches 8
     Dubai dates at 10:00 — it moved on 7 of the last 7 days, never "8 of 7". */
  const fx = [];
  for (const m of [10, 1450, 2890, 4330, 5770, 7210, 8650, 10070]) fx.push(F('QJ0001', m, 25.2), F('QJ0001', m - 5, 25.21));
  const r = run(fx, []).rows[0];
  check('1. moved on 7 of the last 7 days — never more days than the window holds', r.days_moved === 7, String(r.days_moved));
}
{
  /* 2. Silent 26 hours, after a week of bookings the pad read: a parked car.
     No "while the car completed" — none came after the last reading — and it
     goes to the bottom with the idle ones. */
  const fx = []; const bk = [];
  for (let k = 2; k <= 6; k++) { fx.push(F('QK0001', k * 1440, 25.2), F('QK0001', k * 1440 - 5, 25.21)); bk.push(B('QK0001', k * 1440 + 2, k * 1440 - 6)); }
  const lastK = [{ plate: 'QK0001', captured_at: at(26 * 60), status: 'Active', speed: 0 }];
  const r = run(fx, bk, { last: lastK }).rows[0];
  check('2. a unit silent since the car was parked names no booking it missed, and ranks with the idle',
    r.verdict === 'silent' && !/while the car/.test(r.verdict_text) && r.bookings.since_last_reading === 0 && r.rank === 9,
    JSON.stringify([r.verdict_text, r.bookings.since_last_reading, r.rank]));
}
{
  /* 3. A unit with no seat value standing still through three bookings: the
     share is of the bookings it was measured on — "3 of 3", never "3 of 0". */
  const fx = []; const bk = [];
  for (const h of [9, 6, 3]) { for (let k = 0; k <= 4; k++) fx.push({ ...F('QL0001', h * 60 - k * 5, 25.2, null), speed: 0 }); bk.push(B('QL0001', h * 60, h * 60 - 20)); }
  const r = run(fx, bk).rows[0];
  check('3. standing still "through 3 of the 3 bookings long enough to measure" — the denominator is the bookings measured',
    r.verdict === 'elsewhere' && /standing still through 3 of the 3 bookings long enough to measure/.test(r.verdict_text) && r.bookings.still_checked === 3,
    r.verdict_text);
}
{
  /* 4. Readings 30 minutes apart: no step the walk accepts, so no distance was
     MEASURED — absent with that reason, not "did not move", not "0 km". */
  const fx = []; for (let k = 0; k < 10; k++) fx.push(F('QM0001', 300 - k * 30, 25.2 + k * 0.05));
  const r = run(fx, []).rows[0];
  check('4. no measured step: km, days moved and passenger km absent, with the reason',
    r.km === null && r.days_moved === null && r.occupied_km === null && r.steps === 0
    && /no two readings within 20 minutes of each other/.test(r.km_reason || ''), JSON.stringify([r.km, r.occupied_km, r.km_reason]));
}
{
  /* 5. A unit that reports in bursts: two readings 26 minutes apart and 11 km
     apart inside each booking is not a car standing still. */
  const fx = []; const bk = [];
  for (const h of [9, 6, 3]) { fx.push(F('QN0001', h * 60 - 2, 25.2), F('QN0001', h * 60 - 28, 25.3)); bk.push(B('QN0001', h * 60, h * 60 - 30, 12)); }
  const r = run(fx, bk).rows[0];
  check('5. readings too far apart to measure a booking are never "standing still"',
    r.verdict !== 'elsewhere' && r.bookings.standing_still === 0 && r.bookings.still_checked === 0, JSON.stringify([r.verdict, r.bookings]));
}
{
  /* 5b. Found running the fixed code over production's week: three 6-minute
     hotel jobs booked at 13 km, two readings each, standing still — booking
     times too loose and a poll too coarse to call the unit "in another car". */
  const fx = []; const bk = [];
  for (const h of [9, 6, 3]) { fx.push({ ...F('QV0001', h * 60 - 1, 25.2), speed: 0 }, { ...F('QV0001', h * 60 - 5, 25.2), speed: 0 }); bk.push(B('QV0001', h * 60, h * 60 - 6, 13.41, 'hotel')); }
  const r = run(fx, bk).rows[0];
  check('5b. a booking under 10 minutes, or with under 3 readings, is not measured for standing still',
    r.verdict !== 'elsewhere' && r.bookings.still_checked === 0, JSON.stringify([r.verdict, r.bookings]));
}
{
  /* 6. Back today after four bookings with nothing inside them: not "nothing
     to check against" — the unit was not reporting while the car worked. */
  const fx = [F('QO0001', 30, 25.2, false), F('QO0001', 25, 25.21, false)];
  const bk = [2, 3, 4, 5].map((dd) => B('QO0001', dd * 1440, dd * 1440 - 20));
  const r = run(fx, bk).rows[0];
  check('6. four bookings and no seat reading inside any: "not reporting while the car works", a red verdict ranked above the pads',
    r.verdict === 'unreported' && /4 bookings in 7 days and no seat reading fell inside any of them — the unit is not reporting while the car works/.test(r.verdict_text)
    && r.rank < 4, JSON.stringify([r.verdict, r.verdict_text, r.rank]));
}
{
  /* 7. A reading with no position between two that have one: skipped, not
     placed at (0, 0) — the drive either side of it is still measured. */
  const fx = [F('QQ0001', 20, 25.2), { ...F('QQ0001', 15, null), lng: null }, F('QQ0001', 10, 25.25)];
  const r = run(fx, []).rows[0];
  const want = Math.round(hav(25.2, 25.25) * 10) / 10;
  check(`7. a reading with no position does not cost the drive around it: ${want} km`, r.km === want && r.steps === 1, JSON.stringify([r.km, r.steps]));
}
{
  /* 8. One plate on two rosters is one car; a car moved between fleets is
     never both in the table and counted as gone. */
  const fx = [F('QS0001', 30, 25.2), F('QS0001', 25, 25.21), F('QT0001', 30, 25.2), F('QT0001', 25, 25.21)];
  const rosters = [
    { fleet_id: 'ecosine', value: JSON.stringify({ plates: { QS0001: { admitted: true, departed: false }, QT0001: { admitted: true, departed: false } } }) },
    { fleet_id: 'egari', value: JSON.stringify({ plates: { QS0001: { admitted: true, departed: false }, QT0001: { admitted: true, departed: true, last_seen: at(9000) } } }) },
  ];
  const out = run(fx, [], { rosters });
  check('8. a plate on both rosters is one row; a member anywhere is not counted as departed',
    out.rows.length === 2 && out.totals.cars === 2 && out.departed.plates === 0, JSON.stringify([out.rows.map((x) => x.plate), out.departed]));
}
{
  /* 10. A chained Uber request: the next booking was requested while the last
     ride was still going. Its span starts at that ride's drop-off, so the last
     passenger is not counted as this one's. */
  const fx = [F('QR0001', 58, 25.2), F('QR0001', 53, 25.21), F('QR0001', 48, 25.22), F('QR0001', 43, 25.23),
    F('QR0001', 35, 25.24, false), F('QR0001', 30, 25.25, false), F('QR0001', 25, 25.26, false)];
  const bk = [B('QR0001', 60, 40), B('QR0001', 45, 22)];
  const r = run(fx, bk).rows[0];
  check('10. a chained request does not borrow the last ride’s passenger: occupied during 1 of 2',
    r.bookings.read === 2 && r.bookings.seat_seen === 1, JSON.stringify(r.bookings));
}
{
  /* 11. The few-bookings sentence names a SEAT reading, and a lone reading is
     "1 reading", not "1 readings". */
  const r = run([F('QU0001', 30, 25.2), F('QU0001', 25, 25.21)], [B('QU0001', 32, 24)]).rows[0];
  check('11. "only 1 booking with a seat reading inside — too few to judge the pad"',
    r.verdict === 'few' && r.verdict_text === 'only 1 booking with a seat reading inside — too few to judge the pad', r.verdict_text);
}

/* ── 9. what the second review found (in the fixes for the first) ──────── */
console.log('\n9. the second review of 2026-10-20');
{
  /* N1. A unit last heard from long before the window: the bookings counted
     are the window's, so the sentence says the window — never "since its last
     reading", which for a unit silent since 2024 is a far larger number. */
  const bk = [2, 3, 4].map((dd) => B('QW0001', dd * 1440, dd * 1440 - 20, 6, 'hotel'));
  const last = [{ plate: 'QW0001', captured_at: at(60 * 24 * 200), status: 'Active', speed: 0 }];
  const r = run([], bk, { last }).rows[0];
  check('N1. silent since long before the window: "3 bookings in the last 7 days", not "since its last reading"',
    /while the car completed 3 bookings in the last 7 days/.test(r.verdict_text) && !/since its last reading/.test(r.verdict_text), r.verdict_text);
}
{
  /* N2. A hotel booking that "closed" 55 hours after it began must not empty
     the spans of the Uber rides after it: a hotel booking runs for the
     reconciler's distance estimate, not to its close. */
  const fx = []; const bk = [B('QX1001', 60 * 50, -60 * 5, 10, 'hotel')];   // began 50 h ago, "closed" 55 h later
  for (const h of [40, 30, 20, 10]) { for (let k = 0; k <= 4; k++) fx.push(F('QX1001', h * 60 - k * 5, 25.2 + k * 0.01, true)); bk.push(B('QX1001', h * 60, h * 60 - 20)); }
  const r = run(fx, bk).rows[0];
  check('N2. a hotel booking closed 55 hours on does not swallow the four Uber rides after it: occupied during 4 of 4',
    r.bookings.read === 4 && r.bookings.seat_seen === 4 && r.verdict === 'ok', JSON.stringify([r.verdict, r.bookings]));
  check('N2. the hotel estimate is the reconciler’s own (src/reconcile.js bookingWindow)',
    [0, 4.42, 13.41, 42.46, 200].every((km) => {
      const t0 = Date.parse('2026-10-16T04:29:00Z');
      const [, end] = bookingWindow({ requested_at: new Date(t0).toISOString(), distance_km: km || null });
      return hotelEndMs(t0, km || null) === end;
    }));
}
{
  /* N3. Three readings at the pickup and none after: not a car standing still. */
  const fx = []; const bk = [];
  for (const h of [9, 6, 3]) {
    for (const m of [-1, 4, 9]) fx.push({ ...F('QY0001', h * 60 - m, 25.2), speed: 0 });
    fx.push(F('QY0001', h * 60 - 45, 25.4));
    bk.push(B('QY0001', h * 60, h * 60 - 35, 17));
  }
  const r = run(fx, bk).rows[0];
  check('N3. readings only at the pickup are not "standing still through the booking"', r.verdict !== 'elsewhere' && r.bookings.still_checked === 0,
    JSON.stringify([r.verdict, r.bookings]));
}
{
  /* N5. Readings inside the bookings, none with a seat value, seat values only
     outside: the unit WAS reporting — its readings carry no seat value. */
  const fx = []; const bk = [];
  for (const h of [9, 6, 3]) { for (let k = 0; k <= 4; k++) fx.push(F('QZ0001', h * 60 - k * 5, 25.2 + k * 0.01, null)); bk.push(B('QZ0001', h * 60, h * 60 - 20)); }
  fx.push(F('QZ0001', 30, 25.5, false), F('QZ0001', 25, 25.51, false));
  const r = run(fx, bk).rows[0];
  check('N5. "its readings inside them carry no seat value", not "the unit is not reporting"',
    r.verdict === 'unreported' && /its readings inside them carry no seat value/.test(r.verdict_text), r.verdict_text);
}
{
  /* N6. The last passenger, still read a minute after drop-off, is not the
     next booking's: the span opens after the previous span closes. */
  const fx = [F('QA1001', 58, 25.2), F('QA1001', 53, 25.21), F('QA1001', 48, 25.22), F('QA1001', 43, 25.23),
    F('QA1001', 39, 25.24, true), F('QA1001', 35, 25.25, false), F('QA1001', 30, 25.26, false), F('QA1001', 25, 25.27, false)];
  const r = run(fx, [B('QA1001', 60, 40), B('QA1001', 45, 22)]).rows[0];
  check('N6. a reading in the previous ride’s pad is not this ride’s passenger: occupied during 1 of 2', r.bookings.seat_seen === 1 && r.bookings.read === 2,
    JSON.stringify(r.bookings));
}
{
  /* N8. A roster of only not-yet-admitted plates is not a list to stand on. */
  const out = run([F('QB1001', 60, 25.2), F('QB1001', 55, 25.21)], [], {
    rosters: [{ fleet_id: 'ecosine', value: JSON.stringify({ plates: { QB1001: { admitted: false, departed: false } } }) }] });
  check('N8. only pending plates: the readings stand in, and the answer says so', out.roster.known === false && out.rows.length === 1
    && /holds no admitted car yet/.test(out.roster.basis_reason || ''), JSON.stringify(out.roster));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
