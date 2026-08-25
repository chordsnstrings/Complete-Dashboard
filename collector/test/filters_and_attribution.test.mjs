/* ── chips that did nothing, and columns ranked by the wrong thing ─────────
   A two-fleet operator with a channel that has never delivered a row. Every
   assertion here failed against the shipped code, and each one was visible on
   the live product:

     /api/alerts/summary with &fleet=egari came back byte-identical to
     unfiltered (34,547 events), while /api/kpis has always narrowed its own
     alert count by fleet — so the Safety tile and the Safety page disagreed
     under a filter.

     /api/alerts/by-vehicle ranked "Most often" ALPHABETICALLY:
     (array_agg(driver_name ORDER BY driver_name))[1]. On L45255 that named the
     driver with 322 events over the one with 702.

     /api/drivers/directory read from/to only, so with Bolt selected the page
     stated 118 people drove on Bolt — a channel with no trip in the database —
     and &fleet=egari was byte-identical to unfiltered.

     /api/roster filtered on driver_platform_state.fleet_id, which records
     which credential set collected the row: &fleet=egari returned exactly the
     Bolt roster, 67 people, working 0.

     /api/drivers/leaderboard ranked by TOTAL bookings under a caption naming
     completions: 271 x 84% = 228 above 257 x 89% = 229.

     /api/platforms counted FMS telematics twins as bookings, all-time, beside
     a windowed donut — and omitted the one channel with nothing in it.

     The roster filed five of the fleet's busiest drivers as "output not
     observed" while printing their trips in the next column. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups } from '../src/rollup.js';
import { stateRow } from '../src/roster.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

const W = 'from=2026-08-01&to=2026-08-31';
const D = (d) => `2026-08-${String(d).padStart(2, '0')}`;
let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, distance_km, status, price)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [o.platform, `t${n++}`, o.fleet, o.plate, o.drv, o.name,
    `${o.day}T09:00:00+04:00`, o.km ?? 10, o.status ?? 'completed', o.price ?? null]);

/* ECOSINE: two Uber drivers on one plate. Ranked by total bookings, Rida leads
   with 20; ranked by COMPLETIONS, Sana leads with 18 against Rida's 16. */
for (let d = 1; d <= 20; d++) {
  await trip({ platform: 'uber', fleet: 'ecosine', plate: 'ECO-1', drv: 'e-rida',
    name: 'Rida Aslam', day: D(d), status: d <= 4 ? 'rider_cancelled' : 'completed' });
}
for (let d = 1; d <= 18; d++) {
  await trip({ platform: 'uber', fleet: 'ecosine', plate: 'ECO-1', drv: 'e-sana',
    name: 'Sana Iqbal', day: D(d) });
}
// EGARI: one hotel driver, so a fleet filter has something distinct to find.
for (let d = 1; d <= 9; d++) {
  await trip({ platform: 'hotel', fleet: 'egari', plate: 'EGA-1', drv: 'g-omar',
    name: 'Omar Nasser', day: D(d), price: 120 });
}
// FMS telematics twins on the Ecosine plate: journeys, never bookings.
for (let d = 1; d <= 12; d++) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at,
             distance_km, status)
           VALUES ('fms',$1,'ecosine','ECO-1',$2,190000,'completed')`,
  [`fms-${d}`, `${D(d)}T06:00:00+04:00`]);
}

/* Custody, so alerts can be attributed. Rida holds ECO-1 on four days and Sana
   on sixteen — so ALPHABETICALLY Rida wins ("Rida" < "Sana"), while by event
   count Sana does. That inversion is the whole point of the fixture. */
for (let d = 1; d <= 20; d++) {
  await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
             fleet_id, trips, km, is_primary)
           VALUES ('ECO-1',$1,$2,'uber',$3,'ecosine',5,60,true)`,
  [D(d), d <= 4 ? 'e-rida' : 'e-sana', d <= 4 ? 'Rida Aslam' : 'Sana Iqbal']);
}
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
           fleet_id, trips, km, is_primary)
         VALUES ('EGA-1','2026-08-05','g-omar','hotel','Omar Nasser','egari',3,40,true)`);

/* Alerts: four on Rida's days, sixteen on Sana's, all on the Ecosine plate;
   five on the Egari plate. One alert type falls in none of the four buckets,
   so the residual column has something to hold. */
let a = 0;
for (let d = 1; d <= 20; d++) {
  await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
           VALUES ('fms',$1,'ecosine','ECO-1',$2,$3)`,
  [`al-${a++}`, d === 7 ? 'Seatbelt' : 'Harsh Brake', `${D(d)}T10:00:00+04:00`]);
}
for (let d = 1; d <= 5; d++) {
  await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
           VALUES ('fms',$1,'egari','EGA-1','OverSpeed',$2)`, [`ag-${a++}`, `${D(d)}T11:00:00+04:00`]);
}

/* Standing. Bolt's rows were collected under Egari's credentials — the only
   Bolt token that works — and describe people who drive for neither fleet's
   Uber or hotel business. Filtering the roster on that column returns the Bolt
   roster and calls it Egari. */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name,
           state, state_raw, can_earn)
         VALUES ('bolt','b-1','egari','Bolt Person One','active','active',true),
                ('bolt','b-2','egari','Bolt Person Two','active','active',true),
                ('uber','e-rida','ecosine','Rida Aslam','active','ONBOARDING_STATUS_ACTIVE',true),
                ('uber','e-sana','ecosine','Sana Iqbal','active','ONBOARDING_STATUS_ACTIVE',true),
                ('uber','g-omar','ecosine','Omar Nasser','active','ONBOARDING_STATUS_ACTIVE',true),
                ('uber','g-omar2','ecosine','Omar Nasser Two','active','ONBOARDING_STATUS_ACTIVE',true)`);
