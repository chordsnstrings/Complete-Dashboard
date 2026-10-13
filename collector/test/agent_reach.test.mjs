/* The assistant's second reach: hours, live, money and places (2026-10-13).
   ──────────────────────────────────────────────────────────────────────────
   The operator: "let the chat have access to driver online hours, logged in
   time, shift durations or break times · live car positions or real-time
   driver status · full ledger balances, driver statement line items, payment
   settlement history · historical location based on time".

   Eleven tools (api/agent_tools.js) over the routes the pages already read,
   and one new route (api/where_routes.js) for the question no page answered
   in words: where was this car at that time. This file runs every tool
   against the REAL routes on a synthetic fleet — one driver, one car, one
   Sunday — and then again behind the REAL gate with real roles, because the
   whole of the assistant's access story is that each tool is the asker's own
   GET:

     §1  hours: a day's log-in sessions and the break between them, read off
         Uber's timeline exactly as the driver page reads it; the period's
         hours equal /api/driver/daily's; a day with no record says so;
     §2  live: area names on the live map's rows, live vs stale, a driver's
         car found through Uber's live record, statuses with counts;
     §3  places: "3pm" read by the server, never by the model; a bare "3"
         asked back; the nearest fix and who was driving; a stretch's stops;
         every car at one moment;
     §4  money: balances, the money statement's lines without the
         verification row, the platform statements' totals, and payouts;
     §5  access: a Finance manager (no locations) is told positions are
         withheld — never handed area names through the new `place` field —
         and refused the history route; a Dispatcher (no cash) is refused the
         ledger in the gate's words;
     §6  the chat end to end: a placeholder of kind hours reads "11h 15m";
     §7  the independent review's thirteen findings, each held: absences
         that read as zeros, refusals that read as absences, a sentence that
         carried booking times past a role holding bookings as totals only,
         one person on two accounts read as a handover, midnight edges, the
         pay book's sign, "at night", and two guard false refusals.

   Proved by revert, each run against this file as it now stands (58 checks,
   2026-10-13). The first round's seven, re-run after §7 was added (each
   count is higher than it was, because §7 leans on the same code):
     · '[].place' taken out of /api/live's LOC paths in the manifest: the
       Finance manager is handed "Deira" through the new field — 1 fails.
     · live_cars ignoring the gate's x-fm-withheld (locHidden false): the
       Finance manager's cars vanish and the tool says no tracker is on
       record — 2 fail.
     · whereabouts sending the person's words straight to the route
       (at=3pm): the route refuses it and the moment is lost — 4 fail.
     · driver_shift without the one-minute join: a floored minute between two
       spans reads as a break, and the chat says "11h 14m with 2 breaks" —
       5 fail.
     · ledger_entries keeping verification rows: the production ritual's row
       is shown as a real line — 1 fails.
     · formatValue's hours rule removed: "11.25" reaches the person — 3
       fail.
     · /api/live without placeAt: every area is null, for the Dispatcher
       too — 3 fail.
   The review's thirteen (§7), each reverted alone:
     · driver_at_why's paths left off BK in the manifest: a Fleet technician
       reads "16:00 … 17:00" in the handover sentence — 1 fails.
     · /api/where comparing trips by account, not by person_key: one man on
       Uber then Bolt is read as a handover — 1 fails.
     · driver_shift ignoring the midnight edges: a log-out at "24:00" and a
       log-in at "00:00" the driver never made — 2 fail.
     · driver_status keeping the minute figures on a no-day answer: "0 min
       online" for a driver nobody measured — 1 fails.
     · ledger_balances taking the pay book's stored sign as owed: money the
       company owes reads as money the driver owes — 1 fails.
     · platform_statements keeping cash lines past a role without CASH (the
       shaper does not enforce `components[category=…]` paths) — 1 fails.
     · start_times reading a withheld verdict as "not judged" — 1 fails.
     · live_cars reading the gate's refusal as "no car on record" — 1 fails.
     · whereabouts saying "0 stops" over a stretch with one position — 1
       fails.
     · the guard matching a platform or fleet by key prefix (fleet_hours'
       `fleet_id` read as a fleet name) — 1 fails.
     · the guard not absorbing "hours" after an hours figure: "11h 15m
       hours" — 1 fails.
     · "10 at night" read as 22:00's afternoon twin — 1 fails.
     · driver_hours counting withheld trips as zero days worked — 1 fails.
   Production's five (§8, after the first conversation with the real model),
   each reverted alone against the 72-check file:
     · live_cars without the fill under Uber's coordinate-free rows: the car
       eight minutes from its fix reads "no tracker position" — 4 fail.
     · one car's last fix today not asked of /api/where — 2 fail.
     · the guard without a row's own fleet/platform cell — 2 fail.
     · a cell CONTAINING the word accepted ("bolt, uber" as Uber's) — 1 fails.
     · driver_shift not marked as Uber's record — 1 fails.
     · ledger balances labelled with the period asked — 1 fails.
     · plain labels keeping their unit ("fares aed AED") — 1 fails.
   Not proved by revert: live_cars taking a filled car's age from the fix's
   own instant rather than the route's gap_min (to the truncated minute) —
   the two differ by under a minute, which a check cannot pin without
   freezing the database's clock. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { accessLayer } from '../api/access/middleware.js';
import * as svc from '../api/access/service.js';
import { hashPassword } from '../api/access/crypto.js';
import { agentTest } from '../api/agent_routes.js';
import { toolbox } from '../api/agent_tools.js';
import { resolveClock } from '../api/agent_period.js';
import { formatValue, checkReply, plainAnswer } from '../api/agent_guard.js';
import { findStops } from '../api/where_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const db = { query: (t, p) => pg.query(t, p) };
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

/* ── the fleet ─────────────────────────────────────────────────────────── */
const A = 'aaaaaaaa-3333-4333-8333-000000000001';     // Test Driver Alpha, Uber, car L19262
const NAME = 'Test Driver Alpha';
const D = '2026-10-11';                                // a Sunday
const D0 = '2026-10-10';                               // a day with trips and no log-in record
const T = (day, hhmm) => `${day}T${hhmm}:00+04:00`;
let tn = 0;
const trip = (day, from, to, price = 30, payment = 'card') => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at,
                     status, price, distance_km, payment_type)
   VALUES ('uber',$1,'egari','L19262',$2,$3,$4::timestamptz,$5::timestamptz,'completed',$6,8,$7)`,
  [`ar${++tn}`, A, NAME, T(day, from), T(day, to), price, payment]);
await trip(D, '10:00', '10:20');
await trip(D, '14:40', '15:05', 45, 'cash');
await trip(D, '18:00', '18:30');
await trip(D0, '11:00', '11:25');
await trip(D0, '16:00', '16:30');
/* The same man on his Bolt account in the same car (one person, two
   accounts: the name folds to one person_key), and a second driver who takes
   the car at 17:00 — so 15:30 is between ONE person's trips and 16:30 is a
   handover. */
const B = 'aaaaaaaa-3333-4333-8333-000000000002'; const NAME_B = 'Test Driver Bravo';
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
         VALUES ('bolt','ar-bolt-1','egari','L19262','7000999',$1,$2::timestamptz,$3::timestamptz,'completed',20,5),
                ('uber','ar-b-1','egari','L19262',$4,$5,$6::timestamptz,$7::timestamptz,'completed',25,6)`,
