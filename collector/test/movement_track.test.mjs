/* A driver's movement, granular (2026-11-24, the operator: "in territory
   let's focus on granular view. we need to see territory where they move
   around, where they park everything").
   ──────────────────────────────────────────────────────────────────────────
     §1  segmentRows: the day's log as rows, each stop split by what the
         driver was doing while the car stood, a drive with both ends, a stop
         held across a quiet tracker said as inferred;
     §2  routePieces: the path cut wherever the state changes and wherever
         the tracker went silent, never across two custody windows, never
         through a stop;
     §3  parkingSpots: stops grouped within 150 m, longest first — visits,
         time, what the driver was doing, nights, the usual hours;
     §4  the whole path on a real Postgres: the rollup keeps the segments and
         the car-hours, and /api/driver/movement/track draws the route from
         the tracker's own fixes inside those hours only.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { segmentRows, routePieces, parkingSpots } from '../api/movement_track.js';
import { minuteStatus, buildDay } from '../src/movement_rollup.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const D = '2026-10-11';
const at = (hm, day = D) => new Date(`${day}T${hm}:00+04:00`).toISOString();
const mm = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const F = (hm, lat, lng, extra = {}) => ({ plate: 'L1', source: 'fms', at: at(hm), time: hm, m: mm(hm), lat, lng, speed: null, passenger: false, ...extra });

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 the day as rows');
{
  const status = minuteStatus({ statusAll: [{ s: mm('08:00'), e: mm('09:00'), status: 'online' }], trips: [{ s: mm('08:40'), e: mm('09:00') }] });
  const rows = segmentRows([
    { kind: 'stop', s: mm('08:00'), e: mm('08:50'), minutes: 50, area: 'Deira', lat: 25.27, lng: 55.31, plate: 'L1', source: 'fms', longest_silence_min: 6 },
    { kind: 'drive', s: mm('08:50'), e: mm('09:10'), minutes: 20, from_area: 'Deira', to_area: 'Al Garhoud', lat: 25.27, lng: 55.31,
      to_lat: 25.24, to_lng: 55.35, km: 6.43, km_with_passenger: 6.43, passenger: 'with a passenger', passenger_min: 20, plate: 'L1', source: 'fms' },
    { kind: 'stop', s: mm('10:00'), e: mm('11:06'), minutes: 66, area: 'Al Garhoud', lat: 25.24, lng: 55.35, plate: 'L1', source: 'cabman', longest_silence_min: 66 },
    { kind: 'silence', s: mm('12:00'), e: mm('13:00'), minutes: 60, plate: 'L1', from_area: 'Al Garhoud', to_area: 'Deira', moved_km: 7.2 },
  ], status);
  const [st, dr, quiet, sil] = rows;
  check('a stop is split by what the driver was doing while the car stood: 40 minutes waiting online, 10 on a job',
    st.wait_min === 40 && st.ontrip_min === 10 && st.offline_min === 0 && st.seq === 0, JSON.stringify(st));
  check('a drive carries both ends, its km and the seat', dr.lat === 25.27 && dr.to_lat === 25.24 && dr.to_area === 'Al Garhoud'
    && dr.km === 6.4 && dr.passenger === 'with a passenger' && dr.wait_min === null, JSON.stringify(dr));
  check('a stop held across a quiet tracker is said as inferred; one watched throughout is not', quiet.inferred === true && st.inferred === false
    && quiet.offline_min === 66, JSON.stringify(quiet));
  check('a silence keeps how far the car moved while nobody was watching', sil.kind === 'silence' && sil.km === 7.2 && sil.area === 'Al Garhoud');
}

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 the path');
{
  const fixes = [
    F('08:00', 25.200, 55.300), F('08:05', 25.200, 55.300),                                    // stopped
    F('08:10', 25.215, 55.310, { speed: 40 }), F('08:15', 25.230, 55.320, { speed: 40 }),      // empty
    F('08:20', 25.245, 55.330, { speed: 40, passenger: true }), F('08:25', 25.260, 55.340, { speed: 40, passenger: true }), // aboard
    F('09:10', 25.300, 55.380, { speed: 40, passenger: true }),                                // after a 45-minute silence
    F('09:15', 25.315, 55.390, { speed: 40, passenger: true }),
  ];
  const pieces = routePieces(fixes);
  check('the path is cut where the state changes: empty, then a passenger aboard — and a stop is no piece',
    pieces.length === 3 && pieces[0].state === 'empty' && pieces[1].state === 'passenger' && pieces[0].points.length === 3, JSON.stringify(pieces));
  check('…and never drawn across a silence: the drive after it is a piece of its own',
    pieces[2].state === 'passenger' && pieces[2].s === mm('09:10') && pieces[1].e === mm('08:25'), JSON.stringify(pieces.map((p) => [p.s, p.e])));
  const two = routePieces([F('08:00', 25.20, 55.30, { speed: 40, w: 'a' }), F('08:05', 25.215, 55.31, { speed: 40, w: 'a' }),
    F('08:10', 25.23, 55.32, { speed: 40, w: 'b' }), F('08:15', 25.245, 55.33, { speed: 40, w: 'b' })]);
  check('two custody windows of the same car are never joined by a line', two.length === 2 && two.every((p) => p.points.length === 2), JSON.stringify(two));
  const unk = routePieces([F('08:00', 25.20, 55.30, { speed: 40, passenger: null }), F('08:05', 25.215, 55.31, { speed: 40, passenger: null })]);
  check('a drive with the seat unreported is its own state, never "empty"', unk[0]?.state === 'seat_unknown', JSON.stringify(unk));
}

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 where they park');
{
  const S = (day, s, e, lat, lng, extra = {}) => ({ day, kind: 'stop', s_min: s, e_min: e, minutes: e - s, lat, lng, area: 'Al Barsha',
    wait_min: 0, ontrip_min: 0, offline_min: e - s, ...extra });
  const spots = parkingSpots([
    S('2026-10-10', 0, 360, 25.1100, 55.2000),                                   // a night parked
    S('2026-10-11', 30, 330, 25.1105, 55.2004),                                  // another, 60 m away
    S('2026-10-11', 600, 640, 25.2000, 55.3000, { area: 'Deira', wait_min: 40, offline_min: 0 }),
    S('2026-10-11', 700, 705, 25.2000, 55.3000, { area: 'Deira' }),              // five minutes: not a parking stop
  ]);
  const home = spots[0];
  check('two nights 60 m apart are one place: two visits, two nights, the time summed', spots.length === 2 && home.visits === 2
    && home.nights === 2 && home.minutes === 660 && home.days === 2 && home.offline_min === 660, JSON.stringify(home));
  check('…with the usual hours, and the longest place first', home.usual_from_min === 0 && home.usual_to_min === 330 && spots[1].area === 'Deira'
    && spots[1].wait_min === 40 && spots[1].nights === 0, JSON.stringify(spots));
}

/* ── §4 ─────────────────────────────────────────────────────────────────── */
console.log('\n§4 the whole path');
const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
const K = 'kkkkkkkk-1111-4111-8111-000000000077';
const O = 'oooooooo-2222-4222-8222-000000000077';
const [{ id: PID }] = await q(`INSERT INTO driver (fleet_id, full_name) VALUES ('ecosine','Test Driver Kilo') RETURNING id`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES ('uber',$1,$2)`, [K, PID]);
const T = (hm) => `${D}T${hm}:00+04:00`;
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','k-1','ecosine','L30001',$1,'Test Driver Kilo',$2::timestamptz,$3::timestamptz,'completed',40,9)`, [K, T('09:00'), T('09:25')]);
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','o-1','ecosine','L30001',$1,'Test Driver Oscar',$2::timestamptz,$3::timestamptz,'completed',30,8)`, [O, T('01:00'), T('01:30')]);
const uberRow = (hm, status, who) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status, raw)
   VALUES ('uber','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3::jsonb)`,
  [T(hm), status, JSON.stringify({ driverInfo: { driverUuid: who, firstName: 'Test', lastName: who === K ? 'Kilo' : 'Oscar' } })]);