/* The three words the live roster could not read, written through the SAME
   normaliser the collector uses. driver_platform_state.state is stored at
   ingest, not derived at read, so inserting a hand-picked state here would
   test nothing: it is stateRow() that decides, and stateRow() is what was
   wrong. Uber sends WAITLISTED_AUTO_REACTIVATION eighteen times, _REJECTED
   five, _APPLIED and _ACCEPTED once each, and all of them landed as `unknown`
   — reported by /api/roster/states as words we cannot read and by the roster
   as "standing not reported" for people the provider had described plainly. */
for (const [id, name, raw] of [
  ['w-1', 'Waiting Person', 'ONBOARDING_STATUS_WAITLISTED_AUTO_REACTIVATION'],
  ['w-2', 'Applied Person', 'ONBOARDING_STATUS_APPLIED'],
  ['w-3', 'Rejected Person', 'ONBOARDING_STATUS_REJECTED'],
  ['w-4', 'Accepted Person', 'ONBOARDING_STATUS_ACCEPTED'],
]) {
  const row = stateRow({ platform: 'uber', driverExtId: id, fleetId: 'ecosine', name, rawState: raw });
  await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name,
             state, state_raw, can_earn) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [row.platform, row.driver_ext_id, row.fleet_id, row.full_name, row.state, row.state_raw, row.can_earn]);
}
await q(`INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at, error)
         VALUES ('uber','ecosine','incremental','ok',100,'2026-08-31T20:00:00Z',NULL),
                ('hotel','egari','incremental','ok',9,'2026-08-31T20:00:00Z',NULL),
                ('fms','ecosine','incremental','ok',12,'2026-08-31T20:00:00Z',NULL),
                ('bolt','ecosine','incremental','partial',0,'2026-08-31T20:00:00Z',
                 'FI roster ecosine: code=503 NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED')`);
await refreshRollups({ db });

const { server, get } = await mountAll(db);
const body = async (path) => (await get(path)).body;

console.log('\nsafety: the fleet chip narrows, and "most often" means most often');

const sumAll = await body(`/api/alerts/summary?${W}`);
const sumEco = await body(`/api/alerts/summary?${W}&fleet=ecosine`);
const sumEga = await body(`/api/alerts/summary?${W}&fleet=egari`);
const tot = (x) => x.reduce((s, r) => s + r.n, 0);
check('a fleet filter changes the summary at all', tot(sumEco) !== tot(sumAll),
  `${tot(sumEco)} vs ${tot(sumAll)}`);
check('and the two fleets partition the events between them',
  tot(sumEco) === 20 && tot(sumEga) === 5 && tot(sumAll) === 25,
  JSON.stringify([tot(sumEco), tot(sumEga), tot(sumAll)]));
const kEga = await body(`/api/kpis?${W}&fleet=egari`);
check('so the Overview tile and the Safety page agree under a filter',
  kEga.alerts === tot(sumEga), `${kEga.alerts} vs ${tot(sumEga)}`);

const byVeh = await body(`/api/alerts/by-vehicle?${W}`);
const eco1 = byVeh.rows.find((r) => r.plate === 'ECO-1');
check('"most often" names the driver with the most events, not the first alphabetically',
  eco1.top_driver === 'Sana Iqbal', `${eco1.top_driver} (${eco1.top_driver_alerts})`);
