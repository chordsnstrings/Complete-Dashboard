// An unexplained trip must name whoever held the car THAT DAY, not whoever has it now.
// Handovers matter here: if two people drove the plate, both are named rather than
// silently attributing the flag to one of them.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
for (const f of ['schema.sql','schema_v2.sql','schema_v3.sql','schema_v4.sql','schema_v5.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

// custody: L44305 driven by Alice on the 18th, Alice+Bob on the 19th; L82923 by Carl
await q(`INSERT INTO vehicle_driver_day (plate,day,driver_ext_id,platform,driver_name,trips,is_primary) VALUES
  ('L44305','2026-08-18','a','uber','Alice Ahmed',8,true),
  ('L44305','2026-08-19','a','uber','Alice Ahmed',5,true),
  ('L44305','2026-08-19','b','uber','Bob Khan',3,false),
  ('L44305','2026-08-25','z','uber','Later Driver',9,true),
  ('L82923','2026-08-18','c','uber','Carl Said',6,true)`);

// flagged segments (times in +04:00 so the Dubai-date join is exercised)
await q(`INSERT INTO occupancy_segment (plate,fleet_id,started_at,ended_at,duration_min,distance_km,verdict) VALUES
  ('L44305','ecosine','2026-08-18T09:00:00+04:00','2026-08-18T09:40:00+04:00',40,12,'unauthorized'),
  ('L44305','ecosine','2026-08-19T21:30:00+04:00','2026-08-19T22:10:00+04:00',40,15,'unauthorized'),
  ('L82923','ecosine','2026-08-18T14:00:00+04:00','2026-08-18T14:20:00+04:00',20,5,'unauthorized'),
  ('L64921','ecosine','2026-08-18T14:00:00+04:00','2026-08-18T14:20:00+04:00',20,5,'unauthorized')`);

const byVeh = await q(
  `WITH seg AS (
     SELECT plate, count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized
     FROM occupancy_segment GROUP BY plate HAVING count(*) FILTER (WHERE verdict='unauthorized')>0),
   who AS (
     SELECT o.plate, string_agg(DISTINCT v.driver_name, ', ') AS drivers
     FROM occupancy_segment o
     JOIN vehicle_driver_day v ON v.plate=o.plate
       AND v.day=(o.started_at AT TIME ZONE 'Asia/Dubai')::date
     WHERE o.verdict='unauthorized' AND v.driver_name IS NOT NULL
     GROUP BY o.plate)
   SELECT seg.*, who.drivers FROM seg LEFT JOIN who USING (plate) ORDER BY seg.unauthorized DESC`);

const l44 = byVeh.find(r => r.plate === 'L44305');
check('flagged vehicle carries driver names', !!l44?.drivers, JSON.stringify(l44));
check('handover names both drivers', /Alice/.test(l44.drivers) && /Bob/.test(l44.drivers), l44.drivers);
check('a later driver is not blamed', !/Later Driver/.test(l44.drivers), l44.drivers);
check('single-driver vehicle names one', byVeh.find(r => r.plate === 'L82923')?.drivers === 'Carl Said');
check('no-custody vehicle is null, not wrong', byVeh.find(r => r.plate === 'L64921')?.drivers == null);

// per-segment attribution, the version the table shows
const list = await q(
  `SELECT o.plate, o.started_at,
          (SELECT string_agg(DISTINCT v.driver_name, ', ') FROM vehicle_driver_day v
            WHERE v.plate=o.plate AND v.day=(o.started_at AT TIME ZONE 'Asia/Dubai')::date
              AND v.driver_name IS NOT NULL) AS drivers
   FROM occupancy_segment o WHERE o.verdict='unauthorized' ORDER BY o.started_at`);
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const seg18 = list.find(r => r.plate === 'L44305' && iso(r.started_at) === '2026-08-18');
const seg19 = list.find(r => r.plate === 'L44305' && iso(r.started_at) >= '2026-08-19');
check('18th segment attributed to Alice only', seg18?.drivers === 'Alice Ahmed', seg18?.drivers);
check('19th segment attributed to both', /Alice/.test(seg19?.drivers || '') && /Bob/.test(seg19?.drivers || ''), seg19?.drivers);

// late-evening Dubai time must not slip to the previous UTC day
const late = await q(
  `SELECT (('2026-08-19T21:30:00+04:00'::timestamptz) AT TIME ZONE 'Asia/Dubai')::date AS d`);
// a 21:30 Dubai timestamp is 17:30 UTC — the Dubai-date conversion must not slip a day
check('Dubai-evening timestamps keep the right date',
  new Date(late[0].d).toISOString().slice(0, 10) === '2026-08-19', String(late[0].d));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
