/* One driver's movement per day, kept — and the range view over it
   (2026-11-24, the operator's step B: "where the driver spent time or roamed
   around … complete view for the duration selected").
   ──────────────────────────────────────────────────────────────────────────
     §1  what each minute was: on a job, online, or nothing working —
         bookings first, Uber's live status, the log-in record before it;
     §2  the minutes and km per cell: waiting online vs parked with nothing
         working, moving empty vs moving with the seat unreported (never
         "empty"), a passenger aboard, a quiet parked tracker as a stop with
         no km, online minutes the tracker did not see;
     §3  pickups and drop-offs placed, each by its rung: Uber's own job stage
         and the tracker, the booking's coordinates, the seat, the end time —
         and a cancelled booking is neither;
     §4  the whole path on a real Postgres: build a day for a person on the
         spine, read /api/driver/movement over a range, and Territory's
         waiting spots now come from the driver's own hours, in minutes.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { minuteStatus, rollupMovement, placePoints, buildDay, buildPersonDay, personsForDay, movementRollupTick } from '../src/movement_rollup.js';
import { driverScope } from '../api/driver_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const D = '2026-10-11';
const at = (hm, day = D) => new Date(`${day}T${hm}:00+04:00`).toISOString();
const mm = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const F = (hm, lat, lng, extra = {}) => ({ plate: 'L1', source: 'fms', at: at(hm), time: hm, m: mm(hm), lat, lng, speed: null, passenger: false, ...extra });

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 what the driver was doing, minute by minute');
{
  const st = minuteStatus({
    statusAll: [{ s: mm('08:00'), e: mm('10:00'), status: 'online' }, { s: mm('10:00'), e: mm('11:00'), status: 'offline' }],
    online: [{ s: mm('06:00'), e: mm('09:00') }],
    trips: [{ s: mm('09:10'), e: mm('09:40') }, { s: mm('10:20'), e: mm('10:30') }],
  });
  check('before the live feed\'s first word the log-in record says online; after it, the live feed decides',
    st[mm('06:30')] === 'online' && st[mm('08:30')] === 'online' && st[mm('10:45')] === null, JSON.stringify([st[mm('06:30')], st[mm('10:45')]]));
  check('a booking is a job from request to end, whatever the live feed said — even while it said offline',
    st[mm('09:20')] === 'ontrip' && st[mm('10:25')] === 'ontrip' && st[mm('09:40')] === 'online');
  const today = minuteStatus({ statusAll: [{ s: mm('08:00'), e: 1440, status: 'online' }], limit: mm('09:00') });
  check('today, nothing is claimed after now', today[mm('08:59')] === 'online' && today[mm('09:00')] === null);
}

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 minutes and km, per cell');
{
  const st = minuteStatus({ statusAll: [{ s: mm('08:00'), e: mm('09:00'), status: 'online' }, { s: mm('09:00'), e: 1440, status: 'offline' }],
    trips: [{ s: mm('08:30'), e: mm('08:45') }] });
  const A = [25.2000, 55.3000]; const B = [25.2300, 55.3300];
  const fixes = [
    F('08:00', ...A), F('08:10', ...A), F('08:20', ...A, { passenger: null }), // waiting online at A, 20 min
    F('08:30', 25.21, 55.31, { passenger: null, speed: 40 }),               // moving, seat unreported, 10 min
    F('08:36', 25.22, 55.32, { passenger: true, speed: 40 }),               // a passenger aboard
    F('08:44', ...B, { passenger: true, speed: 30 }),
    F('08:50', 25.2302, 55.3302, { passenger: false }),                     // stopped at B: on the job to 08:45, then waiting
    F('09:00', ...B), F('09:10', ...B),                                     // parked, offline
    F('10:16', 25.2301, 55.3301, { source: 'fms' }),                        // 66 min quiet, FMS: a silence (>30)
  ];
  const { day, cells } = rollupMovement({ fixes, status: st });
  check('waiting is stopped while online and on no job: 20 minutes at A and 15 at B once the job ended — not the 10 parked offline, nor the minute still on the job',
    day.wait_min === 35 && day.parked_offline_min === 10, JSON.stringify(day));
  check('a moving car whose seat nobody reported is NOT counted as empty',
    day.moving_seat_unknown_min === 10 && day.moving_empty_min === 0, JSON.stringify(day));
  check('a passenger aboard is counted, and the km with them', day.with_passenger_min === 14 && day.km_with_passenger > 0 && day.km > day.km_with_passenger,
    JSON.stringify(day));
  check('a 66-minute quiet gap on an FMS unit is a silence, not a stop (FMS is held to 30)', day.stopped_min === 46 && day.parked_quiet_min === 0, JSON.stringify(day));
  check('online minutes the tracker did not see are counted, not filled in', day.online_min === 60 && day.unseen_online_min === 0
    && day.seen_min > 0, JSON.stringify(day));
  const a = cells.find((c) => c.cell_lat === Math.round(A[0] / 0.005) && c.cell_lng === Math.round(A[1] / 0.005));
  check('the cell at A holds the waiting minutes, named by the grid place_cell uses', a && a.wait_min >= 20 && a.fixes === 3, JSON.stringify(a));
  const sumCells = (k) => Math.round(cells.reduce((s, c) => s + c[k], 0));
  check('the cells add up to the day', sumCells('stopped_min') === day.stopped_min && Math.abs(cells.reduce((s, c) => s + c.km, 0) - day.km) < 0.2,
    JSON.stringify({ cells: sumCells('stopped_min'), day: day.stopped_min }));
  const cab = rollupMovement({ fixes: [F('10:00', ...A, { source: 'cabman' }), F('11:06', 25.2002, 55.3002, { source: 'cabman' })],
    status: minuteStatus({ statusAll: [{ s: 0, e: 1440, status: 'online' }] }) });
  check('a CABMAN unit quiet and parked for 66 minutes is a stop, inferred, with no km', cab.day.stopped_min === 66
    && cab.day.parked_quiet_min === 66 && cab.day.km === 0 && cab.day.wait_min === 66, JSON.stringify(cab.day));
  /* The review of 2026-11-24. */
  const jump = rollupMovement({ fixes: [F('10:00', 25.10, 55.20), F('10:06', 0.0001, 0.0001), F('10:12', 25.1001, 55.2001)],
    status: minuteStatus({ statusAll: [{ s: 0, e: 1440, status: 'online' }] }) });
  const nullIsland = jump.cells.find((c) => c.cell_lat === 0 && c.cell_lng === 0);
  check('a fix at 0,0 adds no kilometres and no minutes anywhere', jump.day.km < 1 && (!nullIsland || (nullIsland.stopped_min === 0
    && nullIsland.moving_empty_min === 0 && nullIsland.km === 0)), JSON.stringify({ day: jump.day, nullIsland }));
  const job = rollupMovement({ fixes: [F('09:00', ...A), F('09:15', ...A), F('09:30', ...A)],
    status: minuteStatus({ statusAll: [{ s: mm('09:00'), e: mm('10:00'), status: 'online' }], trips: [{ s: mm('09:00'), e: mm('09:15') }] }) });
  const jc = job.cells[0];
  check('a stop on a job is neither waiting nor parked: the stop splits three ways and the three add up to it',
    Math.round(jc.stopped_ontrip_min) === 15 && Math.round(jc.wait_min) === 15 && jc.parked_offline_min === 0
    && Math.round(jc.wait_min + jc.stopped_ontrip_min + jc.parked_offline_min) === Math.round(jc.stopped_min), JSON.stringify(jc));
  const lone = rollupMovement({ fixes: [F('08:00', ...A)], status: minuteStatus({ statusAll: [{ s: mm('07:00'), e: mm('09:00'), status: 'online' }] }) });
  check('online for two hours with one fix: 120 online minutes, all unseen', lone.day.online_min === 120 && lone.day.unseen_online_min === 120,
    JSON.stringify(lone.day));
}

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 pickups and drop-offs, placed');
{
  const fixes = [F('08:00', 25.20, 55.30), F('08:05', 25.21, 55.31), F('08:10', 25.22, 55.32, { passenger: true }),
    F('08:25', 25.25, 55.35, { passenger: true }), F('08:30', 25.26, 55.36), F('09:30', 25.30, 55.40), F('09:58', 25.31, 55.41)];
  const trips = [
    { platform: 'uber', external_id: 'u1', plate: 'L1', outcome: 'completed', requested_at: at('07:58'), ended_at: at('08:30') },
    { platform: 'hotel', external_id: 'h1', plate: 'L1', outcome: 'completed', requested_at: at('09:00'), ended_at: at('09:20'),
      pickup_lat: 25.11, pickup_lng: 55.22, dropoff_lat: 25.12, dropoff_lng: 55.23 },
    { platform: 'bolt', external_id: 'b1', plate: 'L1', outcome: 'completed', requested_at: at('09:40'), ended_at: at('10:00') },
    { platform: 'uber', external_id: 'u2', plate: 'L1', outcome: 'not_completed', requested_at: at('09:00'), ended_at: at('09:05') },
  ];
  const stages = [{ job_ext_id: 'u1', state: 'DJ_PICKUP', at: at('08:04') }, { job_ext_id: 'u1', state: 'DJ_COMPLETED', at: at('08:29') }];
  const { points, counts } = placePoints({ trips, stages, fixes });
  const p = (id, kind) => points.find((x) => x.external_id === id && x.kind === kind);
  check('Uber\'s own pickup moment, placed by the car\'s nearest fix (one minute away)',
    p('u1', 'pickup')?.basis === 'uber_stage' && p('u1', 'pickup').gap_s === 60 && p('u1', 'pickup').lat === 25.21, JSON.stringify(p('u1', 'pickup')));
  check('…and its drop-off the same way', p('u1', 'dropoff')?.basis === 'uber_stage' && p('u1', 'dropoff').lat === 25.26);
  check('a booking with its own coordinates keeps them', p('h1', 'pickup')?.basis === 'booking' && p('h1', 'dropoff')?.lat === 25.12);
  check('a Bolt booking with no coordinates and no seat reading: no pickup (a request time is not a pickup time), the drop-off from its end time',
    !p('b1', 'pickup') && p('b1', 'dropoff')?.basis === 'trip_end' && p('b1', 'dropoff').gap_s === 120, JSON.stringify(points.filter((x) => x.external_id === 'b1')));
  check('a cancelled booking is neither a pickup nor a drop-off', !points.some((x) => x.external_id === 'u2')
    && counts.pickups === 3 && counts.pickups_placed === 2 && counts.dropoffs === 3 && counts.dropoffs_placed === 3, JSON.stringify(counts));
  const seat = placePoints({ trips: [{ platform: 'bolt', external_id: 'b2', plate: 'L1', outcome: 'completed', requested_at: at('08:01'), ended_at: at('08:40') }], fixes });
  check('with the seat reported, the first and last fix with a passenger aboard place the pickup and drop-off',
    seat.points.find((x) => x.kind === 'pickup')?.basis === 'seat' && seat.points.find((x) => x.kind === 'pickup').lat === 25.22
    && seat.points.find((x) => x.kind === 'dropoff')?.lat === 25.25, JSON.stringify(seat.points));
  const far = placePoints({ trips: [trips[0]], stages: [{ job_ext_id: 'u1', state: 'DJ_PICKUP', at: at('08:50') }], fixes: fixes.slice(0, 5) });
  check('a stage moment with no fix within five minutes is not placed from a distant one',
    !far.points.some((x) => x.kind === 'pickup' && x.basis === 'uber_stage'), JSON.stringify(far.points));
}

