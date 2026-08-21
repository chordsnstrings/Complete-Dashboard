// Serves the real dashboard UI + a PGlite-backed API clone for design preview.
import express from 'express';
import { db } from './seed-preview.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const pub = join(__dir, '..', 'api', 'public');

// Re-use the real server's SQL by importing its source and swapping the pool: simplest reliable
// approach here is a thin re-implementation of the same queries against PGlite.
const app = express(); app.use(express.json());
const q = async (t,p=[]) => (await db.query(t,p)).rows;
const range=(r)=>[r.query.from||'2000-01-01',r.query.to||'2100-01-01',r.query.platform||null,r.query.fleet||null];
const F=`requested_at BETWEEN $1 AND $2 AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`;
const w=(fn)=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>res.status(500).json({error:String(e)}));

app.get('/api/health',(_,r)=>r.json({ok:true}));
app.get('/api/kpis',w(async(req,res)=>{const p=range(req);
  const [t]=await q(`SELECT count(*)::int trips, round(sum(distance_km)::numeric,0) km, round(avg(distance_km)::numeric,2) avg_km,
    round(100.0*sum((status='completed')::int)/nullif(count(*),0),1) completion_pct,
    round(100.0*sum((status ILIKE '%cancel%')::int)/nullif(count(*),0),1) cancel_pct,
    count(distinct driver_ext_id)::int drivers, count(distinct plate)::int vehicles, round(sum(price)::numeric,0) revenue FROM trip WHERE ${F}`,p);
  const [v]=await q(`SELECT count(*)::int live_vehicles FROM (SELECT DISTINCT ON (plate) plate FROM telemetry_snapshot ORDER BY plate, polled_at DESC) s`);
  const [a]=await q(`SELECT count(*)::int alerts FROM alert WHERE occurred_at BETWEEN $1 AND $2`,[p[0],p[1]]);
  res.json({...t,...v,...a});}));
app.get('/api/trips/daily',w(async(q2,res)=>res.json(await q(`SELECT date_trunc('day',requested_at)::date d, count(*)::int trips, round(sum(distance_km)::numeric,0) km, round(sum(price)::numeric,0) revenue FROM trip WHERE ${F} GROUP BY 1 ORDER BY 1`,range(q2)))));
app.get('/api/trips/hourly',w(async(q2,res)=>res.json(await q(`SELECT extract(hour from requested_at)::int h, count(*)::int trips FROM trip WHERE ${F} GROUP BY 1 ORDER BY 1`,range(q2)))));
app.get('/api/trips/heatmap',w(async(q2,res)=>res.json(await q(`SELECT extract(dow from requested_at)::int dow, extract(hour from requested_at)::int h, count(*)::int trips FROM trip WHERE ${F} GROUP BY 1,2 ORDER BY 1,2`,range(q2)))));
app.get('/api/mix',w(async(req,res)=>{const dim={payment:'payment_type',status:'status',platform:'platform',fleet:'fleet_id'}[req.query.by]||'product';
  res.json(await q(`SELECT coalesce(${dim},'unknown') label, count(*)::int n, round(sum(price)::numeric,0) revenue FROM trip WHERE ${F} GROUP BY 1 ORDER BY 2 DESC`,range(req)));}));
