/* Month-over-month breaks must never be computed across a hole in the data.
   Production reported "2025-10 → 2026-02: -82%, drivers 102 → 0" as a business
   event. Nothing had happened — we simply held no rows for November, December
   or January, and the comparison stepped straight over them. A confident wrong
   number is worse than no number, so this pins the behaviour. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The whole schema, read from src/db.js. This file used to load a hand-picked
   subset ending at v5, which meant the route under test ran against a shape
   production has not had for a long time — and the route reads trip_norm, not
   trip: the cancel ratio it reports was computed with ILIKE '%cancel%', which
   matches none of Bolt's client_did_not_show, driver_did_not_respond or
   driver_rejected, and its denominator counted FMS telematics rows that
   hardcode 'completed' and cannot be cancelled at all. */
await applySchema(db);

// Sep and Oct 2025 busy on Uber with named drivers; Nov–Jan absent entirely;
// Feb 2026 back but only from the telematics feed, which carries no driver id.
const mk = (platform, ext, day, drv) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,distance_km,status,price)
   VALUES ($1,$2,'ecosine','L1',$3,$4,$5,10,'completed',40)`,
  [platform, ext, drv, drv ? 'Driver ' + drv : null, `${day}T10:00:00+04:00`]);

let n = 0;
for (let i = 1; i <= 20; i++) await mk('uber', `s${n++}`, `2025-09-${String(i).padStart(2, '0')}`, `d${i % 4}`);
for (let i = 1; i <= 10; i++) await mk('uber', `o${n++}`, `2025-10-${String(i).padStart(2, '0')}`, `d${i % 4}`);
for (let i = 1; i <= 9; i++) await mk('fms', `f${n++}`, `2026-02-${String(i).padStart(2, '0')}`, null);
for (let i = 1; i <= 20; i++) await mk('fms', `g${n++}`, `2026-03-${String(i).padStart(2, '0')}`, null);

/* ── mount just the trend route, using the real handler source ─────────────
   The route is defined inline in api/server.js against a live pool, so it is
   extracted here rather than imported. Keeping the SQL identical is the point;
   the test fails loudly if the two drift. */
const src = readFileSync('api/server.js', 'utf8');
const { mountSource, server, get } = await mountAll(db, { serverRoutes: false });
mountSource(src.slice(src.indexOf("app.get('/api/trend/monthly'"),
  src.indexOf('// external context joined to the day')));
const trend = await get('/api/trend/monthly');
if (trend.body == null) throw new Error(`/api/trend/monthly → ${trend.status} ${trend.raw}`);
const { months, breaks, gaps } = trend.body;

/* ── the calendar is filled, so a hole looks like a hole ─────────────────── */
check('every month between first and last is present', months.length === 7, String(months.length));
check('months are labelled YYYY-MM', months[0].m === '2025-09', months[0]?.m);
const nov = months.find((m) => m.m === '2025-11');
check('a month with no rows is flagged no_data', nov?.no_data === true, JSON.stringify(nov));
check('a month with no rows reports null drivers, not zero', nov?.drivers === null, String(nov?.drivers));
check('an observed month is not flagged no_data', months.find((m) => m.m === '2025-09')?.no_data === false);

/* ── gaps are reported as runs ───────────────────────────────────────────── */
check('the three-month hole is reported as one gap', gaps.length === 1, JSON.stringify(gaps));
check('the gap spans Nov to Jan', gaps[0]?.from === '2025-11' && gaps[0]?.to === '2026-01', JSON.stringify(gaps[0]));
check('the gap length is counted', gaps[0]?.months === 3, String(gaps[0]?.months));

/* ── breaks never step over the hole ─────────────────────────────────────── */
check('no break is reported across the gap',
  !breaks.some((b) => b.from === '2025-10' && b.to === '2026-02'), JSON.stringify(breaks));
check('every break joins two adjacent observed months',
  breaks.every((b) => {
    const ia = months.findIndex((m) => m.m === b.from), ib = months.findIndex((m) => m.m === b.to);
    return ib === ia + 1 && !months[ia].no_data && !months[ib].no_data;
  }), JSON.stringify(breaks));
// Sep 20 → Oct 10 is -50%, and both months were observed, so it is real.
const real = breaks.find((b) => b.from === '2025-09');
check('a genuine month-over-month swing is still reported', real?.change_pct === -50, JSON.stringify(real));

/* ── a telematics month has journeys, not bookings ────────────────────────
   `trips` used to be count(*) over bookings AND the telematics twins of the
   same journeys, so a month with FMS running counted each physical trip twice
   and a month without it counted it once. That alone manufactures a
   "structural break" on the date the telematics boxes came online — on the
   page whose job is explaining what caused a break. The two are counted
   separately now and never summed. */
const feb = months.find((m) => m.m === '2026-02');
check('a telematics-only month reports no bookings, because it has none',
  feb?.trips === 0, String(feb?.trips));
check('its journeys are carried separately rather than being dropped',
  feb?.telematics_journeys === 9, String(feb?.telematics_journeys));
check('a telematics-only month is marked as having no driver attribution',
  feb?.drivers_known === false, String(feb?.drivers_known));
/* And the consequence that matters: with bookings at zero on both sides, there
   is no month-over-month move to report at all. The old counting produced one
   out of nothing. */
const febBreak = breaks.find((b) => b.to === '2026-03');
check('no break is manufactured between two months that had no bookings',
  !febBreak, JSON.stringify(febBreak));
check('and no break in the record claims a driver count it could not attribute',
  breaks.every((b) => (b.drivers_from == null) === (b.drivers_to == null)
    || b.drivers_from != null),
  JSON.stringify(breaks.map((b) => [b.from, b.drivers_from, b.drivers_to])));
check('a break where the platform mix changed says so',
  breaks.every((b) => b.platform_shift === null || (b.platform_shift.from && b.platform_shift.to)),
  JSON.stringify(breaks.map((b) => b.platform_shift)));

/* ── one odometer row must not become a month's distance ──────────────────
   FMS distances are odometer-derived and a single row can read 193,027 km.
   This query summed distance_km unguarded, so April 2026 reported 12,681,536
   km across 91 vehicles — 4,600 km per car per day, every day of the month.
   The months that looked sane were exactly the months FMS happened to be dark,
   which is why it survived: the number was only absurd where nobody had a
   reason to look.

   `has_distance` in trip_norm exists for this and was not being used. */
{
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
             requested_at,distance_km,status,price)
           VALUES ('fms','odo1','ecosine','L1',NULL,NULL,'2026-03-05T10:00:00+04:00',193027,'completed',NULL),
                  ('uber','real1','ecosine','L1','d1','Driver d1','2026-03-05T11:00:00+04:00',14,'completed',40),
                  ('uber','real2','ecosine','L1','d1','Driver d1','2026-03-06T11:00:00+04:00',16,'completed',40)`);
  const again = (await get('/api/trend/monthly')).body;
  const mar = (again.months || []).find((m) => m.m === '2026-03');
  check('a 193,027 km odometer row is excluded from the month’s distance',
    Number(mar.km) === 30, String(mar.km));
  check('and it is not counted as a booking either',
    mar.trips === 2, String(mar.trips));
  check('the distance is reported alongside how many bookings it was measured over',
    mar.measured_trips === 2, String(mar.measured_trips));
  check('so km per booking is a number a person can sanity-check',
    Math.round(mar.km / mar.measured_trips) === 15, String(mar.km / mar.measured_trips));

  /* And the Dubai-month boundary. A 01:00 Dubai trip on the 1st is 21:00 UTC
     on the last day of the previous month; date_trunc on the raw timestamp put
     it in the wrong month, and this fleet's airport wave starts before dawn. */
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
             requested_at,distance_km,status,price)
           VALUES ('uber','tz1','ecosine','L1','d1','Driver d1','2026-04-01T01:00:00+04:00',10,'completed',40)`);
  const tz = (await get('/api/trend/monthly')).body;
  const apr = (tz.months || []).find((m) => m.m === '2026-04');
  check('a 01:00 Dubai booking counts in the Dubai month, not the UTC one',
    apr?.trips === 1, `${apr?.trips} in April`);
}


/* ── the ends of a record are partial by construction ─────────────────────
   Collection starts and stops mid-month, so the first and last months hold
   fewer days than they appear to. Live, collection began on 21 August: that
   month holds eleven days and September reads as +344% against it. Nothing
   happened — that is a fact about when we started collecting.

   The flag comes from the RECORD'S SPAN, not from trip density: a month with
   genuinely quiet days is a quiet month, not a partial one, and excluding it
   from every comparison would hide exactly the thing worth seeing. */
{
  const p2 = (await get('/api/trend/monthly')).body;
  const ms = p2.months.filter((m) => !m.no_data);
  const firstObserved = ms[0], lastObserved = ms[ms.length - 1];

  // The fixture's first trip is 1 September, so that month is WHOLE — even
  // though its last ten days carry no trips at all.
  check('a month the record covers from its first day is not partial, however quiet its tail',
    firstObserved.m === '2025-09' && firstObserved.partial_month === false,
    JSON.stringify([firstObserved.m, firstObserved.partial_month]));
  // The last trip is 20 March, so that month IS partial.
  check('the month the record stops inside is flagged as partial',
    lastObserved.partial_month === true, JSON.stringify([lastObserved.m, lastObserved.partial_month]));
  /* The Dubai-boundary test above added a 01:00 booking on 1 April, so the
     record now ends there and April holds exactly one day. That is the sharp
     version of this case: a month whose entire content is one trip would
     otherwise be compared against a full month as though the two were alike.

     Checked against the record's real last day rather than a restatement of
     the endpoint's own arithmetic — a test that recomputes the code's formula
     agrees with it by construction and can never fail. */
  const [{ last_day: recordEnd }] = await q(
    `SELECT to_char(max((requested_at AT TIME ZONE 'Asia/Dubai')::date),'YYYY-MM-DD') last_day FROM trip`);
  const expectedDays = Number(recordEnd.slice(8, 10));   // the record ends inside this month
  check('it says how many days of it the record actually holds',
    recordEnd.slice(0, 7) !== lastObserved.m || lastObserved.days_in_record === expectedDays,
    `${lastObserved.m} holds ${lastObserved.days_in_record}, record ends ${recordEnd}`);
  check('a month holding a single day of the record says exactly that, not zero and not a full month',
    lastObserved.days_in_record >= 1 && lastObserved.days_in_record <= 31,
    String(lastObserved.days_in_record));
  check('a whole month inside the record is never flagged',
    ms.slice(0, -1).every((m) => m.partial_month === false),
    JSON.stringify(ms.filter((m) => m.partial_month).map((m) => m.m)));

  /* Now make the record START mid-month, which is the live case: collection
     began on 21 August 2025 and that month reads as an 84% collapse against
     September purely because it holds eleven days. */
  await q(
    `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,distance_km,status,price)
     VALUES ('uber','partial-1','ecosine','L1','d1','Driver d1','2025-08-21T10:00:00+04:00',10,'completed',40),
            ('uber','partial-2','ecosine','L1','d1','Driver d1','2025-08-25T10:00:00+04:00',10,'completed',40)`);
  const p3 = (await get('/api/trend/monthly')).body;
  const aug = p3.months.find((m) => m.m === '2025-08');
  check('a month the record starts inside is flagged as partial',
    aug?.partial_month === true, JSON.stringify([aug?.m, aug?.partial_month]));
  check('and the day count is from the record’s own start, not the month’s',
    aug?.days_in_record === 11, String(aug?.days_in_record));

  const augBreak = (p3.breaks || []).find((b) => b.from === '2025-08');
  check('the break out of it is reported rather than hidden',
    !!augBreak, JSON.stringify((p3.breaks || []).map((b) => [b.from, b.to])));
  check('but flagged as a boundary artefact, so nothing reads it as an event',
    augBreak?.boundary_artifact === true, String(augBreak?.boundary_artifact));
  check('and it names which side of it was the partial month',
    augBreak?.partial_side === '2025-08', String(augBreak?.partial_side));
  check('a break between two whole months carries no such flag',
    (p3.breaks || []).filter((b) => b.from !== '2025-08' && b.to !== p3.months.filter((m) => !m.no_data).slice(-1)[0].m)
      .every((b) => b.boundary_artifact === false),
    JSON.stringify((p3.breaks || []).map((b) => [b.from, b.to, b.boundary_artifact])));
}

server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
