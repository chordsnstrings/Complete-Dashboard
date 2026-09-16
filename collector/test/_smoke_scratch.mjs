import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
const db = new PGlite();
await applySchema(db);
const q = (t,p=[]) => db.query(t,p).then(r=>r.rows);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
const { get, server } = await mountAll(db);
const WIN='from=2026-08-01&to=2026-09-30';
const paths=[
 `/api/unauthorized/by-vehicle?${WIN}`,
 `/api/product/by-vehicle?${WIN}`,
 `/api/tiers/by-vehicle?${WIN}`,
 `/api/alerts/by-vehicle?${WIN}`,
 `/api/alerts/by-driver?${WIN}`,
 `/api/settlement/cash-exposure?${WIN}`,
 `/api/settlement/receivables?${WIN}`,
 `/api/day?day=2026-09-10`,
 `/api/kpis?${WIN}`,
 `/api/revenue?${WIN}`,
 `/api/finance/receipts?${WIN}`,
 `/api/playbook?${WIN}`,
 `/api/compare?a=2026-09-09&b=2026-09-10`,
 `/api/slot?dow=4&hour=19&${WIN}`,
 `/api/vehicle/kpis?plate=L1&${WIN}`,
 `/api/vehicle/daily?plate=L1&${WIN}`,
 `/api/economics/assets?${WIN}`,
 `/api/export/trips.csv?grain=day&${WIN}`,
 `/api/supply/balance?${WIN}`,
 `/api/drivers/performance?${WIN}`,
 `/api/reconcile/periods?${WIN}`,
 `/api/earnings/components?${WIN}`,
];
let bad=0;
for (const p of paths){
  const r = await get(p);
  const ok = r.status===200 || r.status===404;
  if(!ok){bad++;console.log('FAIL',p,r.status,JSON.stringify(r.body||r.raw).slice(0,300));}
  else console.log('ok  ',p,r.status);
}
server.close(); await db.close();
console.log(bad?'BAD '+bad:'ALL OK');
process.exit(bad?1:0);
