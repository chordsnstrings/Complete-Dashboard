/* Where the cars should be, and when — checked against arithmetic, not vibes.
   ─────────────────────────────────────────────────────────────────────────
   The optimiser makes one join nothing else in the product makes: bookings
   that START in an area against cars that ARRIVED in it, in the hour before.
   Where departures outrun arrivals, the fleet is driving in empty — and that
   difference is the only number on the page a rota would be rewritten for, so
   it is the one worth pinning down.

   Three properties, each of which was a decision that could have gone the
   other way:

     the hour shift  a car that lands at 16:00 serves a 17:00 booking. Compared
                     in the same hour instead, every evening peak reads as
                     already supplied and the page says do nothing.
     the rate        a slot that occurred four times and one that occurred
                     thirty are not the same opportunity at the same total.
     the floor       arrivals are an UPPER bound on cars present, because a car
                     may have left for reasons this cannot see. So the gap is a
                     floor. Overstating it is how a repositioning plan sends
                     cars to an area that was already covered.
*/
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* Dubai time. 2026-08-06 is a Thursday, which is dow 4. */
const AT = (day, hour) => `2026-08-${String(day).padStart(2, '0')}T${String(hour - 4).padStart(2, '0')}:10:00Z`;
let n = 0;
const trip = (day, hour, fromArea, toArea, mins = 20) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
   VALUES ('uber', $1, 'ecosine', 'L1', 'd1', 'D', $2::timestamptz, $2::timestamptz + ($3 || ' minutes')::interval,
           $4, $5, 8, 'completed', 40, '{}'::jsonb)`,
  [`t${++n}`, AT(day, hour), String(mins),
    `Shop 1 - ${fromArea} - Dubai - UAE`, `Villa 2 - ${toArea} - Dubai - UAE`]);

/* Thursdays in the window: the 6th, 13th, 20th, 27th — four occurrences.
   Marina produces four 17:00 pickups a Thursday and receives nothing at 16:00,
   so every one of those cars arrives empty. Deira receives four at 16:00 and
   starts nothing at 17:00 — the same cars, idle in the wrong place. */
for (const day of [6, 13, 20, 27]) {
  for (let i = 0; i < 4; i++) await trip(day, 17, 'Dubai Marina', 'Business Bay');
  for (let i = 0; i < 4; i++) await trip(day, 16, 'Business Bay', 'Deira', 20);
  /* Two cars a Thursday DO land in Marina at 16:30, so its 17:00 demand is
     half covered — which makes the share arriving empty a real fraction
     rather than the 100% a fixture with no arrivals anywhere would give. */
  for (let i = 0; i < 2; i++) await trip(day, 16, 'Al Barsha', 'Dubai Marina', 20);
}

const { get } = await mountAll(db, { serverRoutes: true });
const res = await get('/api/optimise?from=2026-08-01&to=2026-08-31');
check('the endpoint answers', res.status === 200, JSON.stringify(res.body).slice(0, 140));
const d = res.body;

const marina = d.slots.find((s) => s.area === 'Dubai Marina' && s.dow === 4 && s.h === 17);
check('a Thursday 17:00 pickup lands on Thursday 17:00', !!marina, JSON.stringify(d.slots.slice(0, 3)));
check('…with all sixteen of its pickups', marina?.pickups === 16, String(marina?.pickups));
check('…over the four Thursdays that happened', marina?.occurrences === 4, String(marina?.occurrences));
check('…so the rate is four an hour, not sixteen', marina?.per_occurrence === 4, String(marina?.per_occurrence));
check('…and eight cars had landed there', marina?.arrivals === 8, String(marina?.arrivals));
check('…so the gap is the eight that still arrive empty', marina?.gap === 8, String(marina?.gap));

/* The hour shift: a trip ENDING at 16:30 is counted as an arrival at 17:00,
   because that is the car a 17:00 booking can use. */
const deira = d.slots.find((s) => s.area === 'Deira' && s.dow === 4 && s.h === 17);
check('a car that lands at 16:30 counts as available at 17:00', deira?.arrivals === 16,
  JSON.stringify(deira));
check('…and Deira starts nothing then, so it is surplus', deira?.pickups === 0 && deira.gap === -16,
  JSON.stringify(deira));

/* Business Bay starts sixteen trips at 16:00 with nothing landing there, so
   four cars an occurrence arrive empty — the worst rate in the fixture, and
   the top of the list. Marina is half covered and ranks below it even though
   it has the same pickups, which is the ranking doing its job: the
   opportunity is the SHORTFALL, not the volume. */
const move = d.moves[0];
check('the top move is the place-hour driving in empty most often',
  move?.area === 'Business Bay' && move?.h === 16, JSON.stringify(move));
check('…stated per occurrence, which is what a rota is written against',
  move?.gap_per_occurrence === 4, String(move?.gap_per_occurrence));
check('…and an equally busy place-hour that is half covered ranks below it',
  d.moves.find((m) => m.area === 'Dubai Marina')?.gap_per_occurrence === 2
  && d.moves.findIndex((m) => m.area === 'Dubai Marina') > 0,
  JSON.stringify(d.moves.map((m) => [m.area, m.h, m.gap_per_occurrence])));
check('the surplus side names where the cars actually are',
  d.surplus[0]?.area === 'Deira' && d.surplus[0]?.h === 17, JSON.stringify(d.surplus[0]));

/* Nothing invented: an address with no community segment is excluded rather
   than bucketed into an area that would then rank. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, requested_at,
                           ended_at, pickup_addr, dropoff_addr, status, price, raw)
         VALUES ('uber','nx','ecosine','L2','d2',$1::timestamptz,$1::timestamptz + interval '10 min',
                 'somewhere', 'elsewhere', 'completed', 10, '{}'::jsonb)`, [AT(6, 9)]);