/* ── §4 ─────────────────────────────────────────────────────────────────── */
console.log('\n§4 the whole path: build a day, read a range');
const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
const K = 'kkkkkkkk-1111-4111-8111-000000000009';
const [{ id: PID }] = await q(`INSERT INTO driver (fleet_id, full_name) VALUES ('ecosine','Test Driver Kilo') RETURNING id`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES ('uber',$1,$2)`, [K, PID]);
const T = (hm) => `${D}T${hm}:00+04:00`;
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','k-1','ecosine','L30001',$1,'Test Driver Kilo',$2::timestamptz,$3::timestamptz,'completed',40,9)`, [K, T('09:00'), T('09:25')]);
await q(`INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, state, job_ext_id)
         VALUES ('uber','ecosine',$1,$2::timestamptz,'job','DJ_PICKUP','k-1'), ('uber','ecosine',$1,$3::timestamptz,'job','DJ_COMPLETED','k-1')`,
[K, T('09:05'), T('09:20')]);
const uberRow = (hm, status) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status, raw)
   VALUES ('uber','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3::jsonb)`,
  [T(hm), status, JSON.stringify({ driverInfo: { driverUuid: K, firstName: 'Test', lastName: 'Kilo' } })]);
await uberRow('07:04', 'ONLINE'); await uberRow('09:00', 'ONTRIP'); await uberRow('09:30', 'ONLINE'); await uberRow('12:10', 'OFFLINE');
const sev = (hm, status) => q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
  VALUES ('uber',$1,$2::timestamptz,$3,$4,'ecosine')`, [K, T(hm), status, `DRIVER_STATUS_${status.toUpperCase()}`]);
await sev('07:04', 'online'); await sev('09:00', 'ontrip'); await sev('09:30', 'online'); await sev('12:10', 'offline');
const fx = (hm, [lat, lng], seat = 0, speed = null) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
   VALUES ('fms','L30001','ecosine',$1::timestamptz,$1::timestamptz,$2,$3,$4,$5)`, [T(hm), lat, lng, speed, seat]);
