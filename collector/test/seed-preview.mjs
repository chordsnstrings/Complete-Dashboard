// Boots the real API against an in-process Postgres seeded with realistic data, for design preview.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
await db.exec(readFileSync('sql/schema.sql','utf8'));

const PLATES=['L45240','L46174','L40965','L36395','L41435','L27045','L94178','L75104','L90721','L44251','L45235','L82923'];
const DRIVERS=['Muhammad Khalid','Nauman Hassan','Muhammad Asif Zada','Bakht Zada Sharif','Umer Naveed Qadir','Kashif Ali','Tariq Afzal','Wisal Muhammad','Shahab Ali Hayat','Najeeb Ullah Khan'];
const PLATFORMS=[['uber',.45],['yango',.2],['hotel',.15],['bolt',.1],['fms',.10]];
const PRODUCTS={uber:['Electric','UberX','Comfort','Black'],yango:['comfort','econom'],hotel:['pick_and_drop','hourly'],bolt:['Bolt','Comfort'],fms:['telematics']};
const PAY=['apple_pay','braintree','cash','offline','cashless','cash-driver','paypal'];
let seed=42; const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
const pick=(a)=>a[Math.floor(rnd()*a.length)];
const trips=[];
const now=Date.now();
for(let d=29;d>=0;d--){
  const n=55+Math.floor(rnd()*45);
  for(let i=0;i<n;i++){
    const r=rnd(); let acc=0,plat='uber';
    for(const [p,w] of PLATFORMS){acc+=w; if(r<=acc){plat=p;break}}
    const hour=[7,8,9,10,11,12,13,14,15,16,17,17,18,18,19,20,21,22,23,0,1][Math.floor(rnd()*21)];
    const start=new Date(now-d*864e5); start.setHours(hour,Math.floor(rnd()*60),0,0);
    const dist=+(2+rnd()*22).toFixed(2);
    const st=rnd()<0.89?'completed':(rnd()<0.9?'rider_cancelled':'driver_cancelled');
    trips.push([plat,`${plat}-${d}-${i}`,'ecosine',pick(PLATES),`drv-${DRIVERS.indexOf(pick(DRIVERS))}`,pick(DRIVERS),
      start.toISOString(),new Date(start.getTime()+dist*3*60000).toISOString(),dist,st,pick(PRODUCTS[plat]),pick(PAY),
      +(8+dist*2.4+rnd()*15).toFixed(2)]);
  }
}
for(const t of trips) await db.query(
 `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,ended_at,distance_km,status,product,payment_type,price)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,t);

// alerts
const ATYPES=['Harsh Brake','Sharp Turn','Harsh Acceleration','OverSpeed','Main Power Lost'];
for(let i=0;i<420;i++){const d=Math.floor(rnd()*30);
  await db.query(`INSERT INTO alert (platform,external_id,fleet_id,plate,alert_type,occurred_at) VALUES ('fms',$1,'ecosine',$2,$3,$4) ON CONFLICT DO NOTHING`,
  [`a${i}`,pick(PLATES),pick(ATYPES),new Date(now-d*864e5-rnd()*864e5).toISOString()]);}

// telemetry + occupancy segments (incl. unauthorized)
for(let i=0;i<300;i++){const p=pick(PLATES);
  await db.query(`INSERT INTO telemetry_snapshot (source,fleet_id,plate,captured_at,lat,lng,speed,status,seat_occupied,ignition,polled_at,odometer)
    VALUES ('cabman','ecosine',$1,$2,$3,$4,$5,$6,$7,true,now(),$8) ON CONFLICT DO NOTHING`,
    [p,new Date(now-Math.floor(rnd()*30)*864e5-rnd()*36e5).toISOString(),25.05+rnd()*.25,55.1+rnd()*.35,
     Math.floor(rnd()*90),rnd()<.3?'Engaged':'Active',rnd()<.3,190000+Math.floor(rnd()*90000)]);}
const VERDICTS=[['authorized',150],['unauthorized',23],['sensor_suspect',9],['partial',14],['stationary',61]];
let sid=0;
for(const [v,count] of VERDICTS) for(let i=0;i<count;i++){
  const d=Math.floor(rnd()*30); const start=new Date(now-d*864e5-rnd()*72e5);
  const dur=v==='sensor_suspect'?300+Math.floor(rnd()*300):v==='stationary'?2+Math.floor(rnd()*4):12+Math.floor(rnd()*40);
  const dist=v==='stationary'||v==='sensor_suspect'?+(rnd()*.6).toFixed(2):+(2+rnd()*24).toFixed(2);
  await db.query(`INSERT INTO occupancy_segment (plate,started_at,ended_at,fleet_id,duration_min,distance_km,top_speed,fixes,max_gap_min,ignition_ratio,verdict,matched_platform,low_confidence,start_lat,start_lng)
    VALUES ($1,$2,$3,'ecosine',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
   [pick(PLATES),start.toISOString(),new Date(start.getTime()+dur*60000).toISOString(),dur,dist,
    v==='stationary'?0:20+Math.floor(rnd()*70),Math.max(2,Math.floor(dur/5)),v==='partial'?25:5,
    v==='sensor_suspect'?0.05:0.9,v,v==='authorized'?pick(['uber','yango','hotel','bolt']):null,v==='unauthorized'&&rnd()<.2,
    25.05+rnd()*.25,55.1+rnd()*.35]);sid++;}

