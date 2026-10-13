/* One driver's day as the car saw it (2026-10-13).
   ──────────────────────────────────────────────────────────────────────────
   The operator, about #driver/…/day for a driver online four hours that
   morning: "it didn't show. We need to see when he was online, from where,
   and where he moved on a granular level … his whole day's movement as
   reported by cabman or fms and potentially with a passenger or not."

   Measured on production that morning, Kashif Ali Ayyub Khan: /api/driver/day
   for the 13th returned 0 trips, 3 log-in spans ending 10:17 (the timeline
   collector's reach) and 0 fixes — the car was found only through bookings,
   and none had been filed — while Uber's live feed had him online from 07:04
   and on a trip at 11:38 in L27045, whose FMS tracker had 74 fixes that day.

   This file holds the arithmetic (api/day_movement.js) and the route
   (/api/driver/day) on a synthetic fleet: one car shared by two drivers, the
   night man's shift before the day man's, a morning with no booking at all,
   a passenger aboard for one drive, and a silence in the tracker.

     §1  custody: whose car, when — stretched to the online spell, never
         across another driver's evidence; a car changing hands mid-spell;
         evidence of two people at once said, not resolved;
     §2  the car: runs by state (passenger / moving / stopped), nothing
         across a silence; distance by seat summing to the total;
     §3  the route, a past day with no booking: live status spans, the car
         found from Uber's own status rows, the night man's fixes NOT his,
         stops and drives in order, where he went online;
     §4  the route, today: the window runs to now, the spell is open.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { custodyWindows, carRuns, distanceBySeat, movementSegments, statusSpans } from '../api/day_movement.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── §1 custody ─────────────────────────────────────────────────────────── */
console.log('\n§1 whose car, and when');
{
  const w = custodyWindows({ own: [{ plate: 'L1', s: 430, e: 430, kind: 'uber_vehicle' }, { plate: 'L1', s: 700, e: 730, kind: 'booking' }],
    others: [{ plate: 'L1', s: 30, e: 300, who: 'Night' }], spells: [{ s: 424, e: 760 }] });
  check('his window runs from the start of the online spell to its end', w.length === 1 && w[0].from === 424 && w[0].to === 760
    && w[0].core_from === 430 && w[0].core_to === 730 && w[0].stretched, JSON.stringify(w));
  const c = custodyWindows({ own: [{ plate: 'L1', s: 430, e: 430 }], others: [{ plate: 'L1', s: 400, e: 410, who: 'Night' }],
    spells: [{ s: 380, e: 500 }] });
  check('…but never back across the other driver\'s evidence in the same car', c[0].from === 410, JSON.stringify(c));
  const sh = custodyWindows({ own: [{ plate: 'L1', s: 430, e: 460, kind: 'booking' }],
    others: [{ plate: 'L1', s: 440, e: 440, who: 'Other' }], spells: [] });
  check('another driver\'s evidence INSIDE one of his own bookings is said as shared, not given to either',
    sh[0].shared.length === 1 && sh[0].shared[0].who === 'Other' && sh[0].from === 430 && sh[0].to === 460, JSON.stringify(sh));
  const two = custodyWindows({ own: [{ plate: 'L1', s: 420, e: 480 }, { plate: 'L2', s: 600, e: 650 }], spells: [{ s: 400, e: 700 }] });
  check('two cars in one spell: the change of car is at his last evidence in the first',
    two.length === 2 && two[0].plate === 'L1' && two[0].to === 480 && two[1].plate === 'L2' && two[1].from === 480, JSON.stringify(two));
  const now = custodyWindows({ own: [{ plate: 'L1', s: 430, e: 430 }], spells: [{ s: 424, e: 700 }], limit: 650 });
  check('today the window stops at now', now[0].to === 650, JSON.stringify(now));
  const sp = statusSpans([{ status: 'online', from_at: '2026-10-11T03:04:00Z', to_at: '2026-10-11T03:46:00Z' },
    { status: 'online', from_at: '2026-10-11T03:46:00Z', to_at: '2026-10-11T05:00:00Z' },
    { status: 'ontrip', from_at: '2026-10-11T05:00:00Z', to_at: '2026-10-11T05:30:00Z' }], Date.parse('2026-10-11T00:00:00+04:00'), null);
  check('Uber\'s heartbeat ONLINE spans are one spell', sp.length === 2 && sp[0].s === 424 && sp[0].e === 540 && sp[1].status === 'ontrip', JSON.stringify(sp));
}