check('and returns their count, so the claim can be checked',
  eco1.top_driver_alerts === 16, String(eco1.top_driver_alerts));
check('the id comes with the name, so the cell is a link',
  eco1.top_driver_id === 'e-sana', String(eco1.top_driver_id));
check('by-vehicle rows reconcile against their own total',
  byVeh.rows.every((r) => r.harsh_brake + r.harsh_accel + r.sharp_turn + r.overspeed
    + r.other === r.alerts), JSON.stringify(byVeh.rows));

const byDrv = await body(`/api/alerts/by-driver?${W}`);
check('by-driver rows reconcile too, which six of sixty live rows did not',
  byDrv.rows.every((r) => r.harsh_brake + r.harsh_accel + r.sharp_turn + r.overspeed
    + r.other === r.alerts), JSON.stringify(byDrv.rows));
check('and the residual is where the odd alert type went',
  byDrv.rows.reduce((s, r) => s + r.other, 0) === 1,
  JSON.stringify(byDrv.rows.map((r) => [r.driver_name, r.other])));

console.log('\ndrivers: ranked by the column the caption names');

const lb = await body(`/api/drivers/leaderboard?${W}`);
check('the leaderboard returns the completed count it is captioned with',
  lb.rows.every((r) => typeof r.completed_trips === 'number'),
  JSON.stringify(lb.rows.map((r) => [r.driver_name, r.trips, r.completed_trips])));
check('and ranks by it: 18 completions of 18 outranks 16 of 20',
  lb.rows[0].driver_name === 'Sana Iqbal' && lb.rows[0].completed_trips === 18
  && lb.rows[1].driver_name === 'Rida Aslam' && lb.rows[1].completed_trips === 16,
  JSON.stringify(lb.rows.map((r) => [r.driver_name, r.trips, r.completed_trips])));
check('the total-bookings order really is the other way round',
  lb.rows.find((r) => r.driver_name === 'Rida Aslam').trips
    > lb.rows.find((r) => r.driver_name === 'Sana Iqbal').trips);

console.log('\ndirectory: the chips narrow the population, not just the arithmetic');

const dirAll = await body(`/api/drivers/directory?${W}`);
const dirBolt = await body(`/api/drivers/directory?${W}&platform=bolt`);
const dirEga = await body(`/api/drivers/directory?${W}&fleet=egari`);
const dirEco = await body(`/api/drivers/directory?${W}&fleet=ecosine`);
check('asking for a channel with no trip does not report the whole fleet as idle on it',
  dirBolt.length < dirAll.length && dirBolt.every((r) => r.trips === 0),
  `${dirBolt.length} of ${dirAll.length}`);
check('and it returns the people that channel actually knows about',
  dirBolt.map((r) => r.driver_name).sort().join(',') === 'Bolt Person One,Bolt Person Two',
  JSON.stringify(dirBolt.map((r) => r.driver_name)));
check('a fleet filter is not byte-identical to no filter',
  JSON.stringify(dirEga) !== JSON.stringify(dirAll));
check('Egari returns the person who drove for Egari',
  dirEga.some((r) => r.driver_name === 'Omar Nasser' && r.trips === 9),
  JSON.stringify(dirEga.map((r) => [r.driver_name, r.trips])));
check('and not the two who drove for Ecosine',
  !dirEga.some((r) => r.trips > 0 && /Rida|Sana/.test(r.driver_name)),
  JSON.stringify(dirEga.map((r) => [r.driver_name, r.trips])));
check('the two fleets\' trip counts add up to the unfiltered one',
  dirEco.reduce((s, r) => s + r.trips, 0) + dirEga.reduce((s, r) => s + r.trips, 0)
    === dirAll.reduce((s, r) => s + r.trips, 0),
  `${dirEco.reduce((s, r) => s + r.trips, 0)} + ${dirEga.reduce((s, r) => s + r.trips, 0)}`
  + ` vs ${dirAll.reduce((s, r) => s + r.trips, 0)}`);
check('a never-driven person carries the platform that knows them',
  dirAll.filter((r) => r.trips === 0 && r.state_platform).length > 0,
  JSON.stringify(dirAll.filter((r) => r.trips === 0).map((r) => [r.driver_name, r.state_platform])));

console.log('\nroster: standing, output, and which fleet somebody drives for');

const ros = await body(`/api/roster?${W}`);
const byName = (nm) => ros.people.find((x) => x.name === nm);
check('somebody with trips in the window is not filed as "output not observed"',
  byName('Rida Aslam').activity_known === true
  && byName('Rida Aslam').category === 'working',
  JSON.stringify([byName('Rida Aslam').activity_known, byName('Rida Aslam').category]));
