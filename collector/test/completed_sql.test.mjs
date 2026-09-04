/* A re-derivation nothing checks is a re-derivation that drifts.
   ─────────────────────────────────────────────────────────────────────────
   trip_norm derives `outcome` (sql/schema_v18.sql) and several hot queries
   read `trip` directly instead — person_key is a column of trip and joining
   the view for it cost a sequential scan at every window. Those queries
   already re-derive has_fare and has_distance in the same spirit, and
   COMPLETED_SQL is the third of the kind.

   The cost of not checking one is on the record. /api/economics/drivers
   carried a FOURTH copy of the status list, and it had drifted: no
   `optional_ride_` strip and no `offer_rejected`, so on production over 365
   days 908 optional_ride_driver_did_not_respond and 626
   optional_ride_driver_rejected rows read as 'other' on that ledger while
   schema_v18 reads them as not_completed.

   So the fragment is asserted against the view itself, over every status
   spelling in the record, in one database. If they ever disagree this fails
   and names the spelling. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { COMPLETED_SQL } from '../api/income_sql.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* Every spelling the four collectors write, including the ones that made the
   drift visible. Uber's, Bolt's with and without its offer prefix, Yango's,
   the hotel channel's, and the two that must resolve to neither. */
const STATUSES = [
  'completed', 'finished', 'complete', 'closed', 'delivered',
  'COMPLETED', ' Finished ', 'rider_cancelled', 'driver_cancelled',
  'client_did_not_show', 'driver_did_not_respond', 'driver_rejected',
  'rejected', 'offer_rejected', 'expired', 'failed', 'no_show',
  'optional_ride_driver_did_not_respond', 'optional_ride_driver_rejected',
  'optional_ride_driver_cancelled_after_accept', 'optional_ride_completed',
  'in_progress', 'accepted', 'unknown_state',
];

let n = 0;
for (const st of STATUSES) {
  await q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
       requested_at, ended_at, distance_km, status, price, currency)
     VALUES ('bolt', $1, 'ecosine', 'L500', 'd1', 'D One',
             '2026-09-02T09:00:00+04:00', '2026-09-02T09:20:00+04:00', 8, $2, 30, 'AED')`,
    [`s${++n}`, st]);
}
/* And a telematics journey, where the question does not apply at all. */
await q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
   VALUES ('fms', 'j1', 'ecosine', 'L500', '2026-09-02T09:00:00+04:00', 'completed')`);

console.log('\nthe fragment and the view agree on every spelling in the record');

const rows = await q(
  `SELECT n.external_id, n.status, n.platform, n.outcome,
          ${COMPLETED_SQL('n.status')} AS frag
     FROM trip_norm n ORDER BY n.external_id`);

check('every status in the fixture came back', rows.length === STATUSES.length + 1,
  `${rows.length} of ${STATUSES.length + 1}`);

/* The claim: on a BOOKING, the fragment is true exactly where the view says
   completed. fms is excluded because the view answers NULL there and the
   fragment is a plain boolean — the callers all guard on is_booking first. */
const bookings = rows.filter((r) => r.platform !== 'fms');
const disagree = bookings.filter((r) => (r.outcome === 'completed') !== r.frag);
check('the shared test is true exactly where trip_norm says completed',
  disagree.length === 0,
  JSON.stringify(disagree.map((r) => [r.status, r.outcome, r.frag])));

/* Named individually, because the whole point is which spellings drift. */
const by = Object.fromEntries(bookings.map((r) => [r.status, r.frag]));
check('Bolt’s offer prefix does not make a rejection look like a completion',
  by['optional_ride_driver_rejected'] === false
  && by['optional_ride_driver_did_not_respond'] === false,
  JSON.stringify([by['optional_ride_driver_rejected'], by['optional_ride_driver_did_not_respond']]));
check('…and it does not stop a completion being one either',
  by['optional_ride_completed'] === true, String(by['optional_ride_completed']));
check('case and whitespace do not change the answer',
  by['COMPLETED'] === true && by[' Finished '] === true,
  JSON.stringify([by['COMPLETED'], by[' Finished ']]));
check('a ride still running is not complete',
  by['in_progress'] === false && by['accepted'] === false,
  JSON.stringify([by['in_progress'], by['accepted']]));
check('and a status nobody has mapped is not silently completed',
  by['unknown_state'] === false, String(by['unknown_state']));

/* The telematics row, which the callers reach only behind is_booking. */
const j = rows.find((r) => r.platform === 'fms');
check('the view answers NULL for a journey nobody sold',
  j && j.outcome === null, String(j && j.outcome));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