[NAME, T(D, '16:00'), T(D, '16:20'), B, NAME_B, T(D, '17:00'), T(D, '17:20')]);

/* Uber's timeline for the Sunday: online 08:00, a blip at 12:00:30 back at
   12:01:10 (one floored minute — not a break), off at 13:00, back at 13:45
   (a real 45-minute break), off at 20:00. */
const ev = (at, status) => q(
  `INSERT INTO driver_timeline_event (platform, driver_ext_id, fleet_id, at, kind, status, state)
   VALUES ('uber',$1,'egari',$2::timestamptz,'status',$3,'')`, [A, at, status]);
await ev(T(D, '08:00'), 'ONLINE');
await ev(`${D}T12:00:30+04:00`, 'OFFLINE');
await ev(`${D}T12:01:10+04:00`, 'ONLINE');
await ev(T(D, '13:00'), 'OFFLINE');
await ev(T(D, '13:45'), 'ONLINE');
await ev(T(D, '20:00'), 'OFFLINE');
/* Bravo's night shift: online 23:00 on the Sunday, off 01:30 on Monday. */
await q(`INSERT INTO driver_timeline_event (platform, driver_ext_id, fleet_id, at, kind, status, state)
         VALUES ('uber',$1,'egari',$2::timestamptz,'status','ONLINE',''), ('uber',$1,'egari',$3::timestamptz,'status','OFFLINE','')`,
[B, T(D, '23:00'), T('2026-10-12', '01:30')]);
await q(`INSERT INTO collection_run (source, fleet_id, mode, status, started_at, finished_at)
         VALUES ('uber_timeline','egari','incremental','ok', now() - interval '1 hour', now())`).catch(() => {});

/* The kept per-day record, as src/rollup.js writes it: 675 minutes online on
   the Sunday (08:00–13:00 and 13:45–20:00), 75 on a job; the Saturday has
   trips and NULL online — never collected, which is not zero. */
await q(`INSERT INTO driver_day (driver_ext_id, day, fleet_id, platforms, plates, trips, completed, cancelled, km,
           online_min, idle_online_min, on_job_min, first_min, last_min, longest_wait_min)
         VALUES ($1,$2,'egari',ARRAY['uber'],ARRAY['L19262'],3,3,0,24,675,600,75,600,1110,175),
                ($1,$3,'egari',ARRAY['uber'],ARRAY['L19262'],2,2,0,16,NULL,NULL,55,660,990,275)`, [A, D, D0]);
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, can_earn, plate, observed_at)
         VALUES ('uber',$1,'egari',$2,'active',true,'L19262',now())`, [A, NAME]);
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, driver_name, platform, trips, km, revenue,
           first_trip_at, last_trip_at, is_primary)
         VALUES ('L19262',$1::date,$2,$3,'uber',3,24,105,$4::timestamptz,$5::timestamptz,true)`,
[D, A, NAME, T(D, '10:00'), T(D, '18:00')]);

/* The car's tracker on the Sunday, and the gazetteer naming its ground.
   Parked in Deira 14:00–14:30, driving to Za'abeel, parked there 15:10–15:40. */
