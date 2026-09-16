/* WHO GETS NAMED BESIDE AN UNEXPLAINED JOURNEY, AND WHO DOES NOT.
   ═══════════════════════════════════════════════════════════════════════════
   An unauthorized trip is, by definition, a journey with no booking against
   it — so there is no trip record naming its driver, and every name this
   feature prints is an INFERENCE. Naming the wrong person accuses an innocent
   employee of theft. That is what makes this file's assertions load-bearing in
   a way an aggregate's are not: the failure mode is not a wrong number on a
   chart, it is a wrong name on an accusation.

   Five things are asserted and each one is a defect that has either happened
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

   Against a real Postgres through mountAll, because every one of these is SQL
   and no amount of reading it would catch a wrong join or a missing fold.

   Each assertion below was proved by REVERSION, not by passing: the named
   expression in api/unauthorized_sql.js was broken, this file was run and the
   assertion watched to fail, and the expression was restored. The reversion
   that proves each one is written beside it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { TIERS, BRACKET_CAP_MIN } from '../api/unauthorized_sql.js';

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

const { get, server } = await mountAll(db);
const WIN = 'from=2026-08-01&to=2026-09-30';
const all = await get(`/api/unauthorized/attributed?${WIN}&limit=500`);
const rowAt = (plate, iso) => all.body.rows.find(
  (r) => r.plate === plate && String(r.started_at).slice(0, 16) === iso);

console.log('the fleet list answers, and every row carries a tier and a reason for it');
{
  check('the route answers', all.status === 200, String(all.status));
  check('every segment in the window is attributed to exactly one tier',
    all.body.rows.length === 6
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
    all.body.distribution.segments === 6
    && all.body.distribution.bracketed === 1
    && all.body.distribution.ambiguous === 1
    && all.body.distribution.unknown === 1
    && all.body.distribution.sole_custodian === 3,
    JSON.stringify(all.body.distribution));
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
  /* The exclusion is what makes a bracket evidence rather than coincidence. */
  check('the claim that nobody else had the car in between is stated, not assumed',
    /No other driver has a booking on this car between those two/.test(r.attribution_evidence),
    r.attribution_evidence);
}

console.log('\n2. a handover day with nothing to separate the two is AMBIGUOUS, and names both');
{
  const r = rowAt('L45243', '2026-09-12T12:27');
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
  check('and it says WHY time could not separate them',
    new RegExp(`no Uber trip on this car ends within ${BRACKET_CAP_MIN} minutes before`)
      .test(r.attribution_evidence), r.attribution_evidence);
  /* The trips that exist on this plate that day are 707 and 318 minutes away.
     An uncapped bracket would reach both and name Waseem off a car that was
     idle in between — which is the L45235 shape the cap was measured to stop. */
  check('a trip far outside the cap does not bracket anything',
    r.bracket_before_min === null && r.bracket_after_min === null,
    `${r.bracket_before_min} / ${r.bracket_after_min}`);
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
  check('so the tier is sole_custodian rather than a manufactured ambiguity',
    r.attribution_tier === 'sole_custodian', r.attribution_tier);
  check('the two spellings fold to one person key',
    r.attribution_candidate_keys.length === 1
    && r.attribution_candidate_keys[0] === 'umair khan shah',
    JSON.stringify(r.attribution_candidate_keys));
  /* Custody, stated as custody. "Held by X that day" is a conversation;
     "X drove it" is an accusation the evidence does not support. */
  check('and the sentence says custody, not driving',
    /this is custody, not driving/.test(r.attribution_evidence), r.attribution_evidence);
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
  check('and the custodian named is the Dubai day’s, not the UTC day’s',
    r.attribution_candidates.length === 1
    && r.attribution_candidates[0].name === 'Night Custodian',
    JSON.stringify(r.attribution_candidates));
  check('the sentence dates itself on the Dubai day too, so the two cannot disagree',
    /on 2026-09-06/.test(r.attribution_evidence), r.attribution_evidence);
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
}

console.log('\nthe tier filter selects on the ladder, not on a word in the reason');
{
  const r = await get(`/api/unauthorized/attributed?${WIN}&tier=ambiguous`);
  check('only the ambiguous segment comes back',
    r.body.rows.length === 1 && r.body.rows[0].plate === 'L45243'
    && r.body.rows[0].attribution_tier === 'ambiguous',
    JSON.stringify(r.body.rows.map((x) => [x.plate, x.attribution_tier])));
  /* Facets computed over the current filter tell a reader nothing about what
     else is there — the rule /api/segments already applies. */
  check('…while the distribution still describes the whole window',
    r.body.distribution.segments === 6, JSON.stringify(r.body.distribution));
  const bogus = await get(`/api/unauthorized/attributed?${WIN}&tier=definitely`);
  check('an unknown tier is ignored rather than returning an empty page as a clean one',
    bogus.body.rows.length === 6 && bogus.body.filter.tier === null,
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
    && all.body.coverage.days_with_data === 6
    && all.body.coverage.days_in_window === 61
    && /6 of the 61 days/.test(all.body.coverage.note || ''),
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
    r.body.attributed.total === 1
    && r.body.attributed.rows[0].plate === 'L45243'
    && r.body.attributed.rows[0].attribution_tier === 'bracketed',
    JSON.stringify(r.body.attributed.rows.map((x) => [x.plate, x.attribution_tier])));
  check('the one he is merely a candidate for is under `also_a_candidate`',
    r.body.also_a_candidate.total === 1
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
  check('the person time RULED OUT is attributed nothing',
    w.body.attributed.total === 0, JSON.stringify(w.body.attributed.rows.map((x) => x.plate)));
  check('…and appears only under the ambiguous heading',
    w.body.also_a_candidate.total === 1, String(w.body.also_a_candidate.total));
  /* The coverage note has to reach the driver page too, or an empty tab reads
     as a clean record rather than as an absence of evidence. */
  check('the driver page carries the same coverage note as the fleet page',
    w.body.coverage.days_with_data === all.body.coverage.days_with_data
    && /days/.test(w.body.coverage.note || ''), JSON.stringify(w.body.coverage));
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
