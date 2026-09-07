/* An accusation is checked against our own record before it is made.
   ─────────────────────────────────────────────────────────────────────────
   drivers_online_no_trips is the most severe finding this product emits, and
   on 2026-09-07 every word of it was false. It named eight drivers as "online
   but completed no trips" on 6 September. Against our own trip_norm those
   eight completed SEVENTY-ONE bookings between them — 16, 14, 10, 9, 8, 6, 4
   and 4 — and Uber's "13.5 hours online in total" was 109 hours measured.
   Every one of them was active, could earn, and was rated between 4.85 and
   4.99 over hundreds of lifetime trips. The board's top item, at critical
   severity, was calling the fleet's best drivers dead weight.

   The mechanism is plain once seen. Uber's getRecommendations is a SNAPSHOT
   republished DURING the day about the day in progress; the rule read it as a
   verdict on a finished one. A driver who went online at 07:49 and completed
   his first booking at 09:01 is "1.2 hours online, zero trips" in an 08:01
   snapshot and a full day's work by evening.

   Two properties are pinned here, and both are about what the rule REFUSES to
   say rather than what it says — which is the half that was missing:
     1. a driver our own record shows completing a booking is never named;
     2. a period that has not closed is not reported as a verdict on it.
   Plus the arbitration bug found alongside: twenty rows written newest-first
   through an arbiter keyed on entity_id 'all' meant the OLDEST row in the
   batch was the one that survived, and the two fleets overwrote each other. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const { pool } = await import('../src/db.js');
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});

/* Yesterday in Dubai, so the period is closed however this file is run. */
const dubai = (d) => new Date(d.getTime() + 4 * 36e5).toISOString().slice(0, 10);
const YESTERDAY = dubai(new Date(Date.now() - 864e5));
const TODAY = dubai(new Date());

/* WORKED really did complete a booking; IDLE really did not. Uber flags both,
   which is the situation measured on production. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, ended_at, status, distance_km)
         VALUES ('uber','pf-1','ecosine','L1','WORKED','Worked All Day',
                 ($1::date + time '09:01') AT TIME ZONE 'Asia/Dubai',
                 ($1::date + time '09:30') AT TIME ZONE 'Asia/Dubai','completed',12)`, [YESTERDAY]);

const flagged = JSON.stringify([
  { driver_ext_id: 'WORKED', value: 0, online_hours: 1.2 },
  { driver_ext_id: 'IDLE', value: 0, online_hours: 2.0 },
]);
const rec = async (fleet, start, end, updated) => q(
  `INSERT INTO platform_recommendation
     (platform, rec_type, rec_uuid, fleet_id, period_start, period_end,
      org_value, target_value, flagged_count, flagged, updated_at)
   VALUES ('uber','RECOMMENDATION_TYPE_ORG_TRIP_COMPLETION',$1,$2,$3::date,$4::date,
           0.5,0.9,2,$5,$6)`,
  [`u-${fleet}-${end}`, fleet, start, end, flagged, updated]);

await rec('ecosine', YESTERDAY, YESTERDAY, `${YESTERDAY}T04:00:00Z`);

const { computeInsights } = await import('../src/insights.js');
await computeInsights();

console.log('\nnobody who worked is accused of not working');

const found = await q(`SELECT * FROM insight WHERE code = 'drivers_online_no_trips'`);
check('the finding is still emitted for the driver who really did nothing',
  found.length === 1, `${found.length} rows`);
const refs = found[0] && (typeof found[0].refs === 'string' ? JSON.parse(found[0].refs) : found[0].refs);
const named = (refs || []).map((r) => r.driver_ext_id);
check('…and it names them', named.includes('IDLE'), JSON.stringify(named));
/* THE ASSERTION THIS FILE EXISTS FOR. */
check('…and it does NOT name the driver our own record shows completing a booking',
  !named.includes('WORKED'), JSON.stringify(named));
check('…so the count is one, not two', Number(found[0]?.metric) === 1, String(found[0]?.metric));
/* The ones dropped are not hidden — an operator reading "1 driver" where Uber
   said 2 deserves to know why the numbers differ. */
check('…and it says why the others were dropped',
  /did complete bookings/.test(found[0]?.detail || ''), found[0]?.detail);

console.log('\na day still running is not reported as a verdict on it');

await q(`DELETE FROM insight`);
await q(`DELETE FROM platform_recommendation`);
await rec('ecosine', TODAY, TODAY, `${TODAY}T04:00:00Z`);
await computeInsights();
const open = await q(`SELECT * FROM insight WHERE code = 'drivers_online_no_trips'`);
check('an open period still reports', open.length === 1, `${open.length} rows`);
check('…but not at critical severity', open[0]?.severity !== 'critical', open[0]?.severity);
check('…and it says the period has not closed',
  /has not closed|day so far/i.test(open[0]?.detail || ''), open[0]?.detail);
check('…and the action does not send anybody to make a phone call yet',
  /still running|rather than a call/i.test(open[0]?.action || ''), open[0]?.action);

console.log('\nthe newest reading wins, and one fleet does not overwrite the other');

await q(`DELETE FROM insight`);
await q(`DELETE FROM platform_recommendation`);
/* Two periods for one fleet, and a second fleet. Written newest-first, the old
   code let the OLDEST survive and let egari replace ecosine. */
const older = dubai(new Date(Date.now() - 5 * 864e5));
await rec('ecosine', older, older, `${older}T04:00:00Z`);
await rec('ecosine', YESTERDAY, YESTERDAY, `${YESTERDAY}T04:00:00Z`);
await rec('egari', YESTERDAY, YESTERDAY, `${YESTERDAY}T04:00:00Z`);
await computeInsights();
const rows = await q(`SELECT fleet_id, entity_id, window_end FROM insight
                      WHERE code = 'drivers_online_no_trips' ORDER BY fleet_id`);
check('both fleets survive rather than one replacing the other',
  rows.length === 2, JSON.stringify(rows));
check('…because the row is keyed on the fleet, not on the word "all"',
  rows.every((r) => r.entity_id && r.entity_id !== 'all'),
  JSON.stringify(rows.map((r) => r.entity_id)));
/* pg hands a DATE back as a JS Date, so slicing its toString gives
   "Sun Sep 06" and the comparison is against the wrong shape rather than the
   wrong value. Normalised through the same Dubai helper the seed used. */
const asDay = (v) => (v instanceof Date ? dubai(v) : String(v).slice(0, 10));
check('…and the period kept is the newest, not the oldest of the batch',
  rows.every((r) => asDay(r.window_end) === YESTERDAY),
  JSON.stringify(rows.map((r) => asDay(r.window_end))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
