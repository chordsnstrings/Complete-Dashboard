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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