const DEIRA = [25.2701, 55.3178]; const ZAB = [25.2219, 55.3001];
const fix = (at, [lat, lng], speed, plate = 'L19262', source = 'fms', fleet = 'egari', seat = null) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, seat_count)
   VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz,$5,$6,$7,$8)`, [source, plate, fleet, at, lat, lng, speed, seat]);
for (const hm of ['14:00', '14:10', '14:20', '14:30']) await fix(T(D, hm), DEIRA, 0);
await fix(T(D, '14:52'), [25.246, 55.309], 42, 'L19262', 'fms', 'egari', 1);
for (const hm of ['15:10', '15:20', '15:30', '15:40']) await fix(T(D, hm), ZAB, 0);
for (const hm of ['16:40', '16:50']) await fix(T(D, hm), ZAB, 0);
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations)
         VALUES ($1,$2,'Deira',551,3,950), ($3,$4,'Za''abeel 1',40,1,40)`,
[Math.round(DEIRA[0] / 0.005), Math.round(DEIRA[1] / 0.005), Math.round(ZAB[0] / 0.005), Math.round(ZAB[1] / 0.005)]);

/* Live: L19262 reported two minutes ago in Deira, moving, a passenger
   aboard; L55555 last reported three days ago (stale); an Uber status row
   with no coordinates, which is not a position. */
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
await fix(ago(2), DEIRA, 35, 'L19262', 'fms', 'egari', 1);
await fix(ago(3 * 1440), ZAB, 0, 'L55555', 'cabman', 'ecosine');
await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status)
         VALUES ('uber','L77777','ecosine',$1::timestamptz,$1::timestamptz,'online')`, [ago(1)]);
await q(`INSERT INTO driver_status_now (platform, driver_ext_id, fleet_id, status, status_raw, status_at, observed_at, plate)
         VALUES ('uber',$1,'egari','ontrip','DRIVER_STATUS_ONTRIP',$2,now(),'L19262')`, [A, ago(10)]);
await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, status_raw, fleet_id)
         VALUES ('uber',$1,$2,'online','DRIVER_STATUS_ONLINE','egari'), ('uber',$1,$3,'ontrip','DRIVER_STATUS_ONTRIP','egari')`,
[A, ago(60), ago(10)]);

/* Money: one person, an advance part-repaid, a salary paid, and the
   production ritual's verification row, which is never a real debt. */
await q(`INSERT INTO ledger_policy (pct, effective_from, set_by, note) VALUES (35.00, '2026-01-01', 'ahsan', 'test')`);
await q(`INSERT INTO driver (id, full_name) VALUES (501, $1)`, [NAME]);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis) VALUES ('uber',$1,501,'human:ahsan')`, [A]);
const entry = (type, dir, book, amt, on, src = 'manual', note = 'test') => q(
  `INSERT INTO driver_ledger (person_id, person_name, resolved_from, type_code, direction, book, amount,
                              effective_on, entered_by, note, entry_source)
   VALUES (501,$1,'human:ahsan',$2,$3,$4,$5,$6::date,'ahsan',$7,$8)`, [NAME, type, dir, book, amt, on, note, src]);
await entry('cash_advance', 1, 'advance', 500, '2026-10-01');
await entry('repayment', -1, 'advance', -200, '2026-10-05');
await entry('salary', -1, 'pay', -1500, '2026-10-06');
await entry('cash_advance', 1, 'advance', 1, '2026-10-07', 'verification', 'production ritual');
await q(`INSERT INTO driver_payout_day (platform, driver_ext_id, day, period_start, period_end, earnings, cash_earnings)
         VALUES ('uber',$1,$2::date,'2026-10-05','2026-10-11',105,45)`, [A, D]);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day, gross, fees, net, tips, cash, salik, source)
         VALUES ('uber','egari',$1,$2,$3::date,300,75,225,5,45,4,'api')`, [NAME, A, D]);
const comp = (category, parent, amount) => q(
  `INSERT INTO driver_earnings_component (platform, driver_ext_id, fleet_id, period_start, period_end, category, parent, amount, currency)
   VALUES ('uber',$1,'egari','2026-10-05','2026-10-11',$2,$3,$4,'AED')`, [A, category, parent, amount]);
await comp('your_earnings', null, 230); await comp('fare', 'your_earnings', 300);
await comp('service_fee', 'your_earnings', -75); await comp('tip', 'your_earnings', 5);
await comp('payouts', null, -45); await comp('cash_collected', 'payouts', -45);
await q(`INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount, currency, period_start, period_end, method, source)
         VALUES ('uber','ecosine','u1','2026-10-06',12000.50,'AED','2026-09-29','2026-10-05','bank','test'),
                ('bolt','egari','b1','2026-10-05',1290.67,'AED',NULL,NULL,'bank','test')`);

/* ── the two mounts: the routes bare, and the routes behind the real gate ── */
const bare = await mountAll(pg);
const layer = accessLayer({ db });
const gated = await mountAll(pg, { pre: (app) => { app.use(layer.identify); app.use(layer.gate); } });
const NOW = Date.parse('2026-10-13T10:00:00+04:00');
agentTest.now = () => NOW;

