/* ── the chips have to filter the denominator too ──────────────────────────
   /api/supply/balance divides on-job hours by online hours. The on-job half
   reads trip_norm through FB, which carries the platform and fleet predicates;
   the online half read driver_timeline_event bound on the window alone. So the
   fleet and platform chips moved the numerator and left the divisor exactly
   where it was, and the page printed one fleet's work against both fleets'
   supply. Measured on production over 2026-08-06 → 2026-09-05:

     unfiltered      online_h 25,907   on job 6,102   76% idle
     &fleet=ecosine  online_h 25,907   on job 4,634   82% idle
     &fleet=egari    online_h 25,907   on job 1,468   94% idle
     &platform=bolt  online_h 25,907   on job   138   99% idle

   Byte-identical denominators, down to the heatmap cells — dow 0 hour 0 read
   online_h 30.45 under all of them — while the numerator split correctly at
   4,634 + 1,468 = 6,102. Egari's true online hours are roughly 9,800, so its
   idle_h was overstated about three times over.

   The platform chips were not merely wrong, they were invented:
   driver_timeline_event holds platform 'uber' and nothing else, so
   #supply?platform=bolt printed Uber's hours as Bolt's and called that channel
   99% idle when no availability feed for Bolt exists at all.

   Three properties are pinned here rather than a spelling of the SQL, because
   the defect survived every type check and printed a plausible number: the two
   fleets must disagree about the denominator, they must sum to the unfiltered
   one, and a platform the feed has never carried must come back covered:false
   so the page says availability was not collected instead of borrowing
   somebody else's hours. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

console.log('\nsupply/balance: the fleet and platform chips filter the online hours too');

/* The availability feed as it really is — one platform, two fleets. The
   collector hard-codes SRC = 'uber' (src/sources/uber_timeline.js), so a bolt
   row here would be fiction; the point of the last block below is that there
   is nothing to find. */
const ev = (fleet, drv, at, status) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber', $1, $2, $3::timestamptz, 'status', $4, '')`, [fleet, drv, at, status]);

/* Deliberately lopsided, the way the real fleets are: ecosine online six hours
   a day across two drivers, egari two hours across one. Whole hours inside a
   single Dubai day so the arithmetic is checkable by hand. */
for (const d of ['06', '07', '08']) {
  await ev('ecosine', 'e1', `2026-08-${d}T06:00:00Z`, 'ONLINE');   // Dubai 10:00
  await ev('ecosine', 'e1', `2026-08-${d}T09:00:00Z`, 'OFFLINE');  // Dubai 13:00 → 3h
  await ev('ecosine', 'e2', `2026-08-${d}T06:00:00Z`, 'ONLINE');
  await ev('ecosine', 'e2', `2026-08-${d}T09:00:00Z`, 'OFFLINE');  // 3h
  await ev('egari', 'g1', `2026-08-${d}T06:00:00Z`, 'ONLINE');
  await ev('egari', 'g1', `2026-08-${d}T08:00:00Z`, 'OFFLINE');    // 2h
}
/* 18 ecosine online hours, 6 egari, 24 in total. */

/* And the demand side, including Bolt work — Bolt sells rides, it just never
   reports availability, which is exactly the pair of facts that let the old
   code print a Bolt idle rate. */
