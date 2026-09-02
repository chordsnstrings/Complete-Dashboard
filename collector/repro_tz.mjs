import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './test/schema.mjs';
import { mountAll } from './test/mount.mjs';

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p);

// Does PGlite parse DATE the same way node-postgres does?
const probe = await q(`SELECT '2026-03-01'::date AS d`);
const d = probe.rows[0].d;
console.log('TZ=', process.env.TZ, '| DATE parsed as', typeof d, d instanceof Date ? d.toString() : JSON.stringify(d));

// rollup_month row: month is DATE = first of the month, Dubai.
await q(`INSERT INTO rollup_month (platform, fleet_id, month, bookings, telematics, drivers,
           attributed_trips, vehicles, earning_vehicles, km, measured_trips, revenue,
           priced_trips, not_completed, outcome_n)
         VALUES ('*','*','2026-03-01', 100, 0, 5, 100, 5, 5, 1000, 100, 5000, 100, 0, 100)`);

const { get, server } = await mountAll(db);
const trend = (await get('/api/trend/monthly')).body;
console.log('  /api/trend/monthly month keys:', (trend.months || []).map((m) => m.m).slice(0, 6));

// /api/performer/weeks reads min/max(local_day), a bare DATE.
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, status, distance_km, price)
         VALUES ('uber','p1','ecosine','L1','u1','D','2026-03-01T09:00:00+04:00','completed',5,20)`);
const weeks = (await get('/api/performer/weeks')).body;
console.log('  /api/performer/weeks first_booking:', weeks.first_booking, 'last_booking:', weeks.last_booking);

// /api/coverage earnings_gaps: from_day is a bare DATE, from_ts a timestamptz instant.
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, status, distance_km, price)
         VALUES ('uber','p0','ecosine','L1','u1','D','2026-02-01T23:30:00Z','completed',5,20)`);
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, day, source, gross, net)
         VALUES ('uber','ecosine','u1','2026-03-01','report', 100, 90)`);
const cov = (await get('/api/coverage')).body;
console.log('  /api/coverage earnings_gaps:', JSON.stringify(cov.earnings_gaps));
console.log('  /api/coverage trips[0].from_ts (raw, JSON-serialised):', cov.trips?.[0]?.from_ts);

server.close(); await db.close();