/* ── §2 the car ─────────────────────────────────────────────────────────── */
console.log('\n§2 what the car was doing');
const at = (hm) => new Date(`2026-10-11T${hm}:00+04:00`).toISOString();
const mm = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const F = (hm, lat, lng, extra = {}) => ({ plate: 'L1', source: 'fms', at: at(hm), time: hm, m: mm(hm), lat, lng, speed: null, passenger: false, area: null, ...extra });
{
  const fs = [F('08:00', 25.20, 55.30), F('08:05', 25.20, 55.30), F('08:10', 25.22, 55.32), F('08:15', 25.24, 55.34, { passenger: true }),
    F('08:20', 25.26, 55.36, { passenger: true }), F('09:00', 25.26, 55.36)];
  const runs = carRuns(fs);
  check('stopped, then moving empty, then a passenger aboard — and nothing across the 40-minute silence',
    runs.map((r) => r.state).join() === 'idle,available,engaged' && runs[2].s === mm('08:10') && runs[2].e === mm('08:20')
    && !runs.some((r) => r.e > mm('08:20')), JSON.stringify(runs));
  const d = distanceBySeat(fs);
  check('distance by seat sums to the total', d.km > 0 && d.km_with_passenger > 0 && d.km_empty > 0
    && Math.abs(d.km - (d.km_with_passenger + d.km_empty + d.km_seat_not_reported)) <= 0.11, JSON.stringify(d));
  const none = carRuns([F('08:00', 25.2, 55.3, { passenger: null }), F('08:05', 25.21, 55.31, { passenger: null })]);
  check('a seat nobody reported is not an empty seat', none[0].state === 'available' && none[0].seat === null, JSON.stringify(none));
}

/* ── the fleet for the route ───────────────────────────────────────────── */
const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
const K = 'kkkkkkkk-1111-4111-8111-000000000001';   // Test Driver Kilo, the day man
const O = 'oooooooo-2222-4222-8222-000000000002';   // Test Driver Oscar, the night man
const D = '2026-10-11';
const T = (day, hm) => `${day}T${hm}:00+04:00`;
/* Kilo needs a booking SOMEWHERE for the person spine to know him; it is on
   another day, so the day under test has none. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','k-prev','ecosine','L30001',$1,'Test Driver Kilo',$2::timestamptz,$3::timestamptz,'completed',20,5)`,
[K, T('2026-10-09', '10:00'), T('2026-10-09', '10:20')]);
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','o-night','ecosine','L30001',$1,'Test Driver Oscar',$2::timestamptz,$3::timestamptz,'completed',30,8)`,
[O, T(D, '01:00'), T(D, '01:30')]);
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, plate, name) VALUES ('uber',$1,'ecosine','L30001','Test Driver Kilo')`, [K])
  .catch(async () => q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, plate) VALUES ('uber',$1,'ecosine','L30001')`, [K]));
/* Uber's own status rows in the car — one per status change, the overview
   in raw with the driver's id — as src/sources/uber.js writes them. */
const uberRow = (hm, status, who, name, day = D) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status, raw)
   VALUES ('uber','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3::jsonb)`,
  [T(day, hm), status, JSON.stringify({ driverInfo: { driverUuid: who, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' ') } })]);
