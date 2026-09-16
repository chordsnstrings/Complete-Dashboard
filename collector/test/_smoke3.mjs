import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
const db = new PGlite();
await applySchema(db);
const q=(t,p=[])=>db.query(t,p).then(r=>r.rows);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','E') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO trip (platform, external_id, plate, driver_ext_id, driver_name, requested_at, fleet_id, status, product, distance_km)
 VALUES ('uber','a','L36397','u1','A','2026-09-10T01:00:00Z','ecosine','completed','UberX',10)`);
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, is_primary)
 VALUES ('L36397','2026-09-10','u1','uber','A','ecosine',3,true)`);
const { get, server } = await mountAll(db);
const r = await get('/api/product/by-vehicle?from=2026-09-01&to=2026-09-30');
console.log(r.status, JSON.stringify(r.body).slice(0,400), r.raw);
server.close(); await db.close();
