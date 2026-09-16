import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
const db = new PGlite();
await applySchema(db);
const q=(t,p=[])=>db.query(t,p).then(r=>r.rows);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','E') ON CONFLICT DO NOTHING`);
for (const [i,[id,nm,pf]] of [['5f16534e-68be-451b-b057-3e3d948e868b','Aliyan khalil','uber'],['7fc8da91fc4a44c185e8d6d918db3e6b','Khalil Aliyan','yango'],['b3','ALIYAN KHALIL','bolt'],['u-nouman','Raja Nouman Ahmed','uber']].entries())
  await q(`INSERT INTO trip (platform, external_id, plate, driver_ext_id, driver_name, requested_at, fleet_id, status, product, distance_km, price)
   VALUES ($1,$2,'L36397',$3,$4,'2026-09-10T01:00:00Z','ecosine','completed','UberX',10,100)`,[pf,'x'+i,id,nm]);
const { get, server } = await mountAll(db);
for (const p of ['/api/drivers/cross-platform?from=2026-09-01&to=2026-09-30','/api/compare/period?from=2026-09-01&to=2026-09-30']) {
  const r = await get(p); console.log(p, r.status, JSON.stringify(r.body).slice(0,600));
}
server.close(); await db.close();