const EMI = [25.1000, 55.4000]; const DSO = [25.1200, 55.3800]; const GAR = [25.2400, 55.3500]; const JLT = [25.0700, 55.1400];
for (const hm of ['06:00', '06:20', '06:40']) await fx(hm, JLT);                 // before his hours: not his
for (const hm of ['07:05', '07:15', '07:30', '07:45', '08:00']) await fx(hm, EMI);
await fx('08:06', [25.105, 55.395], 0, 40); await fx('08:12', [25.112, 55.388], 0, 45);
for (const hm of ['08:20', '08:30', '08:40', '08:50', '09:00']) await fx(hm, DSO);
await fx('09:05', DSO, 1, 0); await fx('09:12', [25.19, 55.36], 1, 55); await fx('09:20', GAR, 1, 0);
for (const hm of ['09:30', '09:40', '09:50', '10:00']) await fx(hm, GAR);
await fx('09:45', [0, 0]);                                                         // a lost lock, in his hours
const cell = (p, area) => q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations) VALUES ($1,$2,$3,50,1,50)
  ON CONFLICT DO NOTHING`, [Math.round(p[0] / 0.005), Math.round(p[1] / 0.005), area]);
await cell(EMI, 'Emirates Rd'); await cell(DSO, 'Dubai Silicon Oasis'); await cell(GAR, 'Al Garhoud');

check('the people who worked the day are found on the spine', (await personsForDay(q, D)).includes(Number(PID)));
const built = await buildDay(q, { day: D, now: Date.parse(`${D}T23:30:00+04:00`) + 86400000 });
check('the day is built for them', built.built === 1 && built.failed === 0, JSON.stringify(built));
const [row] = await q(`SELECT * FROM driver_move_day WHERE person_id = $1 AND day = $2::date`, [PID, D]);
check('the day row: his car, his tracker, the passenger minutes, waiting online at Emirates Rd and DSO',
  row && row.plates.join() === 'L30001' && row.sources.join() === 'fms' && row.with_passenger_min >= 14 && row.wait_min >= 40
  && row.pickups === 1 && row.pickups_placed === 1 && row.dropoffs_placed === 1, JSON.stringify(row));
await buildDay(q, { day: D, now: Date.parse(`${D}T23:30:00+04:00`) + 86400000 });
const [{ n: cellsAfter }] = await q(`SELECT count(*)::int n FROM driver_move_cell WHERE person_id = $1`, [PID]);
const [{ n: ptsAfter }] = await q(`SELECT count(*)::int n FROM driver_move_point WHERE person_id = $1`, [PID]);
check('building the same day again replaces it, never adds', cellsAfter > 0 && cellsAfter < 20 && ptsAfter === 2, `${cellsAfter} cells, ${ptsAfter} points`);

const { get } = await mountAll(pg);
const mv = (await get(`/api/driver/movement?id=${K}&from=2026-10-01&to=2026-10-31`)).body;
check('the range view answers over the kept days: totals, cells with their area names, points with their rung',
  mv.totals?.days === 1 && mv.totals.wait_min === row.wait_min && mv.cells.some((c) => c.area === 'Dubai Silicon Oasis' && c.wait_min > 0)
  && mv.points.filter((p) => p.basis === 'uber_stage').length === 2 && mv.points_summary.pickups_by.uber_stage === 1,
  JSON.stringify({ totals: mv.totals, cells: mv.cells?.length, points: mv.points }).slice(0, 600));
check('…and by area, most time first', mv.areas[0]?.area && mv.areas.some((a) => a.area === 'Al Garhoud'), JSON.stringify(mv.areas));
check('the night man\'s hour at JLT is not in it — positions outside his hours are the car\'s, not his',
  !mv.cells.some((c) => Math.abs(c.lat - JLT[0]) < 0.003 && Math.abs(c.lng - JLT[1]) < 0.003));
const before = (await get(`/api/driver/movement?id=${K}&from=2026-07-01&to=2026-07-31`)).body;
check('a window before live collection began says so, rather than showing a driver who never moved',
  before.totals === null && /when live collection began/.test(before.coverage.absent || ''), JSON.stringify(before.coverage));
const byPerson = (await get(`/api/driver/movement?person=${PID}&from=2026-10-01&to=2026-10-31`)).body;
check('addressed by person, the same answer', byPerson.totals?.wait_min === mv.totals.wait_min);
const nobody = (await get(`/api/driver/movement?id=no-such-driver&from=2026-10-01&to=2026-10-31`));
check('an unknown driver is a 404, not an empty movement', nobody.status === 404, String(nobody.status));

/* A lost-lock fix inside his hours never reaches the rollup (REAL_FIX). */
const [{ n: island }] = await q(`SELECT count(*)::int n FROM driver_move_cell WHERE person_id = $1 AND abs(cell_lat) < 200 AND abs(cell_lng) < 200`, [PID]);
check('a 0,0 fix in his hours draws no cell in the Gulf of Guinea and no thousands of km', island === 0 && Number(row.km) < 100, `${island} cells near 0,0, ${row.km} km`);

/* A person-day that cannot be built is recorded as such, with the true
   reason, and the range view says so — never a day he did not work. */
const D2 = '2026-10-12';
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('uber','k-2','ecosine','L30001',$1,'Test Driver Kilo',$2::timestamptz,$3::timestamptz,'completed',30,5)`,
[K, `${D2}T10:00:00+04:00`, `${D2}T10:20:00+04:00`]);
const failedBuild = await buildDay(q, { day: D2, resolve: async () => ({ unresolvable: 'spine-unreadable' }) });
const [frow] = await q(`SELECT failed, absent FROM driver_move_day WHERE person_id = $1 AND day = $2::date`, [PID, D2]);
check('an unresolvable person-day is counted as failed and written with its reason, not skipped in silence',
  failedBuild.failed === 1 && failedBuild.built === 0 && frow?.failed === true && /person register could not be read/.test(frow.absent || ''),
  JSON.stringify({ failedBuild, frow }));