const fetchVia = (port, cookie = '') => async (path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: cookie ? { cookie } : {} });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body, withheld: r.headers.get('x-fm-withheld') };
};
function harness(fetchApi, clock = () => NOW) {
  const run = toolbox({ fetchApi, now: clock });
  let n = 0;
  const ctx = { results: new Map(), drivers: new Map([[A, { name: NAME, ids: [A] }]]),
    store(r) { const id = `r${++n}`; const s = { id, ...r }; this.results.set(id, s); return s; } };
  ctx.drivers.set(B, { name: NAME_B, ids: [B] });
  return (name, args) => run(name, args, ctx);
}
const tool = harness(fetchVia(bare.port));

/* ── §1 hours ─────────────────────────────────────────────────────────── */
console.log('\n§1 hours, log-ins and breaks');
const sh = await tool('driver_shift', { driver_id: A, day: D });
check('two sessions: the one-minute blip at 12:00 is not a break', sh.values?.sessions === 2, JSON.stringify(sh.values));
check('…one 45-minute break, 13:00 to 13:45', sh.values?.breaks === 1 && sh.values?.longest_break_minutes === 45
  && sh.rows?.some((r) => r.what.startsWith('Break') && r.from === '13:00' && r.to === '13:45'), JSON.stringify(sh.rows));
check('logged in 675 minutes, first log-in 08:00, last log-out 20:00, a 12-hour shift span',
  sh.values?.logged_in_minutes === 675 && sh.values?.first_logged_in === '08:00' && sh.values?.last_logged_out === '20:00'
  && sh.values?.shift_span_minutes === 720, JSON.stringify(sh.values));
check('…and the day\'s trips beside it: 4 over both his accounts (3 Uber, 1 Bolt), first at 10:00',
  sh.values?.trips === 4 && sh.values?.first_trip === '10:00', JSON.stringify(sh.values));
check('the result is about this driver, for the guard', sh.filters?.driver === NAME && /Test Driver Alpha/.test(sh.definition));

const hr = await tool('driver_hours', { driver_id: A, from: D0, to: D });
const daily = (await bare.get(`/api/driver/daily?id=${A}&from=${D0}&to=${D}`)).body;
check('the period\'s online hours are the driver page\'s own (/api/driver/daily)',
  hr.values?.online_hours === 11.25 && Number(daily.find((r) => r.day === D)?.hours_online) === 11.25, JSON.stringify(hr.values));
check('a day with trips and no log-in record is "not reported", never zero',
  hr.rows?.find((r) => r.day === D0)?.online_h === null && hr.rows.find((r) => r.day === D0).hours_from === 'not reported'
  && /not zero/.test(hr.note || ''), JSON.stringify(hr.rows?.find((r) => r.day === D0)));
check('…and the totals count only the day that has hours', hr.values?.days_with_online_hours === 1 && hr.values?.days_worked === 2);

const st = await tool('start_times', { day: D, start: '7am' });
const me = st.rows?.find((r) => r.driver_id === A);
check('start_times reads "7am" itself and marks an 08:00 log-in late by 60 minutes',
  st.values?.start === '07:00' && me?.came_online === '08:00' && me?.late === 'late' && me?.minutes_late === 60, JSON.stringify(me));
const fh = await tool('fleet_hours', { from: D0, to: D });
check('fleet_hours carries the measured hours per driver', fh.rows?.find((r) => r.driver_id === A)?.online_h === 11.3
  || fh.rows?.find((r) => r.driver_id === A)?.online_h === 11.2, JSON.stringify(fh.rows?.find((r) => r.driver_id === A)));

/* ── §2 live ──────────────────────────────────────────────────────────── */
console.log('\n§2 live cars and live statuses');
const live = (await bare.get('/api/live')).body;
check('the live map\'s rows now carry the ground\'s name', live.find((r) => r.plate === 'L19262')?.place?.area === 'Deira',
  JSON.stringify(live.find((r) => r.plate === 'L19262')?.place));
const lc = await tool('live_cars', {});
check('live_cars: two cars with a position — the Uber status row is not one', lc.values?.cars_with_a_position === 2
  && !lc.rows.some((r) => r.plate === 'L77777'), JSON.stringify(lc.values));
check('…one live, one stale, the live one first, moving with a passenger, in Deira',
  lc.values?.live === 1 && lc.values?.stale === 1 && lc.rows[0].plate === 'L19262' && lc.rows[0].area === 'Deira'
  && lc.rows[0].motion === 'moving' && lc.rows[0].passenger === 'yes', JSON.stringify(lc.rows[0]));
const lcd = await tool('live_cars', { driver_id: A });
check('a driver\'s car is found through Uber\'s live record', lcd.values?.plate === 'L19262' && /live record/.test(lcd.note || ''),
  JSON.stringify(lcd.values));
const ds = await tool('driver_status', { driver_id: A });
check('driver_status: on a trip, in L19262', ds.values?.status === 'on a trip' && ds.values?.car === 'L19262', JSON.stringify(ds.values));
const df = await tool('driver_status', {});
check('…and the fleet\'s counts', df.values?.on_trip === 1 && df.values?.drivers === 1, JSON.stringify(df.values));

/* ── §3 places ────────────────────────────────────────────────────────── */
console.log('\n§3 where a car was, when');
check('the clock: "3pm" is 15:00, "between 2 and 5pm" is 14:00–17:00, a bare "3" is asked back',
  resolveClock('3pm', NOW).hhmm === '15:00' && resolveClock('between 2 and 5pm', NOW).from === '14:00'
  && resolveClock('3', NOW).ok === false && resolveClock('3', NOW).options.join() === '03:00,15:00');