// ledger + driver performance + runs
const CATS=['platform_reposition_fee','commission','bonus','tip','cash_collected','toll','adjustment'];
for(let i=0;i<260;i++) await db.query(`INSERT INTO ledger_entry (platform,external_id,fleet_id,driver_name,event_at,category,amount,currency) VALUES ($1,$2,'ecosine',$3,$4,$5,$6,'AED') ON CONFLICT DO NOTHING`,
  [pick(['yango','uber']),`l${i}`,pick(DRIVERS),new Date(now-Math.floor(rnd()*30)*864e5).toISOString(),pick(CATS),+((rnd()-0.35)*160).toFixed(2)]);
for(const dn of DRIVERS) for (const pl of ['uber','yango']) await db.query(
  `INSERT INTO driver_performance (platform,fleet_id,driver_ext_id,driver_name,plate,period_start,period_end,trips,hours_online,hours_on_trip,acceptance_rate,cancellation_rate,distance_km,earnings,cash_earnings)
   VALUES ($1,'ecosine',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
  [pl,`drv-${DRIVERS.indexOf(dn)}`,dn,pick(PLATES),new Date(now-7*864e5).toISOString().slice(0,10),new Date(now).toISOString().slice(0,10),
   20+Math.floor(rnd()*50),+(20+rnd()*50).toFixed(1),+(8+rnd()*25).toFixed(1),+(0.8+rnd()*0.2).toFixed(2),+(rnd()*0.06).toFixed(3),
   +(200+rnd()*700).toFixed(0),+(600+rnd()*1400).toFixed(2),+(100+rnd()*400).toFixed(2)]);
for(const [s,st,e] of [['cabman','ok',null],['uber','ok',null],['yango','ok',null],['hotel','ok',null],['fms','ok',null],['bolt','error','Error: bolt fi token failed']])
  await db.query(`INSERT INTO collection_run (source,fleet_id,mode,status,rows_written,finished_at,error,window_start,window_end) VALUES ($1,'ecosine',$2,$3,$4,now(),$5,$6,$7)`,
   [s,s==='cabman'?'realtime':'incremental',st,Math.floor(rnd()*900),e,new Date(now-3*864e5).toISOString().slice(0,10),new Date(now).toISOString().slice(0,10)]);

console.log('seeded:', trips.length, 'trips');
globalThis.__db = db;
export { db };
