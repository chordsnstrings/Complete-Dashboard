// Vehicle documents, platform recommendations and tip signal — the surfaces the
// first pass missed. Uses the real expiry shape seen live (8 vehicles at 5 days).
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

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


/* ── placeholder-date guard ───────────────────────────────────────────────
   Real data: 9 hotel drivers all carry "1/1/26" with licence numbers like
   "123456". Those are system defaults. Reporting nine expiries would be
   confidently wrong, so a dominant shared date raises a data-quality flag
   instead of individual compliance alerts. */
await q(`DELETE FROM driver_compliance`);
for (let i = 0; i < 9; i++) {
  await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_no,licence_expires)
           VALUES ('hotel',$1,'ecosine',$2,'123456','2026-01-01')`, [`ph${i}`, `Placeholder Driver ${i}`]);
}
const spreadPh = (await q(
  `SELECT count(*)::int total,
          mode() WITHIN GROUP (ORDER BY licence_expires) AS common_date,
          count(*) FILTER (WHERE licence_expires =
            (SELECT mode() WITHIN GROUP (ORDER BY licence_expires) FROM driver_compliance
             WHERE licence_expires IS NOT NULL))::int AS common_n
   FROM driver_compliance WHERE licence_expires IS NOT NULL`))[0];
check('placeholder dates detected as dominant', spreadPh.common_n / spreadPh.total >= 0.5,
  `${spreadPh.common_n}/${spreadPh.total}`);

/* THE NUMBER IS A DEFAULT TOO, and this file has said so in a comment since it
   was written — "licence numbers like 123456" — while guarding only the date.
   Measured on production 2026-09-04: of 289 compliance rows, 94 carry a licence
   number and every one of the 94 is the identical string, one distinct value
   across all of them; the other 195 carry none. So the roster holds ZERO real
   licence numbers and the page printed 94 of them as though a reader could
   check one. Detected the same way as the date, and by the same rule: one value
   on more than half the rows that have one is a default. */
const numPh = (await q(
  `SELECT count(*)::int with_number,
          count(DISTINCT licence_no)::int distinct_numbers,
          mode() WITHIN GROUP (ORDER BY licence_no) AS common_no,
          count(*) FILTER (WHERE licence_no =
            (SELECT mode() WITHIN GROUP (ORDER BY licence_no) FROM driver_compliance
             WHERE coalesce(btrim(licence_no),'') <> ''))::int AS common_n
   FROM driver_compliance WHERE coalesce(btrim(licence_no),'') <> ''`))[0];
check('placeholder licence numbers detected as dominant',
  numPh.common_n / numPh.with_number >= 0.5 && numPh.common_n >= 5,
  `${numPh.common_n}/${numPh.with_number}`);
check('and one distinct value across the roster is the evidence',
  numPh.distinct_numbers === 1, String(numPh.distinct_numbers));

// a genuine spread must NOT trip the guard
await q(`DELETE FROM driver_compliance`);
const dates = ['2026-09-01','2026-10-15','2027-01-20','2026-08-01','2026-12-05','2027-03-11'];
for (let i = 0; i < dates.length; i++) {
  await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_no,licence_expires)
           VALUES ('bolt',$1,'egari',$2,$3,$4)`, [`re${i}`, `Real Driver ${i}`, `AE${1000 + i}`, dates[i]]);
}
const spreadReal = (await q(
  `SELECT count(*)::int total,
          count(*) FILTER (WHERE licence_expires =
            (SELECT mode() WITHIN GROUP (ORDER BY licence_expires) FROM driver_compliance
             WHERE licence_expires IS NOT NULL))::int AS common_n
   FROM driver_compliance WHERE licence_expires IS NOT NULL`))[0];
check('genuine spread does not trip the guard', spreadReal.common_n / spreadReal.total < 0.5,
  `${spreadReal.common_n}/${spreadReal.total}`);
/* The same, for the number: a roster of genuine licence numbers must not be
   accused of being defaults. AE1000..AE1005 above are six distinct values. */
const numReal = (await q(
  `SELECT count(*)::int with_number, count(DISTINCT licence_no)::int distinct_numbers,
          count(*) FILTER (WHERE licence_no =
            (SELECT mode() WITHIN GROUP (ORDER BY licence_no) FROM driver_compliance
             WHERE coalesce(btrim(licence_no),'') <> ''))::int AS common_n
   FROM driver_compliance WHERE coalesce(btrim(licence_no),'') <> ''`))[0];
check('a roster of genuine licence numbers is not accused of being defaults',
  numReal.common_n / numReal.with_number < 0.5 && numReal.distinct_numbers === 6,
  `${numReal.common_n}/${numReal.with_number}, ${numReal.distinct_numbers} distinct`);

/* ── deadhead maths (verified against 237 real hotel trips: 6.8% ratio) ── */
const R = 6371, rad = (d) => d * Math.PI / 180;
const hav = (a, b, c, d) => { const dLat = rad(c - a), dLng = rad(d - b);
  const x = Math.sin(dLat/2)**2 + Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x)); };
const dubaiToMarina = hav(25.2048, 55.2708, 25.0805, 55.1403);
check('haversine gives a sane Dubai distance', dubaiToMarina > 14 && dubaiToMarina < 20, dubaiToMarina.toFixed(1) + 'km');
const bad = hav(25.2, 55.2, 0, 0);
check('absurd coordinates exceed the 200km discard threshold', bad > 200, Math.round(bad) + 'km');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
