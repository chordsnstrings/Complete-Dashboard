/* ── data we hold that the page could not show, and one page contradicting
      another about the same people ──────────────────────────────────────────
   Every assertion here failed against the shipped code:

     #drivers said "77 with an expired licence" and painted red EXPIRED pills
     while /api/compliance/drivers, describing the same people, reported
     expired: 0. All 77 carry licence number 123456 and the identical date
     2026-01-01 — what this source writes when the field was never filled in.
     The compliance page knew; the directory had no idea, because the flag was
     never returned to it. And the compliance list, ordered by expiry ascending,
     opened on all 77 of those rows, above the driver who actually stops
     working on Thursday.

     A suspended driver's own page could not show that they were suspended:
     /api/driver/profile never touched driver_platform_state, though
     #roster/blocked shows the state, the reason, the score and the plate they
     still hold for the same person.

     "29.5 per 100 km" was painted critical against a hardcoded 5/15 scale,
     under a sub-label reading "comparable across drivers" — comparable to a
     constant somebody chose.

     #action/<code>/<id> fetched the whole 200-row insight list and searched it
     in the browser, so four open findings answered "no longer open" on their
     own pages while rendering in the chips that linked to them.

     Tips were ranked by rate with no fare floor, so rank 1 in production was
     {tips: 10.00, fare: 63.49} above {tips: 30.00, fare: 506.41}.

     #retention could not be narrowed to a fleet at all, and a month nobody
     joined in had no cohort row rather than a row reading zero. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

/* Six drivers carrying the placeholder date and two carrying real ones: the
   proportion (6 of 8) is what the detector keys on — one date on at least half
   the dated rows, over at least five of them. One real date is in the future
   and one is genuinely in the past, so "expired" has something true to find. */
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
for (let i = 0; i < 6; i++) {
  await q(`INSERT INTO driver_compliance (platform, fleet_id, driver_ext_id, full_name, licence_no,
             licence_expires, state) VALUES ('uber','ecosine',$1,$2,'123456','2026-01-01','working')`,
  [`ph-${i}`, `Placeholder Person ${i}`]);
}
await q(`INSERT INTO driver_compliance (platform, fleet_id, driver_ext_id, full_name, licence_no,
           licence_expires, state)
         VALUES ('uber','ecosine','real-soon','Expires Thursday','AE111',$1,'working'),
                ('uber','egari','real-gone','Genuinely Expired','AE222',$2,'working')`,
[day(3), day(-9)]);

/* WHETHER THE EXPIRY MATTERS.
   ─────────────────────────────────────────────────────────────────────────
   The compliance list gave no way to tell an expiry that has to be acted on
   this morning from one that is a filing job: all 132 production rows read
   State "offline", the hotel channel's word for every account it holds,
   whether the person drove last night or has never driven at all.

   This row is the shape that makes the join hard, and it is the common one on
   production: the compliance record is a HOTEL account and the person's
   driving is filed under a different platform's id. Matching on the id alone
   finds nothing; only the name fold reaches it. */
await q(`INSERT INTO driver_compliance (platform, fleet_id, driver_ext_id, full_name, licence_no,
           licence_expires, state)
         VALUES ('hotel','ecosine','h-night','Night  Shift Person','AE333',$1,'offline')`,
[day(10)]);
for (let d = 20; d <= 24; d++) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, distance_km, status)
           VALUES ('uber',$1,'ecosine','ECO-9','u-night','Night Shift Person',$2,14,'completed')`,
  [`night-${d}`, `2026-08-${d}T22:00:00+04:00`]);
}

/* One driver with work, a standing, a payout period and some alerts — enough
   for the profile, quality and earnings panels to have something to say. */
let n = 0;
for (let d = 1; d <= 12; d++) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, distance_km, status, pickup_addr, pickup_lat, pickup_lng)
           VALUES ('uber',$1,'ecosine','ECO-1','real-soon','Expires Thursday',$2,20,'completed',
                   '12 Cluster E - Al Thanyah Fifth - Dubai - UAE', 25.06, 55.14)`,
  [`t${n++}`, `2026-08-${String(d).padStart(2, '0')}T09:00:00+04:00`]);
}
// A booking with an address and NO coordinate: the shape that makes a map look
// emptier than the table beside it.
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, distance_km, status, pickup_addr)
         VALUES ('uber','t-noloc','ecosine','ECO-1','real-soon','Expires Thursday',
                 '2026-08-13T09:00:00+04:00',20,'completed','Atlantis - Palm Jumeirah - Dubai - UAE')`);
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state,
           state_raw, state_reason, plate, score, can_earn)
         VALUES ('uber','real-soon','ecosine','Expires Thursday','suspended','BLOCKED',
                 'documents under review','ECO-1',72,false)`);
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
           fleet_id, trips, km, is_primary)
         SELECT 'ECO-1', d::date, 'real-soon', 'uber', 'Expires Thursday', 'ecosine', 1, 100, true
           FROM generate_series('2026-08-01'::date, '2026-08-12'::date, '1 day') d`);
await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
         SELECT 'fms', 'a' || g, 'ecosine', 'ECO-1', 'Harsh Brake',
                '2026-08-05T10:00:00+04:00'::timestamptz
           FROM generate_series(1, 12) g`);
