/* #feeds — which cars Uber lists as active are sending seat-sensor and FMS
   data, and who drives each.
   ─────────────────────────────────────────────────────────────────────────
   Every verdict on that page is one of two colours, and the whole value of
   the page is that each colour is TRUE and each red says WHY in words that are
   also true. So this seeds a synthetic fleet with one car for every shape the
   route has to tell apart, runs the real route over it, and pins:

     - a car receiving both feeds is green on both;
     - a car receiving neither is red on both, and says "in the last 24 hours"
       where readings exist and "on record" where none ever did;
     - a car whose fleet has no CABMAN account is red with THAT reason,
       not a sentence that suggests its device is broken;
     - a car Uber does not list as ACTIVE is not listed, and neither is a car
       only another channel or only a tracker knows;
     - the window boundary, ten minutes either side of the 24 hours;
     - a CABMAN fix with no seat reading is not seat-sensor data;
     - a reading dated in the future cannot keep a silent car green;
     - the driver is Uber's assignment where Uber makes one (both of them,
       where it makes two), custody where it does not, and "no driver known"
       with its reason where neither answers;
     - the phone comes through, from the person's other account where the
       account itself carries none, and is null where nobody holds one;
     - every car of a fleet going quiet at once is reported as the feed.

   All data is synthetic: Q-prefixed plates nobody registers, test names, and
   phone numbers on the unassigned +999 country code. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { FEED_WINDOW_H } from '../api/feed_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p);

/* ── Uber's vehicle list ─────────────────────────────────────────────────── */
const uber = async (plate, fleet, status, assigned = []) => q(
  `INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, fleet_id, compliance_status,
                                assigned_driver_ext_id, raw)
   VALUES ('uber', $1, $2, $3, $4, $5, $6::jsonb)`,
  [`veh-${plate}`, plate, fleet, status, assigned[0] || null,
    JSON.stringify({ licensePlate: plate, compliance: { status },
      assignments: assigned.map((id) => ({ __typename: 'VehicleAssignment', entityUUID: id })) })]);

await uber('Q10001', 'ecosine', 'ACTIVE', ['drv-a1']);        // both feeds current
await uber('Q10002', 'ecosine', 'ACTIVE');                    // both feeds three days old
await uber('Q10003', 'ecosine', 'ACTIVE');                    // nothing, ever, and nobody
await uber('Q20001', 'egari', 'ACTIVE', ['drv-e1', 'drv-e2']); // two assigned; no CABMAN account
await uber('Q10004', 'ecosine', 'INACTIVE');                  // not active: must not be listed
await uber('Q10007', 'ecosine', 'ACTIVE');                    // seat reading 23h50m ago
await uber('Q10008', 'ecosine', 'ACTIVE');                    // seat reading 24h10m ago
await uber('Q10009', 'ecosine', 'ACTIVE');                    // a fresh CABMAN fix with no seat value
await uber('Q10010', 'ecosine', 'ACTIVE');                    // stale, plus one fix dated tomorrow
/* Another channel's record of an active car is not Uber's list. */
await q(`INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, fleet_id, compliance_status)
         VALUES ('yango', 'y-veh-Q10005', 'Q10005', 'ecosine', 'ACTIVE')`);

/* ── the two feeds ───────────────────────────────────────────────────────── */
const fix = async (source, plate, fleet, ago, seat = null) => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, seat_occupied, polled_at)
   VALUES ($1, $2, $3, now() - $4::interval, $5, now())`, [source, fleet, plate, ago, seat]);

await fix('cabman', 'Q10001', 'ecosine', '10 minutes', false);
await fix('fms', 'Q10001', 'ecosine', '5 minutes');
await fix('cabman', 'Q10002', 'ecosine', '3 days', true);
await fix('fms', 'Q10002', 'ecosine', '3 days');
await fix('fms', 'Q20001', 'egari', '30 minutes');
await fix('cabman', 'Q10004', 'ecosine', '2 minutes', false);  // fresh, but Uber says INACTIVE
await fix('cabman', 'Q10006', 'ecosine', '2 minutes', true);   // CABMAN knows it; Uber does not
await fix('cabman', 'Q10007', 'ecosine', '23 hours 50 minutes', false);
await fix('cabman', 'Q10008', 'ecosine', '24 hours 10 minutes', false);
await fix('cabman', 'Q10009', 'ecosine', '5 minutes', null);
await fix('cabman', 'Q10010', 'ecosine', '3 days', false);
await fix('cabman', 'Q10010', 'ecosine', '-1 day', true);      // a tracker clock running a day ahead

/* ── FMS's seat sensor: the seat count on FMS's own trip record ─────────────
   FMS and CABMAN are two separate seat-sensor providers (the operator,
   2026-09-23). FMS sends its seat data as the Seat Count on each journey in
   GetTripPassenger, collected into trip.seat_count for platform 'fms'. */
const fmsTrip = (plate, fleet, endedAgo, seat, platform = 'fms') => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, seat_count, status)
   VALUES ($1, $2, $3, $4, now() - $5::interval - interval '20 minutes', now() - $5::interval, $6, 'completed')`,
  [platform, `${plate}|${endedAgo}|${platform}`, fleet, plate, endedAgo, seat]);