const res2 = await get('/api/optimise?from=2026-08-01&to=2026-08-31');
check('an address with no community segment is not given a fake area',
  !res2.body.slots.some((s) => /somewhere|elsewhere/i.test(String(s.area))));

check('the headline counts only what it placed', d.placed_bookings === 40, String(d.placed_bookings));
/* 8 empty into Marina, 16 into Business Bay, 8 into Al Barsha = 32, over the
   40 bookings the join could place. A fraction, so the ratio is under test
   rather than the 100% a fixture with no arrivals anywhere would produce. */
check('and the share arriving empty is a real fraction of what was placed',
  d.empty_arrivals === 32 && d.empty_arrival_pct === 80,
  `${d.empty_arrivals} / ${d.placed_bookings} = ${d.empty_arrival_pct}%`);
check('the note says an area is parsed text, not a polygon', /not a polygon/.test(d.note || ''));
/* The trap this endpoint walked into on real data: Terminal 3 is addressed
   both as "Dubai Int'l Airport" and as "Al Garhoud", so the area arithmetic
   ranked one as the fleet's worst shortfall and the other as its largest
   surplus — for every hour of every day. "Move the cars from the airport to
   the airport". The note has to say so, because a reader who does not know
   that will act on the ranking. */
check('…and warns that one place can be written two ways',
  /two ways|two different ways/.test(d.note || ''), d.note);
check('…naming the pair it actually happened to', /Al Garhoud/.test(d.note || ''));

/* Which is why the vehicle-linked measurement exists: it follows a CAR from
   one drop-off to its next pick-up, so what the places were called does not
   enter into it. */
check('a vehicle-linked idle figure is reported', typeof d.idle_h_between_jobs === 'number',
  String(d.idle_h_between_jobs));
check('…with the handovers it is averaged over', d.handovers > 0, String(d.handovers));
check('…and it is the same one car, in order', Array.isArray(d.waits));
/* One plate, four Thursdays, trips at 16:00 and 17:00 — the 16:00 job ends at
   16:30 and the next starts at 17:10, so forty minutes of waiting, four
   times, in whatever area the 16:00 job ended in. */
const bay = d.waits.find((w) => w.area === 'Deira' && w.h === 16);
check('the wait is measured from drop-off to the next pick-up',
  bay?.median_wait_min === 40, JSON.stringify(bay));
check('…and the note says a shift end is not a wait', /shift end/.test(d.note || ''));

/* Every ranking on this endpoint is a head, not a census. Forty rows out of
   forty and forty rows out of six hundred are different claims, and the
   reader cannot tell them apart from the rows alone. */
check('each capped ranking names the population it was cut from',
  d.totals && typeof d.totals.waits === 'number' && typeof d.totals.moves === 'number'
  && typeof d.totals.surplus === 'number', JSON.stringify(d.totals));
check('…and says how many of them it actually sent',
  d.shown && d.shown.waits === d.waits.length && d.shown.moves === d.moves.length
  && d.shown.surplus === d.surplus.length, JSON.stringify(d.shown));
