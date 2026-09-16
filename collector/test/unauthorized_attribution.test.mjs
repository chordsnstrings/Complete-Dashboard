/* WHO GETS NAMED BESIDE AN UNEXPLAINED JOURNEY, AND WHO DOES NOT.
   ═══════════════════════════════════════════════════════════════════════════
   An unauthorized trip is, by definition, a journey with no booking against
   it — so there is no trip record naming its driver, and every name this
   feature prints is an INFERENCE. Naming the wrong person accuses an innocent
   employee of theft. That is what makes this file's assertions load-bearing in
   a way an aggregate's are not: the failure mode is not a wrong number on a
   chart, it is a wrong name on an accusation.

   Twelve things are asserted and each one is a defect that has either happened
   here or happens in the shipped /api/unauthorized/list today:

     1. a journey time can attribute comes back BRACKETED, with the two gaps
        stated so a reader can check them against the car's own trip list
     2. a HANDOVER DAY comes back AMBIGUOUS with BOTH names and attributes to
        NEITHER — this is the case the operator asked for and it is the case a
        "most likely" rule would get wrong quietly
     3. a car with no custody at all comes back UNKNOWN with the TRUE reason,
        never the car's usual driver
     4. one human holding several platform accounts is ONE candidate. Measured
        on production: /api/unauthorized/list returns 2-4 names for one person
        on 12 of 120 segments ("Fahad Ali Amjad Ali" AND "FAHAD ALI AMJAD ALI"),
        i.e. twelve innocent second names next to an accusation, today
     5. a segment starting 22:30 UTC is filed on the DUBAI day it belongs to,
        because Dubai is UTC+4 and filing it on the UTC day names whoever held
        the car the day BEFORE — a different person who had already handed the
        keys over

   …and then the operator's own rule, which was added after the first five and
   which reorganised two of them:

     6. a journey whose car carries a recent prior Uber trip is named
        LAST_TRIP, and the row states the GAP — because "their trip ended 44
        minutes earlier" and "their trip ended 13 days earlier" are different
        claims and a reader must tell them apart at a glance
     7. a HANDOVER DAY that day-custody could only call `ambiguous` is resolved
        to whoever most recently had the car. This is the change the operator
        asked for and it is the reason the tier exists
     8. `bracketed` still wins where both apply, because a trip on BOTH sides
        is strictly more evidence than a trip on one
     9. a journey whose last Uber trip is BEYOND the measured staleness cap is
        named against NOBODY, says why in the operator's own terms, and returns
        the refused name as CONTEXT under its own key — never as a candidate,
        and never onto that person's driver page
    10. a car with no Uber history, and a car whose Uber history postdates the
        journey, are TWO DIFFERENT ABSENCES and read as two different sentences
    11. two drivers whose Uber trips end at the SAME INSTANT produce TWO
        candidates and no choice — never a coin flip resolved by row order, and
        never a silent fall-back to the weaker day-custody source
    12. one human with several Uber accounts is ONE candidate on the last-trip
        path too, not a tie with himself

   ASSERTIONS 2 AND 5 CHANGED THE SEGMENT THEY RUN AGAINST, and nothing else.
   L45243 on 2026-09-12 and L99001 on 2026-09-05 are both rows the operator's
   rule DELIBERATELY resolves, so the ambiguity assertion moved to L45235 (two
   custodians, only Uber trip 64 days old — genuinely inseparable) and the
   Dubai-day assertion moved to L99002 (a car with no Uber work at all, so
   custody still decides it). The assertions themselves are unchanged in text
   and in force; what they guard could not be shown on a row the new rule
   answers.

   Against a real Postgres through mountAll, because every one of these is SQL
   and no amount of reading it would catch a wrong join or a missing fold.

   Each assertion below was proved by REVERSION, not by passing: the named
   expression in api/unauthorized_sql.js was broken, this file was run and the
   assertion watched to fail, and the expression was restored. The reversion
   that proves each one is written beside it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { TIERS, BRACKET_CAP_MIN, STALE_CAP_MIN, FRESH_BAND_MIN } from '../api/unauthorized_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

const seg = (o) => q(
  `INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, duration_min,
     distance_km, verdict, verdict_reason, low_confidence,
     nearest_platform, nearest_trip_id, nearest_gap_min)
   VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,$6,$7,$8,false,$9,$10,$11)`,
  [o.plate, o.from, o.to, o.fleet || 'ecosine', o.min ?? 30, o.km ?? 12,
    o.verdict || 'unauthorized', o.reason || 'no completed booking overlaps this window',
    o.nearPlatform || null, o.nearTrip || null, o.nearGap ?? null]);

const custody = (o) => q(
  `INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
     fleet_id, trips, is_primary)
   VALUES ($1,$2::date,$3,$4,$5,'ecosine',$6,$7)`,
  [o.plate, o.day, o.id, o.platform || 'uber', o.name, o.trips ?? 3, !!o.primary]);

/* Roster state, for the one edge case that must NOT become a gate. A leaver is
   exactly the person who might take a car unbooked, so a name is never
   suppressed because the person has since left — it is STATED instead. */
const pstate = (o) => q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, can_earn)
   VALUES ($1,$2,'ecosine',$3,$4,$5)`,
  [o.platform || 'uber', o.id, o.name, o.state, o.canEarn]);

let tripN = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, fleet_id, status)
   VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,'ecosine',$8)`,
  [o.platform || 'uber', o.id || `t${++tripN}`, o.plate, o.driver, o.name,
    o.from, o.to || null, o.status || 'completed']);

/* ══ 1. THE NARROWING CASE, taken from production ═════════════════════════
   L45243 on 2026-08-24: day-custody names TWO people, Waseem and Zain, so the
   shipped endpoint prints both next to one journey that had one driver. Zain's
   Uber trip on that car ends 54 minutes before the window opens and his next
   begins 75 minutes after it closes; Waseem has no trip inside that bracket.
   Time narrows two accused to one. */
