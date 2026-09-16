import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
const db = new PGlite();
await applySchema(db);
const q=(t,p=[])=>db.query(t,p).then(r=>r.rows);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','E') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO trip (platform, external_id, plate, driver_ext_id, driver_name, requested_at, fleet_id, status, product, distance_km)
 VALUES ('uber','a','L36397','u1','A','2026-09-10T01:00:00Z','ecosine','completed','UberX',10)`);
console.log(await q(`SELECT plate, product, local_day, is_booking FROM trip_norm`));
await db.close();