const fv = (await get(`/api/driver/movement?id=${K}&from=${D2}&to=${D2}`)).body;
check('…and the range view says the day could not be built, not that he did not work',
  /could not be built/.test(fv.coverage.absent || '') && !/no booking and no working status/.test(fv.coverage.absent || ''), JSON.stringify(fv.coverage));

/* The writes are one transaction: a failure part-way leaves the old day whole. */
const pgTx = async (fn) => { await q('BEGIN'); try { const r = await fn(q); await q('COMMIT'); return r; } catch (e) { await q('ROLLBACK'); throw e; } };
const breakPoints = async (fn) => pgTx((w) => fn((t, p) => (/INSERT INTO driver_move_point/.test(t) ? Promise.reject(new Error('disk full')) : w(t, p))));
const [{ n: cellsBefore }] = await q(`SELECT count(*)::int n FROM driver_move_cell WHERE person_id = $1 AND day = $2::date`, [PID, D]);
const resolve = driverScope({ q, wrap: (f) => f }).resolve;
let threw = false;
try { await buildPersonDay(q, { personId: Number(PID), day: D, resolve, now: Date.parse(`${D}T23:30:00+04:00`) + 86400000, tx: breakPoints }); } catch { threw = true; }
const [{ n: cellsAfterFail }] = await q(`SELECT count(*)::int n FROM driver_move_cell WHERE person_id = $1 AND day = $2::date`, [PID, D]);
check('a write that fails part-way rolls back: the day keeps its cells', threw && cellsBefore > 0 && cellsAfterFail === cellsBefore,
  `${cellsBefore} before, ${cellsAfterFail} after`);

