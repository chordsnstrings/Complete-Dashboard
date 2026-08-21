// Vehicle documents, platform recommendations and tip signal — the surfaces the
// first pass missed. Uses the real expiry shape seen live (8 vehicles at 5 days).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
for (const f of ['schema.sql','schema_v2.sql','schema_v3.sql','schema_v4.sql','schema_v5.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

const day = (n) => new Date(Date.now() + n * 864e5).toISOString();
await q(`INSERT INTO vehicle_profile (platform,vehicle_ext_id,plate,fleet_id,make,model,year)
         VALUES ('uber','v1','L20048','ecosine','Tesla','Model Y',2023),
                ('uber','v2','L37810','ecosine','BYD','Han EV',2024),
                ('uber','v3','L99999','ecosine','Lexus','ES 300h',2022)`);
await q(`INSERT INTO vehicle_document (platform,vehicle_ext_id,doc_type,plate,fleet_id,status,expires_at)
         VALUES ('uber','v1','Vehicle Registration Form','L20048','ecosine','ACTIVE',$1),
                ('uber','v2','Vehicle Registration Form','L37810','ecosine','ACTIVE',$2),
                ('uber','v3','Vehicle Registration Form','L99999','ecosine','ACTIVE',$3)`,
        [day(5), day(-10), day(200)]);

const due = await q(`SELECT plate,(expires_at::date - now()::date) AS days_left FROM vehicle_document
                     WHERE expires_at < now() + interval '45 days' ORDER BY expires_at`);
check('only near/expired documents surface', due.length === 2, JSON.stringify(due));
check('expired one is negative days', Number(due[0].days_left) < 0, JSON.stringify(due[0]));
check('far-future document ignored', !due.some(r => r.plate === 'L99999'));

// severity: expired or <=7 days is critical
const sev = due.map(r => ({ plate: r.plate, critical: Number(r.days_left) < 0 || Number(r.days_left) <= 7 }));
check('5-day and expired both critical', sev.every(s => s.critical), JSON.stringify(sev));

// platform recommendations
await q(`INSERT INTO platform_recommendation (platform,rec_type,rec_uuid,fleet_id,period_start,period_end,org_value,target_value,flagged_count,flagged)
         VALUES ('uber','RECOMMENDATION_TYPE_ORG_TRIP_COMPLETION','r1','ecosine',$1,$1,null,null,2,
                 '[{"driver_ext_id":"d1","value":0,"online_hours":1.0},{"driver_ext_id":"d2","value":0,"online_hours":1.02}]'::jsonb),
                ('uber','RECOMMENDATION_TYPE_ORG_ACCEPTANCE_RATE','r2','ecosine',$1,$1,0.997,0.977,1,
                 '[{"driver_ext_id":"d3","value":0.92}]'::jsonb)`, ['2026-08-19']);
const recs = await q(`SELECT rec_type, flagged_count, flagged FROM platform_recommendation ORDER BY rec_type`);
check('recommendations stored', recs.length === 2, JSON.stringify(recs.map(r=>r.rec_type)));
const comp = recs.find(r => /TRIP_COMPLETION/.test(r.rec_type));
const zero = (typeof comp.flagged === 'string' ? JSON.parse(comp.flagged) : comp.flagged).filter(f => Number(f.value) === 0);
check('zero-trip drivers extracted', zero.length === 2, JSON.stringify(zero));
check('online hours summed', zero.reduce((a,f)=>a+f.online_hours,0) > 2);

// tips
await q(`INSERT INTO driver_earnings_component (platform,driver_ext_id,period_start,period_end,category,amount,driver_name)
         VALUES ('uber','d1','2026-08-14','2026-08-21','net_fare',1000,'Generous Rider Driver'),
                ('uber','d1','2026-08-14','2026-08-21','tip',50,'Generous Rider Driver'),
                ('uber','d2','2026-08-14','2026-08-21','net_fare',1000,'No Tips Driver'),
                ('uber','d2','2026-08-14','2026-08-21','tip',2,'No Tips Driver'),
                ('uber','d3','2026-08-14','2026-08-21','net_fare',800,'Mid Driver'),
                ('uber','d3','2026-08-14','2026-08-21','tip',30,'Mid Driver'),
                ('uber','d4','2026-08-14','2026-08-21','net_fare',900,'Other Driver'),
                ('uber','d4','2026-08-14','2026-08-21','tip',36,'Other Driver')`);
const tips = await q(
  `SELECT driver_ext_id, max(driver_name) nm,
          sum(amount) FILTER (WHERE category='tip') tips,
          sum(amount) FILTER (WHERE category='net_fare') fare,
          (sum(amount) FILTER (WHERE category='tip')/nullif(sum(amount) FILTER (WHERE category='net_fare'),0)) rate
   FROM driver_earnings_component GROUP BY 1 ORDER BY rate ASC`);
check('tip rate computed per driver', tips.length === 4, JSON.stringify(tips.length));
check('worst tipper identified', tips[0].nm === 'No Tips Driver', tips[0].nm);
check('tip rate is a fraction of fare', Math.abs(Number(tips[0].rate) - 0.002) < 1e-6, String(tips[0].rate));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