await fmsTrip('Q10001', 'ecosine', '90 minutes', 0);             // a trip with nobody on the seat is still a reading
await fmsTrip('Q10002', 'ecosine', '3 days', 2);
await fmsTrip('Q20001', 'egari', '2 hours', 1);                  // Egari: no CABMAN, but FMS sends seat counts
await fmsTrip('Q10007', 'ecosine', '1 hour', null);              // an FMS trip with no seat count is not seat data
await fmsTrip('Q10008', 'ecosine', '1 hour', 1, 'uber');         // another channel's seat_count is not FMS's

/* ── who drives them ─────────────────────────────────────────────────────── */
const person = async (platform, id, fleet, name, phone) => q(
  `INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone)
   VALUES ($1, $2, $3, $4, $5)`, [platform, id, fleet, name, phone]);
await person('uber', 'drv-a1', 'ecosine', 'Test Driver Alpha', '+999 555 0101');
await person('uber', 'drv-e1', 'egari', 'Test Driver Echo', '+999 555 0201');
await person('uber', 'drv-e2', 'egari', 'Test Driver Foxtrot', null);
/* The custody driver of Q10002 drives it on the hotel channel, whose record
   carries no phone — but the person spine puts that account on the same human
   as an Uber account that does. */
await person('hotel', 'drv-c2', 'ecosine', 'Test Driver Charlie', null);
await person('uber', 'drv-c2u', 'ecosine', 'Test Driver Charlie', '+999 555 0301');
const [{ id: pid }] = (await q(
  `INSERT INTO driver (fleet_id, full_name) VALUES ('ecosine', 'Test Driver Charlie') RETURNING id`)).rows;
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis)
         VALUES ('hotel', 'drv-c2', $1, 'Test Driver Charlie', 'account'),
                ('uber', 'drv-c2u', $1, 'Test Driver Charlie', 'account')`, [pid]);

/* Custody, which is what vehicle_current_driver reads. Q10001 has a custodian
   who is NOT Uber's assigned driver, so the precedence is observable. */
const custody = async (plate, id, platform, name, day) => q(
  `INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, is_primary)
   VALUES ($1, $2::date, $3, $4, $5, 'ecosine', 3, true)`, [plate, day, id, platform, name]);
await custody('Q10001', 'drv-c9', 'uber', 'Test Driver Custodian', '2026-09-20');
await custody('Q10002', 'drv-c2', 'hotel', 'Test Driver Charlie', '2026-09-19');

const { get, server } = await mountAll(db, { serverRoutes: false });
const read = async () => (await get('/api/vehicles/feeds')).body;
let d = await read();
const row = (plate) => (d.rows || []).find((r) => r.plate === plate);

console.log('\nwho is listed');
check('the route answers with rows', Array.isArray(d?.rows), JSON.stringify(d).slice(0, 200));
const listed = (d.rows || []).map((r) => r.plate).sort();
check('every car Uber lists as ACTIVE, and only those',
  JSON.stringify(listed) === JSON.stringify(
    ['Q10001', 'Q10002', 'Q10003', 'Q10007', 'Q10008', 'Q10009', 'Q10010', 'Q20001']),
  JSON.stringify(listed));
check('a car Uber marks INACTIVE is not listed, however fresh its tracker', !row('Q10004'));
check('a car only another channel lists is not listed', !row('Q10005'));
check('a car only a tracker knows is not listed', !row('Q10006'));
check('one row per car', listed.length === new Set(listed).size);
check('the fleet is the one Uber filed the car under',
  row('Q10001')?.fleet_id === 'ecosine' && row('Q20001')?.fleet_id === 'egari');
check('the window is stated in the response, and it is a day', d.window_hours === 24 && FEED_WINDOW_H === 24,
  String(d.window_hours));

console.log('\nreceiving both, neither');
{
  const r = row('Q10001');
  check('a car receiving both feeds is green on both',
    r?.seat_receiving === true && r?.fms_receiving === true
    && r.seat_state === 'receiving' && r.fms_state === 'receiving', JSON.stringify(r));
  check('…with no reason on either, because there is nothing to explain',
    r?.seat_reason === null && r?.fms_reason === null);
  check('…and the time each was last received',
    !!r?.seat_at && !!r?.fms_at && Date.parse(r.fms_at) > Date.parse(r.seat_at));
}
{
  const r = row('Q10002');
  check('a car receiving neither is red on both',
    r?.seat_receiving === false && r?.fms_receiving === false, JSON.stringify(r));
  check('…and says the readings stopped, rather than that there were none',
    r?.seat_state === 'silent' && /no CABMAN seat-sensor reading in the last 24 hours/.test(r.seat_reason)
    && r?.fms_state === 'silent' && /no FMS reading in the last 24 hours/.test(r.fms_reason),
    `${r?.seat_reason} | ${r?.fms_reason}`);
  check('…and still carries when each was last heard from',
    !!r?.seat_at && !!r?.fms_at);
}
{
  const r = row('Q10003');
  check('a car no feed has ever reported is red on both, "on record"',
    r?.seat_state === 'never' && r?.fms_state === 'never'
    && /on record for this car/.test(r.seat_reason) && /on record for this car/.test(r.fms_reason),
    `${r?.seat_reason} | ${r?.fms_reason}`);
  check('…with no last-received time to show', r?.seat_at == null && r?.fms_at == null);
}

console.log('\na fleet with no CABMAN account');
{
  const r = row('Q20001');
  check('an Egari car is red on the seat sensor', r?.seat_receiving === false, JSON.stringify(r));
  check('…and the reason is the account, in those words',
    r?.seat_state === 'no_account' && r?.seat_reason === 'no CABMAN account for Egari',
    String(r?.seat_reason));
  check('…which says nothing about its device', !/device|broken|fault|tracker/i.test(r?.seat_reason || ''));
  check('…while its FMS, which Egari does have, is judged on its readings', r?.fms_receiving === true);
  check('…and so is its FMS seat sensor: Egari has seat data, just not from CABMAN',
    r?.fms_seat_receiving === true && r?.fms_seat_state === 'receiving' && !!r?.fms_seat_at, JSON.stringify(r));
  check('the response names which fleets hold which accounts',
    JSON.stringify(d.accounts?.seat) === '["ecosine"]'
    && JSON.stringify([...(d.accounts?.fms || [])].sort()) === '["ecosine","egari"]',
    JSON.stringify(d.accounts));
}

console.log('\nthe window');
check('a seat reading 23h50m old is receiving', row('Q10007')?.seat_receiving === true,
  JSON.stringify(row('Q10007')));
check('a seat reading 24h10m old is not', row('Q10008')?.seat_receiving === false
  && row('Q10008')?.seat_state === 'silent', JSON.stringify(row('Q10008')));
check('a fresh CABMAN fix with no seat value is not seat-sensor data',
  row('Q10009')?.seat_receiving === false && row('Q10009')?.seat_state === 'never',
  JSON.stringify(row('Q10009')));
check('a reading dated tomorrow does not keep a car green whose real readings are three days old',
  row('Q10010')?.seat_receiving === false && row('Q10010')?.seat_state === 'silent'
  && Date.parse(row('Q10010')?.seat_at) < Date.now(),
  JSON.stringify(row('Q10010')));

console.log('\nthe driver and the phone');
{
  const r = row('Q10001');
  check('Uber’s own assignment names the driver, ahead of custody',
    r?.driver_basis === 'uber_assignment' && r.driver_refs.length === 1
    && r.driver_refs[0].name === 'Test Driver Alpha', JSON.stringify(r?.driver_refs));
  check('…with the phone the roster holds for them', r?.driver_refs?.[0]?.phone === '+999 555 0101');
  check('…and the account to open their page by', r?.driver_refs?.[0]?.id === 'drv-a1');
}
{
  const r = row('Q20001');
  const names = (r?.driver_refs || []).map((x) => x.name);
  check('a car Uber assigns to two drivers names both',
    r?.driver_basis === 'uber_assignment'
    && JSON.stringify(names) === '["Test Driver Echo","Test Driver Foxtrot"]', JSON.stringify(names));
  const fox = (r?.driver_refs || []).find((x) => x.name === 'Test Driver Foxtrot');
  check('a driver nobody holds a phone for comes back with phone null, not a blank string',
    fox && fox.phone === null, JSON.stringify(fox));
}
{
  const r = row('Q10002');
  check('where Uber assigns nobody, the custody driver is named',
    r?.driver_basis === 'custody' && r.driver_refs[0]?.name === 'Test Driver Charlie'
    && r.driver_as_of === '2026-09-19', JSON.stringify(r?.driver_refs) + r?.driver_as_of);
  check('…and their phone comes from the same person’s other account when this one has none',
    r?.driver_refs?.[0]?.phone === '+999 555 0301', JSON.stringify(r?.driver_refs));
}
{
  const r = row('Q10003');
  check('a car nobody is known to drive says so, with the reason',
    r?.driver_refs?.length === 0 && r?.driver_basis === null
    && /no driver known/.test(r?.driver_absent || ''), JSON.stringify(r));
  check('…and its plate is not linked to a vehicle page that would 404',
    r?.vehicle_page === false && row('Q10001')?.vehicle_page === true);
}

console.log('\nFMS, the second seat-sensor provider');
{
  check('a car with an FMS trip carrying a seat count in the window is receiving',
    row('Q10001')?.fms_seat_receiving === true, JSON.stringify(row('Q10001')));
  check('…even when the count is 0: an empty seat is still a reading', row('Q10001')?.fms_seat_state === 'receiving');
  check('a car whose last FMS seat count is three days old is not, and says when it was',
    row('Q10002')?.fms_seat_receiving === false && row('Q10002')?.fms_seat_state === 'silent'
    && !!row('Q10002')?.fms_seat_at && /no FMS seat-count reading in the last 24 hours/.test(row('Q10002')?.fms_seat_reason || ''),
    JSON.stringify(row('Q10002')));
  check('an FMS trip with no seat count is not seat-sensor data',
    row('Q10007')?.fms_seat_receiving === false && row('Q10007')?.fms_seat_at == null, JSON.stringify(row('Q10007')));
  check('another channel\u2019s seat count is not FMS\u2019s', row('Q10008')?.fms_seat_receiving === false
    && row('Q10008')?.fms_seat_at == null, JSON.stringify(row('Q10008')));
  check('a car FMS has never sent a seat count for says so, "on record"',
    row('Q10003')?.fms_seat_state === 'never'
    && row('Q10003')?.fms_seat_reason === 'no FMS seat-count reading on record for this car', row('Q10003')?.fms_seat_reason);
  check('the response names FMS as a seat-sensor provider for both fleets',
    JSON.stringify([...(d.accounts?.fms_seat || [])].sort()) === '["ecosine","egari"]', JSON.stringify(d.accounts));
}

console.log('\nthe count at the top');
check('receiving and not receiving are counted per feed over every listed car',
  d.totals?.vehicles === 8
  && d.totals.seat.receiving === 2 && d.totals.seat.not_receiving === 6
  && d.totals.fms.receiving === 2 && d.totals.fms.not_receiving === 6
  && d.totals.fms_seat?.receiving === 2 && d.totals.fms_seat?.not_receiving === 6,
  JSON.stringify(d.totals));
check('…and per fleet', d.totals?.fleets?.ecosine === 7 && d.totals?.fleets?.egari === 1,
  JSON.stringify(d.totals?.fleets));
check('the cars that need attention come first',
  d.rows[0] && !d.rows[0].seat_receiving && !d.rows[0].fms_receiving
  && d.rows[d.rows.length - 1].plate === 'Q10001', d.rows.map((r) => r.plate).join(','));

console.log('\na fleet whose whole feed goes quiet');
/* Every Ecosine seat reading pushed back five days. Nothing Ecosine receives
   on CABMAN any more, which is the shape of an expired login, not of seven
   devices failing on one afternoon. */
await q(`UPDATE telemetry_snapshot SET captured_at = captured_at - interval '5 days'
          WHERE source = 'cabman'`);
d = await read();
check('a car the feed used to report is red with the feed named as the cause',
  row('Q10001')?.seat_state === 'feed_dark'
  && /nothing from CABMAN for any Ecosine car in 24 hours/.test(row('Q10001')?.seat_reason || ''),
  String(row('Q10001')?.seat_reason));
check('…but a car it never reported still says only that', row('Q10003')?.seat_state === 'never');
check('…and the fleet without an account still says only that', row('Q20001')?.seat_state === 'no_account');
check('…and the other feed is untouched', row('Q10001')?.fms_state === 'receiving');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