await uberRow('00:30', 'ONLINE', O, 'Test Oscar');
await uberRow('05:00', 'OFFLINE', O, 'Test Oscar');
await uberRow('07:04', 'ONLINE', K, 'Test Kilo');
await uberRow('09:00', 'ONTRIP', K, 'Test Kilo');
await uberRow('09:30', 'ONLINE', K, 'Test Kilo');
/* …and OFFLINE at 12:10: the tick writes a row for every status change. */
await uberRow('12:10', 'OFFLINE', K, 'Test Kilo');
/* Uber's live status events for Kilo. */
const sev = (hm, status, day = D) => q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
  VALUES ('uber',$1,$2::timestamptz,$3,$4,'ecosine')`, [K, T(day, hm), status, `DRIVER_STATUS_${status.toUpperCase()}`]);
await sev('07:04', 'online'); await sev('09:00', 'ontrip'); await sev('09:30', 'online'); await sev('12:10', 'offline');
/* The tracker. Oscar drives at night (00:30–05:00, Deira); the car sits at
   JLT 06:00–06:50; Kilo goes online at 07:04 parked at Emirates Rd, drives
   empty to DSO, waits, carries a passenger to Garhoud, goes silent for 40
   minutes, drives to Deira and parks. */
const fx = async (hm, [lat, lng], seat = 0, speed = null) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
   VALUES ('fms','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3,$4,$5)`, [T(D, hm), lat, lng, speed, seat]);
