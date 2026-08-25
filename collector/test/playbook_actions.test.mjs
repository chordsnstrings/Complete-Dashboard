/* ── the to-do list named the wrong people and sized the wrong month ───────
   Four defects, all of them on a page that tells an operator what to do:

   1. Every idle-vehicle detail row named the same three drivers. The CTE was
      called `v` and custodyOverWindow/custodyCountOverWindow alias
      vehicle_driver_day as `v` too, so the injected `v.plate = v.plate` was a
      self-comparison: true for every custody row in the window. Production
      showed driver_n 123 on all twelve rows, including L12377, L19261 and
      L25379, which have journeys 0 and no custody at all.

   2. Ceilings labelled "bookings/month" were per-window. median_bookings came
      back 38 / 120 / 1,656 at 7 / 30 / 365 days, so the SAME 31 blocked
      vehicles were sized at 1,163 / 3,705 / 51,336 bookings a month.

   3. "Modelled upside" added avoided loss to gain. The reduce matched
      /bookings/ against ceiling_unit and 'bookings/month protected' matches,
      so renew_documents' protection was summed beside the redeployment ceiling
      of the same cars.

   4. The platform and fleet chips did nothing: md5 of /api/playbook was
      identical across no filter, &platform=uber, &fleet=egari and
      &fleet=ecosine on a two-fleet operator.

   Plus the three money actions carrying no evidence table at all, and "Put 1
   vehicles back to work". */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

/* A YEAR of work at a constant daily rate on one earning car per fleet, so the
   per-30-day median is the same number whichever range is asked for. That is
   what makes the ceiling check below a test of the normalisation rather than of
   how the fixture happens to be bunched: with the work concentrated in one
   month, a correctly normalised ceiling still differs by window, because the
   fleet genuinely was not working the rest of the year.

   ECO-BUSY takes three bookings a day (a plain fare, a cash fare the driver
   holds, and a room charge on account) and EGA-BUSY one, so the median over the
   two earning cars is two a day at every window. Three cars take nothing at
   all; ECO-IDLE-HELD was held by ONE person, ECO-IDLE-BARE by nobody — the row
   the alias collision invented drivers for. */
const YEAR = "generate_series('2026-01-01'::date, '2026-12-31'::date, '1 day') d";
const daily = (plate, fleetId, platform, price, pay, tag) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, distance_km, status, price, payment_type)
   SELECT $1, $2 || to_char(d,'YYYYMMDD'), $3, $4, 'd-busy', 'Busy Driver',
          d + interval '9 hours', 12, 'completed', $5, $6
     FROM ${YEAR}`,
  [platform, tag, fleetId, plate, price, pay]);

await daily('ECO-BUSY', 'ecosine', 'uber', null, 'cashless', 'a');
await daily('ECO-BUSY', 'ecosine', 'hotel', 55, 'cash', 'b');
await daily('ECO-BUSY', 'ecosine', 'hotel', 90, 'room-charge', 'c');
await daily('EGA-BUSY', 'egari', 'uber', null, 'cashless', 'd');

// One booking that did not complete, so the Improve action fires with a
// per-platform breakdown behind it.
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, distance_km, status, price)
         VALUES ('uber','lost-1','ecosine','ECO-BUSY','d-busy','Busy Driver',
                 '2026-08-05T10:00:00+04:00',5,'rider_cancelled',NULL)`);

for (const plate of ['ECO-IDLE-HELD', 'ECO-IDLE-BARE', 'EGA-IDLE']) {
  await q(`INSERT INTO vehicle_document (platform, vehicle_ext_id, fleet_id, plate, doc_type,
             expires_at, status)
           VALUES ('fms',$1,$2,$3,'registration',now() + interval '5 days','valid')`,
    [`veh-${plate}`, plate.startsWith('EGA') ? 'egari' : 'ecosine', plate]);
}