/* One payout period, written the way the collector writes it: driver_payout_day
   is derived from driver_performance by src/rollup.js, so seeding the source is
   what makes the derived table real. The acceptance rate and the rating live
   here and nowhere else — two columns the earnings table drew and the payout
   table could never fill. */
await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name,
           period_start, period_end, earnings, cash_earnings, trips,
           acceptance_rate, cancellation_rate, rating)
         VALUES ('uber','ecosine','real-soon','Expires Thursday','2026-08-01','2026-08-07',
                 700, 70, 14, 0.93, 0.04, 4.87)`);

/* Retention needs whole months to follow, and the month in progress is
   excluded by construction — a driver who has not worked yet this week has not
   left. Three earlier months, one of which nobody joined in: June is the month
   the live fleet recruited nobody and had no cohort row at all. */
for (const [m, who] of [['05', ['r-a', 'r-b']], ['06', ['r-a', 'r-b']], ['07', ['r-a', 'r-c']]]) {
  for (const id of who) {
    await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
               requested_at, distance_km, status)
             VALUES ('uber',$1,'ecosine','ECO-9',$2,$3,$4,10,'completed')`,
    [`r-${m}-${id}`, id, `Retention ${id}`, `2026-${m}-10T09:00:00+04:00`]);
  }
}
/* Tips: one driver whose rate is high on a tiny base — the shape that used to
   rank first — and one whose rate is lower on a real one. */
await q(`INSERT INTO driver_earnings_component (platform, driver_ext_id, fleet_id, period_start,
           period_end, category, amount, driver_name)
         VALUES ('uber','tiny','ecosine','2026-08-01','2026-08-07','net_fare',63.49,'Tiny Base'),
                ('uber','tiny','ecosine','2026-08-01','2026-08-07','tip',10,'Tiny Base'),
                ('uber','real','ecosine','2026-08-01','2026-08-07','net_fare',506.41,'Real Base'),
                ('uber','real','ecosine','2026-08-01','2026-08-07','tip',30,'Real Base')`);
/* Insights: 3 findings under one code, one of them fleet-wide with refs, and
   one whose impact is the modelled idle-vehicle constant. */
await q(`INSERT INTO insight (code, severity, category, entity_type, entity_id, title, detail,
           impact_aed, fleet_id, refs, window_start, window_end, computed_at)
         VALUES ('unsafe_driving','warning','safety','vehicle','ECO-1','a','b',NULL,'ecosine',NULL,
                 '2026-08-01','2026-08-31', now()),
                ('unsafe_driving','warning','safety','vehicle','ECO-2','a','b',NULL,'egari',NULL,
                 '2026-08-01','2026-08-03', now()),
                ('idle_vehicle','critical','utilisation','vehicle','ECO-3','a','b',1680,'ecosine',NULL,
                 NULL,NULL, now()),
                ('drivers_online_no_trips','critical','utilisation','fleet','all','a','b',NULL,'ecosine',
                 '[{"driver_ext_id":"real-soon","hours_online":6.2}]'::jsonb, NULL, NULL, now())`);
await refreshRollups({ db });

const { server, get } = await mountAll(db);
const body = async (p) => (await get(p)).body;

console.log('\ncompliance: a date nobody entered is not an expiry');

const comp = await body('/api/compliance/drivers');
check('the placeholder is detected and named', comp.placeholder_date === '2026-01-01'
  && comp.placeholder_rows === 6, JSON.stringify([comp.placeholder_date, comp.placeholder_rows]));
check('every row says whether its own date is the placeholder',
  comp.drivers.filter((r) => r.licence_placeholder).length === 6,
  JSON.stringify(comp.drivers.map((r) => [r.full_name, r.licence_placeholder])));
check('only the genuinely lapsed licence counts as expired',
  comp.totals.expired === 1, String(comp.totals.expired));
check('the placeholder rows are counted, as their own number',
  comp.totals.placeholder === 6, String(comp.totals.placeholder));
