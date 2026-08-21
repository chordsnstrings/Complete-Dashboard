// Validates schema v2 + the insight SQL against a real Postgres (PGlite, in-process).
// Seeds a fleet with deliberately planted problems and asserts each rule finds them.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`)); };

await db.exec(readFileSync('sql/schema.sql', 'utf8'));
await db.exec(readFileSync('sql/schema_v2.sql', 'utf8'));
console.log('schema: applied v1 + v2');

// ── seed ──────────────────────────────────────────────────────────────────
const now = new Date();
const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(now.getTime() - n * 864e5);

// IDLE-1 has telemetry but no trips; BUSY-1 works normally
for (const [plate, hoursAgo] of [['IDLE1', 2], ['BUSY1', 1], ['DARK1', 100]]) {
  await q(`INSERT INTO telemetry_snapshot (source,fleet_id,plate,captured_at,polled_at,lat,lng,speed,status)
           VALUES ('cabman','ecosine',$1,$2,$2,25.2,55.3,0,'Active')`, [plate, iso(new Date(now - hoursAgo * 36e5))]);
}
// BUSY1 trips (with deadhead + cancels)
for (let i = 0; i < 60; i++) {
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,distance_km,status,price,deadhead_km,partner_name)
           VALUES ('uber',$1,'ecosine','BUSY1','d1','Test Driver',$2,$3,$4,$5,$6,$7)`,
    [`t${i}`, iso(daysAgo(i % 25)), 10, i % 5 === 0 ? 'rider_cancelled' : 'completed', 40, 5, i < 50 ? 'Hotel A' : 'Hotel B']);
}
// harsh events on BUSY1
for (let i = 0; i < 80; i++) {
  await q(`INSERT INTO alert (platform,external_id,fleet_id,plate,alert_type,occurred_at)
           VALUES ('fms',$1,'ecosine','BUSY1',$2,$3)`,
    [`a${i}`, i % 2 ? 'Harsh Brake' : 'OverSpeed', iso(daysAgo(i % 20))]);
}
// compliance: one expired, one expiring
await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_no,licence_expires)
         VALUES ('hotel','d-exp','ecosine','Expired Driver','L1',$1),('hotel','d-soon','ecosine','Soon Driver','L2',$2)`,
  [iso(daysAgo(30)).slice(0, 10), iso(new Date(now.getTime() + 20 * 864e5)).slice(0, 10)]);
// utilisation: one poor
await q(`INSERT INTO vehicle_utilisation (platform,vehicle_ext_id,plate,fleet_id,period_start,period_end,hours_online,hours_on_trip,utilisation,earnings_per_hour,trips)
         VALUES ('uber','v1','POOR1','ecosine',$1,$2,40,4,0.10,25,8)`,
  [iso(daysAgo(20)).slice(0, 10), iso(now).slice(0, 10)]);
// weather forecast: rain ahead
await q(`INSERT INTO weather_daily (day,temp_max,precipitation,is_forecast)
         VALUES ($1,38,6.5,true),($2,46,0,true)`,
  [iso(new Date(now.getTime() + 2 * 864e5)).slice(0, 10), iso(new Date(now.getTime() + 3 * 864e5)).slice(0, 10)]);

const from = iso(daysAgo(30)).slice(0, 10), to = iso(now).slice(0, 10);

// ── rule 1: idle vehicles ────────────────────────────────────────────────
const idle = await q(
  `WITH seen AS (SELECT plate,fleet_id,max(captured_at) last_seen FROM telemetry_snapshot WHERE plate IS NOT NULL GROUP BY plate,fleet_id),
        earned AS (SELECT plate,count(*)::int trips FROM trip WHERE requested_at BETWEEN $1 AND $2 AND plate IS NOT NULL GROUP BY plate)
   SELECT s.plate FROM seen s LEFT JOIN earned e USING (plate) WHERE coalesce(e.trips,0)=0`, [from, to]);
const idlePlates = idle.map((r) => r.plate).sort();
check('idle_vehicle finds non-earning vehicles', idlePlates.includes('IDLE1') && idlePlates.includes('DARK1'), JSON.stringify(idlePlates));
check('idle_vehicle excludes the earning vehicle', !idlePlates.includes('BUSY1'));

// ── rule 2: low utilisation ──────────────────────────────────────────────
const util = await q(`SELECT plate,utilisation FROM vehicle_utilisation WHERE utilisation < 0.20 AND hours_online > 5`);
check('low_utilisation flags the poor performer', util.length === 1 && util[0].plate === 'POOR1');

// ── rule 3: licence ──────────────────────────────────────────────────────
const lic = await q(`SELECT driver_ext_id, licence_expires < now() AS gone FROM driver_compliance
                     WHERE licence_expires < (now() + interval '45 days') ORDER BY licence_expires`);
check('licence rule catches expired + expiring', lic.length === 2, JSON.stringify(lic));
check('licence rule marks the expired one', lic[0].gone === true);