await uberRow('00:30', 'ONLINE', O); await uberRow('05:00', 'OFFLINE', O);
await uberRow('07:04', 'ONLINE', K); await uberRow('09:00', 'ONTRIP', K); await uberRow('09:30', 'ONLINE', K); await uberRow('12:10', 'OFFLINE', K);
const sev = (hm, status) => q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
  VALUES ('uber',$1,$2::timestamptz,$3,$4,'ecosine')`, [K, T(hm), status, `DRIVER_STATUS_${status.toUpperCase()}`]);
await sev('07:04', 'online'); await sev('09:00', 'ontrip'); await sev('09:30', 'online'); await sev('12:10', 'offline');
const fx = (hm, [lat, lng], seat = 0, speed = null) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
   VALUES ('fms','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3,$4,$5)`, [T(hm), lat, lng, speed, seat]);
const DEIRA = [25.2701, 55.3178]; const EMI = [25.1000, 55.4000]; const DSO = [25.1200, 55.3800]; const GAR = [25.2400, 55.3500];
for (let m = 30; m <= 300; m += 10) await fx(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, [DEIRA[0] + (m % 20) * 0.001, DEIRA[1]], 1, 30);
for (const hm of ['07:05', '07:15', '07:30', '07:45', '08:00']) await fx(hm, EMI);
await fx('08:06', [25.105, 55.395], 0, 40); await fx('08:12', [25.112, 55.388], 0, 45);
for (const hm of ['08:20', '08:30', '08:40', '08:50', '09:00']) await fx(hm, DSO);
await fx('09:05', DSO, 1, 0); await fx('09:12', [25.19, 55.36], 1, 55); await fx('09:20', GAR, 1, 0);
for (const hm of ['09:30', '09:40', '09:50', '10:00']) await fx(hm, GAR);
await fx('09:45', [0, 0]);
const cell = (p, area) => q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations) VALUES ($1,$2,$3,50,1,50)
  ON CONFLICT DO NOTHING`, [Math.round(p[0] / 0.005), Math.round(p[1] / 0.005), area]);
await cell(EMI, 'Emirates Rd'); await cell(DSO, 'Dubai Silicon Oasis'); await cell(GAR, 'Al Garhoud'); await cell(DEIRA, 'Deira');

await buildDay(q, { day: D, now: Date.parse(`${D}T23:30:00+04:00`) + 86400000 });
const segs = await q(`SELECT * FROM driver_move_segment WHERE person_id = $1 AND day = $2::date ORDER BY seq`, [PID, D]);
const wins = await q(`SELECT * FROM driver_move_window WHERE person_id = $1 AND day = $2::date`, [PID, D]);
check('the rollup keeps the day as a log — stops and drives in order — and which car was his when, with the tracker kept',
  segs.some((g) => g.kind === 'stop' && g.area === 'Emirates Rd') && segs.some((g) => g.kind === 'drive' && g.to_area === 'Dubai Silicon Oasis')
  && segs.every((g, i) => g.seq === i) && wins.length === 1 && wins[0].plate === 'L30001' && wins[0].source === 'fms'
  && wins[0].from_min === mm('07:04') && wins[0].to_min === mm('12:10'), JSON.stringify({ segs: segs.map((g) => `${g.kind}:${g.area || g.to_area}`), wins }));
const emi = segs.find((g) => g.kind === 'stop' && g.area === 'Emirates Rd');
check('…each stop split by what he was doing: online at Emirates Rd, waiting', emi.wait_min > 0 && emi.wait_min + emi.ontrip_min + emi.offline_min >= emi.minutes - 1,
  JSON.stringify(emi));

const { get } = await mountAll(pg);
const tk = (await get(`/api/driver/movement/track?id=${K}&from=2026-10-01&to=2026-10-31`)).body;
check('the route answers: his day, its stops and drives, the places he parks, and the path in pieces',
  tk.days?.length === 1 && tk.days[0].day === D && tk.stops.length >= 3 && tk.drives.length >= 2 && tk.parking.length >= 3
  && tk.routes.length >= 2 && tk.routes.every((r) => r.points.length >= 2 && r.day === D), JSON.stringify({ days: tk.days, routes: tk.routes?.length, parking: tk.parking?.length }).slice(0, 500));
const allPts = tk.routes.flatMap((r) => r.points);
check('the path is drawn only from his hours: none of the night man\'s Deira laps, no lost-lock 0,0',
  !allPts.some(([la, ln]) => Math.abs(la - DEIRA[0]) < 0.03 && Math.abs(ln - DEIRA[1]) < 0.01) && !allPts.some(([la, ln]) => Math.abs(la) < 1 && Math.abs(ln) < 1),
  JSON.stringify(allPts.slice(0, 8)));
check('the passenger leg is its own piece', tk.routes.some((r) => r.state === 'passenger') && tk.routes.some((r) => r.state === 'empty'),
  JSON.stringify(tk.routes.map((r) => r.state)));
const dso = tk.parking.find((x) => x.area === 'Dubai Silicon Oasis');
check('the place he waited is a parking spot with its minutes split', dso && dso.minutes >= 30 && dso.wait_min > 0, JSON.stringify(dso));
const nobody = await get(`/api/driver/movement/track?id=no-such-driver&from=2026-10-01&to=2026-10-31`);
check('an unknown driver is a 404, not an empty map', nobody.status === 404, String(nobody.status));
const empty = (await get(`/api/driver/movement/track?id=${K}&from=2026-07-01&to=2026-07-31`)).body;
check('a window with nothing built says so, never an empty route as if he never moved', empty.days.length === 0 && /no day in this window/.test(empty.absent || ''),
  JSON.stringify(empty));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