const w3 = await tool('whereabouts', { plate: 'L19262', day: D, time: '3pm' });
check('at 3pm the nearest fix is 14:52, 8 minutes off, moving with a passenger',
  w3.values?.position_time === '14:52' && w3.values?.minutes_from_moment === 8 && w3.values?.motion === 'moving'
  && w3.values?.passenger === 'yes', JSON.stringify(w3.values));
check('…with the fixes either side of 15:00: 14:52 on ground nothing has named, 15:10 in Za\'abeel 1',
  w3.values?.position_before === '14:52' && w3.values?.position_after === "15:10 in Za'abeel 1", JSON.stringify(w3.values));
check('…and the driver is named from the trip in progress (14:40–15:05)',
  w3.values?.driver === NAME && w3.values?.driving_basis === 'on a trip (Uber) from 14:40 to 15:05', JSON.stringify(w3.values));
const w3b = await tool('whereabouts', { plate: 'L19262', day: D, time: '3' });
check('a bare "3" is an error with both readings to offer, not a guess', w3b.error && /03:00 \/ 15:00/.test(w3b.note || ''),
  JSON.stringify(w3b));
const wFar = await tool('whereabouts', { plate: 'L19262', day: D, time: '9am' });
check('a moment with no fix within 30 minutes is absent with the reason', !wFar.values?.area && /too far/.test(wFar.note || ''),
  JSON.stringify(wFar).slice(0, 300));
const wSpan = await tool('whereabouts', { driver_id: A, day: D, time: 'between 2 and 4pm' });
check('a driver is placed in the car their bookings put them in', wSpan.filters?.plate === 'L19262' && wSpan.filters?.driver === NAME);
check('…the stretch has two stops, Deira 14:00–14:30 and Za\'abeel 1 15:10–15:40',
  wSpan.rows?.length === 2 && wSpan.rows[0].area === 'Deira' && wSpan.rows[0].minutes === 30
  && wSpan.rows[1].from === '15:10' && wSpan.rows[1].to === '15:40', JSON.stringify(wSpan.rows));
check('…and the areas in order', wSpan.values?.areas_in_order === "Deira → Za'abeel 1", wSpan.values?.areas_in_order);
const wFleet = await tool('whereabouts', { day: D, time: '14:15' });
check('every car at one moment, with a count per area', wFleet.values?.cars === 1 && wFleet.values?.cars_in_deira === 1,
  JSON.stringify(wFleet.values));
check('findStops needs ten minutes in one place', findStops([
  { at: T(D, '10:00'), time: '10:00', lat: 25.27, lng: 55.31, area: 'X' },
  { at: T(D, '10:05'), time: '10:05', lat: 25.27, lng: 55.31, area: 'X' }]).length === 0);

/* ── §4 money ─────────────────────────────────────────────────────────── */
console.log('\n§4 balances, statement lines, platform statements, payouts');
const lb = await tool('ledger_balances', { driver_id: A });
check('advances owed 300 (500 out, 200 back), the verification row not counted', lb.values?.advance_owed_aed === 300,
  JSON.stringify(lb.values));
check('…cash held unknown with the reason, cash taken a ceiling', lb.values?.cash_held_aed === undefined
  && lb.values?.cash_taken_aed === 45 && /no opening cash position/.test(lb.note || ''), JSON.stringify(lb.values));
const le = await tool('ledger_entries', { driver_id: A });
check('the statement lists three real lines and not the verification row',
  le.values?.entries === 3 && le.rows.length === 3 && !le.rows.some((r) => /ritual/.test(r.note || '')), JSON.stringify(le.values));
check('…with the books\' totals: advance 300, pay −1,500', le.values?.advance_book_aed === 300 && le.values?.pay_book_aed === -1500);
const ps = await tool('platform_statements', { driver_id: A, from: '2026-10-05', to: D });
check('platform statements: gross 300, fees 75, net 225, cash 45',
  ps.values?.statement_gross_aed === 300 && ps.values?.platform_fees_aed === 75 && ps.values?.statement_net_aed === 225
  && ps.values?.cash_collected_aed === 45, JSON.stringify(ps.values));
check('…and the line items with the group each sits in', ps.rows?.some((r) => r.line === 'service fee' && r.under === 'your earnings' && r.amount_aed === -75));
const po = await tool('payouts', { from: '2026-10-01', to: D });
check('payouts: two transfers, per platform and fleet', po.values?.transfers === 2 && po.values?.uber_ecosine_aed === 12000.5
  && po.values?.bolt_egari_aed === 1290.67, JSON.stringify(po.values));
check('…and a transfer the platform did not date says so', po.rows?.find((r) => r.platform === 'bolt')?.settles === 'not stated by the platform');

/* ── §5 access ────────────────────────────────────────────────────────── */
console.log('\n§5 each tool is the asker\'s own GET');
const cfg = await svc.getConfig(db, { fresh: true });
async function person(email, role, fleets = null) {
  const u = await svc.createUser(db, { email, name: `Test ${role}`, status: 'active', passwordHash: hashPassword('a long enough test password') });
  await svc.createGrant(db, { userId: u.id, roleCode: role, fleets, reason: 'test' });
  const s = await svc.createSession(db, { userId: u.id, mfaOk: true, cfg });
  return `fm_sid=${s.token}; fm_csrf=testcsrf`;
}
const FIN = harness(fetchVia(gated.port, await person('fin-reach@example.test', 'FIN')));
const DSP = harness(fetchVia(gated.port, await person('dsp-reach@example.test', 'DSP')));
const finLive = await FIN('live_cars', {});
check('a Finance manager (no locations) still gets the cars, with every area withheld',
  finLive.values?.cars_with_a_position === 2 && finLive.rows.every((r) => r.area === null), JSON.stringify(finLive.rows?.map((r) => r.area)));