/* Ordered by expiry ascending, all six placeholder rows sat at the top of the
   page whose job is to show whose licence lapses next. */
check('the list does not open on six rows of a data-quality artefact',
  comp.drivers[0].licence_placeholder === false,
  JSON.stringify(comp.drivers.slice(0, 2).map((r) => [r.full_name, r.licence_placeholder])));
check('and the soonest real expiry is what a reader sees first',
  comp.drivers[0].full_name === 'Genuinely Expired', comp.drivers[0].full_name);
/* ── whether the expiry matters ────────────────────────────────────────── */
{
  const byName = Object.fromEntries(comp.drivers.map((r) => [r.full_name, r]));
  const worker = byName['Expires Thursday'];
  const idle = byName['Genuinely Expired'];
  const night = byName['Night  Shift Person'];

  check('a compliance row whose id matches the trips reports their driving',
    worker && worker.lifetime_trips === 13, String(worker?.lifetime_trips));
  check('…by the id, so it is not marked as a name match',
    worker && worker.activity_by_name === false, String(worker?.activity_by_name));

  /* The branch that matters on production: a hotel compliance record whose
     person drives under a different platform's id. A join written on the id
     alone finds nothing here and the row reads as though they never drive. */
  check('a hotel record whose driving is filed under another id is still reached',
    night && night.lifetime_trips === 5, JSON.stringify([night?.full_name, night?.lifetime_trips]));
  check('…and says it was matched by name, not by platform id',
    night && night.activity_by_name === true, String(night?.activity_by_name));
  check('…including the day they last drove, which is what makes the expiry urgent',
    night && String(night.last_ever).slice(0, 10) === '2026-08-24', String(night?.last_ever));
  /* The double-spaced name is deliberate: the fold has to normalise runs of
     whitespace on both sides or this row silently reports nothing. */
  check('…even though the two spellings differ by whitespace',
    night && /Night {2}Shift/.test(night.full_name), night?.full_name);

  check('somebody with no driving under either key reports none',
    idle && idle.last_ever == null && !idle.lifetime_trips,
    JSON.stringify([idle?.last_ever, idle?.lifetime_trips]));

  /* An OR'd join across the id and the name can match two driver_lifetime rows
     and list one person twice, on a page headed "whose licence lapses next". */
  check('no compliance row is duplicated by the join',
    comp.drivers.length === new Set(comp.drivers.map((r) => r.driver_ext_id)).size,
    `${comp.drivers.length} rows, ${new Set(comp.drivers.map((r) => r.driver_ext_id)).size} ids`);
}

const compEga = await body('/api/compliance/drivers?fleet=egari');
check('the fleet chip narrows the compliance list',
  compEga.drivers.length === 1 && compEga.drivers[0].full_name === 'Genuinely Expired',
  JSON.stringify(compEga.drivers.map((r) => r.full_name)));

const dir = await body('/api/drivers/directory?from=2026-08-01&to=2026-08-31');
check('the directory carries the same flag, so the two pages cannot disagree',
  dir.filter((r) => r.licence_placeholder).length === 6,
  JSON.stringify(dir.filter((r) => r.licence_placeholder).map((r) => r.driver_name)));
check('and the driver with a real past expiry is not one of them',
  dir.find((r) => r.driver_name === 'Genuinely Expired')?.licence_placeholder === false);

console.log('\nthe driver page can show what the roster page shows');

const prof = await body('/api/driver/profile?id=real-soon');
check('a suspended driver\'s own page carries their standing',
  prof.standing?.length === 1 && prof.standing[0].state === 'suspended',
  JSON.stringify(prof.standing));
check('with the reason, the score and the car they are still holding',
  prof.standing[0].state_reason === 'documents under review'
  && Number(prof.standing[0].score) === 72 && prof.standing[0].plate === 'ECO-1',
  JSON.stringify(prof.standing[0]));

const qual = await body('/api/driver/quality?id=real-soon&from=2026-08-01&to=2026-08-31');
check('a per-100km rate comes with the fleet rate it is high against',
  qual.fleet_alerts_per_100km != null && qual.fleet_alert_km > 0,
  JSON.stringify([qual.alerts_per_100km, qual.fleet_alerts_per_100km]));
check('and the baseline is measured, not a constant — it moves with the data',
  Math.abs(qual.fleet_alerts_per_100km - (qual.fleet_alerts * 100) / qual.fleet_alert_km) < 0.1,
  JSON.stringify([qual.fleet_alerts, qual.fleet_alert_km, qual.fleet_alerts_per_100km]));