const trip = (platform, fleet, id, day, h, mins) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, distance_km, status)
   VALUES ($1, $2, $3, 'L1', 'd1', 'Driver One', $4::timestamptz, $5::timestamptz, 10, 'completed')`,
  [platform, id, fleet, `2026-08-${day}T${h}:00:00+04:00`,
   `2026-08-${day}T${h}:${String(mins).padStart(2, '0')}:00+04:00`]);
let n = 0;
for (const d of ['06', '07', '08']) {
  await trip('uber', 'ecosine', `u${n++}`, d, '10', 30);
  await trip('uber', 'egari', `g${n++}`, d, '10', 30);
  await trip('bolt', 'ecosine', `b${n++}`, d, '10', 30);
}

const { get, server } = await mountAll(db);
/* to=2026-08-09, one day past the last event: the span query bounds on
   `at <= $2::timestamptz` and a bare calendar date is that day's MIDNIGHT, so
   asking to=2026-08-08 would drop the 08th's rows and the hand-arithmetic
   below would be checking two days of feed against three days of it. */
const WIN = 'from=2026-08-06&to=2026-08-09';
const bal = async (extra = '') => (await get(`/api/supply/balance?${WIN}${extra}`)).body;

const all = await bal();
const eco = await bal('&fleet=ecosine');
const eg = await bal('&fleet=egari');
console.log(`  · online_h — unfiltered ${all.totals.online_h}, ecosine ${eco.totals.online_h}, egari ${eg.totals.online_h}`);

check('the unfiltered denominator is every fleet\'s online hours',
  all.totals.online_h === 24, JSON.stringify(all.totals));
/* THE defect, stated as the property and not as a number: the two fleets do
   not have the same amount of supply, so a denominator that is identical under
   both chips is not a measurement of either. */
check('the two fleets do not share one denominator',
  eco.totals.online_h !== eg.totals.online_h,
  `both answered ${eco.totals.online_h}`);
check('each chip answers that fleet\'s own online hours',
  eco.totals.online_h === 18 && eg.totals.online_h === 6,
  `ecosine ${eco.totals.online_h}, egari ${eg.totals.online_h}`);
check('and the two of them add up to the unfiltered total',
  eco.totals.online_h + eg.totals.online_h === all.totals.online_h,
  `${eco.totals.online_h} + ${eg.totals.online_h} ≠ ${all.totals.online_h}`);
/* The consequence the operator actually reads, and the reason this is a
   critical rather than a tidy-up: the headline percentage. Egari's idle rate
   over its own supply is 6 online hours against 1.5 on job; the old code put
   the same 1.5 over all 24 and printed a fleet that was idle nine tenths of
   the time.

   Both sides are computed from the SEEDED hours rather than from the response's
   own display fields, which is deliberate: online_h, on_job_h and idle_h are
   each rounded to a whole hour while idle_pct is computed from the unrounded
   sums, so 4.5 idle over 6 online is 75% beside two rounded fields that read
   5 over 6. Dividing the printed fields back into each other would pin a
   rounding artefact instead of the rate. */
const EG_ONLINE = 6, EG_ONJOB = 1.5;              // three ONLINE spans of 2h, three half-hour jobs
const rightPct = Math.round(((EG_ONLINE - EG_ONJOB) / EG_ONLINE) * 100);
const oldPct = Math.round(((all.totals.online_h - EG_ONJOB) / all.totals.online_h) * 100);
check('so the idle rate a chip prints is over that chip\'s own supply',
  eg.totals.idle_pct === rightPct && rightPct < oldPct,
  `${eg.totals.idle_pct}% printed, ${rightPct}% is right, ${oldPct}% is what the fleet-wide divisor gave`);

/* The heatmap is the same division per cell, and it was identical under every
   chip too — the whole grid was one fleet's picture painted under all of
   them. */
const cellOnline = (b) => {
  const c = b.cells.find((x) => x.dow === 4 && x.h === 10);   // 2026-08-06 is a Thursday
  return c ? c.total_online_h : null;
};
console.log(`  · Thu 10:00 total_online_h — unfiltered ${cellOnline(all)}, ecosine ${cellOnline(eco)}, egari ${cellOnline(eg)}`);
check('the heatmap cells split by fleet as well as the totals do',
  cellOnline(eco) !== cellOnline(eg) && cellOnline(eco) + cellOnline(eg) === cellOnline(all),
  `${cellOnline(eco)} / ${cellOnline(eg)} / ${cellOnline(all)}`);

/* ── a channel with no availability feed at all ───────────────────────────
   Bolt has trips in this window and not one timeline row, which is production
   exactly. The honest answer is that supply was not measured here — `covered`
   false, which api/public/supply.js turns into "Driver availability has not
   been collected for this window" — and never Uber's hours under a Bolt
   heading. */
const bolt = await bal('&platform=bolt');
const uber = await bal('&platform=uber');
console.log(`  · platform=bolt → covered ${bolt.covered}, online_h ${bolt.totals.online_h}, idle_pct ${bolt.totals.idle_pct}`);

const boltTrips = (await q(
  `SELECT count(*)::int AS n FROM trip_norm WHERE platform = 'bolt'`))[0].n;
const boltEvents = (await q(
  `SELECT count(*)::int AS n FROM driver_timeline_event WHERE platform = 'bolt'`))[0].n;
check('the fixture is production\'s shape: Bolt sells rides and reports no availability',
  boltTrips > 0 && boltEvents === 0, `${boltTrips} trips, ${boltEvents} events`);
check('a platform with no availability feed is reported as not covered',
  bolt.covered === false, JSON.stringify(bolt.totals));
check('…rather than borrowing another platform\'s online hours',
  bolt.totals.online_h !== all.totals.online_h && bolt.totals.online_h !== uber.totals.online_h,
  `bolt ${bolt.totals.online_h}, uber ${uber.totals.online_h}, all ${all.totals.online_h}`);
/* An idle percentage is a claim about supply. With no supply measured there is
   nothing to divide, and the response must say so rather than answer 99%. */
check('and no idle rate is invented for it',
  bolt.totals.idle_pct === null, String(bolt.totals.idle_pct));
check('while the platform that DOES report availability still gets all of it',
  uber.covered === true && uber.totals.online_h === all.totals.online_h,
  JSON.stringify(uber.totals));

/* The unfiltered call must be unchanged by all of this — a fix that narrowed
   the default window would trade one wrong number for another. */
check('an unchipped call still sees every row of the feed',
  all.covered === true && all.measured.days === 3, JSON.stringify(all.measured));
/* `measured` is the span the rate is over, and it is now per chip as well:
   both fleets happen to cover the same three days here, so what is pinned is
   that the span comes from the chip's own rows rather than from the whole
   feed — visible when the chip has none. */
check('the measured span is the chip\'s own feed, absent where the chip has none',
  bolt.measured === null && eg.measured.days === 3,
  `${JSON.stringify(bolt.measured)} / ${JSON.stringify(eg.measured)}`);

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