await seg({ plate: 'L45243', from: '2026-08-24T05:33:00Z', to: '2026-08-24T05:48:00Z', min: 15, km: 4 });
await custody({ plate: 'L45243', day: '2026-08-24', id: 'u-waseem', name: 'Waseem Abbas Ghulam Nabi', trips: 9, primary: true });
await custody({ plate: 'L45243', day: '2026-08-24', id: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan', trips: 4 });
await trip({ plate: 'L45243', driver: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan',
  from: '2026-08-24T03:15:00Z', to: '2026-08-24T04:39:00Z' });           // ends 54 min before
await trip({ plate: 'L45243', driver: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan',
  from: '2026-08-24T07:03:00Z', to: '2026-08-24T07:40:00Z' });           // begins 75 min after
await trip({ plate: 'L45243', driver: 'u-waseem', name: 'Waseem Abbas Ghulam Nabi',
  from: '2026-08-23T22:00:00Z', to: '2026-08-23T23:10:00Z' });           // nowhere near

/* ══ 2. THE SAME PAIR, THE SAME CAR, A DAY NOTHING BRACKETS ═══════════════
   L45243 on 2026-09-12: both men hold the car and no trip on either side of
   the window is within the cap. Production would "name" Waseem off his
   nineteen-hour trip span; a span that wide contains almost everything and is
   not an observation, which is why span-custody is not in this build. */
await seg({ plate: 'L45243', from: '2026-09-12T12:27:00Z', to: '2026-09-12T13:08:00Z', min: 41, km: 22 });
await custody({ plate: 'L45243', day: '2026-09-12', id: 'u-waseem', name: 'Waseem Abbas Ghulam Nabi', trips: 11, primary: true });
await custody({ plate: 'L45243', day: '2026-09-12', id: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan', trips: 2 });
await trip({ plate: 'L45243', driver: 'u-waseem', name: 'Waseem Abbas Ghulam Nabi',
  from: '2026-09-11T23:23:00Z', to: '2026-09-12T00:40:00Z' });           // 707 min before — far outside the cap
await trip({ plate: 'L45243', driver: 'u-waseem', name: 'Waseem Abbas Ghulam Nabi',
  from: '2026-09-12T18:26:00Z', to: '2026-09-12T19:00:00Z' });           // 318 min after — also outside

/* ══ 3. A CAR WITH NO BOOKING IDENTITY AT ALL ════════════════════════════
   L82907 on production carries twelve flagged segments across seven days and
   exactly ONE booking in 108 days. There is a seat sensor and a GPS trace and
   nothing that names a human. */
await seg({ plate: 'L82907', from: '2026-09-11T19:28:00Z', to: '2026-09-11T19:38:00Z', min: 10, km: 6,
  /* The reconciler's own nearest-booking pointer, which it fills on 106 of
     production's 120 unauthorized segments. Here it points four weeks away —
     the shape L82907 really is, one booking in 108 days — so the row carries a
     NAME while the ladder can reach nobody. That is the row where the
     temptation to print it as an answer lives. */
  nearPlatform: 'hotel', nearTrip: 'h-far-1', nearGap: -42010 });
/* …and the one booking it DOES have, four weeks earlier, exactly as production
   has it. This is what makes the assertion below a real one rather than a
   vacuous one: there IS a name available for this car, it is simply not a name
   about this day, and "the car's usual driver" is the fallback that would
   reach for it. */
await custody({ plate: 'L82907', day: '2026-08-13', id: 'h-usual', platform: 'hotel',
  name: 'The Car’s Usual Driver', trips: 1, primary: true });
await trip({ platform: 'hotel', id: 'h-far-1', plate: 'L82907', driver: 'h-usual',
  name: 'The Car’s Usual Driver',
  from: '2026-08-13T08:00:00Z', to: '2026-08-13T08:40:00Z' });

/* ══ 4. ONE HUMAN, TWO PLATFORM ACCOUNTS, TWO SPELLINGS ══════════════════
   The production shape verbatim: a case difference and a doubled space, one
   Uber account and one Yango account, one man. */
await seg({ plate: 'L76092', from: '2026-09-16T02:38:00Z', to: '2026-09-16T03:28:00Z', min: 50, km: 50 });
await custody({ plate: 'L76092', day: '2026-09-16', id: 'u-umair', platform: 'uber', name: 'Umair Khan Shah', trips: 7, primary: true });
await custody({ plate: 'L76092', day: '2026-09-16', id: 'y-umair', platform: 'yango', name: 'UMAIR  KHAN SHAH', trips: 2 });
await trip({ plate: 'L76092', driver: 'u-umair', name: 'Umair Khan Shah',
  from: '2026-09-15T10:00:00Z', to: '2026-09-15T10:40:00Z' });
await trip({ platform: 'yango', plate: 'L76092', driver: 'y-umair', name: 'UMAIR  KHAN SHAH',
  from: '2026-09-15T14:00:00Z', to: '2026-09-15T14:30:00Z' });

/* ══ 5. 22:30 UTC IS THE NEXT DAY IN DUBAI ═══════════════════════════════
   Two custodians, one on each side of Dubai midnight, so a UTC-day fold does
   not merely mislabel the row — it names a different person. */
await seg({ plate: 'L99001', from: '2026-09-05T22:30:00Z', to: '2026-09-05T22:55:00Z', min: 25, km: 9 });
await custody({ plate: 'L99001', day: '2026-09-05', id: 'u-day', name: 'Daytime Custodian', trips: 8, primary: true });
await custody({ plate: 'L99001', day: '2026-09-06', id: 'u-night', name: 'Night Custodian', trips: 5, primary: true });
await trip({ plate: 'L99001', driver: 'u-day', name: 'Daytime Custodian', from: '2026-09-05T09:00:00Z', to: '2026-09-05T09:40:00Z' });
await trip({ plate: 'L99001', driver: 'u-night', name: 'Night Custodian', from: '2026-09-06T06:00:00Z', to: '2026-09-06T06:40:00Z' });

/* ══ 6. A TRACKER WHOSE CLOCK IS TWO DAYS OUT ════════════════════════════
   api/segment_routes.js's own header records this: "thirteen accusations each
   showing a nearest booking exactly 240 minutes away is one bug, not thirteen
   dishonest drivers". Production carries 37 segments whose verdict_reason says
   the telemetry clock is minutes-to-days behind wall time. Those timestamps
   cannot be compared against a booking clock at all — so this segment is given
   a PERFECT bracket, one custodian, and a skew, and the bracket must not fire. */
await seg({ plate: 'L77777', from: '2026-09-08T06:00:00Z', to: '2026-09-08T06:30:00Z', min: 30, km: 14,
  reason: 'no completed booking overlaps; telemetry clock is 2339 min behind wall time' });
await custody({ plate: 'L77777', day: '2026-09-08', id: 'u-skew', name: 'Skewed Tracker Driver', trips: 6, primary: true });
await trip({ plate: 'L77777', driver: 'u-skew', name: 'Skewed Tracker Driver',
  from: '2026-09-08T04:30:00Z', to: '2026-09-08T05:30:00Z' });           // ends 30 min before
await trip({ plate: 'L77777', driver: 'u-skew', name: 'Skewed Tracker Driver',
  from: '2026-09-08T07:00:00Z', to: '2026-09-08T07:40:00Z' });           // begins 30 min after


/* ══════════════════════════════════════════════════════════════════════════
   THE OPERATOR'S RULE. Fixtures 7-14.

   "usually one person drives per car. so we will take the last trip custodian
    for that specific vehicle. whoever did the last trip on uber is the one
    responsible."

   Everything below exists because that rule has to be applied FAITHFULLY and
   described TRUTHFULLY at the same time, and those two pull in opposite
   directions on exactly the rows where it is weakest.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══ 7. GENUINELY AMBIGUOUS, UNDER BOTH RULES ════════════════════════════
   Two custodians on the Dubai day and the car's only Uber trip is 64 days
   old — past STALE_CAP_MIN, so the operator's rule reaches nobody either and
   the row stays ambiguous with both names. This is where the assertions that
   used to run against L45243 on 2026-09-12 now live: that segment is one the
   operator's rule DELIBERATELY resolves, so an ambiguity fixture had to be one
   the rule genuinely cannot separate. The assertions themselves are unchanged.

   The 64-day trip is by a THIRD person, so the over-cap context name and the
   two candidates cannot be confused with one another. */
await seg({ plate: 'L45235', from: '2026-09-03T09:10:00Z', to: '2026-09-03T09:40:00Z', min: 30, km: 18 });
await custody({ plate: 'L45235', day: '2026-09-03', id: 'u-waseem', name: 'Waseem Abbas Ghulam Nabi', trips: 11, primary: true });
await custody({ plate: 'L45235', day: '2026-09-03', id: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan', trips: 2 });
await trip({ plate: 'L45235', driver: 'u-relief', name: 'Relief Driver Long Gone',
  from: '2026-07-01T05:00:00Z', to: '2026-07-01T06:00:00Z' });          // 64 days — far past the cap

/* ══ 8. THE HANDOVER DAY THE OPERATOR'S RULE IS FOR ══════════════════════
   The production shape of L45243 on 2026-09-03 verbatim: day-custody names two
   people, so /api/unauthorized/list prints both and one of the two is being
   implicated for a journey he did not make. One of them finished an Uber trip
   on this car 44 minutes before the journey opened; the other's last was two
   days earlier. Nothing brackets — there is no trip on the far side — so the
   old ladder could only say "ambiguous, two names". The operator's rule picks
   the person who most recently had the car, which is the correct answer on a
   handover day and is the single largest reason this tier exists.

   Sami also carries a roster row saying his Uber account cannot take work, to
   prove the leaver case is STATED and never used as a gate. */
await seg({ plate: 'L44305', from: '2026-09-03T08:28:00Z', to: '2026-09-03T09:58:00Z', min: 90, km: 66 });
await custody({ plate: 'L44305', day: '2026-09-03', id: 'u-hamid', name: 'Hamid Raza Sultan', trips: 7, primary: true });
await custody({ plate: 'L44305', day: '2026-09-03', id: 'u-sami', name: 'Sami Ullah Noor', trips: 3 });
await trip({ plate: 'L44305', driver: 'u-sami', name: 'Sami Ullah Noor',
  from: '2026-09-03T06:50:00Z', to: '2026-09-03T07:44:00Z' });          // ends 44 min before
await trip({ plate: 'L44305', driver: 'u-hamid', name: 'Hamid Raza Sultan',
  from: '2026-09-01T09:00:00Z', to: '2026-09-01T10:00:00Z' });          // two days earlier
await pstate({ id: 'u-sami', name: 'Sami Ullah Noor', state: 'deactivated', canEarn: false });

/* ══ 9. THE LAST TRIP IS TEN MONTHS OLD ══════════════════════════════════
   L63970 on production: the journey is 2026-08-31 and the most recent Uber
   trip on that plate ended 2025-10-31 — 304 days, the worst case in the
   measured set. The car has run hotel and Bolt work all year. Three
   independent signals say the name is worthless (the staleness, the roster
   state, and a contradiction with day-custody), and the rule must therefore
   name NOBODY while still saying whose trip it refused and how old it was. */
await seg({ plate: 'L63970', from: '2026-08-31T03:14:00Z', to: '2026-08-31T03:35:00Z', min: 21, km: 7 });
await trip({ plate: 'L63970', driver: 'u-zahid', name: 'Zahid Ullah Afsar Zada',
  from: '2025-10-31T00:50:00Z', to: '2025-10-31T01:50:00Z' });          // 304 days before

/* ══ 10. THE CAR'S UBER HISTORY POSTDATES THE JOURNEY ════════════════════
   A different absence from fixture 9 and from fixture 3, and it must read as a
   different sentence. Measured on production this case is 0 of 120 over a
   lookback to 2025-10-01 — and it was 1 of 120 under a lookback bounded at
   2026-06-01, i.e. it is almost always an artefact of how far back the QUERY
   looked rather than a fact about the car. That is exactly why it gets its own
   sentence: printed as "this car has no Uber history" it would be a false
   statement about the vehicle caused by a bound in the SQL. */
await seg({ plate: 'L74169', from: '2026-08-21T09:13:00Z', to: '2026-08-21T10:13:00Z', min: 60, km: 34 });
await trip({ plate: 'L74169', driver: 'u-asif', name: 'Muhammad Asif Zada',
  from: '2026-09-02T12:00:00Z', to: '2026-09-02T12:40:00Z' });          // AFTER the journey

/* ══ 11. TWO DRIVERS' UBER TRIPS END AT THE SAME INSTANT ═════════════════
   Measured: 0 occurrences across 21,961 distinct (plate, Uber ended_at)
   instants on the flagged plates, so this fixture is synthetic — and it has to
   exist anyway, because a tie resolved by whichever row the planner returned
   first is a coin flip that reads to an operator as a finding. This file's
   subject is a wrong NAME, and a randomly chosen one is the worst kind.

   A third person holds the car that day, and the tie must NOT fall back to
   her: day-custody is the weaker source and letting it decide here would
   silently overrule the operator's rule with a worse answer. */
await seg({ plate: 'L11111', from: '2026-09-07T05:00:00Z', to: '2026-09-07T05:30:00Z', min: 30, km: 11 });
await custody({ plate: 'L11111', day: '2026-09-07', id: 'u-third', name: 'Aaaa Day Custodian', trips: 4, primary: true });
await trip({ plate: 'L11111', driver: 'u-tie-b', name: 'Bilal Tie Bravo',
  from: '2026-09-07T03:10:00Z', to: '2026-09-07T04:00:12Z' });
await trip({ plate: 'L11111', driver: 'u-tie-a', name: 'Adnan Tie Alpha',
  from: '2026-09-07T03:20:00Z', to: '2026-09-07T04:00:12Z' });

/* ══ 12. ONE MAN, TWO UBER ACCOUNTS, BOTH LAST TRIPS AT ONE INSTANT ══════
   The same production shape as fixture 4 — a case difference and a doubled
   space — but on the LAST-TRIP path rather than the custody path, because the
   two folds are separate expressions and a fold that is right in `cust` is not
   thereby right in `last_ppl`. Unfolded this is a tie and the journey comes
   back ambiguous with one man listed twice beside an accusation. */
await seg({ plate: 'L22222', from: '2026-09-08T11:00:00Z', to: '2026-09-08T11:25:00Z', min: 25, km: 13 });
await trip({ plate: 'L22222', driver: 'u-rana', name: 'Rana Jahanzaib Akbar',
  from: '2026-09-08T09:10:00Z', to: '2026-09-08T10:00:00Z' });
await trip({ plate: 'L22222', driver: 'u-rana-2', name: 'RANA  JAHANZAIB AKBAR',
  from: '2026-09-08T09:20:00Z', to: '2026-09-08T10:00:00Z' });

/* ══ 13. THE DUBAI DAY, ON A ROW CUSTODY STILL DECIDES ═══════════════════
   Fixture 5's twin. 22:30 UTC is 02:30 the NEXT day in Dubai and two
   custodians sit either side of that midnight, so a UTC fold does not merely
   mislabel the row — it names a different person who had already handed the
   keys over. This car has no Uber work at all, so the operator's rule is
   silent and the row is decided by custody, which is what makes it the place
   the SEG_DAY assertion belongs now. */
await seg({ plate: 'L99002', from: '2026-09-05T22:30:00Z', to: '2026-09-05T22:55:00Z', min: 25, km: 9 });
await custody({ plate: 'L99002', day: '2026-09-05', id: 'u-day2', name: 'Daytime Custodian Two', trips: 8, primary: true });
await custody({ plate: 'L99002', day: '2026-09-06', id: 'u-night2', name: 'Night Custodian Two', trips: 5, primary: true });
await trip({ platform: 'hotel', plate: 'L99002', driver: 'h-corp', name: 'Hotel Channel Driver',
  from: '2026-09-04T08:00:00Z', to: '2026-09-04T08:40:00Z' });

/* ══ 14. A NAME NOTHING ELSE COULD REACH, OFF A THIRTEEN-DAY-OLD TRIP ════
   No custody record at all, so the old ladder says `unknown` and offers
   nothing — 33 of production's 120 journeys are in this state and this is the
   single largest source of the coverage the operator's rule buys. The trip is
   13 days old: inside the 31,631-minute cap and well past the 1,494-minute
   p98 band, so the sentence must lead with the AGE rather than the name. */
await seg({ plate: 'L64009', from: '2026-09-01T06:08:00Z', to: '2026-09-01T06:24:00Z', min: 16, km: 4 });
await trip({ plate: 'L64009', driver: 'u-jahan', name: 'Rana Jahanzaib Quiet Spell',
  from: '2026-08-19T05:10:00Z', to: '2026-08-19T06:08:00Z' });          // 13 days before

/* ══════════════════════════════════════════════════════════════════════════
   THE ACCUSATION-HONESTY FIXTURES. 15-22.

   Every one of these is a shape where the module NAMED somebody, or DENIED a
   trip it had itself found, or claimed a population was exhaustive when it was
   not. They are seeded last so that the fixtures above keep the tier
   distribution they were written against.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══ 15. A TEXTBOOK BRACKET, BROKEN BY A HOTEL BOOKING IN THE GAP ════════
   The exclusion clause is what turns a bracket from coincidence into evidence,
   and it used to run over `near` — Uber only, id required. So another person's
   hotel booking inside the gap was invisible to it, the bracket fired, and the
   page printed the strongest claim this product makes against somebody who was
   demonstrably not in the car. The hotel channel is documented in
   src/custody.js as naming a driver on every booking without always carrying
   an id, which is why this fixture's intruder has no driver_ext_id. */
await seg({ plate: 'L44306', from: '2026-09-09T05:33:00Z', to: '2026-09-09T05:53:00Z', min: 20, km: 8 });
await custody({ plate: 'L44306', day: '2026-09-09', id: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan', trips: 5, primary: true });
await custody({ plate: 'L44306', day: '2026-09-09', id: 'h-kashif', platform: 'hotel', name: 'Kashif Ali Muhammad Ali', trips: 2 });
await trip({ plate: 'L44306', driver: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan',
  from: '2026-09-09T03:40:00Z', to: '2026-09-09T04:39:00Z' });            // ends 54 min before
await trip({ plate: 'L44306', driver: 'u-zain', name: 'Zain Hassan Raja Nasrullah Khan',
  from: '2026-09-09T07:08:00Z', to: '2026-09-09T07:48:00Z' });            // begins 75 min after
/* The intruder: a hotel booking inside the gap, naming a driver and carrying
   NO account number. Invisible to the old exclusion in two separate ways. */
await trip({ platform: 'hotel', id: 'h-intruder', plate: 'L44306', driver: null,
  name: 'Kashif Ali Muhammad Ali', from: '2026-09-09T05:00:00Z', to: '2026-09-09T05:20:00Z' });

/* ══ 16. HALF A BRACKET — A TRIP BEFORE AND NOTHING AFTER ════════════════
   The `sole_custodian` sentence used to deny both sides in a fixed string.
   Here one side genuinely exists, forty minutes away, and a reader who opens
   the car's trip list to check finds it. */
await seg({ plate: 'L55501', from: '2026-09-10T08:00:00Z', to: '2026-09-10T08:30:00Z', min: 30, km: 10 });
await custody({ plate: 'L55501', day: '2026-09-10', id: 'u-half', name: 'Halfbracket Only Custodian', trips: 4, primary: true });
/* A CANCELLED ride is the only thing after the window, and the bracket must
   not use it: the reconciler refuses to match on it, so an attribution built
   out of it would quote a trip that did not happen as a measurement. It is
   also the only Uber row this plate has after the journey, so if it were
   admitted the row would read `bracketed` instead. */
await trip({ plate: 'L55501', driver: 'u-half', name: 'Halfbracket Only Custodian',
  from: '2026-09-10T06:30:00Z', to: '2026-09-10T07:20:00Z' });            // ends 40 min before
await trip({ plate: 'L55501', driver: 'u-half', name: 'Halfbracket Only Custodian',
  id: 'cancelled-after', status: 'rider_cancelled',
  from: '2026-09-10T09:10:00Z', to: null });                              // never happened

/* ══ 17. THE HANDOVER: TRIPS EITHER SIDE, DIFFERENT PEOPLE ══════════════
   The shape the whole feature exists for, and the shape the old sentence was
   worst on: A's trip ends 30 minutes before the window and B's begins 20
   minutes after it, so nobody brackets, the tier falls to `ambiguous`, and the
   sentence denied the exact two bookings that are the strongest available
   evidence that the car changed hands DURING the journey. */
await seg({ plate: 'L55502', from: '2026-09-11T08:00:00Z', to: '2026-09-11T08:30:00Z', min: 30, km: 14 });
await custody({ plate: 'L55502', day: '2026-09-11', id: 'u-hand-a', name: 'Aamir Handover Alpha', trips: 6, primary: true });
await custody({ plate: 'L55502', day: '2026-09-11', id: 'u-hand-b', name: 'Bashir Handover Bravo', trips: 4 });
await trip({ plate: 'L55502', driver: 'u-hand-a', name: 'Aamir Handover Alpha',
  from: '2026-09-11T06:40:00Z', to: '2026-09-11T07:30:00Z' });            // A ends 30 min before
await trip({ plate: 'L55502', driver: 'u-hand-b', name: 'Bashir Handover Bravo',
  from: '2026-09-11T08:50:00Z', to: '2026-09-11T09:30:00Z' });            // B begins 20 min after

/* ══ 18. A NEIGHBOUR'S CLOCK CONFESSION, ON A ROW THAT CARRIES NONE ═════
   src/reconcile.js writes "N min behind" ONLY on its clockSuspect branch,
   which sets verdict='unverifiable' — never 'unauthorized'. So reading the
   skew off an unauthorized row's own verdict_reason could never fire on the
   population this endpoint serves, and the guard was a no-op on every row it
   was asked about. Here the plate confesses on a DIFFERENT segment, two days
   away, exactly as a real tracker would; the unauthorized row beside it has a
   textbook bracket and must not use it. */
await seg({ plate: 'L88881', from: '2026-09-04T06:00:00Z', to: '2026-09-04T06:20:00Z', min: 20, km: 9,
  verdict: 'unverifiable',
  reason: 'telemetry clock is 247 min behind wall time — bookings cannot be matched reliably' });
await seg({ plate: 'L88881', from: '2026-09-06T06:00:00Z', to: '2026-09-06T06:30:00Z', min: 30, km: 15,
  reason: 'no completed booking overlaps; nearest is a uber trip 240 min away' });
await custody({ plate: 'L88881', day: '2026-09-06', id: 'u-neigh', name: 'Neighbour Skew Custodian', trips: 5, primary: true });
await trip({ plate: 'L88881', driver: 'u-neigh', name: 'Neighbour Skew Custodian',
  from: '2026-09-06T04:30:00Z', to: '2026-09-06T05:30:00Z' });            // ends 30 min before
await trip({ plate: 'L88881', driver: 'u-neigh', name: 'Neighbour Skew Custodian',
  from: '2026-09-06T07:00:00Z', to: '2026-09-06T07:40:00Z' });            // begins 30 min after

/* ══ 19. A JOURNEY THAT CROSSES DUBAI MIDNIGHT ══════════════════════════
   19:50 UTC is 23:50 in Dubai and the journey closes at 00:40 the next day.
   Custody was read at the START day only, so only Wisal was in the frame, the
   count came back 1, and the row printed "there is nobody else it could have
   been" about a car whose keys changed inside the window. This car has no Uber
   work at all, so the operator's rule is silent and custody decides the row —
   which is what makes it the place the assertion belongs. */
await seg({ plate: 'L99003', from: '2026-08-24T19:50:00Z', to: '2026-08-24T20:40:00Z', min: 50, km: 21 });
await custody({ plate: 'L99003', day: '2026-08-24', id: 'u-wisal', name: 'Wisal Muhammad Irshah Muhammad', trips: 7, primary: true });
await custody({ plate: 'L99003', day: '2026-08-25', id: 'u-shehzad', name: 'Shehzad Ahmad Ghulam Muhammad', trips: 6, primary: true });
await trip({ platform: 'hotel', plate: 'L99003', driver: 'h-corp2', name: 'Hotel Channel Driver Two',
  from: '2026-08-20T08:00:00Z', to: '2026-08-20T08:40:00Z' });

/* ══ 20. ONE NAMED CUSTODIAN PLUS A CUSTODY RECORD WITH NO NAME ═════════
   sql/schema_v19.sql admits a custody row carrying an id and no name. The name
   filter ran BEFORE the count, so the unnamed record was silently removed from
   the population the sentence then claimed to be exhaustive: "there is nobody
   else it could have been", about a day there demonstrably was somebody else
   on. A blank-named row is the same defect wearing an empty string. */
await seg({ plate: 'L44251', from: '2026-09-02T07:00:00Z', to: '2026-09-02T07:25:00Z', min: 25, km: 11 });
await custody({ plate: 'L44251', day: '2026-09-02', id: 'u-kashif2', name: 'Kashif Ali Muhammad Ali', trips: 6, primary: true });
await custody({ plate: 'L44251', day: '2026-09-02', id: 'y-7781', platform: 'yango', name: null, trips: 2 });
await custody({ plate: 'L44251', day: '2026-09-02', id: 'y-7782', platform: 'yango', name: '', trips: 1 });

/* ══ 21. AN UBER ROW WITH AN ACCOUNT AND NO NAME ════════════════════════
   `near` required a non-blank driver_ext_id and NOT a non-blank driver_name,
   although trip.driver_name is nullable and nearestJoin() guards exactly this.
   Two such rows either side of a window produced tier='bracketed' with
   candidates=[{"name":null,…}] and the sentence "Named by time: ." — Postgres
   format() renders a NULL argument as an empty string rather than failing, so
   the defect was silent and the page printed a nameless accusation under a
   tier pill. There is a named custodian on the day, so the honest answer here
   is that custodian, by custody, and never a bracket around nobody. */
await seg({ plate: 'L55503', from: '2026-09-13T07:00:00Z', to: '2026-09-13T07:30:00Z', min: 30, km: 12 });
await custody({ plate: 'L55503', day: '2026-09-13', id: 'u-named', name: 'Properly Named Custodian', trips: 5, primary: true });
await trip({ plate: 'L55503', driver: 'u-9f2ab', name: null,
  from: '2026-09-13T05:20:00Z', to: '2026-09-13T06:06:00Z' });            // ends 54 min before
await trip({ plate: 'L55503', driver: 'u-9f2ab', name: null,
  from: '2026-09-13T08:45:00Z', to: '2026-09-13T09:20:00Z' });            // begins 75 min after

/* ══ 22. THE INTERVENING TRIP THAT STARTED BEFORE THE BRACKET'S LEFT EDGE
   The exclusion tested only the REQUEST instant of the other booking, so a
   trip requested 10:55 and ending 11:40 did not break a bracket whose left
   edge is 11:00 — a bracket is an interval claim and the exclusion was a point
   test against one end of the other interval. B's own booking record puts B in
   that car until twenty minutes before the journey started and B was not even
   offered as a candidate. */
await seg({ plate: 'L55504', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:20:00Z', min: 20, km: 7 });
await custody({ plate: 'L55504', day: '2026-09-14', id: 'u-ovl-a', name: 'Aadil Overlap Alpha', trips: 6, primary: true });
await custody({ plate: 'L55504', day: '2026-09-14', id: 'u-ovl-b', name: 'Basit Overlap Bravo', trips: 3 });
await trip({ plate: 'L55504', driver: 'u-ovl-a', name: 'Aadil Overlap Alpha',
  from: '2026-09-14T06:10:00Z', to: '2026-09-14T07:00:00Z' });            // A ends 60 min before
await trip({ plate: 'L55504', driver: 'u-ovl-b', name: 'Basit Overlap Bravo',
  from: '2026-09-14T06:55:00Z', to: '2026-09-14T07:40:00Z' });            // B requested BEFORE A ends
await trip({ plate: 'L55504', driver: 'u-ovl-a', name: 'Aadil Overlap Alpha',
  from: '2026-09-14T09:00:00Z', to: '2026-09-14T09:40:00Z' });            // A resumes 40 min after

/* ══ 23. A NAME WITH A DUPLICATED ADJACENT WORD AND NO ACCOUNT NUMBER ═══
   personKeysForDriver compared trip.person_key — the fold that COLLAPSES
   repeated adjacent words — against keys built by driver_routes.js from the
   PLAIN fold, which does not. Two different folds compared for equality. A
   hotel driver filed as 'Sajid Gul Gul Muhammad' with no account number was
   therefore unreachable: the Unauthorized tab came back empty for a person the
   fleet page lists by name as a candidate on their own car, beside a fully
   populated Trips tab. */
await seg({ plate: 'L55505', from: '2026-09-15T07:00:00Z', to: '2026-09-15T07:30:00Z', min: 30, km: 13 });
/* driver_ext_id is NOT NULL on vehicle_driver_day, so a channel that names a
   driver without numbering them lands as the empty string — which is exactly
   what personKeyStored's nullif() is there to fall through. */
await custody({ plate: 'L55505', day: '2026-09-15', id: '', platform: 'hotel',
  name: 'Sajid Gul Gul Muhammad', trips: 4, primary: true });
await trip({ platform: 'hotel', plate: 'L55505', driver: null, name: 'Sajid Gul Gul Muhammad',
  from: '2026-09-15T04:00:00Z', to: '2026-09-15T04:40:00Z' });

/* ══════════════════════════════════════════════════════════════════════════
   THE ADVERSARIAL-AUDIT FIXTURES. 25-36.

   Two adversarial lenses read the last-trip rule after it shipped and found
   twelve places where the SQL and the sentence beside it disagreed — a comment
   claiming a guard the query did not have, a cap quoted as the reason on a row
   where the cap was never asked, a measurement quoted on the one kind of row
   that falsifies it. Every one of them is seeded here as the smallest shape
   that reproduces it, because the failure mode of this module is a wrong NAME
   or a wrong REASON, and both are invisible to a green suite that never seeds
   the shape.

   They are seeded last, after the honesty fixtures, so the fixtures above keep
   the rows they were written against.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══ 25. A RIDE THE DRIVER REJECTED IS NOT A TRIP THEY FINISHED ══════════
   last_near's comment argued for nine lines that it was "completed only, as
   the bracket is" and the SQL substituted 't.ended_at IS NOT NULL' — the exact
   proxy COMPLETED()'s own header records as unsafe, safe on the bracket's
   `arrived` side only by accident. A driver_rejected row carrying an end time
   therefore named a man responsible for a journey and printed his rejection as
   a trip he finished. */
await seg({ plate: 'L33301', from: '2026-09-03T08:00:00Z', to: '2026-09-03T08:30:00Z', min: 30, km: 9 });
await trip({ plate: 'L33301', driver: 'u-rej', name: 'Rejected The Ride',
  from: '2026-09-03T07:00:00Z', to: '2026-09-03T07:30:00Z', status: 'driver_rejected' });

/* ══ 26. …AND THE SAME GUARD ON THE CONTEXT NAME ═════════════════════════
   The `ever` CTE, which supplies the name a refused row still reports, had the
   same missing guard. A cancelled ride carrying an end time would be printed
   as "last Uber driver of record" — a name an operator rings round about, read
   off a ride that never happened. Two trips here: a genuinely completed one
   ten months back, and a MORE RECENT cancelled one. The context name must be
   the completed one. */
await seg({ plate: 'L33302', from: '2026-08-31T04:00:00Z', to: '2026-08-31T04:30:00Z', min: 30, km: 10 });
await trip({ plate: 'L33302', driver: 'u-realend', name: 'Really Finished It',
  from: '2025-10-31T00:50:00Z', to: '2025-10-31T01:50:00Z' });
await trip({ plate: 'L33302', driver: 'u-fakeend', name: 'Cancelled With An End',
  from: '2026-08-01T09:00:00Z', to: '2026-08-01T09:40:00Z', status: 'client_cancelled' });

/* ══ 27. A FRESH TRIP WITH NO REQUEST TIME IS STILL THE LAST TRIP ════════
   trip.requested_at is NULLABLE (sql/schema.sql:55) and src/sources/uber.js:192
   writes NULL whenever Uber's CSV omits 'Trip request time'. last_near bounded
   BOTH ends on requested_at, so a NULL made both predicates NULL and dropped
   the row — while `ever`, which had no requested_at predicate, kept it. The
   two CTEs disagreed about one trip and the product then said the trail was
   too old about a trip forty-four minutes old. This is the operator's own
   shape: the exact row they asked the rule to return. */
await seg({ plate: 'L33303', from: '2026-09-03T08:28:00Z', to: '2026-09-03T09:00:00Z', min: 32, km: 14 });
await trip({ plate: 'L33303', driver: 'u-noreq', name: 'No Request Time',
  from: null, to: '2026-09-03T07:44:00Z' });
await trip({ plate: 'L33303', driver: 'u-noreq', name: 'No Request Time',
  from: '2026-08-01T05:00:00Z', to: '2026-08-01T05:30:00Z' });

/* ══ 28. …AND hist COUNTS IT, SO NO SENTENCE PRINTS A BARE FULL STOP ════
   hist.uber_prior tested requested_at alone and hist.uber_first_at was
   min(requested_at), so a plate whose ONLY Uber row has no request time
   reported "no prior Uber trips" and rendered a NULL date through to_char() —
   which format() prints as an EMPTY STRING rather than failing. The row read
   "the first Uber trip on this car was ." about a trip 44 minutes before the
   journey. */
await seg({ plate: 'L33304', from: '2026-09-03T08:28:00Z', to: '2026-09-03T09:00:00Z', min: 32, km: 14 });
await trip({ plate: 'L33304', driver: 'u-onlynoreq', name: 'Only Trip No Request Time',
  from: null, to: '2026-09-03T07:44:00Z' });

/* ══ 29. A CONTRADICTING BOOKING FIVE DAYS OUT, NOT SIX HOURS ═══════════
   The disclosure that somebody ELSE had the car on another channel after the
   trip the rule read was evaluated over the bracket's exclusion set, whose
   floor is about twenty hours before the journey. The cap lets the rule reach
   back 21.97 days, so the probe was 26x narrower than the claim it qualifies
   and on the whole above-p98 band the contradiction was structurally
   invisible. The Uber trip here is 13 days old and the hotel booking that
   contradicts it is 5 days old — well outside the old window, well inside the
   rule's own reach. */
await seg({ plate: 'L33305', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:40:00Z', min: 40, km: 19 });
await trip({ plate: 'L33305', driver: 'u-oldish', name: 'Thirteen Days Back',
  from: '2026-09-01T07:00:00Z', to: '2026-09-01T08:00:00Z' });
await trip({ platform: 'hotel', plate: 'L33305', driver: 'h-fivedays', name: 'Five Days Back Hotel',
  from: '2026-09-09T07:00:00Z', to: '2026-09-09T08:00:00Z' });

/* ══ 30. A BROKEN CLOCK IS NOT AN OLD TRAIL ═════════════════════════════
   The responsible-person column had ONE absence phrase, gated on a condition
   testing neither the cap nor the clock, so a segment whose tracker is 2,339
   minutes out of true printed "Nobody — the trail is too old." beside an
   evidence sentence correctly blaming the tracker. Two different reasons for
   one absence on one row, and the one a page prints is not the one the row's
   own evidence gives — a reader acting on the column concludes the car left
   the Uber channel when the finding is a broken tracker that needs fixing. */
await seg({ plate: 'L33306', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:40:00Z', min: 40, km: 17,
  reason: 'no completed booking overlaps; telemetry clock is 2339 min behind wall time' });
await trip({ plate: 'L33306', driver: 'u-skewold', name: 'Long Before The Skew',
  from: '2026-01-01T07:00:00Z', to: '2026-01-01T08:00:00Z' });

/* ══ 31. THE CONTEXT NAME TIES TOO, AND A TIE IS NOT A NAME ═════════════
   `ever` resolved the refused name with ORDER BY ended_at DESC LIMIT 1 — the
   planner's row order deciding which of two human beings gets printed as "last
   Uber driver of record". This module builds an entire tie branch for the
   last-trip tier on the principle that a tie broken at random is an accusation
   chosen at random, and then reintroduced the trap two CTEs later on a field
   that also prints a name. */
await seg({ plate: 'L33307', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:40:00Z', min: 40, km: 12 });
await trip({ plate: 'L33307', driver: 'u-ct-a', name: 'Aaron Context Tie',
  from: '2026-01-01T07:00:00Z', to: '2026-01-01T08:00:00Z' });
await trip({ plate: 'L33307', driver: 'u-ct-b', name: 'Bashir Context Tie',
  from: '2026-01-01T07:10:00Z', to: '2026-01-01T08:00:00Z' });

/* ══ 32. A LIMIT IN THE QUERY IS NOT A FACT ABOUT THE CAR ═══════════════
   last_near is bounded on requested_at as well as on ended_at, because that is
   the index that exists. A trip INSIDE the cap on its end and outside that
   floor on its request was dropped by last_near, found by `ever`, and reported
   as staleness — producing a clause that contradicts its own two numbers,
   "21.5 days before this journey. That is beyond the 31631-minute cap (21.97
   days)". Needs an Uber row spanning more than eight hours from request to
   end: sampled on six flagged plates the longest is 1.88 h and there are none
   over 8 h, so this is latent on today's data and seeded anyway. */
await seg({ plate: 'L33308', from: '2026-09-03T08:00:00Z', to: '2026-09-03T08:30:00Z', min: 30, km: 11 });
await trip({ plate: 'L33308', driver: 'u-longspan', name: 'Thirty Six Hour Span',
  from: '2026-08-11T08:00:00Z', to: '2026-08-12T20:00:00Z' });

/* ══ 33. TWO CAUSES ARE NOT ONE CAUSE ═══════════════════════════════════
   WHY_NO_LAST tested 'every prior trip is nameless' before 'every prior trip
   is cancelled', and a car carrying BOTH satisfies neither premise — it fell
   through and asserted the cancellation cause, blaming Uber for a gap that is
   in our own ingestion and raising the operator's open cancellation question
   about the wrong car. */
await seg({ plate: 'L33309', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:40:00Z', min: 40, km: 15 });
await trip({ plate: 'L33309', driver: 'u-anon1', name: '',
  from: '2026-09-13T07:00:00Z', to: '2026-09-13T08:00:00Z' });
await trip({ plate: 'L33309', driver: 'u-anon2', name: '',
  from: '2026-09-13T09:00:00Z', to: '2026-09-13T10:00:00Z' });
await trip({ plate: 'L33309', driver: 'u-cancelled-named', name: 'Cancelled And Named',
  from: '2026-09-13T11:00:00Z', to: null, status: 'rider_cancelled' });

/* ══ 34. "FILED AGAINST NOBODY" IS A CLAIM ABOUT THE JOURNEY ════════════
   attribution_last_uber_driver's sentence ended "…and this journey is filed
   against nobody's profile anywhere in the product", and the CASE emitting it
   was not gated on the tier. On a sole_custodian row candidate_keys is
   non-empty, /api/driver/unauthorized matches on it and increments that
   person's "Named beside" tile — so the product asserted the journey was
   attributed to nobody on the same response that files it against a named
   employee. */
await seg({ plate: 'L33310', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:40:00Z', min: 40, km: 21 });
await custody({ plate: 'L33310', day: '2026-09-14', id: 'h-onlyone', platform: 'hotel',
  name: 'Only Custodian Here', trips: 2, primary: true });
await trip({ platform: 'hotel', plate: 'L33310', driver: 'h-onlyone', name: 'Only Custodian Here',
  from: '2026-09-14T04:00:00Z', to: '2026-09-14T05:00:00Z' });
await trip({ plate: 'L33310', driver: 'u-ancient', name: 'Ancient Uber Driver',
  from: '2026-01-01T07:00:00Z', to: '2026-01-01T08:00:00Z' });

/* ══ 35. A COUNTERFACTUAL THE QUERY NEVER EVALUATED ═════════════════════
   The bracketed sentence closed, unconditionally, with "so it is reported as a
   bracket even though the last-trip rule would name the same person". The
   bracket's exclusion is STRICTLY greater than the bracketer's end instant, so
   a second driver ending at the SAME instant does not break the bracket while
   last_ppl returns both — the row told the reader the weaker rule agreed while
   the weaker rule, on that identical before-side data, refuses to answer. */
await seg({ plate: 'L33311', from: '2026-09-03T12:00:00Z', to: '2026-09-03T12:20:00Z', min: 20, km: 8 });
await trip({ plate: 'L33311', driver: 'u-brx', name: 'Bracketer Ecks',
  from: '2026-09-03T10:30:00Z', to: '2026-09-03T11:30:00Z' });
await trip({ plate: 'L33311', driver: 'u-brx', name: 'Bracketer Ecks',
  from: '2026-09-03T12:50:00Z', to: '2026-09-03T13:30:00Z' });
await trip({ plate: 'L33311', driver: 'u-tiy', name: 'Tied Why',
  from: '2026-09-03T10:40:00Z', to: '2026-09-03T11:30:00Z' });

/* ══ 36. A MEASUREMENT QUOTED ON THE ONE ROW THAT FALSIFIES IT ══════════
   The day-custody disagreement clause appended a fixed figure — "Measured over
   120 journeys the two disagree on 2, and both were read off a trip more than
   six months old" — to EVERY disagreement. That figure was measured WITH the
   cap applied and reports ZERO in-cap disagreements, so it could only ever be
   printed on a row that falsifies it. `cust` is scoped to the journey's own
   Dubai day while the rule reaches back 21.97 days, so in-cap disagreements
   are the expected shape of the whole above-p98 band, not an exotic case. */
await seg({ plate: 'L33312', from: '2026-09-14T08:00:00Z', to: '2026-09-14T08:40:00Z', min: 40, km: 16 });
await trip({ plate: 'L33312', driver: 'u-thirteen', name: 'Thirteen Days Ago Driver',
  from: '2026-09-01T07:00:00Z', to: '2026-09-01T08:00:00Z' });
await custody({ plate: 'L33312', day: '2026-09-14', id: 'u-todaycust', name: 'Today Custodian Only',
  trips: 5, primary: true });

/* ══ 37. A NULL REQUEST TIME ON A TRIP TOO OLD TO NAME ANYBODY ══════════
   Fixture 28 proves the rule still ANSWERS a NULL-requested trip, and it does
   so through last_near — which means it never reaches hist at all, and an
   assertion that passes there proves nothing about hist. This is the shape
   that does reach it: the only Uber trip on the car has no request time AND is
   beyond the cap, so the rule reaches nobody and WHY_NO_LAST has to choose
   between "no Uber trip predates this journey" and "the trail is too old".
   With uber_prior counted on requested_at alone the NULL makes it 0, the wrong
   branch fires, and the date is rendered from a NULL uber_first_at as an empty
   string — "the first Uber trip on this car was ." — about a trip that
   predates the journey by ten months. */
await seg({ plate: 'L33313', from: '2026-08-31T04:00:00Z', to: '2026-08-31T04:30:00Z', min: 30, km: 10 });
await trip({ plate: 'L33313', driver: 'u-oldnoreq', name: 'Old And No Request Time',
  from: null, to: '2025-10-31T01:50:00Z' });

/* ══ 38. AN UBER TRIP WITH NO USABLE TIMESTAMP AT ALL ═══════════════════
   The residual of the same defect, and it needs its own sentence rather than
   the no-prior one: a row carrying neither a request time nor an end time
   cannot be placed before or after anything, so uber_first_at is genuinely
   NULL and there is no date to print. The branch is guarded on that rather
   than printing the empty string format() would give it. */
await seg({ plate: 'L33314', from: '2026-08-31T04:00:00Z', to: '2026-08-31T04:30:00Z', min: 30, km: 10 });
await trip({ plate: 'L33314', driver: 'u-notime', name: 'No Times At All',
  from: null, to: null });

const { get, server } = await mountAll(db);
const WIN = 'from=2026-08-01&to=2026-09-30';
const all = await get(`/api/unauthorized/attributed?${WIN}&limit=500`);
const rowAt = (plate, iso) => all.body.rows.find(
  (r) => r.plate === plate && String(r.started_at).slice(0, 16) === iso);

console.log('the fleet list answers, and every row carries a tier and a reason for it');
{
  check('the route answers', all.status === 200, String(all.status));
  check('every segment in the window is attributed to exactly one tier',
    all.body.rows.length === 37
    && all.body.rows.every((r) => TIERS.includes(r.attribution_tier)),
    JSON.stringify(all.body.rows.map((r) => [r.plate, r.attribution_tier])));
  /* A name with no basis beside it is exactly what api/custody_sql.js was
     written to prevent. The tier and the evidence are not decoration: they are
     what makes the name checkable, so a row that has one and not the other is
     a failure whatever the name says. */
  check('no row carries a name without the sentence that justifies it',
    all.body.rows.every((r) => (r.attribution_candidate_count === 0)
      || (r.attribution_evidence && r.attribution_evidence.length > 40)),
    JSON.stringify(all.body.rows.filter((r) => !r.attribution_evidence).map((r) => r.plate)));
  /* The strip that stops the page being read as a list of thieves. */
  check('the distribution of the evidence rides on the response',
    all.body.distribution.segments === 37
    && all.body.distribution.bracketed === 2
    && all.body.distribution.last_trip === 14
    && all.body.distribution.sole_custodian === 6
    && all.body.distribution.ambiguous === 4
    && all.body.distribution.unknown === 11,
    JSON.stringify(all.body.distribution));
  /* The cap is the whole argument for the operator's rule, exactly as
     BRACKET_CAP_MIN is for the bracket, so it has to travel on the response —
     a page that prints a name under this tier must be able to print what the
     name was allowed to rest on. */
  check('the staleness cap and the p98 band travel on the response, as measurements',
    all.body.last_trip.cap_min === STALE_CAP_MIN
    && all.body.last_trip.fresh_band_min === FRESH_BAND_MIN
    && /99.9th percentile/.test(all.body.last_trip.cap_basis || '')
    && /21,942/.test(all.body.last_trip.cap_basis || ''),
    JSON.stringify(all.body.last_trip));
  /* The one figure that would be read as accuracy if it were not labelled. It
     is agreement between two inferences off the same trip table, and the
     thinness at the far end has to travel with it. */
  check('…and the agreement figure says outright that it is not a hit rate',
    /CONSISTENCY between two inferences/.test(all.body.last_trip.not_a_hit_rate || '')
    && /never accuracy/.test(all.body.last_trip.not_a_hit_rate || '')
    && /9 samples/.test(all.body.last_trip.not_a_hit_rate || ''),
    all.body.last_trip.not_a_hit_rate);
  check('the contract note names the operator’s rule and refuses to score it',
    /whoever did the last Uber trip on it is the one responsible/.test(all.body.note)
    && /no figure anywhere on this response is a hit rate/.test(all.body.note),
    all.body.note);
}

console.log('\n1. a journey time can attribute is BRACKETED, with both gaps stated');
{
  const r = rowAt('L45243', '2026-08-24T05:33');
  check('the tier is bracketed', r.attribution_tier === 'bracketed', r.attribution_tier);
  check('and it names exactly one person — the one time picks out, not both custodians',
    r.attribution_candidate_count === 1
    && r.attribution_candidates.length === 1
    && r.attribution_candidates[0].name === 'Zain Hassan Raja Nasrullah Khan',
    JSON.stringify(r.attribution_candidates));
  /* The narrowing itself: day-custody names two and the row still knows it,
     which is what lets a page say "custody named two people, time named one"
     rather than quietly dropping the other. */
  check('while still reporting that TWO people held the car that day',
    r.custodian_count === 2, String(r.custodian_count));
  /* "Bracketed" is not checkable. "Their trip ended 54 minutes before and the
     next began 75 minutes after" is: a reader can open the car's trip list and
     find those two rows. So the gaps are asserted as NUMBERS, not as a word.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change the ladder's
     first branch from `tally.skew IS NULL AND tally.brackets = 1` to
     `tally.brackets = 99`. The tier falls to `ambiguous`, both names come back,
     and all four assertions in this block fail. */
  check('the two gaps are on the row as measured minutes',
    r.bracket_before_min === 54 && r.bracket_after_min === 75,
    `${r.bracket_before_min} / ${r.bracket_after_min}`);
  check('…and the sentence quotes them, so it can be checked against the trip list',
    /ended 54 minutes before/.test(r.attribution_evidence)
    && /began 75 minutes after/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('the sentence also says the cap it worked within',
    r.attribution_evidence.includes(String(BRACKET_CAP_MIN)), r.attribution_evidence);
  /* The exclusion is what makes a bracket evidence rather than coincidence —
     and the sentence has to state the SCOPE of the exclusion, not just its
     existence. It used to read "No other driver has a booking on this car
     between those two" while the NOT EXISTS ran over the Uber-only,
     id-carrying `near` set, so a hotel or Bolt booking inside the gap was
     invisible to the test and the claim was silently platform-scoped while the
     wording was not. The exclusion is now checked across every channel; the
     assertion moved with it, in the same commit, because a test that pins the
     over-broad wording is what locks a false claim in place.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change the
     bracket's `FROM others x` back to `FROM near x`. Fixture 15's hotel
     booking inside the gap stops disqualifying the bracket, that row turns
     `bracketed` and its assertions below fail. */
  check('the exclusion states the channels it actually checked, not just that it ran',
    /No other driver has a booking of ANY kind on this car between those two/
      .test(r.attribution_evidence)
    && /every channel collected/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* BRACKETED OUTRANKS THE OPERATOR'S RULE, and this row is where that is
     decided rather than asserted in a comment. Zain's trip ends 54 minutes
     before the journey — comfortably inside STALE_CAP_MIN — so the last-trip
     rule qualifies here and would name the same man off half the evidence. A
     bracket has a trip on BOTH sides; that is strictly more, so it wins, and
     the two gaps stay on the row.

     (The two tiers can never name DIFFERENT people: any other driver's booking
      between the bracket's two sides disqualifies the bracket, so whoever
      brackets is necessarily the last person to have finished a trip before
      the journey. The ordering therefore decides the LABEL and the evidence
      shown, not the name — which is why this is asserted on the label.)

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, move the
     `WHEN tally.skew IS NULL AND tally.last_people = 1 THEN 'last_trip'` branch
     ABOVE the bracket branch in the `named` ladder. The tier becomes
     `last_trip`, both gaps go null because they are gated on the bracket tier,
     and these two assertions fail while the name stays the same. */
  check('the prior Uber trip is well inside the staleness cap, so last_trip qualifies here',
    54 <= STALE_CAP_MIN && r.attribution_last_trip_gap_min === null,
    String(r.attribution_last_trip_gap_min));
  check('…and the tier is still bracketed, because a trip on both sides is more evidence',
    r.attribution_tier === 'bracketed'
    && /stronger evidence than the operator’s last-trip rule/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n2. a day with nothing to separate the two is AMBIGUOUS, and names both');
{
  /* RETARGETED, AND NOTHING ELSE ABOUT THIS BLOCK CHANGED. It used to run
     against L45243 on 2026-09-12, which the operator's rule now resolves on
     purpose — see block 7. What this block guards is what happens when the
     evidence genuinely cannot separate two people, so it runs against L45235,
     where two custodians hold the car and its only Uber trip is 64 days old:
     past the staleness cap, so the operator's rule reaches nobody either. */
  const r = rowAt('L45235', '2026-09-03T09:10');
  check('the tier is ambiguous', r.attribution_tier === 'ambiguous', r.attribution_tier);
  /* THE ASSERTION THIS WHOLE FILE EXISTS FOR. A "most likely" rule would pick
     Waseem here — more trips, a wider span, the primary custodian flag — and
     it would be wrong half the time and confident every time.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, append `LIMIT 1` to
     the `ELSE (SELECT jsonb_agg(... ) FROM cust)` branch of the candidates
     CASE — i.e. have ambiguity resolve to the first custodian. The tier stays
     `ambiguous` and the list silently becomes one name, and this assertion is
     the only one in the file that fails. */
  check('BOTH people come back, and neither is chosen',
    r.attribution_candidate_count === 2
    && r.attribution_candidates.map((c) => c.name).sort().join(' | ')
       === 'Waseem Abbas Ghulam Nabi | Zain Hassan Raja Nasrullah Khan',
    JSON.stringify(r.attribution_candidates));
  /* Ordering is read as ranking whether or not one is meant, so the order is
     the one thing about an ambiguous list that must not carry information.
     Waseem is the primary custodian with eleven trips to Zain's two; if the
     list were ordered by anything the evidence knows, he would be first. */
  check('…and they are in name order, not in trip-count or primary-custodian order',
    r.attribution_candidates[0].name === 'Waseem Abbas Ghulam Nabi'
    && r.attribution_candidates.map((c) => c.name).join() ===
       r.attribution_candidates.map((c) => c.name).sort().join(),
    JSON.stringify(r.attribution_candidates.map((c) => c.name)));
  check('the sentence names both and says outright that none is chosen',
    /Waseem Abbas Ghulam Nabi, Zain Hassan Raja Nasrullah Khan/.test(r.attribution_evidence)
    && /none is chosen/.test(r.attribution_evidence), r.attribution_evidence);
  /* AND IT SAYS WHAT THE CLOCK ACTUALLY FOUND.
     This plate has exactly one Uber trip in the record and it is 64 days away,
     so both bracket sides are genuinely empty and the old fixed sentence
     happens to be TRUE here. It is asserted here for that reason — this is the
     one shape it was ever true for. The four shapes it was false for are
     fixtures 16-18 below, each of which used to print this same denial over
     trips the query had found. */
  check('and it says WHY time could not separate them — here, that it found nothing',
    new RegExp(`No completed Uber trip on L45235 ends within ${BRACKET_CAP_MIN} minutes before`)
      .test(r.attribution_evidence), r.attribution_evidence);
  /* The one trip that exists on this plate is 64 days away. An uncapped
     bracket would reach across a car that was idle for two months — the
     L45235 shape the bracket cap was measured to stop — and an uncapped
     last-trip rule would name a relief driver who has not touched the car
     since July. */
  check('a trip far outside either cap names nobody and brackets nothing',
    r.bracket_before_min === null && r.bracket_after_min === null
    && r.attribution_last_trip_gap_min === null,
    `${r.bracket_before_min} / ${r.bracket_after_min} / ${r.attribution_last_trip_gap_min}`);
  /* The over-cap name IS returned, because an operator ringing round wants to
     know it exists — under its own key, with its own gap and its own sentence,
     and OUT of the candidate list. Same discipline nearestJoin() applies to
     the reconciler's nearest booking, and for the same reason: an ambiguous or
     unknown row is exactly where a plausible name gets read as an answer.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, add
     `WHEN named.last_people = 0 AND named.ever_gap IS NOT NULL THEN
        (SELECT jsonb_agg(jsonb_build_object('name', name, 'id', id, 'key', pkey)) FROM ever)`
     as the first branch of the candidates CASE. A third name appears beside
     two accused custodians, off a trip from July, and this assertion fails. */
  check('the driver of that 64-day-old trip is context, and is NOT a candidate',
    r.attribution_last_uber_driver
    && r.attribution_last_uber_driver.name === 'Relief Driver Long Gone'
    && /Context, not a candidate/.test(r.attribution_last_uber_driver.means)
    && !JSON.stringify(r.attribution_candidates).includes('Relief Driver')
    && !r.attribution_candidate_keys.includes('relief driver long gone'),
    JSON.stringify([r.attribution_last_uber_driver?.name, r.attribution_candidate_keys]));
  check('…and the sentence says which rule went silent and why, in the operator’s own terms',
    /last-Uber-trip rule can name nobody here either/.test(r.attribution_evidence)
    && /the car has left the Uber channel/.test(r.attribution_evidence)
    && r.attribution_evidence.includes(String(STALE_CAP_MIN)),
    r.attribution_evidence);
}

console.log('\n3. a car nothing books is UNKNOWN, with the true reason and no name');
{
  const r = rowAt('L82907', '2026-09-11T19:28');
  check('the tier is unknown', r.attribution_tier === 'unknown', r.attribution_tier);
  /* REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change the
     candidates CASE branch `WHEN 'unknown' THEN '[]'::jsonb` to fall back to
     the plate's most recent custodian —
       (SELECT jsonb_agg(jsonb_build_object('name', v.driver_name, 'id', v.driver_ext_id,
                                            'key', v.driver_ext_id))
          FROM vehicle_driver_day v WHERE v.plate = o.plate
         ORDER BY v.day DESC LIMIT 1)
     which is the seductive fallback: it would put a name on 33 of production's
     120 segments with nothing behind it. This assertion fails and nothing else
     in the file moves, which is exactly how such a change would arrive. */
  check('nobody is named', r.attribution_candidate_count === 0
    && Array.isArray(r.attribution_candidates) && r.attribution_candidates.length === 0,
    JSON.stringify(r.attribution_candidates));
  /* An empty ARRAY rather than NULL, deliberately. api/public/ui.js tableFrom
     prunes a column that is blank in every row (driver.js:1755 carries the
     long note about a Minutes column lost to exactly this), so a page whose
     rows are ALL unknown would lose the attribution column at precisely the
     moment the reader needs to see that nobody could be named. */
  check('…as an empty array rather than a null, so a column keyed on it survives',
    r.attribution_candidates !== null, String(r.attribution_candidates));
  check('the reason is the TRUE one — no booking names anyone on this car that day',
    /No booking on any channel names a driver for L82907 on 2026-09-11/
      .test(r.attribution_evidence), r.attribution_evidence);
  /* A reason that is not the true one is the specific failure this product
     exists to prevent. "Not collected yet" and "the usual driver" are both
     false here and both are plausible. */
  check('and it does not reach for the car’s usual driver',
    /usual driver is deliberately NOT shown/.test(r.attribution_evidence)
    && !/likely|probably|most likely/i.test(r.attribution_evidence),
    r.attribution_evidence);
  /* The trap, stated as an assertion rather than as a comment: this car HAS a
     custodian on record — four weeks earlier, on a different day — and the
     seductive fallback would print them. On production that fallback would put
     a name on 33 of 120 segments with nothing behind it. */
  check('a custodian recorded on a DIFFERENT day is not borrowed for this one',
    !JSON.stringify(r.attribution_candidates).includes('Usual Driver')
    && !r.attribution_evidence.includes('Usual Driver'),
    JSON.stringify(r.attribution_candidates));
  /* THE NEAREST BOOKING, WHICH NAMES SOMEBODY AND IS STILL NOT AN ANSWER.
     The reconciler already recorded which booking came closest before it
     decided that booking did not explain the journey, and joining it names a
     person for free. On this row that person is four weeks away. The hint is
     returned, because an operator ringing round wants to know it exists — and
     it is returned OUTSIDE the candidate list, with its gap, because a booking
     that far from the window is a fact about the car's day and not about who
     was in the car. */
  check('the nearest booking is returned, with the driver it names and its gap',
    r.nearest_booking && r.nearest_booking.name === 'The Car’s Usual Driver'
    && r.nearest_booking.gap_min === -42010 && r.nearest_booking.platform === 'hotel',
    JSON.stringify(r.nearest_booking));
  check('…and it says outright that it is context rather than a candidate',
    /Context, not a candidate/.test(r.nearest_booking.means || '')
    && /did NOT explain the journey/.test(r.nearest_booking.means || ''),
    r.nearest_booking.means);
  /* The assertion that stops the hint becoming a tier. It is stated as its own
     check rather than folded into "nobody is named" above, because the failure
     it guards is a later change that appends nearest_booking to candidates —
     which would leave "nobody is named" failing for a reason nobody reading
     the diff would connect to this.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change the
     candidates CASE branch `WHEN 'unknown' THEN '[]'::jsonb` to read the
     reconciler's own nearest pointer —
       (SELECT jsonb_agg(jsonb_build_object('name', t9.driver_name,
                'id', t9.driver_ext_id, 'key', t9.driver_ext_id))
          FROM trip t9 WHERE t9.external_id = o.nearest_trip_id
                         AND t9.platform = o.nearest_platform)
     which is the exact shape of the temptation: the pointer is already on the
     row, the join is one line, and the name it produces is four weeks away. */
  check('the hint does not enter the candidate list, the keys, or the tier',
    r.attribution_candidates.length === 0
    && r.attribution_candidate_keys.length === 0
    && r.attribution_tier === 'unknown'
    && !r.attribution_evidence.includes('Usual Driver'),
    JSON.stringify([r.attribution_tier, r.attribution_candidates, r.attribution_candidate_keys]));
  /* THE CAR ON THE WRONG CHANNEL. The operator said "the last trip on uber",
     and BRACKET_PLATFORMS is ['uber'], so a car whose work is all on the hotel
     corporate channel is structurally invisible to this rule — not for want of
     data, but because all its data is somewhere else. Measured on production:
     15 of 120 journeys are on L46706, which has 491 hotel trips in 11.5 months
     by at least ten drivers and ZERO Uber trips; another 13 are on plates that
     migrated off Uber months ago. 28 of 120, 23%, where the honest answer is
     "this car does not run on Uber" — and it has to be SAID rather than
     rendered as a blank, or a reader reads the blank as "nothing happened". */
  check('a car whose work is on another channel says so, rather than going quietly blank',
    /has no Uber trips at all in the record/.test(r.attribution_evidence)
    && /Its work is on the hotel channel/.test(r.attribution_evidence)
    && /a car on the wrong channel, not a car with a thin record/
       .test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n4. one human with several platform accounts is ONE candidate');
{
  const r = rowAt('L76092', '2026-09-16T02:38');
  /* The register-aware fold is what makes this ONE person. Without it the
     custody rows are two, the tier is `ambiguous`, and an innocent second name
     stands next to an accusation — which is what /api/unauthorized/list does
     on 12 of production's 120 segments today.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, replace both uses
     of `${personKeyStored('v')}` in the `cust` CTE with `v.driver_ext_id`.
     custodian_count becomes 2, the tier becomes `ambiguous`, two names come
     back for one man, and the distribution assertion at the top fails too. */
  const two = await q(
    `SELECT count(*)::int n FROM vehicle_driver_day WHERE plate='L76092' AND day='2026-09-16'`);
  check('the database really does hold two custody rows for this car and day',
    two[0].n === 2, String(two[0].n));
  check('and they fold to ONE candidate, not one per account',
    r.attribution_candidate_count === 1 && r.custodian_count === 1
    && r.attribution_candidates.length === 1,
    JSON.stringify(r.attribution_candidates));
  /* The tier moved from `sole_custodian` to `last_trip` when the operator's
     rule landed, and that is the rule working rather than the fixture
     drifting: this man's own Uber trip on this car ended 16 hours before the
     journey, so the rule names him off the trip record directly instead of
     falling back to the day rollup. What this block guards — that he is ONE
     candidate and not two — is untouched by that and is asserted above. */
  check('so the tier is the operator’s rule, off his own trip, not a manufactured ambiguity',
    r.attribution_tier === 'last_trip', r.attribution_tier);
  check('the two spellings fold to one person key',
    r.attribution_candidate_keys.length === 1
    && r.attribution_candidate_keys[0] === 'umair khan shah',
    JSON.stringify(r.attribution_candidate_keys));
  /* Custody, stated as custody, now asserted on fixture 13 — the one row in
     this file that custody still decides. See block 5b. */
  check('and the sentence still refuses to say he drove',
    !/drove|was driving|made this journey/i.test(r.attribution_evidence)
    && /NOT a record of this journey/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n5. a segment at 22:30 UTC is filed on the Dubai day it belongs to');
{
  const r = rowAt('L99001', '2026-09-05T22:30');
  /* Dubai is UTC+4, so 22:30 on the 5th is 02:30 on the 6th locally. Two
     custodians were seeded, one on each side of that midnight, so a UTC fold
     does not merely mislabel the row — it names a different person, who had
     already handed the car over.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change SEG_DAY from
     `(o.started_at AT TIME ZONE 'Asia/Dubai')::date` to `o.started_at::date`.
     local_day stays right (it is computed in the route's own SELECT), the tier
     stays `sole_custodian`, and the NAME changes to Daytime Custodian — a
     quiet, complete, wrong accusation. Both assertions below fail. */
  check('the local day is the Dubai one', r.local_day === '2026-09-06', r.local_day);
  /* THE CUSTODIAN ASSERTION MOVED TO FIXTURE 13, and this is why. Under the
     operator's rule this row is no longer decided by custody at all: the last
     Uber trip on L99001 before the journey is the DAYTIME custodian's, ending
     12.8 hours earlier, and the rule says whoever last had the car has it. So
     the rule and the day rollup name different people here — which is exactly
     the case that has to be VISIBLE rather than quietly resolved.

     Measured on production: the rule contradicts day-custody on 2 of 120
     journeys uncapped and on 0 of 120 under the cap, and both contradictions
     are read off trips more than six months old. A disagreement inside the cap
     is therefore rare enough that hiding one would be indefensible. */
  check('the operator’s rule decides this row, and names whoever last had the car',
    r.attribution_tier === 'last_trip'
    && r.attribution_candidates.length === 1
    && r.attribution_candidates[0].name === 'Daytime Custodian',
    JSON.stringify([r.attribution_tier, r.attribution_candidates]));
  /* REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change the
     CUSTODY_CLAUSE branch `WHEN named.last_in_cust = 0 THEN format('Day-custody
     DISAGREES: …')` to `''`. The tier, the name and the gap are all unchanged
     and the row stops admitting that the other source says somebody else — a
     silent overrule, which is the one thing an accusation surface may not do. */
  check('and it says outright that day-custody names somebody ELSE, rather than hiding it',
    /Day-custody DISAGREES/.test(r.attribution_evidence)
    && /Night Custodian/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('the sentence dates that disagreement on the Dubai day, so the two cannot disagree',
    /on 2026-09-06/.test(r.attribution_evidence), r.attribution_evidence);
}

console.log('\n5b. …and on a row custody still decides, the Dubai day picks the person');
{
  /* Fixture 13: the same 22:30 UTC shape, on a car with no Uber work at all,
     so the operator's rule is silent and custody decides. Dubai is UTC+4, so
     22:30 on the 5th is 02:30 on the 6th locally; two custodians sit either
     side of that midnight, so a UTC fold does not merely mislabel the row — it
     names a different person who had already handed the keys over.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change SEG_DAY from
     `(o.started_at AT TIME ZONE 'Asia/Dubai')::date` to `o.started_at::date`.
     local_day stays right (it is computed in the route's own SELECT), the tier
     stays `sole_custodian`, and the NAME changes to Daytime Custodian Two — a
     quiet, complete, wrong accusation. Both assertions below fail. */
  const r = rowAt('L99002', '2026-09-05T22:30');
  check('the local day is the Dubai one', r.local_day === '2026-09-06', r.local_day);
  check('and the custodian named is the Dubai day’s, not the UTC day’s',
    r.attribution_tier === 'sole_custodian'
    && r.attribution_candidates.length === 1
    && r.attribution_candidates[0].name === 'Night Custodian Two',
    JSON.stringify([r.attribution_tier, r.attribution_candidates]));
  check('the sentence dates itself on the Dubai day too, so the two cannot disagree',
    /on 2026-09-06/.test(r.attribution_evidence), r.attribution_evidence);
  /* Custody, stated as custody. "Held by X that day" is a conversation;
     "X drove it" is an accusation the evidence does not support. */
  check('and the sentence says custody, not driving',
    /this is custody, not driving/.test(r.attribution_evidence), r.attribution_evidence);
  /* And it says why the operator's rule did not decide it, rather than leaving
     a reader to assume the rule was applied and found this person. */
  check('…and why the operator’s rule was silent here — a car with no Uber work',
    /has no Uber trips at all in the record/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n6. a tracker whose clock is days out never brackets, whatever the gaps say');
{
  const r = rowAt('L77777', '2026-09-08T06:00');
  /* The gaps here are a textbook bracket — 30 minutes on each side, the same
     person, no intruder — and they are worthless, because the timestamps they
     are measured between come off a clock 2,339 minutes behind wall time. The
     reconciler already refuses to compare such a segment against a booking;
     this refuses to build an accusation out of the same arithmetic.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, drop the
     `tally.skew IS NULL AND` from the ladder's first branch. The tier becomes
     `bracketed`, the gaps appear as 30 and 30, and the row names one man off a
     clock nobody can trust. */
  check('the tier falls back to custody rather than bracketing',
    r.attribution_tier === 'sole_custodian', r.attribution_tier);
  check('the skew is reported as a number, so a page can name the affected car',
    r.clock_skew_min === 2339, String(r.clock_skew_min));
  /* And the gaps are withheld, not merely unused. The bracket CTE still ran
     and still found its pair; emitting 30 and 30 beside a tier that says time
     decided nothing would be a checkable-looking measurement standing in for
     evidence the row does not have.

     REVERSION THAT PROVES THIS ONE SEPARATELY: in api/unauthorized_sql.js,
     drop the two `CASE WHEN named.tier = 'bracketed' THEN … END` wrappers
     around before_min and after_min, leaving the bare subqueries that were
     there first. The tier stays right and only this assertion fails — which is
     the point of asserting it apart from the tier. */
  check('and the two gaps are withheld, not printed beside a tier that did not use them',
    r.bracket_before_min === null && r.bracket_after_min === null,
    `${r.bracket_before_min} / ${r.bracket_after_min}`);
  check('the sentence says the clock is why, rather than leaving it to be inferred',
    /tracker reports a clock 2339 minutes behind wall time/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* THE OPERATOR'S RULE INHERITS THIS GATE RATHER THAN DROPPING IT. The whole
     rule is ONE clock comparison — this journey's start against the end of a
     trip — so a tracker 2,339 minutes out of true makes it exactly as
     worthless as it makes the bracket. This driver's Uber trip ends 30 minutes
     before the journey by a clock nobody can trust; without the gate the rule
     would name him with a confident 30-minute gap beside the name.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, drop
     `tally.skew IS NULL AND` from the `last_trip` branch of the `named`
     ladder. The tier becomes `last_trip`, a 30-minute gap appears on the row,
     and these two assertions fail while the skew is still reported. */
  check('the operator’s rule does not fire on a clock nobody can trust either',
    r.attribution_tier !== 'last_trip' && r.attribution_last_trip_gap_min === null,
    `${r.attribution_tier} / ${r.attribution_last_trip_gap_min}`);
  check('…and the row says that is why, rather than leaving the rule to look inapplicable',
    /last-Uber-trip rule is not applied here either/.test(r.attribution_evidence)
    && /cannot be compared against a booking clock at all/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\nthe tier filter selects on the ladder, not on a word in the reason');
{
  const r = await get(`/api/unauthorized/attributed?${WIN}&tier=ambiguous`);
  check('only the ambiguous segments come back',
    r.body.rows.length === 4
    && r.body.rows.every((x) => x.attribution_tier === 'ambiguous')
    && r.body.rows.map((x) => x.plate).sort().join() === 'L11111,L44251,L45235,L99003',
    JSON.stringify(r.body.rows.map((x) => [x.plate, x.attribution_tier])));
  const lt = await get(`/api/unauthorized/attributed?${WIN}&tier=last_trip`);
  check('…and the new tier is selectable the same way, on the ladder rather than on a word',
    lt.body.rows.length === 14
    && lt.body.rows.every((x) => x.attribution_tier === 'last_trip'),
    JSON.stringify(lt.body.rows.map((x) => [x.plate, x.attribution_tier])));
  /* Facets computed over the current filter tell a reader nothing about what
     else is there — the rule /api/segments already applies. */
  check('…while the distribution still describes the whole window',
    r.body.distribution.segments === 37, JSON.stringify(r.body.distribution));
  const bogus = await get(`/api/unauthorized/attributed?${WIN}&tier=definitely`);
  check('an unknown tier is ignored rather than returning an empty page as a clean one',
    bogus.body.rows.length === 37 && bogus.body.filter.tier === null,
    String(bogus.body.rows.length));
}

console.log('\nthe evidence is 27 days of a 61-day window, and the response says so');
{
  /* CABMAN is a five-minute realtime poll with no history behind it. A driver
     tab that omits this reads as a clean record for the months before the
     sensor existed — an exoneration nobody measured, which is the same defect
     as an accusation nobody measured. */
  check('the coverage note names the days actually watched',
    all.body.coverage.complete === false
    && all.body.coverage.days_with_data === 18
    && all.body.coverage.days_in_window === 61
    && /18 of the 61 days/.test(all.body.coverage.note || ''),
    JSON.stringify(all.body.coverage));
  /* win() widens `to` to `... 23:59:59.999` for driver routes and winDays()
     does not; `${to}T00:00:00Z` parses to NaN on the widened form, which put
     NaN in this sentence. Asserted as a number rather than as a truthy value. */
  check('…as a number, on both window shapes',
    Number.isFinite(all.body.coverage.days_in_window), String(all.body.coverage.days_in_window));
  const empty = await get('/api/unauthorized/attributed?from=2026-01-01&to=2026-01-31');
  check('a window with no sensor data says that, rather than reading as no unexplained trips',
    empty.body.rows.length === 0
    && /absence of the sensor/.test(empty.body.coverage.note || ''),
    empty.body.coverage.note);
}


/* ══════════════════════════════════════════════════════════════════════════
   THE OPERATOR'S RULE
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. a HANDOVER DAY day-custody could not separate resolves to whoever last had the car');
{
  /* THE ASSERTION THE OPERATOR ASKED FOR. Two people hold L44305 on
     2026-09-03, so day-custody names both and /api/unauthorized/list prints
     both — one of the two is being implicated for a journey he did not make.
     Nothing brackets, because there is no trip on the far side of the window.
     The old ladder could only say `ambiguous`.

     One of the two finished an Uber trip on this car 44 minutes before the
     journey opened. The operator's rule says he is the one responsible, and
     the whole point is that the rule NARROWS the day's own list rather than
     stepping outside it: measured over production, 13 of the 26 ambiguous rows
     resolve this way and in all 13 the person picked is one of the day's own
     custodians.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, remove the
     `WHEN tally.skew IS NULL AND tally.last_people = 1 THEN 'last_trip'` branch
     from the `named` ladder. The tier falls back to `ambiguous`, both men are
     named beside one journey again, and every assertion in this block fails. */
  const r = rowAt('L44305', '2026-09-03T08:28');
  check('the tier is last_trip', r.attribution_tier === 'last_trip', r.attribution_tier);
  check('and exactly one of the two custodians is named — the one who most recently had it',
    r.attribution_candidate_count === 1
    && r.attribution_candidates.length === 1
    && r.attribution_candidates[0].name === 'Sami Ullah Noor',
    JSON.stringify(r.attribution_candidates));
  check('while the row still reports that TWO people held the car that day',
    r.custodian_count === 2, String(r.custodian_count));
  /* The narrowing has to be VISIBLE, or a page shows one name where yesterday
     it showed two and a reader cannot tell whether the other was ruled out or
     dropped. */
  check('the sentence says it narrowed the day’s own list rather than stepping outside it',
    /2 people held L44305 on 2026-09-03/.test(r.attribution_evidence)
    && /Hamid Raza Sultan, Sami Ullah Noor/.test(r.attribution_evidence)
    && /narrows the list, it never steps outside it/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* THE GAP, AS A NUMBER AND IN WORDS. 44 minutes and six days are different
     claims about the same rule and a reader has to tell them apart at a
     glance, so the gap is on the row as an integer AND in the sentence.

     REVERSION THAT PROVES THIS ONE SEPARATELY: in api/unauthorized_sql.js,
     drop the `CASE WHEN named.tier = 'last_trip' THEN … END` wrapper around
     last_trip_gap_min and replace the column with a bare NULL. The tier and the
     name stay right and only the gap assertions fail — which is the point of
     asserting them apart from the tier. */
  check('the gap is on the row as measured minutes',
    r.attribution_last_trip_gap_min === 44, String(r.attribution_last_trip_gap_min));
  check('…and the sentence quotes it, so it can be checked against the car’s trip list',
    /ending 44 minutes earlier/.test(r.attribution_evidence)
    && /finished at 2026-09-03 11:44/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* THE SENTENCE MUST SAY WHAT WAS TESTED AND NOTHING MORE. "The last Uber
     trip on this car before the journey was X's" is checkable; "X made this
     journey" is an accusation no evidence in this building supports. */
  check('the sentence states the rule as an inference and never says he drove',
    /The last Uber trip on L44305 before this journey was Sami Ullah Noor’s/
      .test(r.attribution_evidence)
    && /NOT a record of this journey/.test(r.attribution_evidence)
    && /no booking places anyone behind the wheel while it was happening/
       .test(r.attribution_evidence)
    && !/drove|was driving|made this journey|is responsible for this journey/i
       .test(r.attribution_evidence.replace(/is the one responsible/g, '')),
    r.attribution_evidence);
  check('and it quotes the operator’s rule rather than paraphrasing it into a claim',
    /usually one person drives a car, so whoever did the last Uber trip on it is the one responsible/
      .test(r.attribution_evidence), r.attribution_evidence);
  /* THE ONE FIELD A PAGE PRINTS IN ITS RESPONSIBLE-PERSON COLUMN. Emitted by
     the SQL rather than assembled per shell, so two pages cannot word the same
     answer — or the same absence — differently. */
  check('the responsible-person field carries the name, once',
    r.attribution_responsible === 'Sami Ullah Noor', String(r.attribution_responsible));
  /* A LEAVER IS NOT SUPPRESSED, HE IS FLAGGED. Suppressing a name because the
     person has since left would be the product deciding who is above
     suspicion, and a leaver is exactly the person who might take a car
     unbooked. Measured: 1 of the 21 people the rule names is not currently
     working, and the cap removes that one case anyway — a car whose driver
     left is a car whose Uber trail went cold.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, add
     `AND named.off_roster IS NULL` to the `last_trip` branch of the ladder,
     i.e. make roster state a gate. The tier falls to `ambiguous`, both men are
     named again, and this assertion plus every one above it fails. */
  check('a person who has left the roster is still named, with that stated as a fact',
    r.attribution_candidates[0].name === 'Sami Ullah Noor'
    && /Uber account is recorded as deactivated and cannot currently take work/
       .test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n8. a thirteen-day-old trip still names somebody, in a visibly different voice');
{
  /* L64009 has NO custody record at all, so the old ladder says `unknown` and
     offers nothing. 33 of production's 120 journeys are in that state and this
     is the single largest source of the coverage the operator's rule buys: the
     rule reads the trip table directly rather than the day rollup, so it
     reaches a person vehicle_driver_day cannot.

     The trip is 13 days old — inside STALE_CAP_MIN and well past the
     1,494-minute p98 band — so the claim is real and weaker, and the sentence
     has to LEAD with the age rather than with the name. A single uniform
     sentence would print "their trip ended 44 minutes earlier" and "their trip
     ended 13 days earlier" in the same confident voice.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, delete the
     `CASE WHEN named.last_gap <= ${FRESH_BAND_MIN}` split in the `last_trip`
     evidence branch and keep only the fresh-band format(). The tier, the name
     and the gap are all unchanged; the sentence says the car was in
     "continuous normal Uber service" across a 13-day silence, and the two
     voice assertions below fail. */
  const r = rowAt('L64009', '2026-09-01T06:08');
  check('the tier is last_trip on a journey the old ladder left unknown',
    r.attribution_tier === 'last_trip' && r.custodian_count === 0,
    `${r.attribution_tier} / ${r.custodian_count}`);
  check('the person is named once, and the gap is the measured one',
    r.attribution_candidate_count === 1
    && r.attribution_candidates[0].name === 'Rana Jahanzaib Quiet Spell'
    && r.attribution_last_trip_gap_min === 18720,
    JSON.stringify([r.attribution_candidates, r.attribution_last_trip_gap_min]));
  check('the sentence LEADS with the age of the trip, not with the name',
    /^Read the age of this first: the trip it rests on ended 13.0 days before/
      .test(r.attribution_evidence), r.attribution_evidence.slice(0, 120));
  check('…and says the car was in an abnormally quiet spell, not in normal service',
    /abnormally quiet spell/.test(r.attribution_evidence)
    && /the claim is weaker in proportion to the age of that trip/
       .test(r.attribution_evidence)
    && !/continuous normal Uber service/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* With no custody row there is nothing to corroborate against, and that is a
     third thing — not agreement and not disagreement. */
  check('with no custody row it says so, rather than implying corroboration',
    /No custody record exists for L64009 on 2026-09-01/.test(r.attribution_evidence)
    && /the rule reached a person the day rollup could not/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* And the fresh band reads differently on the same rule, which is the whole
     point of splitting it. */
  const fresh = rowAt('L44305', '2026-09-03T08:28');
  check('the two bands are visibly different sentences about the same rule',
    /continuous normal Uber service/.test(fresh.attribution_evidence)
    && !/abnormally quiet spell/.test(fresh.attribution_evidence)
    && fresh.attribution_evidence.slice(0, 30) !== r.attribution_evidence.slice(0, 30),
    `${fresh.attribution_evidence.slice(0, 60)} || ${r.attribution_evidence.slice(0, 60)}`);
}

console.log('\n9. a trail too old names NOBODY, and says so in the operator’s own terms');
{
  /* L63970's most recent Uber trip ended 304 days before this journey. The
     rule as stated would name that man; the cap, which was measured rather
     than chosen, refuses to. Three independent readings put the line in the
     same place — an empirical void of 135.8 days in the staleness
     distribution, the 99.9th percentile of this fleet's own inter-trip gap,
     and the fact that every journey where the rule contradicts day-custody
     sits on the far side of it.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, raise
     STALE_CAP_MIN to 999999. The tier becomes `last_trip`, a man who has not
     touched this car since October is named for a journey in August, and every
     assertion in this block fails. */
  const r = rowAt('L63970', '2026-08-31T03:14');
  check('the tier is unknown — the cap refuses the name', r.attribution_tier === 'unknown',
    r.attribution_tier);
  check('nobody is named, and no key is filed',
    r.attribution_candidate_count === 0
    && r.attribution_candidates.length === 0
    && r.attribution_candidate_keys.length === 0,
    JSON.stringify([r.attribution_candidates, r.attribution_candidate_keys]));
  /* The operator's own words for the absence, emitted once by the SQL so two
     pages cannot word it differently. */
  check('the responsible-person field says the operator’s sentence, not a blank',
    r.attribution_responsible === 'Nobody — the trail is too old.',
    String(r.attribution_responsible));
  check('the evidence gives the TRUE reason, with the age and the measured cap',
    /ended 304.1 days before this journey began, on 2025-10-31/
      .test(r.attribution_evidence)
    && /the car has left the Uber channel/.test(r.attribution_evidence)
    && /records who USED TO drive this car, not who drove it that night/
       .test(r.attribution_evidence)
    && /99.9th percentile/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and says why the name is withheld rather than shown with a caveat',
    /read as an answer however it is footnoted/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* THE REFUSED NAME IS STILL RETURNED — under its own key, with its own gap
     and its own sentence. An operator ringing round wants to know it exists.
     It is kept out of `candidates` and `candidate_keys` under exactly the
     discipline nearestJoin() already applies to the nearest booking. */
  check('the refused name comes back as context, with its gap and its own sentence',
    r.attribution_last_uber_driver
    && r.attribution_last_uber_driver.name === 'Zahid Ullah Afsar Zada'
    && r.attribution_last_uber_driver.gap_min === 437844
    && /Context, not a candidate — last Uber driver of record/
       .test(r.attribution_last_uber_driver.means)
    && /filed against nobody’s profile anywhere in the product/
       .test(r.attribution_last_uber_driver.means),
    JSON.stringify(r.attribution_last_uber_driver));
  check('…and it is nowhere in the candidate list or the keys',
    !JSON.stringify(r.attribution_candidates).includes('Zahid')
    && !r.attribution_candidate_keys.some((k) => String(k).includes('zahid')),
    JSON.stringify([r.attribution_candidates, r.attribution_candidate_keys]));
}

console.log('\n10. two different absences, two different sentences');
{
  /* L74169's Uber history starts AFTER the journey. Merged into the
     no-Uber-history sentence this would read as a false statement about the
     car — and measured, this case is almost always an artefact of how far back
     the query looked rather than a fact about the vehicle: it was 1 of 120
     under a lookback bounded at 2026-06-01 and 0 of 120 once the lookback was
     widened. That is exactly why the SQL gives the last-trip rule its own
     STALE_CAP_MIN-wide lookback rather than inheriting the report window's.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, delete the
     `WHEN named.uber_prior = 0` branch of WHY_NO_LAST. The row falls into the
     no-Uber-history sentence and tells a reader this car has never run on
     Uber, which is false — it ran on it twelve days after this journey. */
  const r = rowAt('L74169', '2026-08-21T09:13');
  check('the tier is unknown and nobody is invented',
    r.attribution_tier === 'unknown' && r.attribution_candidate_count === 0,
    r.attribution_tier);
  check('it says the car HAS Uber history and that none of it predates this journey',
    /HAS Uber history, but none of it predates this journey/.test(r.attribution_evidence)
    && /the first Uber trip on this car was 2026-09-02/.test(r.attribution_evidence)
    && /Nobody can be named from a trip that had not happened yet/
       .test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and it is a DIFFERENT sentence from the car that never ran on Uber at all',
    !/has no Uber trips at all in the record/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* There is no prior trip at all here, so there is no refused name either —
     and the context key must be absent rather than carrying the trip from
     AFTER the journey, which is the shape of mistake this branch exists for.

     THE SECOND HALF OF THIS ASSERTION WAS RETARGETED, AND IT IS STRONGER NOW.
     It read `attribution_responsible === null`, which was true only because
     the responsible column had exactly one absence phrase — "Nobody — the
     trail is too old." — gated on a condition that tests neither the cap nor
     the clock. That single branch is what let a 44-minute-old trail and a
     tracker 2,339 minutes out of true both print staleness as the reason. The
     column now carries a SHORT TRUE reason for each absence, switching on the
     same token the evidence sentence switches on, so what this assertion has
     to guard is no longer "the column is empty" but the two things that
     actually matter on this row: the column names NO PERSON, and it does not
     blame the age of a trip when the finding is that the car's Uber history
     had not started yet.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, replace the
     no_last_reason CASE in `responsible` with the old single branch
     `WHEN named.last_people = 0 AND named.ever_gap IS NOT NULL THEN 'Nobody —
     the trail is too old.'`. This row goes null-and-silent again while the
     skew row two blocks down starts blaming the age; assert both. */
  check('and no context name is offered from a trip that postdates the journey',
    r.attribution_last_uber_driver == null,
    JSON.stringify(r.attribution_last_uber_driver));
  check('…and the responsible column names nobody and gives the TRUE reason',
    typeof r.attribution_responsible === 'string'
    && /^Nobody — /.test(r.attribution_responsible)
    && /Uber history starts after the journey/.test(r.attribution_responsible)
    && !/too old/.test(r.attribution_responsible),
    String(r.attribution_responsible));
}

console.log('\n11. a tie on the last trip is reported as a tie, never resolved by row order');
{
  /* Measured: 0 occurrences across 21,961 distinct (plate, Uber ended_at)
     instants on the flagged plates. The case is synthetic and it still has to
     be handled, because a tie broken by whichever row the planner returned
     first is a coin flip that reads to an operator as a finding — this file's
     subject is a wrong NAME, and a randomly chosen one is the worst kind.
     api/unauthorized_sql.js's own header records the identical trap on the
     bracket tier.

     THE ASSERTION IS THAT A TIE YIELDS TWO CANDIDATES, never that it yields a
     particular one, because "which one" is precisely what must not be decided.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, change the
     `last_trip` branch of the ladder to `tally.last_people >= 1` and delete the
     `WHEN tally.skew IS NULL AND tally.last_people > 1 THEN 'ambiguous'` branch
     below it. The tier becomes `last_trip`, ONE of the two men is named at the
     planner's discretion, and this block fails. */
  const r = rowAt('L11111', '2026-09-07T05:00');
  check('the tier is ambiguous, and the rule refuses to choose',
    r.attribution_tier === 'ambiguous', r.attribution_tier);
  check('BOTH tied drivers are candidates, in name order, and neither is chosen',
    r.attribution_candidate_count === 2
    && r.attribution_candidates.map((c) => c.name).join(' | ')
       === 'Adnan Tie Alpha | Bilal Tie Bravo'
    && r.attribution_responsible === null,
    JSON.stringify(r.attribution_candidates));
  /* THE TIE DOES NOT FALL BACK TO DAY-CUSTODY. Day-custody names a third
     person for this car and day — and it is the WEAKER source, so letting it
     decide here would silently overrule the operator's rule with a worse
     answer. She is not a candidate and she is not in the keys.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, remove
     `OR named.last_tie` from the candidates and candidate_keys CASEs, so an
     `ambiguous` row always lists custodians. The tier stays right, the day's
     custodian appears instead of the two tied drivers, and this assertion
     fails on its own. */
  const day = await q(
    `SELECT driver_name FROM vehicle_driver_day WHERE plate='L11111' AND day='2026-09-07'`);
  check('the database really does hold a day custodian for this car and day',
    day.length === 1 && day[0].driver_name === 'Aaaa Day Custodian',
    JSON.stringify(day));
  check('…and she is NOT used to break the tie, because she is the weaker source',
    !JSON.stringify(r.attribution_candidates).includes('Aaaa Day Custodian')
    && !r.attribution_candidate_keys.includes('aaaa day custodian'),
    JSON.stringify([r.attribution_candidates, r.attribution_candidate_keys]));
  check('the sentence names the shared instant and says outright that neither is chosen',
    /both ended at 2026-09-07 08:00:12/.test(r.attribution_evidence)
    && /the last trip does not identify one person/.test(r.attribution_evidence)
    && /neither is chosen/.test(r.attribution_evidence)
    && /would silently overrule the operator’s rule with a worse answer/
       .test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n12. one human with several Uber accounts is ONE candidate here too');
{
  /* Fixture 4 proves the fold in `cust`; this proves it in `last_ppl`. They
     are separate expressions and a fold that is right in one is not thereby
     right in the other — and unfolded, this man's two accounts finish at the
     same instant and the row comes back as a TIE with one human listed twice
     beside an accusation.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, replace
     `${personKeyStored('t')} AS pkey` in the `last_near` CTE with
     `t.driver_ext_id AS pkey`. last_people becomes 2, the tier becomes
     `ambiguous`, "Rana Jahanzaib Akbar" and "RANA  JAHANZAIB AKBAR" are listed
     as two people, and every assertion in this block fails. */
  const r = rowAt('L22222', '2026-09-08T11:00');
  const two = await q(
    `SELECT count(*)::int n FROM trip WHERE plate='L22222' AND ended_at IS NOT NULL`);
  check('the database really does hold two trips ending at the same instant',
    two[0].n === 2, String(two[0].n));
  check('and they fold to ONE candidate, so the tier is last_trip and not a tie',
    r.attribution_tier === 'last_trip'
    && r.attribution_candidate_count === 1
    && r.attribution_candidates.length === 1,
    JSON.stringify([r.attribution_tier, r.attribution_candidates]));
  check('the two spellings fold to one person key, so the journey reaches one profile',
    r.attribution_candidate_keys.length === 1
    && r.attribution_candidate_keys[0] === 'rana jahanzaib akbar',
    JSON.stringify(r.attribution_candidate_keys));
  check('and the responsible-person field carries one name, not two',
    typeof r.attribution_responsible === 'string'
    && r.attribution_responsible.toLowerCase() === 'rana jahanzaib akbar',
    String(r.attribution_responsible));
}

/* ══ the driver's own page ═══════════════════════════════════════════════ */
console.log('\nthe driver endpoint keeps "you were named" and "you are one of two" apart');
{
  const r = await get(`/api/driver/unauthorized?id=u-zain&${WIN}`);
  check('the route answers and resolves the person', r.status === 200
    && r.body.driver.name === 'Zain Hassan Raja Nasrullah Khan', JSON.stringify(r.body.driver));
  /* Zain is BRACKETED on 24 August and one of two candidates on 12 September.
     Those are different claims about him and a single list with a tier column
     has nowhere to make the difference impossible to miss — the count that
     would get quoted is the one at the top of the table. */
  check('the journey time named him is under `attributed`',
    r.body.attributed.rows.some((x) => x.plate === 'L45243'
      && x.attribution_tier === 'bracketed'),
    JSON.stringify(r.body.attributed.rows.map((x) => [x.plate, x.attribution_tier])));
  check('the one he is merely a candidate for is under `also_a_candidate`',
    r.body.also_a_candidate.total === 1
    && r.body.also_a_candidate.rows[0].plate === 'L45235'
    && r.body.also_a_candidate.rows[0].attribution_tier === 'ambiguous',
    JSON.stringify(r.body.also_a_candidate.rows.map((x) => [x.plate, x.attribution_tier])));
  check('and the two are never the same row',
    !r.body.attributed.rows.some((a) => r.body.also_a_candidate.rows
      .some((b) => a.plate === b.plate && a.started_at === b.started_at)));
  check('the second list says in words that it is not a list of things he did',
    /No claim is made about who was driving/.test(r.body.also_a_candidate.means),
    r.body.also_a_candidate.means);
  /* The other custodian's page must show the mirror image: Waseem is named for
     nothing on these two days and is a candidate for one of them. If the
     bracket leaked into his `attributed` list, the feature would accuse two
     people of the same single-driver journey from two different pages. */
  const w = await get(`/api/driver/unauthorized?id=u-waseem&${WIN}`);
  /* The bracket on 24 August named Zain and RULED WASEEM OUT, and it must not
     leak onto Waseem's page — if it did, the feature would accuse two people
     of the same single-driver journey from two different pages. What Waseem IS
     attributed is a different journey on the same car on 12 September, where
     his own Uber trip was the last one before it; that is the operator's rule
     naming him, not the bracket leaking. Asserted on the JOURNEY rather than
     on a bare total, because a total cannot tell those two apart. */
  check('the journey time RULED HIM OUT of is not on his page',
    !w.body.attributed.rows.some((x) => String(x.started_at).slice(0, 16) === '2026-08-24T05:33')
    && !w.body.also_a_candidate.rows.some(
      (x) => String(x.started_at).slice(0, 16) === '2026-08-24T05:33'),
    JSON.stringify(w.body.attributed.rows.map((x) => [x.plate, x.started_at])));
  check('…and what he IS attributed is the operator’s rule on his own last trip',
    w.body.attributed.total === 1
    && w.body.attributed.rows[0].attribution_tier === 'last_trip'
    && w.body.attributed.by_tier.last_trip === 1
    && w.body.attributed.by_tier.bracketed === 0,
    JSON.stringify(w.body.attributed.by_tier));
  check('…and he appears once more, under the ambiguous heading',
    w.body.also_a_candidate.total === 1, String(w.body.also_a_candidate.total));
  /* The coverage note has to reach the driver page too, or an empty tab reads
     as a clean record rather than as an absence of evidence — and on a PERSON'S
     page it has to be a statement about THEIR cars.

     THE DEFECT THIS ASSERTION USED TO ENCODE. It required the driver page's
     days_with_data to EQUAL the fleet page's, i.e. it pinned the fleet-wide
     count in place. api/public/driver.js prints that number as "No unexplained
     journey in this window names this person, across the N of M days the seat
     sensor actually watched", which asserts coverage over their cars that was
     never measured: a driver whose only cars carry no sensor at all reads as N
     days of watched-and-clean. An exoneration nobody measured is the same
     defect class as an accusation nobody measured, and it was the assertion
     that kept it.

     REVERSION THAT PROVES THIS: drop the `plates` argument from the
     coverageOf() call on the driver route. days_with_data jumps back to the
     fleet-wide figure and the first two assertions here fail. */
  check('the driver page states coverage over the cars THIS person held, not the fleet',
    w.body.coverage.plates_held === 2
    && w.body.coverage.days_with_data < all.body.coverage.days_with_data
    && /car\(s\) this person held/.test(w.body.coverage.note || ''),
    JSON.stringify(w.body.coverage));
  check('…and it says whose cars it is a count over, rather than leaving it to the page',
    /this person held/.test(w.body.coverage.scope || ''), w.body.coverage.scope);
  check('the fleet page keeps saying fleet-wide, because that is what it is',
    all.body.coverage.plates_held === null
    && all.body.coverage.scope === 'every car in the fleet',
    JSON.stringify(all.body.coverage.scope));
}

console.log('\na verdict nobody wrote is ignored and SAID to be ignored, never served as clean');
{
  /* `tier` has been validated against TIERS since it was written, specifically
     so that "an unknown value is ignored rather than returning an empty page as
     a clean one". The same reasoning was not applied to `verdict`, which is the
     parameter that decides the whole population. A British-spelled
     ?verdict=unauthorised — what a hand-typed URL or a report script carries —
     bound a value matching no row, and the response came back rows=[],
     distribution all zeroes, under a coverage note stating the sensor covered
     18 of the 61 days. api/public/segments.js reads that distribution for its
     headline band, so the page led with a computed all-clear over a note
     confirming there was evidence to find.

     REVERSION THAT PROVES THIS: replace verdictOf(req) on the fleet route with
     `req.query.verdict === 'all' ? 'all' : (req.query.verdict || 'unauthorized')`.
     All three assertions here fail. */
  const r = await get(`/api/unauthorized/attributed?${WIN}&verdict=unauthorised&limit=500`);
  check('the misspelled verdict does not empty the page',
    r.body.rows.length === 37 && r.body.distribution.segments === 37,
    `${r.body.rows.length} rows, ${r.body.distribution.segments} in the distribution`);
  check('…it falls back to the unexplained ones, which is what this endpoint is for',
    r.body.filter.verdict === 'unauthorized', r.body.filter.verdict);
  check('…and the response SAYS the value was not understood, rather than going quiet',
    /is not one the reconciler writes/.test(r.body.filter.verdict_rejected || ''),
    r.body.filter.verdict_rejected);
  /* A duplicated parameter arrives as an array. Without first() it is compared
     against a list of strings as an array and never matches. */
  const dup = await get(`/api/unauthorized/attributed?${WIN}&verdict=all&verdict=unauthorized`);
  check('a duplicated verdict parameter is read as its first value, not as an array',
    dup.body.filter.verdict === 'all' && dup.body.filter.verdict_rejected === null,
    JSON.stringify(dup.body.filter));
  /* A verdict the reconciler DOES write still works, so this is validation
     rather than a lock on one value. */
  const uv = await get(`/api/unauthorized/attributed?${WIN}&verdict=unverifiable&limit=500`);
  check('a verdict the reconciler really writes is bound as asked',
    uv.body.filter.verdict === 'unverifiable'
    && uv.body.rows.every((x) => x.verdict === 'unverifiable'),
    JSON.stringify(uv.body.rows.map((x) => [x.plate, x.verdict])));
}

console.log('\nthe fleet chip governs the rows as well as the money, or it governs neither');
{
  /* `fleet` governed coverageOf() and rateOf() and NOT the rows query, so the
     two halves of one response described two different populations: a coverage
     note saying "no seat-occupancy evidence exists for this window at all"
     printed directly above a table of Ecosine rows naming this person, each
     priced at the other fleet's AED/km over Ecosine kilometres. Nothing
     triggered it because the driver UI strips the chip — a trap set for the
     next caller rather than a bug that announces itself.

     REVERSION THAT PROVES THIS: remove `AND ($5::text IS NULL OR o.fleet_id =
     $5)` from the driver rows query. The egari call returns Ecosine rows under
     an egari coverage note and both assertions here fail. */
  const zain = await get(`/api/driver/unauthorized?id=u-zain&${WIN}&fleet=egari`);
  check('asked for a fleet with no sensor, the ROWS are empty too — not only the note',
    zain.body.attributed.rows.length === 0
    && zain.body.also_a_candidate.rows.length === 0,
    JSON.stringify(zain.body.attributed.rows.map((x) => x.plate)));
  check('…so the coverage note and the table describe the same population',
    zain.body.coverage.days_with_data === 0 && /absence of the sensor|no car this person held/i
      .test(zain.body.coverage.note || ''),
    JSON.stringify(zain.body.coverage));
  const eco = await get(`/api/driver/unauthorized?id=u-zain&${WIN}&fleet=ecosine`);
  check('and the fleet that DOES carry the sensor still answers with his journeys',
    eco.body.attributed.rows.length > 0, String(eco.body.attributed.rows.length));
}

console.log('\nthe per-person totals are counted over the window, not over the capped list');
{
  const r = await get(`/api/driver/unauthorized?id=u-zain&${WIN}`);
  /* attributed.total and also_a_candidate.total were `.length` over an array
     the query had truncated at 400, served under the key `total` and rendered
     as a bare KPI value while `truncated` sat elsewhere on the response. A
     per-person count of unexplained journeys that is silently a floor is the
     one number on that page that must not be approximate. */
  check('each list reports both a counted total and how many rows came back',
    r.body.attributed.total === r.body.attributed.shown
    && r.body.also_a_candidate.total === r.body.also_a_candidate.shown,
    JSON.stringify([r.body.attributed.total, r.body.attributed.shown]));
  check('…and says in words what the totals are counted over',
    /counted over the whole window/.test(r.body.total_basis || ''), r.body.total_basis);
}

console.log('\nthe driver endpoint folds an identity the way every other tab does');
{
  /* Opening either account of one human must land on the same answer. The
     Yango record and the Uber record here are one man under two spellings; if
     the fold were missing, one of these two pages would be empty and the other
     would show his work — two answers to one question. */
  const a = await get(`/api/driver/unauthorized?id=u-umair&${WIN}`);
  const b = await get(`/api/driver/unauthorized?id=y-umair&${WIN}`);
  check('the Uber record is named beside the journey once, not once per account',
    a.body.attributed.total === 1
    && a.body.attributed.rows[0].attribution_candidate_count === 1,
    JSON.stringify(a.body.attributed.rows.map((x) => x.attribution_candidates)));
  check('and the Yango record answers identically, because it is the same person',
    b.body.attributed.total === a.body.attributed.total
    && b.body.attributed.rows[0]?.plate === a.body.attributed.rows[0]?.plate,
    `${b.body.attributed.total} vs ${a.body.attributed.total}`);
  check('an unknown-tier journey reaches nobody’s page',
    !a.body.attributed.rows.concat(a.body.also_a_candidate.rows)
      .some((x) => x.plate === 'L82907'));
  /* THE OVER-CAP NAME MUST NOT REACH A PROFILE. This is the assertion that
     makes the "context, not a candidate" placement real rather than cosmetic:
     the man whose 304-day-old trip was refused is resolvable, has a page, and
     that page must not carry the journey. A name in a candidate list is what
     files a journey against a person, so keeping it out of candidate_keys is
     the whole mechanism — and this checks the mechanism from the other end.

     TWO GATES STAND BETWEEN THAT NAME AND THIS PAGE, and they are asserted
     separately because either one alone would be enough and neither alone is
     the guarantee. The first is candidate_keys, proved by reversion in block
     9 (adding `WHEN named.last_people = 0 AND named.ever_gap IS NOT NULL THEN
     (SELECT array_agg(pkey) FROM ever)` to the candidate_keys CASE puts the
     key back and fails that block). The second is this endpoint's own split,
     which files only bracketed/last_trip/sole_custodian under `attributed` and
     ambiguous under `also_a_candidate`, so an `unknown` row reaches neither.

     REVERSION THAT PROVES THIS ONE: make BOTH changes — the candidate_keys
     branch above, AND add 'unknown' to the `attributed` filter in
     api/unauthorized_routes.js. That is the realistic shape of the mistake: a
     later change that decides unknown rows should be listed too, on top of a
     key that was never supposed to be there. This assertion is the only one
     that fails on the pair. */
  const z = await get(`/api/driver/unauthorized?id=u-zahid&${WIN}`);
  check('a journey whose only name the cap refused is filed against nobody’s page',
    z.status === 200
    && !z.body.attributed.rows.concat(z.body.also_a_candidate.rows)
      .some((x) => x.plate === 'L63970'),
    JSON.stringify([z.status, z.body.attributed?.total, z.body.also_a_candidate?.total]));
  const missing = await get(`/api/driver/unauthorized?id=nobody-at-all&${WIN}`);
  check('an id nothing knows 404s rather than answering emptily', missing.status === 404,
    String(missing.status));
}

console.log('\nthe value of the distance carries the rate that priced it');
{
  /* The same convention /api/unauthorized/list uses — the rate and its basis
     ride on every row rather than in a wrapper, because a money total whose
     rate is not stated is the kind of unfootnoted figure this product spent a
     month removing. Nothing in this fixture carries a fare, so the honest
     answer is a null with the reason, never a zero. */
  const r = rowAt('L45243', '2026-08-24T05:33');
  check('with no priced booking in the window, the value is absent rather than zero',
    r.forgone_aed === null && r.aed_per_km === null, String(r.forgone_aed));
  check('…and the row says why', /no rate to value this at/.test(r.rate_basis), r.rate_basis);
}

console.log('\nUber’s status feed corroborates and never attributes');
{
  /* driver_status_event is empty in this fixture, which is the shape 113 of
     production's 120 segments are in: the table is append-only from the day
     the collector started writing it and there is no backfill. The distinction
     that matters is between "they were off the app" and "nobody was watching
     yet", and api/status_routes.js records what happens when those two read
     alike — sixty-six drivers Uber had said nothing about were reported as
     offline. */
  const r = rowAt('L45243', '2026-08-24T05:33');
  check('with no status history, the note says the feed does not reach back',
    /holds nothing yet|does not reach back/.test(r.status_note || ''), r.status_note);
  check('…and it does not promote anyone or claim anything about driving',
    !/drove|was driving/i.test(r.status_note || ''), r.status_note);
  /* And with history, it corroborates a name the LADDER chose — it never adds
     one. Seeded after the fact so the two states are asserted in one run. */
  await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, fleet_id)
           VALUES ('uber','u-zain','2026-08-24T04:50:00Z','offline','ecosine')`);
  const again = await get(`/api/unauthorized/attributed?${WIN}&limit=500`);
  const r2 = again.body.rows.find((x) => x.plate === 'L45243'
    && String(x.started_at).slice(0, 16) === '2026-08-24T05:33');
  check('a status before the journey is reported as corroboration, explicitly labelled',
    /Corroboration only, and it names nobody/.test(r2.status_note || '')
    && /Zain Hassan Raja Nasrullah Khan was offline on Uber/.test(r2.status_note || ''),
    r2.status_note);
  check('and it says being off the app is what an unexplained journey looks like',
    /not evidence of driving/.test(r2.status_note || ''), r2.status_note);
  check('the tier is unmoved by it — the status feed promotes nobody',
    r2.attribution_tier === 'bracketed', r2.attribution_tier);
}

console.log('\n15. a hotel booking inside the gap breaks the bracket, and the sentence says so');
{
  const r = rowAt('L44306', '2026-09-09T05:33');
  /* Zain's own Uber trips sit 54 minutes before and 75 minutes after — a
     textbook bracket by the numbers, and the same numbers as fixture 1. The
     only difference is Kashif's hotel booking at 05:00-05:20, which carries no
     account number. The old exclusion ran over `near`, which is Uber-only AND
     id-required, so it was invisible twice over and the row was served as
     attribution_tier='bracketed' with Zain as the single candidate.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js change the
     bracket's `FROM others x` back to `FROM near x`. This row turns
     `bracketed` and the first two assertions here fail. */
  check('the bracket does NOT fire when another driver has the car in between',
    r.attribution_tier !== 'bracketed', r.attribution_tier);
  check('…even though the intruding booking is on another channel and carries no account id',
    (await q(`SELECT count(*)::int n FROM trip
               WHERE plate = 'L44306' AND platform = 'hotel'
                 AND coalesce(btrim(driver_ext_id), '') = ''`))[0].n === 1);
  /* THE OPERATOR'S RULE IS UBER-ONLY BY THEIR OWN INSTRUCTION, so it still
     names Zain here. That is a decision, not a defect — but the booking that
     refused the bracket is the more recent record of who had this car, and a
     product that refuses to bracket on it and then says nothing about it is
     choosing which evidence to report. */
  check('the more recent booking on the channel the rule does not read is STATED, not dropped',
    /One booking this rule does NOT read sits between that trip and the journey/
      .test(r.attribution_evidence)
    && /Kashif Ali Muhammad Ali/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n16. a cancelled ride is never half a bracket, and never quoted as a trip');
{
  const r = rowAt('L55501', '2026-09-10T08:00');
  /* The only Uber row after this window is a rider_cancelled request 40
     minutes later. `resumed` keys on requested_at alone, so it used to be a
     fully valid AFTER side: tier='bracketed' and the evidence sentence quoted
     "their next Uber trip on the same car began 40 minutes after it ended"
     about a ride that never happened. src/reconcile.js findMatch refuses that
     same row as an EXPLANATION of the journey; it must not then be usable as
     an ACCUSATION.

     REVERSION THAT PROVES THIS: remove `AND ${COMPLETED('t')}` from the `near`
     CTE. The row turns `bracketed` and this assertion fails. */
  check('a cancelled ride does not bracket a journey',
    r.attribution_tier !== 'bracketed', r.attribution_tier);
  check('…and no sentence on the row quotes a trip that began after this journey',
    !/next Uber trip on the same car began/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('the cancelled row really is in the database, so this is a filter and not an absence',
    (await q(`SELECT count(*)::int n FROM trip
               WHERE plate = 'L55501' AND status = 'rider_cancelled'`))[0].n === 1);
}

console.log('\n17. an intervening trip that STARTED before the bracket’s left edge still breaks it');
{
  const r = rowAt('L55504', '2026-09-14T08:00');
  /* Aadil ends 07:00 and resumes 09:00, so he brackets. Basit's trip was
     REQUESTED 06:55 — before Aadil's left edge — and ran to 07:40, twenty
     minutes before the journey started. The exclusion tested only the other
     booking's request instant, so Basit's own booking record put him in that
     car through the whole gap and he was not even offered as a candidate.

     REVERSION THAT PROVES THIS: change the exclusion back to
     `x.requested_at > b.ended_at`. This row turns `bracketed`, names Aadil
     alone, and both assertions here fail. */
  check('a booking that overlaps the gap rather than starting inside it breaks the bracket',
    r.attribution_tier !== 'bracketed', r.attribution_tier);
  check('…and the person whose booking ran through the gap is the one named, not the bracketer',
    (r.attribution_candidates || []).map((c) => c.name).join() === 'Basit Overlap Bravo',
    JSON.stringify(r.attribution_candidates));
}

console.log('\n18. a plate whose neighbour confessed a clock refuses to bracket too');
{
  const r = rowAt('L88881', '2026-09-06T06:00');
  /* THE GUARD THAT COULD NOT FIRE. SKEW() reads "N min behind" out of
     verdict_reason, and src/reconcile.js writes that sentence ONLY on its
     clockSuspect branch, which sets verdict='unverifiable' — never
     'unauthorized'. So on this endpoint's default population the skew was NULL
     on every row and `skew IS NULL AND brackets = 1` was a no-op. Fixture 6
     passes only because it seeds a reason string reconcile.js cannot produce
     for an unauthorized segment; it proved the regex, not the guard.

     Here the plate confesses on a DIFFERENT segment two days away, which is
     how a real tracker behaves, and the unauthorized row beside it carries a
     textbook bracket that must not be used.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, drop
     `plate_skew.min_behind` from the coalesce that builds tally.skew. This row
     turns `bracketed` and every assertion here fails. */
  check('the segment’s own reason carries no skew at all, as an unauthorized row never can',
    !/min behind/.test((await q(
      `SELECT verdict_reason FROM occupancy_segment
        WHERE plate = 'L88881' AND verdict = 'unauthorized'`))[0].verdict_reason),
    'the fixture must not smuggle the skew onto the row under test');
  check('…and the skew is found anyway, off the plate’s own unverifiable neighbour',
    r.clock_skew_min === 247, String(r.clock_skew_min));
  check('the row says WHERE the skew was found, so the number is falsifiable',
    /another segment on L88881 within a week either side/.test(r.clock_skew_basis || ''),
    r.clock_skew_basis);
  check('the bracket is refused', r.attribution_tier !== 'bracketed', r.attribution_tier);
  /* AND THE SENTENCE DOES NOT DENY THE TWO TRIPS THE QUERY FOUND. This is the
     defect the whole TIME_SAYS clause exists for: the old fixed string read
     "no Uber trip on L88881 ends within 240 minutes before this journey or
     begins within 240 minutes after it" over a pair of trips thirty minutes
     either side, and an operator who opened the car's trip list to check found
     them. */
  check('the sentence says a bracket EXISTS and was refused — it never denies the trips',
    /DO sit on both sides of this journey, and the bracket was deliberately refused/
      .test(r.attribution_evidence)
    && !/no completed uber trip on l88881 ends within/i.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n18b. and fixture 6’s textbook bracket is described rather than denied');
{
  const r = rowAt('L77777', '2026-09-08T06:00');
  /* The repo's own fixture is what proved the defect. Its comment says "a
     textbook bracket — 30 minutes on each side, the same person, no intruder",
     and the row printed a sentence flatly denying both of those trips. */
  check('the skewed row states the refusal rather than an absence',
    /DO sit on both sides of this journey/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and names how many minutes out the clock is, and where that came from',
    /2339 minutes behind wall time/.test(r.attribution_evidence)
    && /this segment’s own recorded reason/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n19. a journey across Dubai midnight sees BOTH days’ custodians');
{
  const r = rowAt('L99003', '2026-08-24T19:50');
  /* 19:50 UTC is 23:50 in Dubai; the journey closes 00:40 on the 25th. Custody
     was read at the START day only, so only Wisal was in the frame, the count
     came back 1, and the row read `sole_custodian` with "there is nobody else
     it could have been" — about a car whose keys changed inside the window.

     REVERSION THAT PROVES THIS: change `cust`'s day predicate back to
     `v.day = ${'$'}{SEG_DAY(o)}`. The tier falls to `sole_custodian`, Shehzad
     disappears from the candidate list, and all three assertions here fail. */
  check('the tier is ambiguous, because two people held the car across this journey',
    r.attribution_tier === 'ambiguous', r.attribution_tier);
  check('BOTH days’ custodians are candidates, in name order',
    (r.attribution_candidates || []).map((c) => c.name).join(' / ')
      === 'Shehzad Ahmad Ghulam Muhammad / Wisal Muhammad Irshah Muhammad',
    JSON.stringify(r.attribution_candidates));
  check('…and the sentence names both Dubai days, so either trip list can be checked',
    /2026-08-24 and 2026-08-25, the two Dubai days this journey spans/
      .test(r.attribution_evidence), r.attribution_evidence);
}

console.log('\n20. a custody record with no name is counted, even though it cannot be listed');
{
  const r = rowAt('L44251', '2026-09-02T07:00');
  /* sql/schema_v19.sql admits a custody row carrying an id and no name, and
     the name filter ran BEFORE the count — so a plate-day held by one named
     person plus two nameless accounts reported custodians = 1, tier
     `sole_custodian`, and "there is nobody else it could have been". There
     demonstrably was; the product simply cannot name them.

     REVERSION THAT PROVES THIS: change the ladder's sole_custodian branch back
     to `WHEN tally.custodians = 1 THEN 'sole_custodian'`. This row turns
     `sole_custodian` and the first two assertions here fail. */
  check('one NAMED custodian plus unnamed records is not reported as a sole custodian',
    r.attribution_tier === 'ambiguous', r.attribution_tier);
  check('the unnamed records are counted on the row rather than silently dropped',
    r.unnamed_custodian_count === 2, String(r.unnamed_custodian_count));
  check('…and the sentence says outright that this product cannot name them',
    /custody record\(s\) on this car for 2026-09-02 that carry an account but no name/
      .test(r.attribution_evidence), r.attribution_evidence);
  check('the one it CAN name is still listed, because hiding the row would be worse',
    (r.attribution_candidates || []).map((c) => c.name).join() === 'Kashif Ali Muhammad Ali',
    JSON.stringify(r.attribution_candidates));
  /* A blank name is the same defect wearing an empty string: it folds to a
     person key of its own and became a DISTINCT person, so the list led with
     an empty name and the sentence counted a record as a human. */
  check('no candidate anywhere on the response has a blank name',
    all.body.rows.every((x) => (x.attribution_candidates || [])
      .every((c) => c.name && String(c.name).trim())),
    JSON.stringify(all.body.rows.flatMap((x) => (x.attribution_candidates || [])
      .filter((c) => !c.name || !String(c.name).trim()).map(() => x.plate))));
}

console.log('\n21. an Uber row with an account and no name never becomes a nameless accusation');
{
  const r = rowAt('L55503', '2026-09-13T07:00');
  /* Two rows 54 minutes before and 75 minutes after, same account, NULL name.
     They fold to their own person key, so they used to bracket: tier
     'bracketed', candidates [{"name":null,…}], and the sentence "Named by
     time: ." — because Postgres format() renders a NULL argument as an empty
     string rather than failing, so the defect was silent.

     REVERSION THAT PROVES THIS: remove `AND coalesce(btrim(t.driver_name), '')
     <> ''` from the `near` CTE. The row turns `bracketed`, its single
     candidate has a null name, and the first two assertions here fail. */
  check('a nameless trip pair does not bracket', r.attribution_tier !== 'bracketed',
    r.attribution_tier);
  check('the row names the custodian it CAN name, not an empty string',
    (r.attribution_candidates || []).map((c) => c.name).join() === 'Properly Named Custodian',
    JSON.stringify(r.attribution_candidates));
  /* THE TRUE REASON, NOT A PLAUSIBLE ONE. Before the nameless branch existed
     this row fell through to "every earlier Uber ride on L55503 was CANCELLED",
     which is a different absence and a false one. */
  check('…and the reason given is the missing NAME, not a cancelled ride',
    /every one of them is filed WITHOUT A DRIVER NAME/.test(r.attribution_evidence)
    && !/was CANCELLED/.test(r.attribution_evidence), r.attribution_evidence);
  check('no row anywhere on the response carries an empty name in its evidence sentence',
    all.body.rows.every((x) => !/Named by time: \./.test(x.attribution_evidence || '')));
}

console.log('\n22. a duplicated-word name with no account number still reaches its own page');
{
  /* personKeysForDriver compared trip.person_key — the fold that COLLAPSES
     repeated adjacent words — against keys built by driver_routes.js out of the
     PLAIN fold, which does not. 'Sajid Gul Gul Muhammad' folds to
     'sajid gul muhammad' on one side and 'name:sajid gul gul muhammad' on the
     other, so the comparison could never match and the Unauthorized tab came
     back EMPTY for a person the fleet page lists by name as a candidate on
     their own car — beside a fully populated Trips tab, which matches on
     driver_routes.js PKEY's plain fold.

     REVERSION THAT PROVES THIS: restore
     `('name:' || coalesce(t.person_key, '')) = ANY(keys)` in
     personKeysForDriver. `attributed.total` falls to 0 and both assertions
     here fail. */
  const fleet = rowAt('L55505', '2026-09-15T07:00');
  check('the fleet page does name this person as the car’s only custodian',
    (fleet.attribution_candidates || []).map((c) => c.name).join() === 'Sajid Gul Gul Muhammad',
    JSON.stringify(fleet.attribution_candidates));
  /* THE ID ON THE CANDIDATE HAS TO BE ONE THE DRIVER PAGE CAN OPEN.
     vehicle_driver_day.driver_ext_id is NOT NULL but may be '', because a
     channel that names a driver without numbering them still gets a custody
     row. The candidate carried that empty string, and every shell renders a
     candidate as entity('driver', c.id, c.name) — so the one rung where a
     hotel-only driver is the answer produced a name linking nowhere, which is
     this file's own definition of a name nobody can check.

     REVERSION THAT PROVES THIS: in api/unauthorized_sql.js change the cust
     branch of `candidates` back to 'id', id. The id comes back as the empty
     string and both assertions here fail. */
  check('the candidate carries an id the driver page can resolve, not an empty string',
    fleet.attribution_candidates[0].id === 'name:sajid gul muhammad',
    JSON.stringify(fleet.attribution_candidates[0]));
  const id = encodeURIComponent(fleet.attribution_candidates[0].id);
  const mine = await get(`/api/driver/unauthorized?id=${id}&${WIN}`);
  check('…and opening it lands on a tab that carries this journey',
    mine.status === 200 && mine.body.attributed.rows.some((x) => x.plate === 'L55505'),
    `${mine.status} ${JSON.stringify((mine.body.attributed || {}).rows?.map((x) => x.plate))}`);
}

console.log('\n24. the OLDER list folds the same people, and never prints a blank one');
{
  /* THE TWO SURFACES HAVE TO COUNT ONE DAY'S CUSTODIANS THE SAME WAY.
     ───────────────────────────────────────────────────────────────────────
     /api/unauthorized/list builds its names through api/custody_sql.js
     custodyNames()/custodyRefs(), and those filtered `driver_name IS NOT NULL`
     without excluding the EMPTY STRING — while api/unauthorized_sql.js `cust`,
     the expression the ACCUSATION ladder counts custodians with, closed that
     hole. sql/schema_v19.sql builds a custody row whenever EITHER an id or a
     name is present, so a channel that files a blank name still gets one; it
     folds to person_key NULL, PERSON_OF falls back to the raw account id, and
     the row becomes a DISTINCT person.

     L44251 on 2026-09-02 is seeded with exactly that shape: Kashif, plus a
     yango row with a NULL name, plus a yango row with an EMPTY name. On the
     looser predicate the empty one survived and sorted FIRST, so this
     journey's `drivers` read ", Kashif Ali Muhammad Ali" and driver_refs
     carried a nameless, unopenable second entry beside an accusation — while
     #segments and the driver tab, reading the ladder, showed one custodian and
     said in words how many records they could not name. Two numbers for one
     plate-day, and the disagreement invisible.

     REVERSION THAT PROVES THIS: in api/custody_sql.js restore
     `AND v.driver_name IS NOT NULL` in custodyNames and custodyRefs. `drivers`
     comes back with a leading ", " and driver_refs gains a blank entry, and
     the first three assertions here fail. */
  const list = await get(`/api/unauthorized/list?${WIN}&limit=500`);
  check('the older list answers as the bare array three shells read it as',
    list.status === 200 && Array.isArray(list.body), String(list.status));
  const row = (list.body || []).find((x) => x.plate === 'L44251');
  check('the blank-named custody record is not printed as a custodian',
    row && row.drivers === 'Kashif Ali Muhammad Ali', JSON.stringify(row && row.drivers));
  check('…and no reference on any row of this list carries a blank name',
    (list.body || []).every((x) => (x.driver_refs || [])
      .every((c) => c.name && String(c.name).trim())),
    JSON.stringify((list.body || []).flatMap((x) => (x.driver_refs || [])
      .filter((c) => !c.name || !String(c.name).trim()).map(() => x.plate))));
  /* AND THE TWO SURFACES NOW AGREE ABOUT THIS DAY. The list names the one
     person it can name; the ladder names the same one and states, separately,
     that two more custody records exist it cannot put a name to. Neither
     invents a custodian and neither drops one silently. */
  const att = rowAt('L44251', '2026-09-02T07:00');
  check('the ladder and the list name the same single person for this journey',
    row.drivers === (att.attribution_candidates || []).map((c) => c.name).join(', '),
    `${row.drivers} vs ${JSON.stringify(att.attribution_candidates)}`);
}

console.log('\n25. a ride the driver REJECTED is not a trip they finished');
{
  /* REVERSION THAT PROVES THIS: in api/unauthorized_sql.js, delete
     `AND ${COMPLETED('t')}` from last_near. L33301 flips from `unknown` back to
     `last_trip`, attribution_responsible becomes 'Rejected The Ride', the gap
     comes back as 30, and the evidence reads "ending 30 minutes earlier — it
     finished at 2026-09-03 11:30" about a ride the man refused. */
  const r = rowAt('L33301', '2026-09-03T08:00');
  check('a rejected ride carrying an end time does NOT name anybody',
    r.attribution_tier !== 'last_trip'
    && r.attribution_last_trip_gap_min === null
    && (r.attribution_candidates || []).length === 0,
    JSON.stringify([r.attribution_tier, r.attribution_last_trip_gap_min]));
  check('…and no sentence on the row says that ride FINISHED or ENDED before the journey',
    !/ending 30 minutes earlier/.test(r.attribution_evidence)
    && !/Rejected The Ride/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* The house rule: the TRUE reason, never a plausible one. The cause here is
     the status, so the row must say the status. */
  check('the reason given is that no earlier ride was completed, and it names nobody',
    r.attribution_responsible === 'Nobody — no earlier Uber ride on this car was completed.'
    && /was CANCELLED, rejected or otherwise not completed/.test(r.attribution_evidence),
    `${r.attribution_responsible} :: ${r.attribution_evidence}`);
  /* Proof this is a FILTER and not an absence: the row really is in the table,
     which is what makes the assertion above non-vacuous. */
  const [seeded] = await q(
    `SELECT status, ended_at FROM trip WHERE plate = 'L33301' AND driver_ext_id = 'u-rej'`);
  check('…and the rejected ride really is in the database, with an end time on it',
    seeded && seeded.status === 'driver_rejected' && seeded.ended_at !== null,
    JSON.stringify(seeded));
}

console.log('\n26. the CONTEXT name is completed-only too');
{
  /* REVERSION THAT PROVES THIS: delete `AND ${COMPLETED('t')}` from the ever_at
     and ever CTEs. attribution_last_uber_driver.name becomes 'Cancelled With
     An End' — a name an operator would ring round about, read off a ride that
     never happened — and the evidence dates the trail to 2026-08-01 instead of
     2025-10-31. */
  const r = rowAt('L33302', '2026-08-31T04:00');
  check('the last Uber driver OF RECORD is the one who completed a trip, not the cancellation',
    r.attribution_last_uber_driver
    && r.attribution_last_uber_driver.name === 'Really Finished It',
    JSON.stringify(r.attribution_last_uber_driver));
  check('…and the more recent CANCELLED ride is nowhere on the row',
    !/Cancelled With An End/.test(JSON.stringify(r)),
    r.attribution_evidence);
}

console.log('\n27. a fresh trip with NO REQUEST TIME is still the last trip');
{
  /* This is the operator's own shape and the product was refusing to answer it.
     REVERSION THAT PROVES THIS: in last_near, restore
     `AND t.requested_at <= ${o}.started_at` and drop the IS NULL arm from the
     lower bound. L33303 flips from `last_trip` to `unknown`,
     attribution_responsible becomes "Nobody — the trail is too old." about a
     trail 44 minutes old, and last_uber_driver.means says "44 minutes before
     this journey. That is beyond the 31631-minute cap." */
  const r = rowAt('L33303', '2026-09-03T08:28');
  check('a completed Uber trip with a NULL requested_at still names the person',
    r.attribution_tier === 'last_trip'
    && r.attribution_responsible === 'No Request Time'
    && r.attribution_last_trip_gap_min === 44,
    JSON.stringify([r.attribution_tier, r.attribution_responsible,
      r.attribution_last_trip_gap_min]));
  check('…and nothing on the row calls a 44-minute-old trail too old',
    !/too old/.test(String(r.attribution_responsible))
    && !/beyond the/.test(JSON.stringify(r.attribution_last_uber_driver || {})),
    JSON.stringify([r.attribution_responsible, r.attribution_last_uber_driver]));
  /* Non-vacuous: the seeded row really does carry a NULL request time, which is
     what src/sources/uber.js:192 writes when Uber's CSV omits the column. */
  const [seeded] = await q(
    `SELECT requested_at, ended_at FROM trip WHERE plate = 'L33303' AND ended_at
       = '2026-09-03T07:44:00Z'::timestamptz`);
  check('…and the trip really does have no request time in the database',
    seeded && seeded.requested_at === null && seeded.ended_at !== null,
    JSON.stringify(seeded));
}

console.log('\n28. …and no sentence prints a date this product does not hold');
{
  /* REVERSION THAT PROVES THIS: in hist, change uber_prior and uber_first_at
     back to t.requested_at alone. L33304 reports uber_prior = 0, falls into the
     "history postdates the journey" branch, and prints "the first Uber trip on
     this car was ." — format() renders the NULL date as an empty string rather
     than failing, so the sentence loses its date silently and states two
     falsehoods about a trip 44 minutes before the journey. */
  const r = rowAt('L33304', '2026-09-03T08:28');
  check('a plate whose ONLY Uber trip has no request time is still answered by the rule',
    r.attribution_tier === 'last_trip'
    && r.attribution_responsible === 'Only Trip No Request Time',
    JSON.stringify([r.attribution_tier, r.attribution_responsible]));
  check('…and it is never described as a car whose Uber history postdates the journey',
    !/none of it predates this journey/.test(r.attribution_evidence),
    r.attribution_evidence);
  /* The typographical hole, asserted across the whole response rather than on
     one row: a sentence that lost its date to a NULL leaves a space before a
     full stop, and that is cheap to catch everywhere at once. */
  check('no evidence sentence anywhere on the response has a hole where a date should be',
    all.body.rows.every((x) => !/ \./.test(String(x.attribution_evidence || ''))
      && !/was \.|on \.|至/.test(String(x.attribution_evidence || ''))),
    JSON.stringify(all.body.rows.filter((x) => / \./.test(String(x.attribution_evidence || '')))
      .map((x) => [x.plate, x.attribution_evidence])));
}

console.log('\n29. a contradicting booking FIVE DAYS out is disclosed, not just a six-hour one');
{
  /* REVERSION THAT PROVES THIS: point the later_other column in `tally` back at
     the `others` CTE. L33305's hotel booking is five days before the journey
     and `others` only reaches about twenty hours back, so the clause goes
     silent and the row prints 'Thirteen Days Back' with no mention that
     somebody else demonstrably had the car eight days after his last trip. */
  const r = rowAt('L33305', '2026-09-14T08:00');
  check('the rule still names the last Uber driver, as the operator asked',
    r.attribution_tier === 'last_trip'
    && r.attribution_responsible === 'Thirteen Days Back',
    JSON.stringify([r.attribution_tier, r.attribution_responsible]));
  check('…and the more recent booking by somebody ELSE is disclosed at five days out',
    /One booking this rule does NOT read sits between that trip and the journey/
      .test(r.attribution_evidence)
    && /Five Days Back Hotel/.test(r.attribution_evidence)
    && /5.0 days before the journey began/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and it is disclosed as context, never as a change of name',
    /does not change the name above/.test(r.attribution_evidence)
    && !(r.attribution_candidates || []).some((c) => /Five Days Back/.test(c.name)),
    JSON.stringify(r.attribution_candidates));
}

console.log('\n30. a broken clock is reported as a broken clock, in BOTH places');
{
  /* REVERSION THAT PROVES THIS: replace the no_last_reason CASE in
     `responsible` with the old single branch, `WHEN named.last_people = 0 AND
     named.ever_gap IS NOT NULL THEN 'Nobody — the trail is too old.'`. The
     column starts blaming the age of a trip on a row whose own evidence blames
     the tracker, which is the shape a reader acts on and gets wrong. */
  const r = rowAt('L33306', '2026-09-14T08:00');
  check('the clock refuses the rule, and the COLUMN says so rather than blaming the age',
    r.attribution_responsible === 'Nobody — this car’s clock is untrustworthy.',
    String(r.attribution_responsible));
  check('…and the evidence sentence blames the same thing',
    /a tracker 2339 minutes out of true cannot be compared/.test(r.attribution_evidence)
    && !/the car has left the Uber channel/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and the context name says the AGE is not what refused it',
    r.attribution_last_uber_driver
    && /The AGE is not what refused it/.test(r.attribution_last_uber_driver.means)
    && /clock 2339 minutes behind wall time/.test(r.attribution_last_uber_driver.means)
    && !/beyond the 31631-minute cap/.test(r.attribution_last_uber_driver.means),
    String(r.attribution_last_uber_driver && r.attribution_last_uber_driver.means));
  /* THE GENERAL FORM, over every row on the response rather than this one: the
     column and the sentence are switched off ONE token now, so they can never
     state different reasons. This is the assertion that would catch a seventh
     absence being added to one and not the other. */
  const said = (x) => String(x.attribution_responsible || '');
  check('on EVERY absence on the response, the column and the sentence agree',
    all.body.rows.filter((x) => /^Nobody — /.test(said(x))).every((x) => {
      const e = String(x.attribution_evidence || '');
      if (/clock is untrustworthy/.test(said(x))) return /out of true cannot be compared/.test(e);
      if (/trail is too old/.test(said(x))) return /the car has left the Uber channel/.test(e);
      if (/does not run on Uber/.test(said(x))) return /car on the wrong channel/.test(e);
      if (/no booking of any kind/.test(said(x))) return /no booking identity at all/.test(e);
      if (/history starts after the journey/.test(said(x))) return /none of it predates this journey/.test(e);
      if (/no usable time/.test(said(x))) return /not one of them carries a usable timestamp/.test(e);
      if (/name no driver/.test(said(x))) return /filed WITHOUT A DRIVER NAME/.test(e);
      if (/was completed/.test(said(x))) return /otherwise not completed/.test(e);
      if (/named and completed/.test(said(x))) return /not one of them is a NAMED, COMPLETED trip/.test(e);
      if (/lookback/.test(said(x))) return /the lookback floor the rule scans on/.test(e);
      return false;
    }),
    JSON.stringify(all.body.rows.filter((x) => /^Nobody — /.test(said(x)))
      .map((x) => [x.plate, said(x)])));
}

console.log('\n31. the CONTEXT name ties too, and a tie is not a name');
{
  /* REVERSION THAT PROVES THIS: collapse ever_at and ever back into one CTE
     with `ORDER BY t.ended_at DESC LIMIT 1`. The row names whichever of the two
     the planner returned first as the singular "last Uber driver of record" —
     which is the one sentence an operator ringing round would act on — and the
     other human being disappears from the response entirely. */
  const r = rowAt('L33307', '2026-09-14T08:00');
  check('two drivers ending at one instant produce NO single last driver of record',
    r.attribution_last_uber_driver
    && r.attribution_last_uber_driver.name === null
    && r.attribution_last_uber_driver.person_count === 2,
    JSON.stringify(r.attribution_last_uber_driver));
  check('…and BOTH are named, in name order, rather than one being hidden',
    r.attribution_last_uber_driver.names === 'Aaron Context Tie, Bashir Context Tie'
    && /NO SINGLE NAME/.test(r.attribution_last_uber_driver.means),
    JSON.stringify(r.attribution_last_uber_driver));
  check('…and the evidence sentence says the tie exists rather than picking one',
    /ended at that very same instant/.test(r.attribution_evidence)
    && /will not nominate one of them/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and neither of them becomes a candidate',
    (r.attribution_candidates || []).length === 0
    && !(r.attribution_candidate_keys || []).some((k) => /context tie/.test(String(k))),
    JSON.stringify([r.attribution_candidates, r.attribution_candidate_keys]));
}

console.log('\n32. a limit in the query is reported as a limit in the query');
{
  /* REVERSION THAT PROVES THIS: change the 'stale' arm of no_last_reason back
     to `WHEN tally.ever_gap IS NOT NULL THEN 'stale'` and delete the
     lookback_floor arm. The row then says "21.5 days before this journey. That
     is beyond the 31631-minute cap (21.97 days)" — a clause contradicting its
     own two numbers — and adds that the car has left the Uber channel, about a
     car worked three weeks earlier. */
  const r = rowAt('L33308', '2026-09-03T08:00');
  check('a trip INSIDE the cap is never reported as too old',
    r.attribution_responsible === 'Nobody — this query’s lookback, not the car’s record.'
    && !/the car has left the Uber channel/.test(r.attribution_evidence),
    `${r.attribution_responsible} :: ${r.attribution_evidence}`);
  check('…and the sentence names the floor, and says it is the query’s reach not the car’s',
    /INSIDE the 31631-minute cap/.test(r.attribution_evidence)
    && /the lookback floor the rule scans on/.test(r.attribution_evidence)
    && /This is the query’s reach, not the car’s record/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and the context name says the same thing rather than blaming the age',
    /The AGE is not what refused it/.test(r.attribution_last_uber_driver.means)
    && /a limit in the query rather than a fact about the car/
       .test(r.attribution_last_uber_driver.means),
    r.attribution_last_uber_driver.means);
  /* The gap really is inside the cap, so the old sentence was arithmetically
     self-contradicting and not merely loose. */
  check('…and the gap it is talking about really is inside the cap',
    r.attribution_last_uber_driver.gap_min < STALE_CAP_MIN,
    `${r.attribution_last_uber_driver.gap_min} vs ${STALE_CAP_MIN}`);
}

console.log('\n33. two causes are stated as two causes');
{
  /* REVERSION THAT PROVES THIS: restore WHY_NO_LAST's old branch order — the
     `uber_prior = uber_nameless` equality before the cancellation branch. This
     plate satisfies neither premise, falls through, and asserts "every earlier
     Uber ride on L33309 was CANCELLED and carries no end time" about two trips
     that completed normally and are merely anonymous in our record. */
  const r = rowAt('L33309', '2026-09-14T08:00');
  check('a car with BOTH anonymous and cancelled prior trips gets neither single-cause sentence',
    !/every one of them is filed WITHOUT A DRIVER NAME/.test(r.attribution_evidence)
    && !/every earlier Uber ride on L33309 that names a driver was CANCELLED/
       .test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and each count is stated on its own, with the right number against it',
    /2 filed without a driver name/.test(r.attribution_evidence)
    && /1 cancelled, rejected or otherwise not completed/.test(r.attribution_evidence)
    && /HAS 3 Uber trip\(s\) before this journey/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and the column says what was actually missing, not one of the two causes',
    r.attribution_responsible
      === 'Nobody — no earlier Uber trip here is both named and completed.',
    String(r.attribution_responsible));
}

console.log('\n34. "filed against nobody" is a claim about the journey, so it is tested on the row');
{
  /* REVERSION THAT PROVES THIS: in last_uber_driver's means, replace the
     tier-aware branch with the old unconditional clause "…and this journey is
     filed against nobody's profile anywhere in the product." The response then
     says a journey is attributed to nobody on the same row that files it
     against Only Custodian Here and increments her "Named beside" tile. */
  const r = rowAt('L33310', '2026-09-14T08:00');
  check('the ladder does reach a person through custody on this row',
    r.attribution_tier === 'sole_custodian'
    && r.attribution_responsible === 'Only Custodian Here'
    && (r.attribution_candidate_keys || []).length === 1,
    JSON.stringify([r.attribution_tier, r.attribution_responsible,
      r.attribution_candidate_keys]));
  check('…so the context name does NOT claim the journey is filed against nobody',
    r.attribution_last_uber_driver
    && !/filed against nobody/.test(r.attribution_last_uber_driver.means)
    && /This journey is NOT unattributed/.test(r.attribution_last_uber_driver.means)
    && /Only Custodian Here/.test(r.attribution_last_uber_driver.means),
    String(r.attribution_last_uber_driver && r.attribution_last_uber_driver.means));
  check('…and the over-cap name is still returned, and still not a candidate',
    r.attribution_last_uber_driver.name === 'Ancient Uber Driver'
    && !JSON.stringify(r.attribution_candidates).includes('Ancient')
    && !(r.attribution_candidate_keys || []).some((k) => /ancient/.test(String(k))),
    JSON.stringify([r.attribution_last_uber_driver.name, r.attribution_candidates]));
  /* THE GENERAL FORM. The phrase is a claim about the whole product's filing of
     this journey, so it may appear only where nothing is filed. */
  check('no row on the response claims to be filed against nobody while naming a candidate',
    all.body.rows.every((x) => !(
      /filed against nobody/.test(JSON.stringify(x.attribution_last_uber_driver || {}))
      && (x.attribution_candidate_count || 0) > 0)),
    JSON.stringify(all.body.rows
      .filter((x) => /filed against nobody/
        .test(JSON.stringify(x.attribution_last_uber_driver || {})))
      .map((x) => [x.plate, x.attribution_candidate_count])));
}

console.log('\n35. a counterfactual is evaluated before it is asserted');
{
  /* REVERSION THAT PROVES THIS: restore the unconditional closing clause "so it
     is reported as a bracket even though the last-trip rule would name the same
     person". On this row the last-trip rule names TWO people and chooses
     neither, so the sentence tells a reader the weaker rule agreed when the
     weaker rule refused to answer. */
  const r = rowAt('L33311', '2026-09-03T12:00');
  check('the bracket still fires — a tie on the before side does not break it',
    r.attribution_tier === 'bracketed'
    && r.attribution_responsible === 'Bracketer Ecks'
    && r.bracket_before_min === 30 && r.bracket_after_min === 30,
    JSON.stringify([r.attribution_tier, r.attribution_responsible,
      r.bracket_before_min, r.bracket_after_min]));
  check('…and the row does NOT claim the last-trip rule would name the same person',
    !/would name the same person/.test(r.attribution_evidence)
    && !/the operator’s last-trip rule, run on the same car, names the same person/
       .test(r.attribution_evidence),
    r.attribution_evidence);
  check('…it says what is true instead: that rule does not separate these two on its own',
    /does NOT separate these two on its own/.test(r.attribution_evidence)
    && /Bracketer Ecks, Tied Why/.test(r.attribution_evidence)
    && /the trip on the FAR side of the journey that narrows it to one/
       .test(r.attribution_evidence),
    r.attribution_evidence);
  /* …and where the two rules DO agree, the claim is still made, because the
     fix is a weaker SENTENCE and not a removed one. */
  const agree = rowAt('L44305', '2026-09-03T08:28') && rowAt('L45243', '2026-08-24T05:33');
  check('…while a bracket the last-trip rule DOES corroborate still says so',
    /names the same person/.test(agree.attribution_evidence),
    agree.attribution_evidence);
}

console.log('\n36. a measurement is quoted only inside the band it was measured in');
{
  /* REVERSION THAT PROVES THIS: make the corroborating figure unconditional
     again. The row then prints "Measured over 120 journeys the two disagree on
     2, and both were read off a trip more than six months old" directly beneath
     a name it read off a 13-day-old trip that day-custody contradicts — a
     self-refuting reassurance next to an accusation. */
  const r = rowAt('L33312', '2026-09-14T08:00');
  check('the disagreement with day-custody is stated outright, not hidden',
    r.attribution_tier === 'last_trip'
    && /Day-custody DISAGREES/.test(r.attribution_evidence)
    && /Today Custodian Only/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and the 0-of-120 figure is NOT quoted on a row that falsifies it',
    !/the two disagree on 2/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…the row says the measurement does not cover this shape, and why',
    /does NOT cover this shape and must not be quoted here/.test(r.attribution_evidence)
    && /it counted disagreements at 0 of 120 under the cap, and this is one/
       .test(r.attribution_evidence)
    && /13.0 days old/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n37. the response says what its own aggregate spans, and what its rows are');
{
  /* Not a sentence on a row: three claims the DRIVER endpoint makes about its
     own two lists. api/public/segments.js states the rule this endpoint was
     breaking — "One column per rung of the ladder, and they are never added
     together" — while `attributed.total` sums three rungs of different strength
     under one amber tile.

     REVERSION THAT PROVES THIS: delete total_basis, rows_are_not_trips and
     tiers from api/unauthorized_routes.js, and restore also_a_candidate's
     heading to 'Cars this person held on a day an unexplained journey
     happened'. Every assertion in this block fails. */
  const d = await get(`/api/driver/unauthorized?id=u-sami&${WIN}`);
  check('the driver endpoint answers', d.status === 200, String(d.status));
  check('the attributed total says outright that it spans three rungs of different strength',
    /THREE RUNGS OF DIFFERENT STRENGTH/.test(d.body.attributed.total_basis || '')
    && /must not be quoted on its own/.test(d.body.attributed.total_basis || '')
    && /Read by_tier, not this number/.test(d.body.attributed.total_basis || ''),
    String(d.body.attributed.total_basis));
  check('…and it names the three counts it is the sum of, so the split is checkable',
    d.body.attributed.total === (d.body.attributed.by_tier.bracketed
      + d.body.attributed.by_tier.last_trip + d.body.attributed.by_tier.sole_custodian)
    && new RegExp(`${d.body.attributed.by_tier.last_trip} by the operator’s`)
      .test(d.body.attributed.total_basis || ''),
    JSON.stringify([d.body.attributed.total, d.body.attributed.by_tier]));
  check('…and it tells a renderer not to give the mixed figure a verdict colour',
    /must not give it a verdict colour/.test(d.body.attributed.total_basis || ''),
    String(d.body.attributed.total_basis));
  /* The interleave: driver.js sorts these rows into the person's own trip
     ledger, and its comment enumerates the TWO rungs that existed before the
     operator's rule. The membership is data now, and the obligation is stated. */
  check('the list declares which rungs it holds, as data rather than as prose',
    Array.isArray(d.body.attributed.tiers)
    && d.body.attributed.tiers.join() === 'bracketed,last_trip,sole_custodian',
    JSON.stringify(d.body.attributed.tiers));
  check('…and says outright that these rows are not things this person did',
    /NO booking, placed beside this person by an inference/
      .test(d.body.attributed.rows_are_not_trips || '')
    && /must show attribution_tier on every one of them/
       .test(d.body.attributed.rows_are_not_trips || '')
    && /must not caption the mixed table as a complete record/
       .test(d.body.attributed.rows_are_not_trips || ''),
    String(d.body.attributed.rows_are_not_trips));
  /* The ambiguous tier has a second entrance — a TIE on the last Uber trip,
     where the candidates come from the trip table and not from custody — and
     these two strings described day-custody only, directly contradicting the
     row's own "Day-custody is NOT used to break this tie". */
  check('the candidate list no longer claims custody is why somebody is on it',
    !/Cars this person held on a day an unexplained journey happened/
      .test(d.body.also_a_candidate.heading)
    && /one of several candidates for/.test(d.body.also_a_candidate.heading),
    String(d.body.also_a_candidate.heading));
  /* Asserted against a person who actually HAS an ambiguous row, so the
     populated branch of `means` is the one being read. */
  const amb = await get(`/api/driver/unauthorized?id=u-waseem&${WIN}`);
  check('…and its meaning covers both entrances to the ambiguous tier',
    amb.body.also_a_candidate.total > 0
    && /The evidence reaches this person and it reaches somebody else/
      .test(amb.body.also_a_candidate.means)
    && /ended at the very same instant/.test(amb.body.also_a_candidate.means),
    `${amb.body.also_a_candidate.total} :: ${amb.body.also_a_candidate.means}`);
  /* The rule string on the fleet response claims COMPLETED, and that claim is
     only true now that last_near actually applies COMPLETED(). */
  check('the fleet response’s rule string claims completed-only, and the SQL now honours it',
    /most recent COMPLETED Uber trip/.test(all.body.last_trip.rule || ''),
    String(all.body.last_trip.rule));
}

console.log('\n39. a NULL request time never turns a ten-month-old trail into "no history yet"');
{
  /* REVERSION THAT PROVES THIS: in hist, change uber_prior back to
     `count(*) FILTER (… AND t.requested_at <= ${o}.started_at)` and
     uber_first_at back to `min(t.requested_at) FILTER (…)`. L33313 reports
     uber_prior = 0, takes the "history postdates this journey" branch, and
     prints "the first Uber trip on this car was ." — a false statement about
     the car with a typographical hole where format() rendered the NULL. */
  const r = rowAt('L33313', '2026-08-31T04:00');
  check('the true reason is the AGE of the trip, not an absence of one',
    r.attribution_responsible === 'Nobody — the trail is too old.'
    && /ended 304.1 days before this journey began, on 2025-10-31/
       .test(r.attribution_evidence),
    `${r.attribution_responsible} :: ${r.attribution_evidence}`);
  check('…and it is never described as a car whose Uber history postdates the journey',
    !/none of it predates this journey/.test(r.attribution_evidence)
    && !/had not happened yet/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and the refused name is still reported as context',
    r.attribution_last_uber_driver
    && r.attribution_last_uber_driver.name === 'Old And No Request Time',
    JSON.stringify(r.attribution_last_uber_driver));
}

console.log('\n40. a trip with no usable timestamp gets its own sentence, and no invented date');
{
  /* REVERSION THAT PROVES THIS: delete the `AND tally.uber_first_at IS NOT
     NULL` guard from the no_prior arm of no_last_reason and remove the
     'undateable' arm. L33314 falls into the no_prior branch and renders a NULL
     through to_char(), which format() prints as an empty string — the same trap
     ROSTER_CLAUSE records having been bitten by once, and the reason that
     guard is on the VALUE rather than on the formatted sentence. */
  const r = rowAt('L33314', '2026-08-31T04:00');
  check('a car whose Uber rows carry no times at all says so, and prints no date',
    r.attribution_responsible === 'Nobody — this car’s Uber trips carry no usable time.'
    && /not one of them carries a usable timestamp/.test(r.attribution_evidence)
    && /no date is printed here because this product does not hold one/
       .test(r.attribution_evidence),
    `${r.attribution_responsible} :: ${r.attribution_evidence}`);
  check('…and it is NOT reported as a car whose history postdates the journey',
    !/none of it predates this journey/.test(r.attribution_evidence),
    r.attribution_evidence);
  check('…and no date-shaped hole is left anywhere in the sentence',
    !/was \./.test(r.attribution_evidence) && !/ \./.test(r.attribution_evidence),
    r.attribution_evidence);
}

/* CLOSE THE SERVER AND THE DATABASE, AND EXIT EXPLICITLY.
   mountAll calls app.listen(0) with keepAliveTimeout = 0, so idle sockets are
   never reaped and PGlite holds its own handles; without this the file prints
   its tally and never exits, and test/run-all.mjs SIGKILLs it at 300 s and
   reports it as FAILING with every one of its assertions passing. Every other
   mounted-route test in this directory ends exactly this way. */
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