const earn = await body('/api/driver/earnings?id=real-soon&from=2026-08-01&to=2026-08-31');
check('the earnings periods carry the acceptance and rating columns the table draws',
  earn.periods.length === 1 && Number(earn.periods[0].acceptance_rate) === 0.93
  && Number(earn.periods[0].rating) === 4.87, JSON.stringify(earn.periods[0]));
check('and the caption total is computed where the rows are',
  earn.counted_total === earn.periods.reduce((a, r) => a + Number(r.counted), 0),
  JSON.stringify([earn.counted_total, earn.periods.map((r) => r.counted)]));

const terr = await body('/api/driver/territory?id=real-soon&from=2026-08-01&to=2026-08-31');
check('the territory map says how much of the work it could place',
  terr.coverage.bookings === 13 && terr.coverage.positioned === 12
  && terr.coverage.addressed === 13, JSON.stringify(terr.coverage));
check('and the areas are communities, not building numbers',
  terr.areas.some((a) => a.area === 'Al Thanyah Fifth'),
  JSON.stringify(terr.areas.map((a) => a.area)));

console.log('\ninsights: a finding page can find its own finding');

const one = await body('/api/insights?code=unsafe_driving');
check('asking for a code returns every row under it',
  one.insights.length === 2 && one.insights.every((r) => r.code === 'unsafe_driving'),
  JSON.stringify(one.insights.map((r) => r.entity_id)));
const oneEntity = await body('/api/insights?code=unsafe_driving&entity_id=ECO-2');
check('and one entity narrows to one finding',
  oneEntity.insights.length === 1 && oneEntity.insights[0].entity_id === 'ECO-2');
check('a modelled impact says it is modelled',
  (await body('/api/insights?code=idle_vehicle')).insights[0].impact_kind === 'modelled');
check('and a measured one is not called modelled',
  one.insights.every((r) => r.impact_kind == null));
const byFleet = await body('/api/insights?fleet=egari');
check('the fleet a finding is about can be asked for',
  byFleet.insights.length === 1 && byFleet.insights[0].entity_id === 'ECO-2',
  JSON.stringify(byFleet.insights.map((r) => [r.entity_id, r.fleet_id])));
/* Windows: one unsafe_driving row spans the whole month, one three days. A
   list that mixes them ranks two multiples against two different medians. */
const win = await body('/api/insights?from=2026-08-01&to=2026-08-05');
check('a window returns only findings measured over it',
  win.insights.filter((r) => r.code === 'unsafe_driving').length === 1,
  JSON.stringify(win.insights.filter((r) => r.code === 'unsafe_driving').map((r) => r.entity_id)));
check('while a finding with no window of its own always passes',
  win.insights.some((r) => r.code === 'idle_vehicle'),
  JSON.stringify(win.insights.map((r) => r.code)));
const named = await body('/api/insights?code=drivers_online_no_trips');
check('the fleet-wide finding names the people it is about',
  named.insights[0].refs?.[0]?.driver_ext_id === 'real-soon',
  JSON.stringify(named.insights[0].refs));

console.log('\ntips: a rate needs a base worth dividing by');

const tips = await body('/api/earnings/tips?from=2026-08-01&to=2026-08-31');
check('the AED 63 base is not rank 1 any more — it is not ranked at all',
  tips.rows.length === 1 && tips.rows[0].driver_ext_id === 'real',
  JSON.stringify(tips.rows.map((r) => [r.driver_ext_id, r.fare, r.tip_pct])));
check('and the drivers below the floor are counted rather than dropped',
  tips.excluded_n === 1 && tips.fare_floor === 300,
  JSON.stringify([tips.excluded_n, tips.fare_floor]));

console.log('\nretention: a month nobody joined is a row, not an absence');

const ret = await body('/api/retention');
check('retention answers', ret.ok === true, JSON.stringify(ret.reason));
check('the fleet filter is accepted and reported',
  (await body('/api/retention?fleet=ecosine')).fleet === 'ecosine');
check('a fleet with no drivers at all is a refusal, not the other fleet\'s cohorts',
  (await body('/api/retention?fleet=egari')).ok === false,
  JSON.stringify((await body('/api/retention?fleet=egari')).cohorts));
check('every complete month has a cohort row, including the ones with no intake',
  ret.cohorts.length === ret.months.length,
  `${ret.cohorts.length} cohorts over ${ret.months.length} months`);
check('and a month nobody joined reports no percentage rather than 0%',
  ret.cohorts.filter((c) => c.no_intake).every((c) => c.still_active_pct === null),
  JSON.stringify(ret.cohorts.map((c) => [c.cohort, c.size, c.still_active_pct])));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