const DEIRA = [25.2701, 55.3178]; const JLT = [25.0700, 55.1400]; const EMI = [25.1000, 55.4000];
const DSO = [25.1200, 55.3800]; const GAR = [25.2400, 55.3500];
for (let m = 30; m <= 300; m += 10) await fx(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, [DEIRA[0] + (m % 20) * 0.001, DEIRA[1]], 1, 30);
for (const hm of ['06:00', '06:20', '06:40', '06:50']) await fx(hm, JLT);
for (const hm of ['07:05', '07:15', '07:30', '07:45', '08:00']) await fx(hm, EMI);
await fx('08:06', [25.105, 55.395], 0, 40); await fx('08:12', [25.112, 55.388], 0, 45);
for (const hm of ['08:20', '08:30', '08:40', '08:50']) await fx(hm, DSO);
await fx('09:05', [25.15, 55.37], 1, 50); await fx('09:12', [25.19, 55.36], 1, 55); await fx('09:20', [25.23, 55.352], 1, 30);
for (const hm of ['09:25', '09:35', '09:45', '09:55']) await fx(hm, GAR);
await fx('10:40', [25.25, 55.34], 0, 30); await fx('10:50', [25.262, 55.325], 0, 25);
for (const hm of ['11:00', '11:20', '11:40', '12:00', '12:10']) await fx(hm, DEIRA);
const cell = (p, area, n = 50) => q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations) VALUES ($1,$2,$3,$4,1,$4)
  ON CONFLICT DO NOTHING`, [Math.round(p[0] / 0.005), Math.round(p[1] / 0.005), area, n]);
await cell(DEIRA, 'Deira'); await cell(JLT, 'Jumeirah Lakes Towers'); await cell(EMI, 'Emirates Rd');
await cell(DSO, 'Dubai Silicon Oasis'); await cell(GAR, 'Al Garhoud');

const bare = await mountAll(pg);
const get = async (path) => (await bare.get(path)).body;

/* ── §3 the route, a past day with no booking ──────────────────────────── */
console.log('\n§3 a day with no booking: online, from where, and where the car went');
const b = await get(`/api/driver/day?id=${K}&day=${D}`);
check('no booking on the day, and the route still answers', Array.isArray(b?.trips) && b.trips.length === 0, JSON.stringify(b).slice(0, 300));
/* No event before midnight, so the day opens UNKNOWN — not offline; the
   status strip's own rule (api/status_routes.js SPANS_SQL). */
check('Uber\'s live status: online 07:04, on a trip 09:00–09:30, online to 12:10, then offline — and nothing claimed before 07:04',
  (b.status_spans || []).map((x) => `${x.status}@${x.s}`).join() === `online@${mm('07:04')},ontrip@${mm('09:00')},online@${mm('09:30')},offline@${mm('12:10')}`,
  JSON.stringify(b.status_spans));
check('…and where he went online: Emirates Rd, from the tracker',
  b.status_spans?.find((x) => x.s === mm('07:04'))?.went_online?.where === 'Emirates Rd', JSON.stringify(b.status_spans?.[1]));
const w = b.movement?.windows || [];
check('the car is found from Uber\'s own status rows: L30001, 07:04 to the end of his spell at 12:10',
  w.length === 1 && w[0].plate === 'L30001' && w[0].from === mm('07:04') && w[0].to === mm('12:10') && w[0].basis.includes('uber_vehicle'),
  JSON.stringify(w));
check('the night man\'s fixes and the car\'s idle hour at JLT are NOT his — none before 07:04, and counted apart',
  b.fixes.length > 0 && b.fixes.every((f) => f.m >= mm('07:04')) && b.movement.outside_fixes === 28 + 4,
  `${b.fixes.length} fixes, first ${b.fixes[0]?.time}, outside ${b.movement?.outside_fixes}`);
const seg = b.movement?.segments || [];
const kinds = seg.map((s) => `${s.kind}${s.area ? `:${s.area}` : s.to_area ? `>${s.to_area}` : ''}`).join(' | ');
check('the log in order: parked at Emirates Rd, drive to DSO, wait, drive to Garhoud, wait, a silence, drive to Deira, park',
  /^stop:Emirates Rd \| drive>Dubai Silicon Oasis \| stop:Dubai Silicon Oasis \| drive>Al Garhoud \| stop:Al Garhoud \| silence[^|]* \| drive>Deira \| stop:Deira$/.test(kinds), kinds);
const toGar = seg.find((s) => s.kind === 'drive' && s.to_area === 'Al Garhoud');
check('the drive to Garhoud carried a passenger for 30 of its 35 minutes (set down before the car stopped); the drive to DSO was empty',
  toGar?.passenger === 'part of it with a passenger' && toGar?.passenger_min === 30 && toGar?.minutes === 35
  && seg.find((s) => s.kind === 'drive' && s.to_area === 'Dubai Silicon Oasis')?.passenger === 'empty', JSON.stringify(toGar));
const t = b.movement?.totals || {};
check('the day\'s distance split by seat, from the tracker\'s own reading', t.km > 0 && t.km_with_passenger > 0 && t.km_empty > 0
  && t.seat_reported === true && t.sources.join() === 'fms', JSON.stringify(t));
check('the car\'s runs: a passenger aboard 09:05–09:20 — and nothing drawn across the silence',
  (b.movement?.runs || []).some((r) => r.state === 'engaged' && r.s <= mm('09:05') && r.e >= mm('09:20'))
  && !(b.movement?.runs || []).some((r) => r.s < mm('10:40') && r.e > mm('09:55')), JSON.stringify(b.movement?.runs));
check('the page-facing fixes carry their seat and source', b.fixes.some((f) => f.passenger === true && f.source === 'fms'), JSON.stringify(b.fixes[0]));

/* Oscar's own night, for the other side of the same rule. */
const o = await get(`/api/driver/day?id=${O}&day=${D}`);
check('the night man\'s day holds his night in the car and none of Kilo\'s morning',
  (o.movement?.windows || []).length === 1 && o.fixes.length > 0 && o.fixes.every((f) => f.m <= mm('05:00')), JSON.stringify(o.movement?.windows));

/* ── §4 today ──────────────────────────────────────────────────────────── */
console.log('\n§4 today: the window runs to now');
const DUBAI_MS = 4 * 3600_000;
const today = new Date(Date.now() + DUBAI_MS).toISOString().slice(0, 10);
const sinceMidnight = Math.floor(((Date.now() + DUBAI_MS) % 86400000) / 60000);
const back = Math.max(2, Math.min(40, sinceMidnight - 1));
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id) VALUES ('uber',$1,$2::timestamptz,'online','DRIVER_STATUS_ONLINE','ecosine')`, [K, ago(back)]);
/* The live feed answering now, as the tick writes it. */
await q(`INSERT INTO driver_status_now (platform, driver_ext_id, fleet_id, status, status_raw, status_at, observed_at, plate)
         VALUES ('uber',$1,'ecosine','online','DRIVER_STATUS_ONLINE',$2::timestamptz,now(),'L30001')
         ON CONFLICT (platform, driver_ext_id) DO UPDATE SET observed_at = now(), status = 'online', status_at = EXCLUDED.status_at`, [K, ago(back)]);
