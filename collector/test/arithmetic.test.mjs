/* Does every number equal the numbers reported beside it?
   ─────────────────────────────────────────────────────────────────────────
   This product's standing rule is that a claim nobody can check is an opinion
   with a database behind it. Applied to a rate, that means the numerator and
   the denominator have to be on the page too — and applied to a page, it means
   the parts have to add up to the whole it is printed under.

   Both are checkable directly, against a real database, and neither was:

     - /api/kpis reports completed_trips and cancelled_trips beside its rates.
       /api/driver/kpis and /api/vehicle/kpis reported only the rate and the
       denominator, so "90.5%" on a driver's page was a figure the reader had
       to take on trust while the same rate on the fleet page could be checked.

     - A breakdown that does not sum to its headline is the single most common
       way a dashboard lies, and it is invisible until somebody adds the column
       up by hand.

   Everything here is arithmetic on ONE response or between two endpoints
   describing the same population, so a failure is unambiguous. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
const { get, server } = await mountAll(db);
const W = 'from=2026-08-01&to=2026-08-31';

/* Postgres numeric arrives as a JS STRING. Comparing one with === is a bug
   this product has shipped twice, so every assertion coerces. */
const N = (v) => (v == null || v === '' ? null : Number(v));
const sum = (rows, k) => (rows || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
/* A rate rounded to one decimal can differ from the exact ratio by up to 0.05.
   The tolerance is that, not a shrug — 0.6 would hide a rate computed over the
   wrong denominator on a small fleet. */
const near = (a, b, tol = 0.06) => a != null && b != null && Number.isFinite(a)
  && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ── 1. the fleet headline is internally consistent ─────────────────────── */
const k = (await get(`/api/kpis?${W}`)).body;
check('completion is the completed trips over the bookable ones',
  near(N(k.completion_pct), 100 * k.completed_trips / k.bookable_trips),
  `${k.completion_pct} vs ${k.completed_trips}/${k.bookable_trips}`);
check('cancellation is over the same denominator',
  near(N(k.cancel_pct), 100 * k.cancelled_trips / k.bookable_trips),
  `${k.cancel_pct} vs ${k.cancelled_trips}/${k.bookable_trips}`);
check('and the two outcomes cannot exceed the trips they are drawn from',
  k.completed_trips + k.cancelled_trips <= k.bookable_trips,
  `${k.completed_trips}+${k.cancelled_trips} vs ${k.bookable_trips}`);
check('average distance is over the trips that reported one, not over all of them',
  near(N(k.avg_km), N(k.km) / k.trips_with_distance, 0.05),
  `${k.avg_km} vs ${N(k.km)}/${k.trips_with_distance}`);
check('average fare is over the trips that carry a fare',
  near(N(k.avg_fare), N(k.revenue) / k.priced_trips, 0.05),
  `${k.avg_fare} vs ${N(k.revenue)}/${k.priced_trips}`);
/* Both halves over the SAME trips. `revenue` covers every trip with a fare;
   `priced_km` covers those that also report a distance. Dividing the first by
   the second is a ratio between two populations, and live it gave 3.93 where
   revenue/priced_km is 5.28 — neither figure derivable from the two printed
   beside it. priced_measured_revenue is the matching numerator. */
check('revenue per km is the revenue of the priced trips over the distance of those same trips',
  near(N(k.revenue_per_km), N(k.priced_measured_revenue) / N(k.priced_km), 0.02),
  `${k.revenue_per_km} vs ${N(k.priced_measured_revenue)}/${N(k.priced_km)}`);
check('and that numerator is no larger than the revenue it is drawn from',
  N(k.priced_measured_revenue) <= N(k.revenue) + 1,
  `${k.priced_measured_revenue} vs ${k.revenue}`);
check('the fleet accounts for the bookings that belong to no vehicle',
  typeof k.trips_without_vehicle === 'number', String(k.trips_without_vehicle));
check('the coverage percentages are what they claim to be',
  near(N(k.priced_pct), 100 * k.priced_trips / k.trips)
  && near(N(k.attributed_pct), 100 * k.attributed_trips / k.trips),
  `${k.priced_pct} / ${k.attributed_pct}`);

/* ── 2. every breakdown sums to the headline it sits under ──────────────── */
for (const by of ['platform', 'status', 'payment', '']) {
  const rows = (await get(`/api/mix?${W}${by ? `&by=${by}` : ''}`)).body || [];
  const t = sum(rows, 'n');
  /* The payment breakdown deliberately excludes rows no provider labelled —
     /api/mix/detail reports those separately rather than inventing an
     "unknown" bucket — so it is the one dimension that may come up short. */
  const ok = by === 'payment' ? t <= k.trips : t === k.trips;
  check(`the ${by || 'product'} mix accounts for the trip count`, ok, `${t} vs ${k.trips}`);
}
check('the daily series sums to the trip count',
  sum((await get(`/api/trips/daily?${W}`)).body, 'trips') === k.trips);
check('the hourly curve sums to the trip count',
  sum((await get(`/api/trips/hourly?${W}`)).body, 'trips') === k.trips);
check('the weekday-hour heatmap sums to the trip count',
  sum((await get(`/api/trips/heatmap?${W}`)).body, 'trips') === k.trips);

/* ── 3. a driver's own page adds up ─────────────────────────────────────── */
{
  const kpi = (await get(`/api/driver/kpis?id=u-khalid&${W}`)).body;
  check('a driver’s rate carries its own numerator, not just its denominator',
    typeof kpi.completed === 'number' && typeof kpi.not_completed === 'number',
    JSON.stringify({ completed: kpi.completed, not_completed: kpi.not_completed }));
  check('and the rate is that numerator over that denominator',
    near(N(kpi.completion_pct), 100 * kpi.completed / kpi.outcome_n),
    `${kpi.completion_pct} vs ${kpi.completed}/${kpi.outcome_n}`);
  check('and the cancellation rate likewise',
    near(N(kpi.cancel_pct), 100 * kpi.not_completed / kpi.outcome_n),
    `${kpi.cancel_pct} vs ${kpi.not_completed}/${kpi.outcome_n}`);
  const daily = (await get(`/api/driver/daily?id=u-khalid&${W}`)).body;
  check('their daily rows sum to their headline', sum(daily, 'trips') === kpi.trips,
    `${sum(daily, 'trips')} vs ${kpi.trips}`);
  check('and so do the completed ones', sum(daily, 'completed') === kpi.completed,
    `${sum(daily, 'completed')} vs ${kpi.completed}`);
  const trips = (await get(`/api/driver/trips?id=u-khalid&${W}&limit=1000`)).body;
  const rows = Array.isArray(trips) ? trips : trips.rows || [];
  check('and the trip list is exactly as long as the count above it',
    rows.length === kpi.trips, `${rows.length} vs ${kpi.trips}`);
  check('their average distance is over the trips that reported one',
    near(N(kpi.avg_km), N(kpi.km) / kpi.trips_with_distance, 0.06),
    `${kpi.avg_km} vs ${N(kpi.km)}/${kpi.trips_with_distance}`);
  /* A ratio between two populations is not a ratio. Revenue per km divided the
     fares of the trips that carry one by the distance of ALL of them, which on
     a driver working mostly Uber — whose export has no fare column — came out
     an order of magnitude low. Both halves must describe the priced trips. */
  check('the driver page reports the distance its revenue was earned over',
    typeof kpi.priced_km !== 'undefined', JSON.stringify({ priced_km: kpi.priced_km }));
  check('and that distance is no larger than the distance of every trip',
    N(kpi.priced_km) <= N(kpi.km) + 1, `${kpi.priced_km} vs ${kpi.km}`);
}

/* ── 4. a vehicle's own page adds up ────────────────────────────────────── */
{
  const kpi = (await get(`/api/vehicle/kpis?plate=${PLATES[0]}&${W}`)).body;
  check('a vehicle’s rate carries its own numerator too',
    typeof kpi.completed === 'number' && typeof kpi.not_completed === 'number',
    JSON.stringify({ completed: kpi.completed, not_completed: kpi.not_completed }));
  check('and it is that numerator over that denominator',
    near(N(kpi.completion_pct), 100 * kpi.completed / kpi.outcome_n),
    `${kpi.completion_pct} vs ${kpi.completed}/${kpi.outcome_n}`);
  const daily = (await get(`/api/vehicle/daily?plate=${PLATES[0]}&${W}`)).body;
  const rows = Array.isArray(daily) ? daily : daily.rows || [];
  check('its daily rows sum to its headline', sum(rows, 'trips') === kpi.trips,
    `${sum(rows, 'trips')} vs ${kpi.trips}`);
  check('a vehicle’s revenue per km is fares over the distance of those same trips',
    near(N(kpi.revenue_per_km), N(kpi.priced_measured_revenue) / N(kpi.priced_km), 0.02),
    `${kpi.revenue_per_km} vs ${N(kpi.priced_measured_revenue)}/${N(kpi.priced_km)}`);
  /* Coerced, and deliberately so: `kpi.priced_km <= kpi.km + 1` on the raw
     values is "829" <= "11641", a lexical comparison that is false. Postgres
     numeric arrives as a JS string and the first version of this very check
     shipped the bug it was written to catch. */
  check('and not over the distance of every booking, which is a different population',
    N(kpi.priced_km) <= N(kpi.km) + 1
    && (kpi.priced_trips === kpi.trips || N(kpi.priced_km) < N(kpi.km)),
    `${kpi.priced_km} priced km of ${kpi.km} total, over ${kpi.priced_trips} of ${kpi.trips} trips`);
  const dd = (await get(`/api/vehicle/drivers-detail?plate=${PLATES[0]}&${W}`)).body;
  check('and the custody totals sum to the same number of trips as the day rows',
    sum(dd.totals, 'trips') === sum(dd.days, 'trips'),
    `${sum(dd.totals, 'trips')} vs ${sum(dd.days, 'trips')}`);
}

/* ── 5. a day's own page adds up ────────────────────────────────────────── */
{
  const d = (await get('/api/day?day=2026-08-05')).body;
  const h = d.headline;
  check('the hours of the day sum to the day’s bookings',
    sum(d.hours, 'bookings') === h.bookings, `${sum(d.hours, 'bookings')} vs ${h.bookings}`);
  check('the platform mix covers every row the day holds, bookings and telematics alike',
    sum(d.platforms, 'n') === h.bookings + h.telematics,
    `${sum(d.platforms, 'n')} vs ${h.bookings}+${h.telematics}`);
  check('the driver table sums to the day’s bookings',
    sum(d.drivers, 'trips') === h.bookings, `${sum(d.drivers, 'trips')} vs ${h.bookings}`);
  check('the vehicle table sums to the day’s bookings',
    sum(d.vehicles, 'bookings') === h.bookings, `${sum(d.vehicles, 'bookings')} vs ${h.bookings}`);
  check('and the harsh-driving breakdowns agree with each other',
    sum(d.alerts, 'n') === sum(d.alertsByVehicle, 'n')
    || sum(d.alertsByVehicle, 'n') === 0,
    `${sum(d.alerts, 'n')} by type vs ${sum(d.alertsByVehicle, 'n')} by vehicle`);
}

/* ── 6. two endpoints describing the same population must agree ─────────── */
{
  const dir = (await get(`/api/drivers/directory?${W}`)).body || [];
  const lb = (await get(`/api/drivers/leaderboard?${W}`)).body;
  const dirTrips = sum(dir, 'trips');
  const lbTrips = sum(lb.rows, 'trips');
  check('the directory and the ranking agree about how much work was done',
    dirTrips === lbTrips, `${dirTrips} vs ${lbTrips}`);
  check('and about how many people did it',
    dir.filter((r) => (r.trips || 0) > 0).length === lb.people,
    `${dir.filter((r) => (r.trips || 0) > 0).length} vs ${lb.people}`);

  const vdir = (await get(`/api/vehicles/directory?${W}`)).body || [];
  const veh = (await get(`/api/vehicles?${W}`)).body;
  check('the vehicle directory and the vehicle list agree about the work',
    sum(vdir, 'trips') === sum(veh.rows, 'trips'),
    `${sum(vdir, 'trips')} vs ${sum(veh.rows, 'trips')}`);
  /* The vehicle table cannot hold a booking with no vehicle on it, so it sums
     to fewer trips than the fleet — by exactly the number the fleet reports as
     unassigned. Live that difference was 15 and had no home, which reads as one
     of the two figures being wrong. */
  check('and the fleet headline agrees once the bookings with no vehicle are added back',
    sum(vdir, 'trips') + (k.trips_without_vehicle || 0) === k.trips,
    `${sum(vdir, 'trips')} + ${k.trips_without_vehicle} vs ${k.trips}`);
}

/* ── 7. and all of it again at a scale where every list is truncated ────── */
/* Small numbers hide truncation: with five vehicles nothing is ever cut, so a
   headline computed over a capped list agrees with the list by accident. At 240
   vehicles and 240 people every one of these breakdowns is a page of a larger
   set, and a sum that still matches is a sum measured over the population. */
{
  server.close(); await db.close();
  const wide = new PGlite();
  await applySchema(wide);
  await seedFleet(wide, { wide: true });
  await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db: wide });
  const w = await mountAll(wide);
  const g = w.get;
  const wk = (await g(`/api/kpis?${W}`)).body;
  check('at scale, the fleet completion rate is still its own numerator over its own denominator',
    near(N(wk.completion_pct), 100 * wk.completed_trips / wk.bookable_trips),
    `${wk.completion_pct} vs ${wk.completed_trips}/${wk.bookable_trips}`);
  check('at scale, the daily series still sums to the trip count',
    sum((await g(`/api/trips/daily?${W}`)).body, 'trips') === wk.trips,
    `${sum((await g(`/api/trips/daily?${W}`)).body, 'trips')} vs ${wk.trips}`);
  check('at scale, the platform mix still accounts for every trip',
    sum((await g(`/api/mix?${W}&by=platform`)).body, 'n') === wk.trips);
  const wdir = (await g(`/api/vehicles/directory?${W}`)).body || [];
  const wveh = (await g(`/api/vehicles?${W}`)).body;
  check('the vehicle list is truncated at this scale, so the next check means something',
    wveh.truncated === true && wveh.rows.length < wdir.length,
    `${wveh.rows.length} shown of ${wveh.total}`);
  check('and the fleet vehicle count is the population, not the page',
    wveh.total === wdir.length, `${wveh.total} vs ${wdir.length}`);
  check('the directory still covers every vehicle, and its trips still sum to the headline',
    sum(wdir, 'trips') === wk.trips, `${sum(wdir, 'trips')} vs ${wk.trips}`);
  const wlb = (await g(`/api/drivers/leaderboard?${W}`)).body;
  const wpeople = ((await g(`/api/drivers/directory?${W}`)).body || [])
    .filter((r) => (r.trips || 0) > 0).length;
  check('the ranking is truncated too, and still counts everybody',
    wlb.truncated === true && wlb.people === wpeople,
    `${wlb.shown} shown, ${wlb.people} people vs ${wpeople} in the directory`);
  w.server.close(); await wide.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