// ── rule 4: unsafe driving ───────────────────────────────────────────────
const unsafe = await q(
  `WITH ev AS (SELECT plate,count(*)::int events FROM alert WHERE occurred_at BETWEEN $1 AND $2 GROUP BY plate),
        km AS (SELECT plate,sum(distance_km) km FROM trip WHERE requested_at BETWEEN $1 AND $2 GROUP BY plate)
   SELECT ev.plate, (ev.events::float/nullif(km.km,0)*100) per100 FROM ev JOIN km USING (plate) WHERE km.km > 50`, [from, to]);
check('unsafe_driving computes events per 100km', unsafe.length === 1 && unsafe[0].per100 > 0, JSON.stringify(unsafe));

// ── rule 5: deadhead ─────────────────────────────────────────────────────
const dead = await q(
  `SELECT plate,(sum(deadhead_km)/nullif(sum(distance_km),0)) ratio FROM trip
   WHERE requested_at BETWEEN $1 AND $2 AND deadhead_km IS NOT NULL GROUP BY plate HAVING sum(distance_km)>30`, [from, to]);
check('deadhead ratio computed', dead.length === 1 && Math.abs(dead[0].ratio - 0.5) < 0.01, JSON.stringify(dead));

// ── rule 6: cancellations ────────────────────────────────────────────────
const canc = await q(
  `SELECT platform,(sum((status ILIKE '%cancel%')::int)::float/nullif(count(*),0)) rate
   FROM trip WHERE requested_at BETWEEN $1 AND $2 GROUP BY platform HAVING count(*)>50`, [from, to]);
// NOTE: `to` is a bare date (midnight), so today's trips fall outside the window.
// The API fixes this with endOfDay(); here we assert the rate is computed sanely.
check('cancellation rate computed in range', canc.length === 1 && canc[0].rate > 0.1 && canc[0].rate < 0.25, JSON.stringify(canc));

// same query with an end-of-day bound must include today's trips
const cancFull = await q(
  `SELECT platform,count(*)::int n,(sum((status ILIKE '%cancel%')::int)::float/nullif(count(*),0)) rate
   FROM trip WHERE requested_at BETWEEN $1 AND $2 GROUP BY platform`, [from, to + ' 23:59:59.999']);
check('endOfDay bound includes same-day trips', cancFull[0].n === 60 && Math.abs(cancFull[0].rate - 0.2) < 0.001, JSON.stringify(cancFull));

// ── rule 7: stale tracker ────────────────────────────────────────────────
const stale = await q(`SELECT DISTINCT ON (plate) plate, captured_at FROM telemetry_snapshot ORDER BY plate, polled_at DESC`);
const staleOnes = stale.filter((r) => (Date.now() - new Date(r.captured_at)) / 36e5 >= 24).map((r) => r.plate);
check('stale_tracker finds the dark vehicle', staleOnes.includes('DARK1') && !staleOnes.includes('BUSY1'), JSON.stringify(staleOnes));

// ── rule 8: weather outlook ──────────────────────────────────────────────
const wx = await q(`SELECT day,temp_max,precipitation FROM weather_daily WHERE is_forecast`);
check('weather rows available for outlook', wx.length === 2);
check('rain day detected', wx.some((r) => Number(r.precipitation) >= 1));
check('heat day detected', wx.some((r) => Number(r.temp_max) >= 45));

// ── rule 9: partner concentration ────────────────────────────────────────
const part = await q(`SELECT partner_name,count(*)::int trips FROM trip WHERE partner_name IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
const totalP = part.reduce((a, r) => a + r.trips, 0);
check('partner concentration >40% detected', part[0].trips / totalP > 0.4, `${part[0]?.partner_name} ${part[0]?.trips}/${totalP}`);

// ── insight table round-trip ─────────────────────────────────────────────
await q(`INSERT INTO insight (code,severity,category,entity_type,entity_id,title,detail,action,impact_aed,window_start,window_end)
         VALUES ('idle_vehicle','critical','utilisation','vehicle','IDLE1','t','d','a',3600,$1,$2)
         ON CONFLICT (code,entity_type,entity_id,window_start,window_end) DO UPDATE SET title=EXCLUDED.title`, [from, to]);
await q(`INSERT INTO insight (code,severity,category,entity_type,entity_id,title,detail,action,impact_aed,window_start,window_end)
         VALUES ('idle_vehicle','critical','utilisation','vehicle','IDLE1','t2','d','a',3600,$1,$2)
         ON CONFLICT (code,entity_type,entity_id,window_start,window_end) DO UPDATE SET title=EXCLUDED.title`, [from, to]);
const ins = await q(`SELECT count(*)::int n, max(title) t FROM insight`);
check('insight upsert is idempotent (no duplicate)', ins[0].n === 1 && ins[0].t === 't2', JSON.stringify(ins[0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
