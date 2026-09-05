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
   4,634 + 1,468 = 6,102.

   How far out that is can be measured without the fix being deployed, and the
   first version of this header carried the audit's guess of "roughly 9,800"
   instead. /api/compare/period sums driver_day.online_min, which
   src/rollup.js:927-932 builds from the same ONLINE spans, and it honours the
   fleet chip. Fetched from production on 2026-09-05 over the same window:
   1,609,712 online minutes unfiltered, 1,074,609 ecosine, 534,900 egari — so
   egari is 33.2% of the fleet's online time, about 8,610 h of this endpoint's
   own 25,907. Its real idle is roughly 7,140 h and 83%, not the 24,439 h and
   94% the page printed, and the idle hours were overstated about three and a
   half times over.

   The platform chips were not merely wrong, they were invented:
   driver_timeline_event holds platform 'uber' and nothing else, so
   #supply?platform=bolt printed Uber's hours as Bolt's and called that channel
   99% idle when no availability feed for Bolt exists at all.

   Properties are pinned here rather than a spelling of the SQL, because the
   defect survived every type check and printed a plausible number: the two
   fleets must disagree about the denominator, they must sum to the unfiltered
   one, and a platform the feed has never carried must come back covered:false
   so the page says availability was not collected instead of borrowing
   somebody else's hours.

   Three more were added after an adversarial read of the fix found that the
   fix itself had introduced one of them. A chip must not out-measure the feed
   it is a subset of — the predicates were first written ahead of lead(), which
   deleted the event that CLOSED a span and let a two-hour shift run to 25. An
   uncovered selection must report its totals as absent and never as 0, because
   `tot` reduces over the supply cells and the page headlined the result as
   "0 jobs in this window" for a channel that really sold 614 rides. And the
   two uncovered cases — a feed that does not exist and a window the feed does
   not reach — must carry DIFFERENT reasons, because the page prints the reason
   and a reader told to wait for a backfill that is never coming has been told
   something worse than nothing. */
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

/* ── one driver whose two events are stamped with different fleets ─────────
   Deliberately on 2026-08-20/21, outside the window every figure above is
   checked over, so it perturbs none of that arithmetic and gets a window of
   its own below.

   The provider stamps a fleet_id on each event independently, and a driver who
   moves between the two organisations — or a row the supplier mislabels — puts
   the ONLINE under one and the OFFLINE that closes it under the other. A span
   is not one row: it is an ONLINE row and the NEXT event on that driver's
   timeline. So the chip predicates have to be applied after lead() has seen
   the whole timeline, and applying them before deletes the closing event and
   lets the ONLINE run on to whatever survives. */
await ev('egari', 'm1', '2026-08-20T06:00:00Z', 'ONLINE');    // Dubai 10:00
await ev('ecosine', 'm1', '2026-08-20T08:00:00Z', 'OFFLINE'); // Dubai 12:00 — closes it, 2h
await ev('egari', 'm1', '2026-08-21T06:00:00Z', 'ONLINE');    // next morning, Dubai 10:00
await ev('egari', 'm1', '2026-08-21T07:00:00Z', 'OFFLINE');   // 1h, both rows one fleet

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


/* ── a span is closed by the next event, whichever fleet stamped it ────────
   The chip predicates were first written into the `ev` CTE, beside the window
   bound and AHEAD of lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at).
   That reads as a filter and is not one: lead() sees only the rows the CTE
   gives it, so &fleet=egari deleted the ecosine-stamped OFFLINE out of the
   middle of m1's timeline and the 10:00 ONLINE closed against the NEXT
   MORNING's ONLINE instead. Measured on this fixture before the predicates
   were moved into `spans`: 25 online hours and 26 painted heatmap cells for a
   driver who was online for three hours across two.

   Pinned as the invariant rather than as the number 3, because the number is
   this fixture's and the invariant is the query's: every span a chip keeps is
   a span the unfiltered query also has, so no chip can report MORE online time
   than the whole feed does, and none can paint more cells. A chip that
   out-measures the feed it is a subset of has invented supply. Revert the
   predicates into `ev` and both of these fail. */
const MIX = 'from=2026-08-20&to=2026-08-22';
const mixed = async (extra = '') => (await get(`/api/supply/balance?${MIX}${extra}`)).body;
const mAll = await mixed();
const mEg = await mixed('&fleet=egari');
const mEco = await mixed('&fleet=ecosine');
console.log(`  · mixed-fleet driver — unfiltered ${mAll.totals.online_h} h in `
  + `${mAll.cells.length} cells, egari ${mEg.totals.online_h} h in ${mEg.cells.length} cells`);

