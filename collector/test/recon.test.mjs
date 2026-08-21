import { buildSegments, classifySegment, findMatch } from '../src/reconcile.js';
const t=(m)=>new Date(Date.parse('2026-08-21T08:00:00Z')+m*60000).toISOString();
const fix=(m,seat,speed,lat,lng,ign=true,odo=1000)=>({plate:'L45235',fleet_id:'ecosine',captured_at:t(m),seat_occupied:seat,speed,ignition:ign,lat,lng,odometer:odo});
export const CASES=[
 ['genuine trip',[fix(0,false,0,25.10,55.20),fix(5,true,0,25.10,55.20,true,1000),fix(10,true,45,25.12,55.23,true,1004),fix(15,true,60,25.14,55.25,true,1009),fix(20,true,30,25.16,55.27,true,1013),fix(25,false,0,25.16,55.27)],'candidate'],
 ['sensor flicker',[fix(0,true,20,25.10,55.20,true,1000),fix(5,false,40,25.12,55.22,true,1003),fix(10,true,50,25.15,55.25,true,1008),fix(15,true,30,25.17,55.27,true,1012),fix(20,false,0,25.17,55.27)],'candidate'],
 ['stuck sensor 10h',Array.from({length:60},(_,i)=>fix(i*10,true,0,25.1,55.2,false,1000)),'sensor_suspect'],
 ['telemetry gap',[fix(0,true,30,25.10,55.20,true,1000),fix(5,true,40,25.12,55.22,true,1004),fix(40,true,35,25.30,55.40,true,1030),fix(45,false,0,25.30,55.40)],'partial'],
 ['parked, poll hole',[fix(0,true,0,25.1,55.2,false,1000),fix(5,true,0,25.1,55.2,false,1000),fix(35,true,0,25.1,55.2,false,1000),fix(40,false,0,25.1,55.2,false,1000)],'partial'],
 ['parked contiguous',[fix(0,true,0,25.1,55.2,false,1000),fix(5,true,0,25.1,55.2,false,1000),fix(10,true,0,25.1,55.2,false,1000),fix(15,false,0,25.1,55.2,false,1000)],'stationary'],
 ['brief stop',[fix(0,true,0,25.1,55.2,true,1000),fix(5,false,0,25.1,55.2)],'stationary'],
];
let pass=0,fail=0;
for(const [name,fixes,exp] of CASES){
  const segs=buildSegments(fixes); const got=classifySegment(segs[0]);
  const ok=got===exp; ok?pass++:fail++;
  console.log(`${ok?'PASS':'FAIL'}  ${name.padEnd(18)} got=${got} expected=${exp} (segs=${segs.length}, gap=${segs[0].max_gap_min}m)`);
}
const seg=buildSegments(CASES[0][1])[0];
const checks=[
 ['match same plate+time', !!findMatch(seg,[{platform:'uber',external_id:'T1',plate:'L45235',requested_at:t(7),ended_at:t(23)}]), true],
 ['reject other plate', !!findMatch(seg,[{platform:'uber',external_id:'T2',plate:'L99999',requested_at:t(7),ended_at:t(23)}]), false],
 ['reject far-off time', !!findMatch(seg,[{platform:'hotel',external_id:'H1',plate:'L45235',requested_at:t(300),ended_at:t(310)}]), false],
 ['accept 12min drift', !!findMatch(seg,[{platform:'hotel',external_id:'H2',plate:'L45235',requested_at:t(-12),ended_at:t(-2)}]), true],
];
for(const [n,got,exp] of checks){ const ok=got===exp; ok?pass++:fail++; console.log(`${ok?'PASS':'FAIL'}  ${n}`); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