/* The first pass after deploy at 04:47 Dubai still builds yesterday. */
await q(`DELETE FROM driver_move_day WHERE day = $1::date`, [D]);
await q(`DELETE FROM source_state WHERE source = 'movement_rollup'`);
await movementRollupTick(q, { now: Date.parse('2026-10-12T04:47:00+04:00'), backfillDays: 1 });
const [again] = await q(`SELECT day FROM driver_move_day WHERE person_id = $1 AND day = $2::date`, [PID, D]);
check('a first pass at 04:47 leaves no day out: the backfill starts at yesterday when there is no cursor yet', !!again);

const terr = (await get(`/api/driver/territory?id=${K}&from=2026-10-01&to=2026-10-31`)).body;
const dso = terr.idle.find((s) => s.area === 'Dubai Silicon Oasis');
check('Territory\'s waiting spots are minutes in his own hours, split waiting online / parked, and named — not a count of fixes',
  dso && dso.wait_min >= 30 && dso.stopped_min >= dso.wait_min && !('fixes' in dso) && terr.idle_absent === null,
  JSON.stringify(terr.idle));
check('…and the car\'s parked hour at JLT before his shift is not one of them',
  !terr.idle.some((s) => Math.abs(s.lat - JLT[0]) < 0.003 && Math.abs(s.lng - JLT[1]) < 0.003), JSON.stringify(terr.idle));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