app.get('/api/drivers/leaderboard',w(async(q2,res)=>res.json(await q(`SELECT driver_name, driver_ext_id, platform, max(plate) plate, count(*)::int trips, round(sum(distance_km)::numeric,0) km, round(avg(distance_km)::numeric,1) avg_km, round(sum(price)::numeric,0) revenue, round(100.0*sum((status='completed')::int)/nullif(count(*),0)) completion_pct FROM trip WHERE ${F} AND driver_name IS NOT NULL GROUP BY driver_name, driver_ext_id, platform ORDER BY trips DESC LIMIT 100`,range(q2)))));
app.get('/api/drivers/cross-platform',w(async(q2,res)=>res.json(await q(`SELECT driver_name, sum((platform='uber')::int)::int uber_trips, sum((platform='yango')::int)::int yango_trips, sum((platform='bolt')::int)::int bolt_trips, sum((platform='fms')::int)::int fms_trips, count(*)::int total_trips, round(sum(distance_km)::numeric,0) km, round(sum(price)::numeric,0) revenue FROM trip WHERE ${F} AND driver_name IS NOT NULL GROUP BY driver_name ORDER BY total_trips DESC LIMIT 100`,range(q2)))));
app.get('/api/drivers/performance',w(async(q2,res)=>res.json(await q(`SELECT platform,driver_name,plate,period_start,period_end,trips,hours_online,hours_on_trip,acceptance_rate,cancellation_rate,distance_km,earnings,cash_earnings,rating FROM driver_performance ORDER BY trips DESC NULLS LAST LIMIT 300`))));
app.get('/api/vehicles',w(async(q2,res)=>res.json(await q(`SELECT plate, count(*)::int trips, round(sum(distance_km)::numeric,0) km, round(sum(price)::numeric,0) revenue, count(distinct driver_ext_id)::int drivers, count(distinct platform)::int platforms, max(requested_at) last_trip FROM trip WHERE ${F} AND plate IS NOT NULL GROUP BY plate ORDER BY trips DESC LIMIT 200`,range(q2)))));
app.get('/api/live',w(async(_,res)=>res.json(await q(`SELECT DISTINCT ON (plate) plate, fleet_id, source, captured_at, polled_at, lat, lng, speed, status, seat_occupied, fuel_level, ac_on, odometer, (now()-polled_at > interval '11 minutes') AS stale FROM telemetry_snapshot ORDER BY plate, polled_at DESC`))));
app.get('/api/track',w(async(req,res)=>res.json(await q(`SELECT captured_at,lat,lng,speed,status,seat_occupied FROM telemetry_snapshot WHERE plate=$1 ORDER BY captured_at LIMIT 60`,[String(req.query.plate||'').toUpperCase()]))));
app.get('/api/alerts/summary',w(async(q2,res)=>res.json(await q(`SELECT alert_type, count(*)::int n FROM alert WHERE occurred_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`,[range(q2)[0],range(q2)[1]]))));
app.get('/api/alerts/by-vehicle',w(async(q2,res)=>res.json(await q(`SELECT plate, count(*)::int alerts, sum((alert_type ILIKE '%brake%')::int)::int harsh_brake, sum((alert_type ILIKE '%accel%')::int)::int harsh_accel, sum((alert_type ILIKE '%turn%')::int)::int sharp_turn, sum((alert_type ILIKE '%speed%')::int)::int overspeed FROM alert WHERE occurred_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 100`,[range(q2)[0],range(q2)[1]]))));
app.get('/api/finance/ledger',w(async(q2,res)=>res.json(await q(`SELECT category, count(*)::int n, round(sum(amount)::numeric,2) amount, currency FROM ledger_entry GROUP BY category,currency ORDER BY abs(sum(amount)) DESC LIMIT 60`))));
app.get('/api/unauthorized/summary',w(async(q2,res)=>{const [from,to]=range(q2);
  const rows=await q(`SELECT verdict, count(*)::int n, round(sum(distance_km)::numeric,0) km, round(sum(duration_min)::numeric,0) minutes FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 GROUP BY verdict ORDER BY n DESC`,[from,to]);
  const [tot]=await q(`SELECT count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized, count(*) FILTER (WHERE verdict='authorized')::int authorized, count(*) FILTER (WHERE verdict='sensor_suspect')::int sensor_suspect, count(*) FILTER (WHERE verdict='partial')::int partial, round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,0) unauth_km, count(*) FILTER (WHERE verdict='unauthorized' AND low_confidence)::int low_confidence FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2`,[from,to]);
  res.json({byVerdict:rows,totals:tot});}));
app.get('/api/unauthorized/list',w(async(q2,res)=>{const [from,to]=range(q2);const v=q2.query.verdict||'unauthorized';
  res.json(await q(`SELECT plate,fleet_id,started_at,ended_at,duration_min,distance_km,top_speed,fixes,max_gap_min,ignition_ratio,verdict,matched_platform,matched_trip_id,low_confidence,unavailable_sources,start_lat,start_lng FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 AND ($3='all' OR verdict=$3) ORDER BY started_at DESC LIMIT 300`,[from,to,v]));}));
app.get('/api/unauthorized/by-vehicle',w(async(q2,res)=>{const [from,to]=range(q2);
  res.json(await q(`SELECT plate, count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized, count(*) FILTER (WHERE verdict='authorized')::int authorized, count(*) FILTER (WHERE verdict='sensor_suspect')::int sensor_suspect, round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,1) unauth_km FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 GROUP BY plate HAVING count(*) FILTER (WHERE verdict='unauthorized')>0 ORDER BY unauthorized DESC LIMIT 100`,[from,to]));}));