/* Custody: only ECO-IDLE-HELD was ever held, and only by one person. Before the
   rename, this row's driver list came back as EVERY custodian in the window and
   ECO-IDLE-BARE came back with them too. */
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
           fleet_id, trips, is_primary)
         VALUES ('ECO-IDLE-HELD','2026-08-04','d-held','uber','Held By Me','ecosine',0,true),
                ('ECO-BUSY','2026-08-04','d-busy','uber','Busy Driver','ecosine',12,true),
                ('EGA-BUSY','2026-08-04','d-ega','uber','Egari Driver','egari',9,true)`);

const { server, get } = await mountAll(db, { serverRoutes: false });
const W = 'from=2026-08-01&to=2026-08-31';
const body = async (qs) => (await get(`/api/playbook?${qs}`)).body;
const find = (b, id) => (b.actions || []).find((a) => a.id === id);

console.log('\nplaybook: the idle-vehicle detail names this car\'s custodians and nobody else');

const b = await body(W);
const idle = find(b, 'redeploy_idle_vehicles');
check('the idle-vehicle action fires', !!idle, JSON.stringify((b.actions || []).map((a) => a.id)));
const held = idle.detail.find((d) => d.plate === 'ECO-IDLE-HELD');
const bare = idle.detail.find((d) => d.plate === 'ECO-IDLE-BARE');
check('a car nobody has ever held reports no custodians, not the whole fleet\'s',
  bare && bare.driver_n === 0 && (bare.driver_refs == null || bare.driver_refs.length === 0),
  JSON.stringify(bare));
check('and a car that WAS held reports only the person who held it',
  held && held.driver_n === 1 && held.driver_refs.length === 1
  && held.driver_refs[0].name === 'Held By Me', JSON.stringify(held));
/* The collision's signature: two different plates handed back an identical
   driver list, because both had been compared against themselves. */
check('two idle cars do not share one custody list',
  JSON.stringify(bare?.driver_refs) !== JSON.stringify(held?.driver_refs));

console.log('\nplaybook: a ceiling labelled per month does not move with the range chip');

const wide = await body('from=2026-01-01&to=2026-12-31');
const narrow = await body('from=2026-08-01&to=2026-08-07');
const ceil = (x, id) => find(x, id)?.ceiling ?? null;
check('the same idle cars are sized the same at one week, one month and one year',
  [ceil(b, 'redeploy_idle_vehicles'), ceil(wide, 'redeploy_idle_vehicles'),
    ceil(narrow, 'redeploy_idle_vehicles')].every((v, _i, a) => v != null
      && Math.abs(v - a[0]) <= Math.max(1, a[0] * 0.1)),
  JSON.stringify([ceil(narrow, 'redeploy_idle_vehicles'), ceil(b, 'redeploy_idle_vehicles'),
    ceil(wide, 'redeploy_idle_vehicles')]));
check('and the fleet median is published in the unit the ceilings are labelled with',
  b.fleet.median_unit === 'bookings per 30 days' && b.fleet.median_bookings_window != null,
  JSON.stringify({ u: b.fleet.median_unit, w: b.fleet.median_bookings_window }));
check('the window used is stated, so the normalisation can be checked',
  b.window_days === 31 && narrow.window_days === 7,
  `${b.window_days} / ${narrow.window_days}`);

console.log('\nplaybook: money kept is not money won');

const docs = find(b, 'renew_documents');
check('the document action fires and is tagged as protection, not gain',
  docs && docs.direction === 'protect', JSON.stringify(docs && docs.direction));
check('every other action is tagged as gain',
  (b.actions || []).filter((a) => a.id !== 'renew_documents' && a.id !== 'renew_licences')
    .every((a) => a.direction === 'gain'));
check('bookings at risk are totalled apart from the ceiling that could be won',
  b.totals.bookings_at_risk > 0
  && b.totals.bookings_ceiling_gain === b.totals.bookings_ceiling
  && b.totals.bookings_ceiling_gain !== b.totals.bookings_ceiling + b.totals.bookings_at_risk,
  JSON.stringify(b.totals));
/* The bug in one line: the protected ceiling must not appear inside the gain. */
check('the protected ceiling is not inside the gain total',
  b.totals.bookings_ceiling_gain
    === (b.actions || []).filter((a) => a.direction !== 'protect')
      .reduce((a, x) => a + (/bookings/.test(x.ceiling_unit || '') ? x.ceiling : 0), 0),
  JSON.stringify(b.totals));
const modelled = await body(`${W}&aed_per_trip=50`);
check('and the modelled AED headline excludes it too',
  modelled.totals.aed_modelled_at_risk > 0
  && modelled.totals.aed_modelled === (modelled.actions || [])
    .filter((a) => a.direction !== 'protect').reduce((a, x) => a + (x.aed_modelled || 0), 0),
  JSON.stringify(modelled.totals));

console.log('\nplaybook: the money actions carry their evidence');

for (const id of ['collect_receivables', 'reconcile_cash', 'reduce_cancellations']) {
  const a = find(b, id);
  check(`${id} fires and expands to a table`, !!a && Array.isArray(a.detail) && a.detail.length > 0,
    JSON.stringify(a && Object.keys(a)));
}
check('the receivable rows carry the id their counterparty page is keyed on',
  find(b, 'collect_receivables').detail.every((r) => 'partner_id' in r && 'driver_ext_id' in r
    && r.amount > 0 && r.oldest_days != null),
  JSON.stringify(find(b, 'collect_receivables').detail[0]));
check('the cash rows carry a driver id and say when the AED is only a floor',
  find(b, 'reconcile_cash').detail.every((r) => 'driver_ext_id' in r
    && typeof r.unpriced_channel === 'boolean'),
  JSON.stringify(find(b, 'reconcile_cash').detail[0]));
check('the cancellation rows break down by platform, which is where the fix is',
  find(b, 'reduce_cancellations').detail.every((r) => r.platform && r.judged > 0),
  JSON.stringify(find(b, 'reduce_cancellations').detail));

console.log('\nplaybook: the filters the page displays actually narrow it');

const eco = await body(`${W}&fleet=ecosine`);
const ega = await body(`${W}&fleet=egari`);
check('the two fleets get different answers',
  JSON.stringify(eco.actions) !== JSON.stringify(ega.actions));
check('Egari\'s idle list contains only Egari plates',
  find(ega, 'redeploy_idle_vehicles').detail.every((d) => d.plate.startsWith('EGA')),
  JSON.stringify(find(ega, 'redeploy_idle_vehicles').detail.map((d) => d.plate)));
check('and Ecosine\'s contains only Ecosine plates',
  find(eco, 'redeploy_idle_vehicles').detail.every((d) => d.plate.startsWith('ECO')),
  JSON.stringify(find(eco, 'redeploy_idle_vehicles').detail.map((d) => d.plate)));
check('a channel with no bookings does not inherit the whole fleet\'s figures',
  JSON.stringify((await body(`${W}&platform=bolt`)).actions)
    !== JSON.stringify(b.actions));

console.log('\nplaybook: one of a thing is not "1 things"');

check('a single Egari idle vehicle reads "1 vehicle", not "1 vehicles"',
  /Put 1 vehicle back to work — it took no booking/.test(find(ega, 'redeploy_idle_vehicles').title),
  find(ega, 'redeploy_idle_vehicles').title);
check('and the size unit agrees with it',
  find(ega, 'redeploy_idle_vehicles').size_unit === 'vehicle',
  find(ega, 'redeploy_idle_vehicles').size_unit);
check('no action title contains a "1 <plural>"',
  (b.actions || []).concat(ega.actions || []).every((a) => !/\b1 (vehicles|drivers|documents|hours|areas|bookings|counterparties|licences)\b/.test(a.title)),
  (b.actions || []).concat(ega.actions || []).map((a) => a.title).join(' | '));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