check('…with the population never smaller than the slice',
  d.totals.waits >= d.waits.length && d.totals.moves >= d.moves.length
  && d.totals.surplus >= d.surplus.length);

/* ── The per-occurrence trap ───────────────────────────────────────────────
   /api/supply/balance answers 168 cells that are each an average PER
   OCCURRENCE of that weekday, which is the only way a Tuesday and a Thursday
   are comparable in a window holding five of one and four of the other. The
   sum of those 168 cells is therefore about one WEEK of hours, not the
   window's total — and the Optimise page printed that sum as "online hours
   measured" and sized its trip upside against it, understating both by
   roughly four times on a 30-day window. The percentages survived, because
   they were ratios of two equally-shrunken numbers; the counts a board would
   read did not.

   The route already answers the honest totals. This pins the gap between the
   two so a page cannot quietly go back to summing cells. */
/* Availability, so the balance route has something to divide. August 2026
   opens on a Saturday, so the window holds five Sundays (2, 9, 16, 23, 30)
   and four Thursdays (6, 13, 20, 27) — an uneven count, which is the whole
   reason the route answers per-occurrence averages and the reason summing
   its cells cannot be the window's total. */
const online = (day, from, to) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber','ecosine','d1', $1::timestamptz, 'status', $2, ''),
          ('uber','ecosine','d1', $3::timestamptz, 'status', 'OFFLINE', '')`,
  [`2026-08-${String(day).padStart(2, '0')}T${String(from).padStart(2, '0')}:00:00+04`, 'ONLINE',
    `2026-08-${String(day).padStart(2, '0')}T${String(to).padStart(2, '0')}:00:00+04`]);
for (const d of [2, 9, 16, 23, 30]) await online(d, 8, 12);   // five Sundays
for (const d of [6, 13, 20, 27]) await online(d, 8, 12);      // four Thursdays

const bal = (await get('/api/supply/balance?from=2026-08-01&to=2026-08-31')).body;
check('the balance route answers window totals, not just cells',
  bal.totals && bal.totals.online_h > 0, JSON.stringify(bal.totals));
check('…and every cell says how many times its weekday occurred',
  bal.cells.length > 0 && bal.cells.every((c) => Number(c.occurrences) > 0));
const cellSum = bal.cells.reduce((a, c) => a + Number(c.online_h || 0), 0);
const scaled = bal.cells.reduce((a, c) => a + Number(c.online_h || 0) * Number(c.occurrences), 0);
check('…so summing the cells is NOT the window total',
  Math.round(scaled) > Math.round(cellSum), `${Math.round(cellSum)} vs ${Math.round(scaled)}`);
check('…and multiplying each cell back out reproduces it',
  Math.abs(scaled - Number(bal.totals.online_h)) <= Math.max(2, Number(bal.totals.online_h) * 0.01),
  `${Math.round(scaled)} vs ${bal.totals.online_h}`);
check('…the jobs total agrees with the same reconstruction',
  Math.abs(bal.cells.reduce((a, c) => a + Number(c.jobs || 0) * Number(c.occurrences), 0)
    - Number(bal.totals.jobs)) <= Math.max(2, Number(bal.totals.jobs) * 0.01));

/* ── an average fare of zero ──────────────────────────────────────────────
   A place-hour of Uber work carries no price on any row, and averaging across
   the priced and the unpriced answered "AED 0" — which a reader takes as "this
   place earns nothing" rather than "nothing here reported a price". Averaged
   over the bookings that carry a fare, with the count beside it, so the rate
   cannot be read without its base. */
const withFare = d.moves.find((m) => m.avg_fare != null);
check('an average fare names how many bookings it is over',
  withFare && Number.isFinite(+withFare.priced_pickups),
  JSON.stringify(withFare && { f: withFare.avg_fare, n: withFare.priced_pickups, p: withFare.pickups }));
check('…and that count never exceeds the bookings it is drawn from',
  d.moves.every((m) => m.priced_pickups == null || m.priced_pickups <= m.pickups));
check('…while a place-hour where nothing carries a price reports no fare at all',
  d.moves.every((m) => m.avg_fare == null || m.priced_pickups > 0),
  JSON.stringify(d.moves.filter((m) => m.avg_fare != null && !(m.priced_pickups > 0)).slice(0, 2)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