await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status, raw)
         VALUES ('uber','L30001','ecosine',$1::timestamptz,$1::timestamptz,'ONLINE',$2::jsonb)`,
[ago(back), JSON.stringify({ driverInfo: { driverUuid: K, firstName: 'Test', lastName: 'Kilo' } })]);
await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
         VALUES ('fms','L30001','ecosine',$1::timestamptz,$1::timestamptz,25.27,55.31,20,1)`, [ago(1)]);
const tb = await get(`/api/driver/day?id=${K}&day=${today}`);
const tw = tb.movement?.windows?.[0];
check('today, with no booking: the spell is open and the window runs to now',
  tb.today === true && tb.status_spans?.at(-1)?.open_ended === true && tw?.to === tb.now_min && tb.fixes.length >= 1,
  JSON.stringify({ today: tb.today, now: tb.now_min, spans: tb.status_spans, w: tb.movement?.windows }));

/* ── §5 the independent review of 2026-10-13 ───────────────────────────────
   Thirty-three findings, every one confirmed by a second reader trying to
   refute it. The server's, each held here: yesterday's rows putting a driver
   in a shared car from midnight; another man's shift inside his day counted
   as his; a log-in span that ran to midnight only because nothing came after
   it; a live feed that stopped answering read as a driver still online; two
   trackers on one car summed into a car crossing the city every minute; the
   state the day opened in placed as "went online at 00:00"; windows that
   depended on the order evidence arrived in; two cars at once read as 0 km;
   parts that did not add up to their total. */
console.log('\n§5 the review: custody, spells, feeds, trackers');
{
  const ord = custodyWindows({ own: [{ plate: 'B', s: 800, e: 830, kind: 'booking' }, { plate: 'A', s: 430, e: 430, kind: 'uber_vehicle' },
    { plate: 'A', s: 550, e: 550, kind: 'uber_vehicle' }], spells: [{ s: 420, e: 1020 }] });
  check('windows follow his evidence, not the order it arrived in: A then B, the change at his last evidence in A, no "two cars at once"',
    ord.map((w) => `${w.plate}:${w.from}-${w.to}`).join() === 'A:420-550,B:550-1020' && !ord.some((w) => w.overlap), JSON.stringify(ord));
  const cut = custodyWindows({ own: [{ plate: 'L1', s: 360, e: 360, kind: 'uber_vehicle' }, { plate: 'L1', s: 900, e: 900, kind: 'uber_vehicle' }],
    others: [{ plate: 'L1', s: 630, e: 870, who: 'Other' }], spells: [{ s: 360, e: 1140 }] });
  check('inside ONE spell, another driver\'s evidence between two of his cuts the car in two — the stretch between is nobody\'s here',
    cut.map((w) => `${w.from}-${w.to}`).join() === '360-630,870-1140' && cut.every((w) => !w.shared.length), JSON.stringify(cut));
  const two = [F('08:00', 25.20, 55.30), { ...F('08:00', 25.00, 55.10), plate: 'L2' }, F('08:05', 25.21, 55.31),
    { ...F('08:05', 25.01, 55.11), plate: 'L2' }, F('08:10', 25.22, 55.32), { ...F('08:10', 25.02, 55.12), plate: 'L2' }];
  const dTwo = distanceBySeat(two);
  const each = distanceBySeat(two.filter((f) => f.plate === 'L1')).km + distanceBySeat(two.filter((f) => f.plate === 'L2')).km;
  check('two cars at once interleave by time, and each is measured on its own — not 0 km, and no jump from one car to the other',
    dTwo.km > 2 && Math.abs(dTwo.km - each) <= 0.1
    && carRuns(two).filter((r) => r.plate === 'L2').length === 1 && carRuns(two).filter((r) => r.plate === 'L1').length === 1, JSON.stringify(dTwo));
  const tiny = distanceBySeat([F('08:00', 25.2, 55.3, { passenger: true }), F('08:01', 25.2, 55.30151, { passenger: true }),
    F('08:02', 25.2, 55.30302, { passenger: false })]);
  check('the parts the page prints add up to the total it prints', tiny.km === Math.round((tiny.km_with_passenger + tiny.km_empty + tiny.km_seat_not_reported) * 10) / 10,
    JSON.stringify(tiny));
}
/* Yesterday: Kilo drove the same car 07:00–15:00 and went OFFLINE. */
await uberRow('07:00', 'ONLINE', K, 'Test Kilo', '2026-10-10');
await uberRow('09:00', 'ONTRIP', K, 'Test Kilo', '2026-10-10');
await uberRow('15:00', 'OFFLINE', K, 'Test Kilo', '2026-10-10');
const y = await get(`/api/driver/day?id=${K}&day=${D}`);
check('yesterday in the same car does not make it his from midnight: his window still opens at 07:04, none of the night man\'s fixes',
  (y.movement?.windows || []).length === 1 && y.movement.windows[0].from === mm('07:04') && y.fixes.every((f) => f.m >= mm('07:04')),
  JSON.stringify(y.movement?.windows));