app.get('/api/unauthorized/daily',w(async(q2,res)=>{const [from,to]=range(q2);
  res.json(await q(`SELECT date_trunc('day',started_at)::date d, count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized, count(*) FILTER (WHERE verdict='authorized')::int authorized FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,[from,to]));}));
app.get('/api/sensor-health',w(async(q2,res)=>res.json(await q(`SELECT t.plate, count(*) FILTER (WHERE t.seat_occupied)::int occupied_fixes, count(*)::int total_fixes, 0::int sensor_suspect_segments FROM telemetry_snapshot t WHERE t.source='cabman' GROUP BY t.plate ORDER BY occupied_fixes ASC LIMIT 100`))));
app.get('/api/platforms',w(async(_,res)=>res.json(await q(`SELECT platform, fleet_id, count(*)::int trips, min(requested_at) earliest, max(requested_at) latest FROM trip GROUP BY platform,fleet_id ORDER BY trips DESC`))));
app.get('/api/status',w(async(_,res)=>res.json(await q(`SELECT DISTINCT ON (source,mode) source,mode,status,rows_written,window_start,window_end,finished_at,error FROM collection_run ORDER BY source,mode,finished_at DESC`))));
app.get('/api/coverage',w(async(_,res)=>res.json({trips:await q(`SELECT platform, count(*)::int n, min(requested_at) from_ts, max(requested_at) to_ts FROM trip GROUP BY 1`),telemetry:await q(`SELECT source, count(*)::int n, max(polled_at) last_poll FROM telemetry_snapshot GROUP BY 1`),alerts:await q(`SELECT count(*)::int n, max(occurred_at) latest FROM alert`),ledger:await q(`SELECT count(*)::int n, max(event_at) latest FROM ledger_entry`)})));
app.get('/api/settings',w(async(_,res)=>{const { describeSettings } = await import('../src/settings.js').catch(()=>({}));
  res.json([
   {key:'FMS_ECOSINE_PASS',group:'FMS / InfoTrack',label:'Ecosine password',secret:true,source:'settings',configured:true,value:'••••••••me'},
   {key:'FMS_EGARI_PASS',group:'FMS / InfoTrack',label:'Egari password',secret:true,source:'settings',configured:true,value:'••••••••me'},
   {key:'CABMAN_ECOSINE_USER',group:'CABMAN DT',label:'Interface username',secret:false,source:'settings',configured:true,value:'admin_ecosine'},
   {key:'CABMAN_ECOSINE_PASS',group:'CABMAN DT',label:'Interface password',secret:true,source:'settings',configured:true,value:'••••••••1#1'},
   {key:'UBER_CLIENT_ID',group:'Uber',label:'OAuth client id',secret:false,source:'settings',configured:true,value:'HJuG0RS0Gc0AETKohn9LknBh2Br9z80Q'},
   {key:'UBER_CLIENT_SECRET',group:'Uber',label:'OAuth client secret',secret:true,source:'settings',configured:true,value:'••••••••EDoV'},
   {key:'UBER_WEB_COOKIE',group:'Uber',label:'Supplier web session cookie',secret:true,hint:'Expires — re-paste from a logged-in supplier.uber.com session',source:'settings',configured:true,value:'••••••••8066'},
   {key:'YANGO_PARK_ID',group:'Yango',label:'Park id',secret:false,source:'settings',configured:true,value:'a23aade0e2ac4f93a2f5d4b51ef1478b'},
   {key:'YANGO_COOKIE',group:'Yango',label:'Yandex session cookie',secret:true,hint:'Expires — re-paste from fleet.yango.com',source:'settings',configured:true,value:'••••••••ORs'},
   {key:'BOLT_CLIENT_ID',group:'Bolt',label:'OAuth client id',secret:false,source:'settings',configured:true,value:'G6BPj_TOfFsWNCrnx4NCt'},
   {key:'BOLT_REFRESH_TOKEN',group:'Bolt',label:'Fleet-portal refresh token',secret:true,hint:'~7 day lifetime — refresh to unlock Bolt trips & earnings',source:'unset',configured:false,value:''},
   {key:'HOTEL_TOKEN',group:'Hotel (ecosine.ae)',label:'Operations manager bearer token',secret:true,source:'settings',configured:true,value:'••••••••bodc'},
   {key:'HOTEL_DOMAIN',group:'Hotel (ecosine.ae)',label:'x-domain header',secret:false,source:'settings',configured:true,value:'hotel.ecosine.ae'},
   {key:'BACKFILL_MONTHS',group:'Collector',label:'Backfill months',secret:false,source:'environment',configured:true,value:'12'},
   {key:'CABMAN_CRON',group:'Collector',label:'CABMAN schedule (cron)',secret:false,source:'environment',configured:true,value:'*/5 * * * *'},
  ]);}));
app.use(express.static(pub));
app.get('*',(_,r)=>r.sendFile(join(pub,'index.html')));
app.listen(8099,()=>console.log('preview on http://localhost:8099'));
