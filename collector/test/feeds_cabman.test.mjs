/* #feeds' CABMAN table — the seat sensor held against the car's own movement
   and its bookings (GET /api/vehicles/feeds/cabman).
   ─────────────────────────────────────────────────────────────────────────
   Asked for on 2026-10-20 after an audit of the 46 cars on CABMAN's list
   found the pad reading occupied during only 66% of their bookings, five
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
import { CAB_DAYS, CAB_GAP_MIN, CAB_HOP_KM, cabmanSeat } from '../api/feed_routes.js';

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
check('G: no reading in the window — no distance measured, absent rather than 0', by.QG0001.km === null && by.QG0001.days_moved === null,
  JSON.stringify([by.QG0001.km, by.QG0001.days_moved]));

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
check('D: the unit may be in, or filed under, another car', /standing still through 3 of 3 bookings — the unit may be fitted to, or filed under, another car/.test(by.QD0001.verdict_text),
  by.QD0001.verdict_text);
check('E: silent — and the car worked while it was', /no CABMAN reading in the last 24 hours — the unit is silent, while the car completed 2 bookings in 7 days/.test(by.QE0001.verdict_text)
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