check('a qualified waitlist word is recognised rather than reported as unknown',
  byName('Waiting Person').states.includes('waitlist'),
  JSON.stringify(byName('Waiting Person').states));
check('so is an application that has been filed',
  byName('Applied Person').states.includes('onboarding'),
  JSON.stringify(byName('Applied Person').states));
check('and so is one that has been accepted',
  byName('Accepted Person').states.includes('onboarding'),
  JSON.stringify(byName('Accepted Person').states));
check('one the provider turned down gets its own state, not "not reported"',
  byName('Rejected Person').states.includes('rejected'),
  JSON.stringify(byName('Rejected Person').states));
check('none of the four is left unclassified',
  ['Waiting Person', 'Applied Person', 'Rejected Person', 'Accepted Person']
    .every((nm) => byName(nm).category !== 'unclassified'),
  JSON.stringify(['Waiting Person', 'Applied Person', 'Rejected Person', 'Accepted Person']
    .map((nm) => [nm, byName(nm).category])));
const states = await body('/api/roster/states');
check('and /api/roster/states no longer reports them as words it cannot read',
  !states.unrecognised_words.some((w) => /WAITLISTED|APPLIED|REJECTED|ACCEPTED/.test(w.word)),
  JSON.stringify(states.unrecognised_words));

const rosEga = await body(`/api/roster?${W}&fleet=egari`);
check('the Egari roster is not simply the roster of whoever Egari\'s token could see',
  rosEga.people.some((x) => x.name === 'Omar Nasser'),
  JSON.stringify(rosEga.people.map((x) => x.name)));
check('and somebody is actually working in it',
  rosEga.totals.working > 0, JSON.stringify(rosEga.totals));
check('the response says which of the two claims put a row there',
  /credentials/.test(rosEga.fleet_basis || ''), String(rosEga.fleet_basis));

console.log('\nplatforms: bookings, twins, and the channel with nothing in it');

const pl = await body(`/api/platforms?${W}`);
const uber = pl.find((r) => r.platform === 'uber');
const fms = pl.find((r) => r.platform === 'fms');
const bolt = pl.find((r) => r.platform === 'bolt');
check('a telematics row is counted as a row, never as a booking',
  fms.bookings === 0 && fms.rows_seen === 12, JSON.stringify([fms.bookings, fms.rows_seen]));
check('and a real channel counts its bookings',
  uber.bookings === 38 && uber.rows_seen === 38, JSON.stringify([uber.bookings, uber.rows_seen]));
check('the windowed column exists, so the table and the donut can agree',
  uber.window_bookings === 38 && uber.windowed === true,
  JSON.stringify([uber.window_bookings, uber.windowed]));
check('a channel that has never delivered a row still has one here',
  bolt != null && bolt.bookings === 0 && bolt.rows_seen === 0, JSON.stringify(bolt));
check('carrying the collector\'s own words about why',
  /COMPANIES_NOT_ALLOWED/.test(bolt.collection_error || ''), String(bolt.collection_error));

console.log('\nrevenue: the fleet filter reaches the money, not only the bookings');

const revAll = await body(`/api/revenue?${W}`);
const revEga = await body(`/api/revenue?${W}&fleet=egari`);
const kAll = await body(`/api/kpis?${W}`);
const kEg = await body(`/api/kpis?${W}&fleet=egari`);
const num = (v) => (v == null ? 0 : Number(v));
check('the Overview and the Revenue page agree unfiltered',
  Math.abs(num(kAll.accounted) - num(revAll.totals.accounted)) < 1,
  `${kAll.accounted} vs ${revAll.totals.accounted}`);
check('and under a fleet filter, which is where they were 3.1x apart',
  Math.abs(num(kEg.accounted) - num(revEga.totals.accounted)) < 1,
  `${kEg.accounted} vs ${revEga.totals.accounted}`);
const revBolt = await body(`/api/revenue?${W}&platform=bolt`);
check('asking for Bolt returns Bolt, not a phantom uber row',
  revBolt.platforms.every((r) => r.platform === 'bolt'),
  JSON.stringify(revBolt.platforms.map((r) => r.platform)));
check('and no tips from a channel that has none',
  !revBolt.totals.tips, String(revBolt.totals.tips));
check('the silent channel is named with the collector\'s reason',
  revAll.silent_platforms.some((x) => x.platform === 'bolt'
    && /COMPANIES_NOT_ALLOWED/.test(x.collection_error || '')),
  JSON.stringify(revAll.silent_platforms));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