check('…and is told positions are withheld, not that no tracker reported',
  /withheld from this person's role/.test(finLive.note || ''), finLive.note);
const finWhere = await FIN('whereabouts', { plate: 'L19262', day: D, time: '3pm' });
check('…and the location history is refused in the gate\'s words', /locations|not shown/i.test(finWhere.withheld || ''),
  JSON.stringify(finWhere).slice(0, 240));
const dspLedger = await DSP('ledger_balances', { driver_id: A });
check('a Dispatcher (no cash) is refused the ledger, never handed a zero',
  dspLedger.withheld && !dspLedger.values, JSON.stringify(dspLedger).slice(0, 240));
const dspLive = await DSP('live_cars', { plate: 'L19262' });
check('…while the Dispatcher, who holds locations, sees where the car is', dspLive.values?.area === 'Deira', JSON.stringify(dspLive.values));

/* ── §6 the chat end to end ───────────────────────────────────────────── */
console.log('\n§6 a placeholder of kind hours, as the person reads it');
check('formatValue: 11.25 hours is "11h 15m", 45 minutes is "45 min"',
  formatValue(11.25, 'hours') === '11h 15m' && formatValue(45, 'min') === '45 min' && formatValue(675, 'min') === '11h 15m');
let script = [];
agentTest.model = async () => { const s = script.shift(); if (!s) throw Object.assign(new Error('out'), { code: 'unreachable' }); return s; };
let cn = 0;
const call = (name, args) => ({ model: 'm', fallback: false,
  message: { content: '', tool_calls: [{ id: `c${++cn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
script = [
  call('find_driver', { name: NAME }),
  call('driver_shift', { driver_id: A, day: D }),
  { model: 'm', fallback: false, message: { content: `${NAME} was logged in for {{r2.logged_in_minutes}} with {{r2.breaks}} break of {{r2.longest_break_minutes}}.` } },
];
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name) VALUES ('uber',$1,'egari',$2)`, [A, NAME]).catch(() => {});
const r = await fetch(`http://127.0.0.1:${bare.port}/api/agent/chat`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: `How long was ${NAME} logged in on Sunday?` }) });
const events = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const last = events[events.length - 1];
check('the answer reads "logged in for 11h 15m with 1 break of 45 min"',
  last?.text === `${NAME} was logged in for 11h 15m with 1 break of 45 min.`, JSON.stringify(last).slice(0, 400));

/* ── §7 the review of 2026-10-13 ─────────────────────────────────────────
   An independent read of this change found absences read as zeros, refusals
   read as absences, a sentence carrying booking times past a role that holds
   bookings as totals only, one person read as two, the pay book's sign
   upside down, and a guard refusing a true sentence. Each case, held. */
console.log('\n§7 the review: absences, refusals and people said truly');
const w1530 = await tool('whereabouts', { plate: 'L19262', day: D, time: '15:30' });
check('15:30 is between ONE man\'s trips on two accounts (Uber to 15:05, Bolt from 16:00), not a handover',
  w1530.values?.driver === NAME && w1530.values?.driving_basis === 'between their own trips at 15:05 and 16:00', JSON.stringify(w1530.values));
const w1630 = await tool('whereabouts', { plate: 'L19262', day: D, time: '16:30' });
check('16:30 is a handover: nobody is named as driving, and both trips are said', !w1630.values?.driver
  && /16:00.*Test Driver Alpha.*17:00.*Test Driver Bravo/.test(w1630.note || ''), w1630.note);
const TEC = harness(fetchVia(gated.port, await person('tec-reach@example.test', 'TEC')));
const tec = await TEC('whereabouts', { plate: 'L19262', day: D, time: '16:30' });
check('a Fleet technician (bookings as totals only) gets the place, and no booking time through the handover sentence',
  tec.values?.area === "Za'abeel 1" && !/16:00|17:00/.test(tec.note || '') && /withheld from this person's role/.test(tec.note || ''),
  JSON.stringify(tec).slice(0, 400));
const shB = await tool('driver_shift', { driver_id: B, day: D });
check('a session running past midnight has no log-out at "24:00"', shB.values?.first_logged_in === '23:00'
  && shB.values?.last_logged_out === undefined && /carries on/.test(shB.values?.still_logged_in_at_midnight || ''), JSON.stringify(shB.values));
const shB2 = await tool('driver_shift', { driver_id: B, day: '2026-10-12' });
check('…and the next day does not begin with a log-in at "00:00"', shB2.values?.first_logged_in === undefined
  && /already online/.test(shB2.values?.logged_in_before_midnight || '') && shB2.values?.last_logged_out === '01:30', JSON.stringify(shB2.values));
const dsB = await tool('driver_status', { driver_id: B });
check('a driver with no status today is not "online 0 minutes"', dsB.values?.online_today_minutes === undefined
  && dsB.values?.status === undefined && /not reported a status|no status change/i.test(dsB.note || ''), JSON.stringify(dsB.values));
check('the pay book reads as pay owed to the driver: 1,500, not "paid −1,500"', lb.values?.pay_owed_to_driver_aed === 1500
  && lb.values?.paid_beyond_recorded_pay_aed === undefined, JSON.stringify(lb.values));
const ANL = harness(fetchVia(gated.port, await person('anl-reach@example.test', 'ANL')));
const anlPs = await ANL('platform_statements', { driver_id: A, from: '2026-10-05', to: D });
check('an Analyst (earnings, no cash) gets the statement lines without the cash ones',
  anlPs.rows?.length > 0 && !anlPs.rows.some((r) => /cash|payouts/.test(`${r.line} ${r.under}`)), JSON.stringify(anlPs.rows));
check('…which the Owner\'s view of the same lines does carry', (await tool('platform_statements', { driver_id: A, from: '2026-10-05', to: D }))
  .rows?.some((r) => r.line === 'cash collected'));
const finSt = await FIN('start_times', { day: D, start: '7am' });
check('a Finance manager (no conduct) is told the verdicts are withheld, not "not judged"',
  finSt.rows?.find((r) => r.driver_id === A)?.late === 'withheld' && finSt.values?.late === undefined, JSON.stringify(finSt.values));
const OPS = harness(fetchVia(gated.port, await person('ops-reach@example.test', 'OPS', ['egari'])));
const opsCar = await OPS('live_cars', { driver_id: A });
check('a one-fleet reader refused the driver lookups is told so, not "no car is on record"',
  /combines the records of every fleet/.test(opsCar.withheld || '') && !opsCar.error, JSON.stringify(opsCar).slice(0, 300));
const CLK = harness(fetchVia(gated.port, await person('clk-reach@example.test', 'CLK')));
const clkShift = await CLK('driver_shift', { driver_id: A, day: D });
const clkHours = await CLK('driver_hours', { driver_id: A, from: D0, to: D });
check('a Cash desk officer (no bookings) gets the log-ins and breaks, and is never told "0 trips"',
  clkShift.values?.sessions === 2 && clkShift.values?.trips === undefined && clkHours.values?.days_worked === undefined
  && /trip counts and trip times.* are withheld from this person's role/.test(clkShift.note || ''), `${JSON.stringify(clkShift.values)} ${clkShift.note}`);
const quiet = await tool('whereabouts', { plate: 'L19262', day: D, time: '6am to 7am' });
check('a stretch with no positions shows no stops rather than "0 stops"', quiet.values?.stops === undefined
  && /fewer than two positions/.test(quiet.note || ''), JSON.stringify(quiet.values));
const RG = new Map([
  ['r1', { id: 'r1', kind: 'table', definition: 'Platform payouts', filters: { platform: null, fleet: null },
    values: { uber_ecosine_aed: 12000.5 }, kinds: { uber_ecosine_aed: 'aed' } }],
  ['r2', { id: 'r2', kind: 'table', definition: 'Shift', filters: { driver: NAME }, values: { logged_in_minutes: 675 }, kinds: { logged_in_minutes: 'min' } }],
]);
const gp = checkReply('Uber paid Ecosine {{r1.uber_ecosine_aed}} last week.', RG);
check('the guard lets "Uber paid Ecosine {{…uber_ecosine_aed}}" through', gp.ok && gp.text === 'Uber paid Ecosine AED 12,000.50 last week.', JSON.stringify(gp));
const gu = checkReply(`${NAME} was logged in for {{r2.logged_in_minutes}} minutes.`, RG, { driverNames: [NAME] });
check('…and absorbs the unit after an hours figure: "11h 15m", not "11h 15m minutes"', gu.text === `${NAME} was logged in for 11h 15m.`, gu.text);
check('"2 at night" is 02:00 and "12 at night" is midnight', resolveClock('2 at night', NOW).hhmm === '02:00'
  && resolveClock('12 at night', NOW).hhmm === '00:00' && resolveClock('9 at night', NOW).hhmm === '21:00');

/* ── §8 production, 2026-10-13 ───────────────────────────────────────────
   The first conversation with the real model on production found five
   faults the synthetic fleet above had not: a car the tracker had placed
   eight minutes earlier answered "no tracker position", because Uber's newer
   status row (no coordinates) is the row /api/live keeps; two true sentences
   refused by the guard; a lifetime cash figure said as "last week"; and
   labels that repeated their unit. Live rows are written at the real clock,
   so this section's tools run on it too. */
console.log('\n§8 production: positions under Uber rows, true sentences, windows, labels');
const realTool = harness(fetchVia(bare.port), () => Date.now());
await fix(ago(8), DEIRA, 20, 'L88881', 'fms', 'egari', 1);
await fix(ago(35), ZAB, 0, 'L88882', 'fms', 'ecosine');
for (const p of ['L88881', 'L88882', 'L88883']) {
  await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, status)
           VALUES ('uber',$1,'egari',$2::timestamptz,$2::timestamptz,'ONLINE')`, [p, ago(1)]);
}
const under = await realTool('live_cars', { plate: 'L88881' });
check('a car whose newest row is Uber\'s status is placed by its tracker\'s fix eight minutes ago — Deira, live',
  under.values?.area === 'Deira' && under.values?.state === 'live' && under.values?.position_age_min === 8
  && /Uber's newer driver-status row/.test(under.note || ''), JSON.stringify(under).slice(0, 400));
const older = await realTool('live_cars', { plate: 'L88882' });
check('…one whose last fix is 35 minutes old is said as stale, with that age and place',
  older.values?.state === 'stale' && older.values?.area === "Za'abeel 1" && older.values?.position_age_min === 35,
  JSON.stringify(older).slice(0, 400));
const none = await realTool('live_cars', { plate: 'L88883' });
check('…and one with no fix today says Uber\'s status carries no position — never "may have no tracker"',
  /no tracker has reported a position for L88883 today — the live list holds only Uber's driver status/.test(none.error || ''),
  JSON.stringify(none).slice(0, 400));
const all = await realTool('live_cars', {});
check('the fleet\'s live list counts the car under the Uber row', all.rows?.some((r) => r.plate === 'L88881' && r.state === 'live')
  && !all.rows?.some((r) => r.plate === 'L88883'), JSON.stringify(all.values));

const RP = new Map([
  ['r1', { id: 'r1', kind: 'table', definition: 'Live driver status — grouped by fleet', filters: { fleet: null, grouped_by: 'fleet' },
    rows: [{ fleet: 'ecosine', count: 116 }, { fleet: 'egari', count: 46 }], values: { ecosine_count: 116, egari_count: 46 },
    kinds: { ecosine_count: 'int', egari_count: 'int' }, columns: [{ key: 'fleet' }, { key: 'count' }] }],
  ['r2', { id: 'r2', kind: 'table', definition: 'Car figures · car L19262 · both fleets', filters: { fleet: null },
    rows: [{ plate: 'L19262', fleet: 'egari', trips: 2 }], values: { total_trips: 2 }, kinds: { total_trips: 'int' } }],
  ['r3', { id: 'r3', kind: 'table', definition: 'Two cars', filters: { fleet: null },
    rows: [{ plate: 'L19262', fleet: 'egari', trips: 2 }, { plate: 'L55555', fleet: 'ecosine', trips: 1 }], values: { total_trips: 3 }, kinds: { total_trips: 'int' } }],
  ['r4', { id: 'r4', kind: 'table', definition: 'A driver on two platforms', filters: { platform: null },
    rows: [{ driver: NAME, platforms: 'bolt, uber', trips: 9 }], values: { total_trips: 9 }, kinds: { total_trips: 'int' } }],
]);
check('the guard accepts "Ecosine has {{r1.rows[0].count}}" — the row\'s own fleet is ecosine',
  checkReply('Ecosine has {{r1.rows[0].count}} drivers working.', RP).ok, JSON.stringify(checkReply('Ecosine has {{r1.rows[0].count}} drivers working.', RP).problems));
check('…and refuses "Egari has {{r1.rows[0].count}}" — that row is Ecosine\'s', !checkReply('Egari has {{r1.rows[0].count}} drivers working.', RP).ok);
check('…accepts "L19262, an Egari car, made {{r2.total_trips}}" — the result\'s one row is Egari\'s',
  checkReply('L19262, an Egari car, made {{r2.total_trips}} trips today.', RP).ok);
check('…refuses the same over two cars of two fleets', !checkReply('L19262, an Egari car, made {{r3.total_trips}} trips today.', RP).ok);
check('…and a row listing "bolt, uber" is not about Uber alone', !checkReply('On Uber he made {{r4.total_trips}} trips.', RP).ok);
const shiftR = await tool('driver_shift', { driver_id: A, day: D });
const gsh = checkReply(`Uber's record has ${NAME} logged in for {{${shiftR.id}.logged_in_minutes}}.`,
  new Map([[shiftR.id, shiftR]]), { driverNames: [NAME] });
check('a sentence calling the shift Uber\'s record is true, and passes', gsh.ok, JSON.stringify(gsh.problems));
const gshB = checkReply(`On Bolt ${NAME} was logged in for {{${shiftR.id}.logged_in_minutes}}.`, new Map([[shiftR.id, shiftR]]), { driverNames: [NAME] });
check('…calling it Bolt\'s is not', !gshB.ok);

const bal = await tool('ledger_balances', { driver_id: A, from: '2026-10-05', to: D });
check('ledger balances are labelled "as of" the period\'s end, never with the period itself',
  /as of Sun 11 Oct 2026/.test(bal.definition) && !/Mon 5 Oct/.test(bal.definition), bal.definition);
check('…only "earned" carries the period, and the note forbids a period beside a balance',
  bal.values?.earned_over === 'Mon 5 Oct – Sun 11 Oct 2026' && /NEVER only a period's/.test(bal.note || ''),
  `${JSON.stringify(bal.values)} ${bal.note}`);

const plain = plainAnswer([{ id: 'r1', kind: 'table', definition: 'Shift', values: { fares_aed: 208.39, logged_in_minutes: 511, total_km: 15 },
  kinds: { fares_aed: 'aed', logged_in_minutes: 'min', total_km: 'km' } }], 'why');
check('the plain figures do not repeat their unit: "fares AED 208.39", "logged in 8h 31m", "total 15.0 km"',
  /fares AED 208\.39; logged in 8h 31m; total 15\.0 km/.test(plain.text), plain.text);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