check('a chip cannot report more online hours than the whole feed',
  mEg.totals.online_h <= mAll.totals.online_h,
  `egari ${mEg.totals.online_h} > unfiltered ${mAll.totals.online_h}`);
check('nor paint more heatmap cells than the whole feed has',
  mEg.cells.length <= mAll.cells.length,
  `egari ${mEg.cells.length} cells > unfiltered ${mAll.cells.length}`);
/* And the span is the right length, not merely a small one: the ONLINE that
   opens it belongs to egari, the OFFLINE that ends it is stamped ecosine, and
   the driver stopped being online at that instant regardless of what the
   provider wrote in the fleet column. Two hours on the 20th plus one on the
   21st. */
check('the closing event ends the span even when another fleet stamped it',
  mEg.totals.online_h === 3 && mAll.totals.online_h === 3,
  `egari ${mEg.totals.online_h}, unfiltered ${mAll.totals.online_h}`);
/* The other side of the same coin: ecosine opened no span here, so it has no
   supply in this window at all — an OFFLINE row is not availability. */
check('a fleet that only closed somebody else\'s span has no supply of its own',
  mEco.covered === false, JSON.stringify(mEco.totals));

/* ── absent, not zero, and never for the wrong reason ──────────────────────
   `tot` is reduced over the supply cells, so an uncovered selection made every
   total 0 — and api/public/supply.js headlined `${fmt(t.jobs)} jobs in this
   window`, which printed "0 jobs in this window" for a channel that sold 614
   rides in the same span on production. Zero is a measurement; this is the
   absence of one. */
for (const [k, v] of Object.entries(bolt.totals)) {
  check(`an uncovered selection reports ${k} as absent rather than 0`,
    v === null, `${k} = ${JSON.stringify(v)}`);
}
check('…while the window really does hold work for it, so a 0 would be a lie',
  boltTrips > 0, `${boltTrips} bolt trips`);

/* ── the two uncovered cases are not the same case ─────────────────────────
   Before this, /api/supply/balance said only `covered: false` and the page
   attached one sentence to it: Uber serves the last 31 days and nothing older,
   so the page fills in going forward and cannot be backfilled. True of a
   window that predates the collector; false of #supply?platform=bolt, which
   has no feed to backfill and never will until somebody writes a Bolt
   collector. A reader told to wait for data that is never coming has been told
   something worse than nothing.

   So the reasons must DIFFER, and the platform list must be read from the feed
   rather than asserted — the day a second collector lands, the sentence has to
   change with it. */
/* Its own window, not bal()'s — bal() prepends WIN, and a second from= in the
   same query string is not a narrower window, it is an ignored one. */
const outside = (await get(
  '/api/supply/balance?from=2026-07-01&to=2026-07-10&platform=uber')).body;
console.log(`  · uncovered reasons — bolt ${JSON.stringify(bolt.uncovered)}, `
  + `July ${JSON.stringify(outside.uncovered)}`);
check('a window before the feed started is uncovered too',
  outside.covered === false, JSON.stringify(outside.totals));
check('and the two uncovered cases give different reasons',
  bolt.uncovered.reason !== outside.uncovered.reason,
  `both said ${bolt.uncovered.reason}`);
check('a channel with no feed at all says so',
  bolt.uncovered.reason === 'no-feed', bolt.uncovered.reason);
check('a channel that has a feed but not in these days says that instead',
  outside.uncovered.reason === 'outside-window', outside.uncovered.reason);
/* Measured from driver_timeline_event, not written into the page: the fixture
   holds uber rows and nothing else, exactly as production does. */
/* Pinned to the SOURCE of the list, not to its contents. `join() === 'uber'`
   passes just as well against a hard-coded 'uber' in the route, which is the
   exact drift this assertion exists to prevent — so it is checked against what
   the fixture actually seeded instead. Seed a second platform and the list must
   grow; that is the property. */
const seededFeed = (await q(
  `SELECT DISTINCT platform FROM driver_timeline_event
    WHERE kind = 'status' AND status <> '' ORDER BY 1`)).map((r) => r.platform);
check('and it names the platforms the feed does carry, read from the table',
  Array.isArray(bolt.uncovered.platforms)
  && bolt.uncovered.platforms.join() === seededFeed.join()
  && seededFeed.length > 0,
  `${JSON.stringify(bolt.uncovered.platforms)} vs seeded ${JSON.stringify(seededFeed)}`);
check('a covered answer carries no reason, because there is nothing to explain',
  all.uncovered === null && uber.uncovered === null,
  `${JSON.stringify(all.uncovered)} / ${JSON.stringify(uber.uncovered)}`);

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