/* 12 Oct, split shifts: Kilo online 06:00–10:00 and 15:00–19:00 in L30001;
   Oscar has it 10:30–14:30 with a booking 12:00–13:30 and a passenger in.
   Kilo was also online from 23:30 the night before to 03:00 (carried in),
   and online 04:00–04:30 with no car on record. */
const D2 = '2026-10-12';
await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id) VALUES ('uber',$1,'2026-10-11T23:30:00+04:00','online','DRIVER_STATUS_ONLINE','ecosine')`, [K]);
for (const [hm, st] of [['03:00', 'offline'], ['04:00', 'online'], ['04:30', 'offline'], ['06:00', 'online'], ['10:00', 'offline'], ['15:00', 'online'], ['19:00', 'offline']]) await sev(hm, st, D2);
await uberRow('06:00', 'ONLINE', K, 'Test Kilo', D2); await uberRow('15:00', 'ONLINE', K, 'Test Kilo', D2);
await uberRow('10:30', 'ONLINE', O, 'Test Oscar', D2); await uberRow('12:00', 'ONTRIP', O, 'Test Oscar', D2); await uberRow('14:30', 'OFFLINE', O, 'Test Oscar', D2);
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','o-noon','ecosine','L30001',$1,'Test Driver Oscar',$2::timestamptz,$3::timestamptz,'completed',40,12)`, [O, T(D2, '12:00'), T(D2, '13:30')]);
for (let m = 360; m <= 1140; m += 10) {
  const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
           VALUES ('fms','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3,$4,$5)`,
  [T(D2, hm), 25.20 + (m % 60) * 0.0004, 55.30 + (m % 60) * 0.0004, 30, m >= 720 && m < 810 ? 1 : 0]);
}
const s2 = await get(`/api/driver/day?id=${K}&day=${D2}`);
const w2 = s2.movement?.windows || [];
check('split shifts: two windows, 06:00–10:00 and 15:00–19:00 — the other man\'s 10:30–14:30 is not his',
  w2.map((w) => `${w.from}-${w.to}`).join() === `${mm('06:00')}-${mm('10:00')},${mm('15:00')}-${mm('19:00')}`
  && !s2.fixes.some((f) => f.m > mm('10:00') && f.m < mm('15:00')), JSON.stringify(w2));
check('…so none of the other man\'s passenger minutes are counted as his, and he is said to have had the car',
  s2.movement?.totals?.with_passenger_min === 0 && (s2.movement?.others || []).some((o) => o.who_id === O),
  JSON.stringify({ t: s2.movement?.totals, others: s2.movement?.others }));
const carried = s2.status_spans?.[0];
check('the spell carried in from before midnight is marked so, and is not placed as "went online at 00:00"',
  carried?.carried_in === true && carried?.s === 0 && carried?.went_online === undefined, JSON.stringify(carried));
const noCar = s2.status_spans?.find((x) => x.s === mm('04:00'));
check('a spell with no car on record is not placed from someone else\'s shift, and says why',
  noCar?.went_online?.where == null && /no car is on record as his at that moment/.test(noCar?.went_online?.why || ''), JSON.stringify(noCar));

/* 8 Oct: the log-in record's last ONLINE never got a successor (closed by
   the day, a claim), no live feed; one booking 08:00–08:30. */
const D3 = '2026-10-08';
await q(`INSERT INTO driver_timeline_event (platform, driver_ext_id, fleet_id, at, kind, status, state) VALUES ('uber',$1,'ecosine',$2::timestamptz,'status','ONLINE','')`, [K, T(D3, '07:00')]);
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','k-d3','ecosine','L30001',$1,'Test Driver Kilo',$2::timestamptz,$3::timestamptz,'completed',20,5)`, [K, T(D3, '08:00'), T(D3, '08:30')]);
for (const hm of ['07:00', '08:00', '08:15', '08:30', '12:00', '18:00', '23:00']) {
  await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
           VALUES ('fms','L30001','ecosine',$1::timestamptz,$1::timestamptz,25.2,55.3,0,0)`, [T(D3, hm)]);
}
const s3 = await get(`/api/driver/day?id=${K}&day=${D3}`);
check('a log-in span that ran to midnight only because nothing came after it does not stretch the car to midnight',
  (s3.online || []).some((o) => o.closed_by === 'day') && (s3.movement?.windows || []).length === 1
  && s3.movement.windows[0].to === mm('08:30'), JSON.stringify({ online: s3.online, w: s3.movement?.windows }));

/* 7 Oct: a car with BOTH trackers, a dozen km apart at the same minute. */
const D4 = '2026-10-07';
await sev('08:00', 'online', D4); await sev('10:00', 'offline', D4);
await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status, raw)
         VALUES ('uber','L30002','ecosine',$1::timestamptz,$1::timestamptz,'ONLINE',$2::jsonb)`,
[T(D4, '08:00'), JSON.stringify({ driverInfo: { driverUuid: K, firstName: 'Test', lastName: 'Kilo' } })]);
for (let m = 480; m <= 600; m += 5) {
  const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
           VALUES ('fms','L30002','ecosine',$1::timestamptz,$1::timestamptz,25.20,55.30,0,0)`, [T(D4, hm)]);
  if (m % 10 === 0) {
    await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_occupied)
             VALUES ('cabman','L30002','ecosine',$1::timestamptz + interval '20 seconds',$1::timestamptz,25.30,55.38,0,false)`, [T(D4, hm)]);
  }
}
const s4 = await get(`/api/driver/day?id=${K}&day=${D4}`);
const w4 = s4.movement?.windows?.[0];
check('a car with two trackers is read from one — the one with more positions — and the other is counted, not summed into phantom km',
  new Set(s4.fixes.map((f) => f.source)).size === 1 && w4?.second_tracker?.kept === 'fms'
  && w4?.second_tracker?.dropped?.[0]?.source === 'cabman' && s4.movement.totals.km < 1,
  JSON.stringify({ w: w4, km: s4.movement?.totals?.km, sources: [...new Set(s4.fixes.map((f) => f.source))] }));

/* Today: the live feed stopped answering for Oscar. */
const backO = Math.max(2, Math.min(40, sinceMidnight - 1));
if (backO > 9) {
  await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id) VALUES ('uber',$1,$2::timestamptz,'online','DRIVER_STATUS_ONLINE','ecosine')`, [O, ago(backO)]);
  await q(`INSERT INTO driver_status_now (platform, driver_ext_id, fleet_id, status, status_raw, status_at, observed_at, plate)
           VALUES ('uber',$1,'ecosine','online','DRIVER_STATUS_ONLINE',$2::timestamptz,$2::timestamptz,'L30003')`, [O, ago(backO)]);
  const so = await get(`/api/driver/day?id=${O}&day=${today}`);
  const lastO = so.status_spans?.at(-1);
  check('a live feed that stopped answering is not "still online now": the spell ends where the feed last answered, and says so',
    lastO && lastO.open_ended !== true && lastO.feed_stale === true && /last answered/.test(so.status_stale || ''),
    JSON.stringify({ last: lastO, stale: so.status_stale }));
} else {
  console.log('  · (the stale-feed check needs ten minutes of today; it is constructed after 00:10 Dubai)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
