/* WHO WAS DRIVING, WHEN NOTHING BOOKED THE JOURNEY.
   ═══════════════════════════════════════════════════════════════════════════
   An unauthorized trip is, BY DEFINITION, a journey with no booking against
   it. There is therefore no trip record naming a driver — if there were, the
   reconciler would have matched it and the verdict would not be `unauthorized`
   at all. Every name this module puts beside one of these journeys is an
   INFERENCE, and naming the wrong person accuses an innocent employee of
   theft. So the module's contract is not "name the driver". It is:

     say which rule named this person, state the measurement that rule ran, and
     where the evidence cannot single out ONE person, say so and list every
     candidate rather than picking the likeliest.

   api/custody_sql.js already states the principle this inherits from:
   "L45240 carried a passenger with no booking" is an accusation nobody can act
   on; "L45240, held by Kashif Ali that day" is a conversation. Day-grain
   custody is where that file stops, and it is exactly where the operator's
   request begins — because a HANDOVER DAY names two people for one journey
   that had one driver, and today /api/unauthorized/list prints both.

   ── THE LADDER, AND THE MEASUREMENT THAT SET IT ────────────────────────────
   Measured against production over from=2026-06-01&to=2026-09-16 — all 120
   unauthorized segments, not a sub-sample. The first column is the ladder as
   it shipped in b01bb70; the second is the ladder as it stands now, after the
   operator's last-trip rule was added between `bracketed` and `sole_custodian`:

     bracketed        13 -> 13   named by TIME, on Uber trips either side
     last_trip         – -> 45   the operator's rule; see the block below
     sole_custodian   48 -> 24   one custodian that day; custody, not driving
     ambiguous        26 -> 13   two or more candidates; NO choice is made
     unknown          33 -> 25   nobody nameable; no name is invented

   Those second-column figures are the measured effect of the cap applied
   below: the rule names 90 of 120 journeys where the old ladder named 61 by a
   single name, and it resolves 13 of the 26 two-name handover rows to one
   person. They are a projection from the measurement, not a re-run of the
   endpoint, because /api/unauthorized/attributed is built and committed but
   not yet deployed — the measurement reproduced the shipped distribution
   exactly (13/48/26/33, all four to the unit) from /api/unauthorized/list's
   driver_refs plus /api/vehicle/trips, which is the strongest available check
   that the reproduction is faithful.

   ── THE OPERATOR'S RULE, IN THEIR OWN WORDS ────────────────────────────────
   "usually one person drives per car. so we will take the last trip custodian
    for that specific vehicle. whoever did the last trip on uber is the one
    responsible."

   That is domain knowledge this database does not hold and cannot derive.
   There is no key handover, no keyfob identity and no driver-ID field on the
   telematics; occupancy_segment carries a seat sensor and a GPS trace, i.e.
   that SOMEBODY was in the car, never who. The rule fills exactly that gap.

   It sits BELOW `bracketed` and ABOVE `sole_custodian`, and both placements
   were reasoned rather than assumed:

     - below `bracketed`, because a bracket has a trip on BOTH sides of the
       journey and the last-trip rule has one. Strictly more evidence wins.
       (The two can never name different people: a bracket is disqualified by
       any other driver's booking between its two sides, so the bracketing
       person IS the last person to have finished a trip before the journey.
       The ordering therefore decides the LABEL and the two stated gaps, not
       the name.)
     - above `sole_custodian` and above `ambiguous`, because resolving the
       handover day is the whole point. Day-custody names everyone who held the
       car that Dubai day and cannot choose; the last-trip rule picks whoever
       most recently had it, which is the correct answer on a handover day and
       is precisely the case that produced `ambiguous`. Measured: 13 of the 26
       ambiguous rows resolve to one person, and in all 13 the person the rule
       picks is ONE OF THE DAY'S OWN CUSTODIANS — it narrows the list, it never
       steps outside it. A further 20 `unknown` rows (33 uncapped) get a name
       the day rollup could not reach, because the rule reads the trip table
       directly rather than vehicle_driver_day.

   WHAT IT IS NOT. It is not a measurement and it must never be printed as one.
   Nothing in this building records who was in that car, so there is no ground
   truth, no precision and no recall — every agreement figure quoted below is
   agreement with day-custody, which is a weaker inference off the same trip
   table. That is CONSISTENCY, not accuracy. The evidence sentence therefore
   says what was actually tested — "the last Uber trip on this car before the
   journey was X's, ending 44 minutes earlier" — and never "X made this
   journey".

   ── THE TIER THAT IS NOT HERE, AND WHY ─────────────────────────────────────
   The brief that commissioned this proposed a strongest tier ON SHIFT:
   driver_status_event (sql/schema_v70.sql) shows exactly one person ONLINE or
   ONTRIP across the segment window. It is provider-timestamped and it is the
   best evidence in the building — and it is NOT an attributor here, because it
   was measured and it names nobody:

     - driver_status_event begins 2026-09-14T12:53:35Z. It is append-only from
       the day the collector started writing it and there is no backfill, so
       113 of the 120 segments have no status history and never will.
     - On all 7 segments that ARE inside the history, EVERY candidate was
       OFFLINE for 100% of the window, or had no event that day at all. Tier
       (a) named a driver on 0 of 7.

   That is structural, not a small sample: an unauthorized trip is by
   definition a journey no channel booked, which for an Uber-fleet driver means
   the app was off. "Exactly one person ONLINE across the window" is close to
   unfalsifiable-in-the-positive on precisely the population it would be
   applied to.

   So the status feed is kept for the one job it is genuinely good at and
   labelled as what it is — CORROBORATION, never attribution. See
   statusJoin() below. "L44251's only custodian was offline on Uber for the
   whole of this journey" is a true, useful, non-accusatory sentence. It does
   not promote anyone to a tier and it never names anyone who was not already
   named by the ladder. Re-confirmed while adding the last-trip rule: the feed
   cannot validate a single one of the rule's namings either.

   ── WHAT MAY HONESTLY BE CLAIMED FROM A CLOCK ──────────────────────────────
   src/reconcile.js RULES constrain this file. matchToleranceMin is 15 — the
   booking/segment clock drift the reconciler itself allows — so a bracket
   built tighter than fifteen minutes would claim a precision the reconciler
   refuses. bookingLagMin is 120: a journey ending within two hours of the
   window edge has not had time to acquire a booking. maxDurationHr is 8, which
   is what bounds the lookback below.

   And clock skew is real here. api/segment_routes.js extracts "(N) min behind"
   out of verdict_reason for a reason its own header records: "thirteen
   accusations each showing a nearest booking exactly 240 minutes away is one
   bug, not thirteen dishonest drivers". A tracker whose clock is days out
   cannot be compared against a booking at all, so a segment carrying a skew is
   never bracketed — it falls to custody, and the evidence sentence says why.
   The last-trip rule INHERITS that gate rather than dropping it: the whole
   rule is one clock comparison (journey start against trip end), so a clock
   days out of true makes it exactly as worthless as it makes the bracket.
*/

/* One definition of who a person is, imported rather than re-typed.
   api/custody_sql.js records what happens otherwise: counting driver_ext_id
   answered SEVEN drivers for a car five humans drove, and listed two of the
   five twice, side by side, with their days split between the rows. On an
   accusation surface that same defect is worse than untidy — measured on
   production, /api/unauthorized/list returns 2+ names that are ONE human on 12
   of the 120 segments ("Fahad Ali Amjad Ali" AND "FAHAD ALI AMJAD ALI";
   "Muhammad Ahmad khan" and "Muhammad Ahmad Ghulam Qadir", which
   api/identity_map.js already holds as one register entry; three names for one
   man on L44305). Folded on the stored person key those counts become
   0:33 / 1:58 / 2:28 / 3:1 — twelve second names next to an accusation, gone.

   personKeyStored is `coalesce(nullif(a.person_key,''), a.driver_ext_id)`, and
   both tables this module reads carry that generated column: trip
   (sql/schema_v20.sql) and vehicle_driver_day, rebuilt register-aware by
   sql/schema_v53.sql from api/identity_map.js.

   The last-trip rule folds on the SAME key and for the same reason: two Uber
   accounts of one man whose trips end at the same instant are one candidate,
   not a tie, and the journey has to reach his profile whichever account is
   opened. */
import { personKeyStored } from './custody_sql.js';

/* HOW FAR EITHER SIDE A BOOKING MAY SIT AND STILL BRACKET A JOURNEY.
   ─────────────────────────────────────────────────────────────────────────
   The cap is the whole argument, because the distribution moves violently with
   it. Measured over the same 120 segments, Uber-only:

     no cap (anything within ±1 day)   bracketed 31
     480 min                           bracketed 18
     240 min                           bracketed 13   ← this
     120 min (RULES.bookingLagMin)     bracketed  8
      60 min                           bracketed  2

   An uncapped bracket is not a better answer, it is a different claim: it
   brackets across a day and a half of an idle car. L45235 on 2026-09-09 has no
   trip on the day itself at all and comes out "bracketed" off a trip on the
   8th and another on the 10th. The cap is the difference between evidence and
   a number, so it is a named constant, it is stated in every sentence this
   module writes, and it travels on the response. */
export const BRACKET_CAP_MIN = 240;

/* src/reconcile.js RULES.matchToleranceMin, restated rather than imported —
   api/ does not import from src/ anywhere else and one number is cheaper than
   a new dependency edge from the read API into the collector. It is the
   booking/segment clock drift the reconciler itself allows, and it is what
   decides when several unexplained journeys on one plate showing the SAME
   distance to their nearest booking are a constant offset rather than a
   coincidence. If RULES changes, this changes with it; the test asserts the
   pair are equal. */
export const MATCH_TOLERANCE_MIN = 15;

/* HOW STALE THE LAST UBER TRIP MAY BE AND STILL NAME SOMEBODY.
   ─────────────────────────────────────────────────────────────────────────
   The operator gave the rule and did not give a cap, and a cap is unavoidable:
   "whoever last drove it" is a strong claim when the last trip ended forty
   minutes earlier and an empty one when it ended nine months earlier. So the
   cap was MEASURED the same way the bracketing window was, and it is not a
   round number because it was not chosen.

     STALE_CAP_MIN = 31,631 minutes = 21.97 days

   It is the 99.9th percentile of this fleet's OWN gap between consecutive Uber
   trips, over 21,942 consecutive trip pairs on the 20 flagged plates.

   THE SENSITIVITY TABLE, over the 105 journeys the uncapped rule names, so the
   next person can see what a looser cap would buy before loosening it:

     cap            journeys named    disagreements with day-custody
     no cap              105                    2
     21.97 d (this)       90                    0
     7 d                  70                    0
     24 h                 45                    0
      4 h                 25                    0
      1 h                 12                    0

   Three independent measurements put the line in the same place, which is why
   this is a measurement and not a preference:

   (1) THE EMPIRICAL GAP IN THE DISTRIBUTION. The 105 staleness values run
       CONTINUOUSLY from 23 min to 29,500 min (20.49 d) — 90 values, no gap
       wider than 3,426 min anywhere in that run. Then a void of 195,570 min
       (135.8 days) with nothing in it at all, then 15 values clustered at
       156.3-304.1 d. That single jump is 4.3x the next largest jump in the
       whole distribution. This is not a continuum with a fuzzy tail, it is two
       populations, and ANY cap in [20.49 d, 156.3 d] separates them
       identically.

   (2) WHAT "STILL IN SERVICE" MEANS ON THIS FLEET. The cap has to encode the
       operator's own premise — the car is in service and one person drives it
       — so the question is how long a WORKING car here normally goes between
       Uber trips. Over those 21,942 pairs: p50 40, p75 152, p90 773, p95
       1,087, p98 1,494, p99 2,573, p99.5 4,054, p99.9 31,631, max 270,357
       (minutes). A gap longer than 31,631 is in the 0.1% tail: that is not a
       car resting, it is a car that has left the Uber channel.

   (3) THE ONLY PRECISION PROXY THERE IS, AND IT BREAKS EXACTLY THERE. Nothing
       proves who drove an unauthorized journey, so the only available check is
       whether the rule agrees with the independent day-custody source. By
       staleness bucket, counting only rows where day-custody names anyone:
       <1h 12/12, 1-4h 13/13, 4-12h 10/10, 12-24h 7/7, 1-3d 12/12, 3-7d 7/7,
       7-21d 9/9 — 70 of 70. Above 21 days: 0 of 2. Every journey where the
       rule contradicts day-custody is on the far side of the void.

       HONESTY NOTE THAT MUST TRAVEL WITH (3) WHEREVER IT IS QUOTED: the 7-21d
       bucket's 9/9 is NINE samples, because 11 of the 20 journeys in that
       bucket have no day-custody row to check against at all. The curve is
       strong and it is THIN at the far end. 70/70 is not 70 independent
       confirmations spread evenly and must never be rendered as a hit rate —
       it is agreement between two inferences drawn from the same trip table.

   EFFECT OF THE CAP: names 90 of 120 (75%) instead of 105 (88%);
   disagreements with day-custody fall from 2 to 0; and 15 journeys move from
   "named off a trip six to ten months old" to absent-with-a-reason. Both of
   the two uncapped disagreements are artefacts of reading a months-old trip
   (L63970, 304 days; L74169, 188 days) rather than cases where day-custody got
   a live handover wrong — so the rule's justification is COVERAGE and
   RESOLUTION, never the correction of two misattributions. */
export const STALE_CAP_MIN = 31631;

/* THE SECOND BOUNDARY, WHICH IS NOT A SECOND CAP — both bands name the person.
   p98 of the same in-service inter-trip gap is 1,494 minutes (24.9 h). At or
   under it the car was in continuous normal Uber service across the journey
   and the claim is at its strongest (45 of the 90). Above it and under the cap
   the car was still in service but in an abnormally quiet spell (the other
   45), and the sentence LEADS with the age of the trip instead of the name.
   The split exists so that a page can say "their trip ended 44 minutes
   earlier" and "their trip ended 13 days earlier" in visibly different voices
   rather than in one uniform sentence that flattens the difference. */
export const FRESH_BAND_MIN = 1494;

/* Uber only, because the operator asked for Uber — "we can match who drove
   that car using uber" — and because it is the channel whose coverage on this
   fleet is near total. Measured, for the record, so a later change is a
   decision rather than a discovery: letting Bolt and the hotel channel bracket
   as well moves the distribution to 50/30/22/13/5 at the five caps above, i.e.
   22 rather than 13 at this cap. Widening it is defensible; doing it silently
   is not.

   THE LAST-TRIP RULE REUSES THIS LIST RATHER THAN FORKING IT, and that has a
   measured cost which is OPEN WITH THE OPERATOR rather than settled here:
   15 of 120 journeys (12.5%) are on L46706, which has 491 hotel-channel trips
   in the last 11.5 months by at least ten drivers and ZERO Uber trips ever;
   a further 13 are on plates whose Uber history simply stopped months ago
   (L82907 last Uber 2026-02-20 then hotel; L78465 last Uber 2026-04-11 then
   Bolt; L63970 hotel and Bolt only all year). Together 28 of 120, 23%, where
   the honest answer is "this car does not run on Uber". Falling back to the
   last trip on ANY channel would name 27 of those 28 and is a ONE-LINE change
   to this constant — but it is a different claim about a different channel's
   data quality, so it waits for the operator rather than being taken here. The
   evidence sentence says which of the two absences it hit. */
export const BRACKET_PLATFORMS = ['uber'];

/* The clock skew the reconciler wrote into its own reason line, as an int.
   Byte-identical to api/segment_routes.js's SKEW so the two surfaces cannot
   come to disagree about which segments are unusable. */
export const SKEW = (col) => `(regexp_match(${col}, '([0-9]+) min behind'))[1]::int`;

/** The Dubai calendar day a segment belongs to.
    A journey starting 22:30 UTC is the NEXT day in Dubai, and filing it on the
    UTC day names whoever held the car the day before — a different person, and
    an accusation against someone who had already handed the keys over. */
export const SEG_DAY = (o = 'o') => `(${o}.started_at AT TIME ZONE 'Asia/Dubai')::date`;

/** The instant a segment closes. A segment with no recorded end is treated as
    closing when it opened, which is the conservative direction: it makes the
    "after" side of a bracket harder to satisfy, never easier.

    The last-trip rule deliberately does NOT use this. It is measured against
    the journey's START only, so a segment with no recorded end costs it
    nothing and the conservative fallback is not needed on that path. */
const SEG_END = (o = 'o') => `coalesce(${o}.ended_at, ${o}.started_at)`;

/** THE LAST DUBAI DAY A JOURNEY TOUCHES, which is not always the first.
    ─────────────────────────────────────────────────────────────────────────
    THE DEFECT THIS EXISTS FOR. Custody was read at the Dubai day of
    `started_at` ONLY. RULES.maxDurationHr is 8, so a journey opening 23:50 and
    closing 00:40 is structurally possible and is exactly the night-shift shape
    a taxi fleet hands cars over on. On such a row only the OPENING day's
    custodian was in `cust`; custodians came back 1; the tier was
    `sole_custodian`; and the sentence read "X is the only person the trip
    record shows holding this car on 2026-08-24, so there is nobody else it
    could have been" while the person who held the car for most of the window
    was the 25th's custodian and never appeared as a candidate at all. The
    sentence was false on a record this same query could have read.

    So custody, and the day-bookings probe beside it, range over BOTH days.
    Where the two differ and the custodian sets differ, the tier cannot be
    sole_custodian and the sentence names both days — a reader checking one
    day's trip list would otherwise never find the other half. */
export const SEG_END_DAY = (o = 'o') => `((coalesce(${o}.ended_at, ${o}.started_at)) AT TIME ZONE 'Asia/Dubai')::date`;

/** COMPLETED ONLY, in the reconciler's own vocabulary rather than a second one.
    ─────────────────────────────────────────────────────────────────────────
    THE DEFECT THIS EXISTS FOR. The bracket was built over booking rows the
    reconciler explicitly refuses to match on. src/reconcile.js findMatch
    restricts its match set to `outcome === 'completed' || outcome == null`,
    and trip.status carries rider_cancelled, driver_cancelled,
    driver_did_not_respond and driver_rejected — all of which
    sql/schema_v18.sql trip_norm normalises to outcome='not_completed'. The
    `arrived` side happened to be safe by accident, because a cancelled ride
    carries no ended_at; `resumed` keys on requested_at alone, so a ride that
    never happened was a fully valid AFTER side of a bracket and was quoted in
    the evidence sentence as "their next Uber trip on the same car began 100
    minutes after it ended". Half of the only measurement on the row was a trip
    that did not occur — and the reconciler had already refused that same row
    as an explanation of the journey.

    Byte-equivalent to trip_norm's own CASE, minus the fms branch that cannot
    arise on a bracketing channel, so the two surfaces cannot come to disagree
    about what a trip is. A NULL status is treated as completed, exactly as the
    reconciler treats a NULL outcome. */
const COMPLETED = (t = 't') => `(${t}.status IS NULL OR regexp_replace(lower(btrim(${t}.status)),
      '^optional_ride_', '') IN ('completed', 'finished', 'complete', 'closed', 'delivered'))`;

/** A gap in minutes, said the way a human would say it. 44 minutes and six
    days are different claims and a reader has to tell them apart at a glance,
    so no sentence in this file prints a bare minute count above an hour. */
const GAP_SAY = (g) => `CASE
      WHEN ${g} IS NULL  THEN 'an unmeasured time'
      WHEN ${g} < 90     THEN ${g} || ' minutes'
      WHEN ${g} < 2880   THEN trim(to_char(${g} / 60.0, 'FM999990.0')) || ' hours'
      ELSE                    trim(to_char(${g} / 1440.0, 'FM999990.0')) || ' days'
    END`;

export const TIERS = ['bracketed', 'last_trip', 'sole_custodian', 'ambiguous', 'unknown'];

/* The vocabulary, beside the ladder rather than inlined at each call site —
   the same discipline api/public/segments.js VERDICT_MEANS applies to the
   reconciler's verdicts, and the same one api/status_routes.js applies to an
   absent status. Three different absences must read as three different
   sentences, or a page tells a reader something that is not the true reason. */
export const TIER_MEANS = {
  bracketed: 'Named by time. The same person’s Uber trip on this car ended shortly '
    + 'before this journey began and their next began shortly after it ended, with no '
    + 'other driver’s booking on the car in between. The strongest claim this product '
    + 'makes about an unexplained journey — and still an inference, not a trip record.',
  last_trip: 'The operator’s rule: usually one person drives a car, so whoever did the '
    + 'last Uber trip on it is the one responsible. This person finished the most recent '
    + 'Uber trip on this car before the journey began, and the row states how long before. '
    + 'It is an inference from the car’s Uber record, NOT a record of this journey — '
    + 'nothing places anyone behind the wheel while it was happening. The trip must be '
    + `within ${STALE_CAP_MIN} minutes (21.97 days), which is the 99.9th percentile of `
    + 'this fleet’s own gap between consecutive Uber trips; beyond that the car has left '
    + 'the Uber channel and nobody is named.',
  sole_custodian: 'One custodian. Exactly one person holds this car on this Dubai day '
    + 'across every channel, so there is nobody else it could have been — but this is '
    + 'custody, not driving: no booking places anyone behind the wheel during the '
    + 'journey itself.',
  ambiguous: 'More than one candidate, and nothing separates them. Every person the '
    + 'evidence reaches is listed, equally weighted and in name order. No choice '
    + 'is made and none should be read into the ordering.',
  unknown: 'Nobody. No booking on any channel names a driver for this car on this day, '
    + 'so there is no candidate to offer. The car’s usual driver is NOT shown here: '
    + 'naming them would be invention.',
};

/* ── the ladder, as one lateral join ──────────────────────────────────────
   A LATERAL rather than a set of correlated scalar subqueries, because the
   tiers share their working: the custodian list decides three of the five
   tiers and the bracket needs the same neighbourhood of trips twice. Written
   once, it cannot drift between the tier, the candidate list and the sentence
   that explains them — and the row count of the query it is dropped into
   cannot multiply, which a join to vehicle_driver_day would.

   Returns, per segment:
     tier             one of TIERS
     candidates       jsonb [{name, id, key}] — EVERY surviving candidate
     candidate_keys   text[] of the same people's person keys, for filtering
     candidate_count  int
     evidence         one sentence a human can check against the trip list
     before_min/after_min  the two bracket gaps, stated rather than summarised
     last_trip_gap_min     how stale the last Uber trip was, on the rows it named
     last_uber_driver      context on a row the cap refused, never a candidate
     responsible           the one short field a page prints in its own column
     custodian_count  how many people held the car that day, whatever the tier
     clock_skew_min   present when the tracker's clock makes time useless here
*/
export const attributionJoin = (o = 'o') => {
  const PV = `(${BRACKET_PLATFORMS.map((p) => `'${p}'`).join(', ')})`;
  const END = SEG_END(o);
  const DAY = `to_char(${SEG_DAY(o)}, 'YYYY-MM-DD')`;
  /* THE TWO DUBAI DAYS, NAMED WHEN THEY DIFFER.
     A journey that opens before Dubai midnight and closes after it is not a
     fact about one day, and a reader who checks the day the sentence names
     would never find the other half of the custody. */
  const DAYS = `CASE WHEN named.day_open = named.day_close
      THEN to_char(named.day_open, 'YYYY-MM-DD')
      ELSE format('%s and %s, the two Dubai days this journey spans',
                  to_char(named.day_open, 'YYYY-MM-DD'), to_char(named.day_close, 'YYYY-MM-DD'))
    END`;
  /* The one clause that says why the operator's rule named nobody on this row.
     It is appended to EVERY sentence the rule did not decide, because the
     alternative is a page that silently stops applying the operator's rule on
     a quarter of its rows. Four different absences, four different sentences,
     per the house rule — and the order matters: a car with no Uber history at
     all must not be reported as a car whose Uber history is stale. */
  const WHY_NO_LAST = `CASE
      WHEN named.skew IS NOT NULL THEN format(
        'The operator’s last-Uber-trip rule is not applied here either, and for the same '
        || 'reason: the rule is one clock comparison — this journey’s start against the end '
        || 'of a trip — and a tracker %s minutes out of true cannot be compared against a '
        || 'booking clock at all.', named.skew)
      WHEN named.uber_trips = 0 AND named.other_trips = 0 THEN format(
        'The operator’s last-Uber-trip rule can name nobody here: the trip record holds no '
        || 'booking of ANY kind on %s that names a driver, so there is no last trip on any '
        || 'channel to read. This is not a car whose Uber history is thin — it is a car with '
        || 'no booking identity at all.', ${o}.plate)
      WHEN named.uber_trips = 0 THEN format(
        'The operator’s last-Uber-trip rule can name nobody here: %s has no Uber trips at '
        || 'all in the record. Its work is on the %s channel (%s trips, %s different '
        || 'drivers). The rule reads the last UBER trip, and this car has none — this is a '
        || 'car on the wrong channel, not a car with a thin record.',
        ${o}.plate, coalesce(named.other_platform, 'other'), named.other_trips,
        named.other_people)
      WHEN named.uber_prior > 0 AND named.uber_prior = named.uber_nameless THEN format(
        'The operator’s last-Uber-trip rule can name nobody here: %s HAS %s Uber trip(s) '
        || 'before this journey and every one of them is filed WITHOUT A DRIVER NAME. An '
        || 'account number with no name behind it is not a person this product can accuse, '
        || 'and printing one would render the name as an empty string under a tier pill — '
        || 'which is what this row used to do. The absence is in our record of the trip, not '
        || 'in the car’s history.',
        ${o}.plate, named.uber_prior)
      WHEN named.uber_prior = 0 THEN format(
        'The operator’s last-Uber-trip rule can name nobody here: %s HAS Uber history, but '
        || 'none of it predates this journey — the first Uber trip on this car was %s. '
        || 'Nobody can be named from a trip that had not happened yet.',
        ${o}.plate, to_char(named.uber_first_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD'))
      WHEN named.ever_gap IS NULL THEN format(
        'The operator’s last-Uber-trip rule can name nobody here: every earlier Uber ride on '
        || '%s was CANCELLED and carries no end time, so none of them is a completed trip '
        || 'this rule could read. Completed trips only, which is the conservative direction '
        || 'for an accusation and is the same predicate the bracket uses. Whether a '
        || 'cancelled ride should count as "the last trip" is an open question for the '
        || 'operator and is deliberately not decided here.', ${o}.plate)
      ELSE format(
        'The operator’s last-Uber-trip rule can name nobody here either. The most recent '
        || 'Uber trip on %s was %s’s and it ended %s before this journey began, on %s; the '
        || 'car has had no Uber work since. The rule rests on the car being in service with '
        || 'one driver, and across a gap that long the car has left the Uber channel — so '
        || 'that trip records who USED TO drive this car, not who drove it that night. The '
        || 'name is deliberately kept out of the responsible-person field rather than shown '
        || 'there with a caveat, because a name in that field is read as an answer however '
        || 'it is footnoted; it is returned separately, as context. The cap is %s minutes '
        || '(21.97 days) — the 99.9th percentile of this fleet’s own gap between '
        || 'consecutive Uber trips, above which the fleet’s own record says the car was not '
        || 'in normal service.',
        ${o}.plate, named.ever_name, ${GAP_SAY('named.ever_gap')},
        to_char(named.ever_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD'), ${STALE_CAP_MIN})
    END`;
  /* What day-custody says about the person the rule just named. Stated on the
     row in all four of its states, because "the rule and the day rollup agree"
     and "the rule contradicts the day rollup" are the only corroboration this
     feature has and hiding either one would be choosing which to report.
     Measured: under the cap the two disagree on 0 of 120; uncapped, on 2. */
  const CUSTODY_CLAUSE = `CASE
      WHEN named.custodians = 0 THEN format(
        'No custody record exists for %s on %s, so nothing here corroborates or contradicts '
        || 'this name — the rule reached a person the day rollup could not.',
        ${o}.plate, ${DAYS})
      WHEN named.last_in_cust = 0 THEN format(
        'Day-custody DISAGREES: on %s the custody record names %s for this car. This row '
        || 'follows the operator’s rule and the contradiction is stated rather than hidden. '
        || 'Measured over 120 journeys the two disagree on 2, and both were read off a trip '
        || 'more than six months old.', ${DAYS}, (SELECT string_agg(name, ', ' ORDER BY name) FROM cust))
      WHEN named.custodians = 1 THEN format(
        'Day-custody agrees: the same person is the only custodian on record for %s on %s.',
        ${o}.plate, ${DAYS})
      ELSE format(
        '%s people held %s on %s — %s — and day-custody cannot choose between them. The last '
        || 'Uber trip narrows that list to one, and the person it picks is one of the day’s '
        || 'own custodians: the rule narrows the list, it never steps outside it.',
        named.custodians, ${o}.plate, ${DAYS},
        (SELECT string_agg(name, ', ' ORDER BY name) FROM cust))
    END`;
  /* See tally.later_other. Four words of an operator's own rule are not a
     licence to withhold a booking that contradicts it. */
  const LATER_OTHER_CLAUSE = `CASE WHEN named.later_other IS NOT NULL THEN format(
      ' One booking this rule does NOT read sits between that trip and the journey: a %s '
      || 'booking on this same car in %s’s name, %s before the journey began. The operator’s '
      || 'rule is Uber-only by the operator’s own instruction, so it does not change the name '
      || 'above — but it is the more recent record of who had this car, and withholding it '
      || 'would be the product choosing which evidence to report.',
      named.later_other->>'platform', named.later_other->>'name',
      ${GAP_SAY(`(named.later_other->>'gap_min')::int`)}) ELSE '' END`;
  /* A leaver is exactly the person who might take a car unbooked, so roster
     state is NOT a gate — suppressing a name because someone has since left
     would be the product deciding who is above suspicion. It is stated as a
     fact the reader needs instead, and only when driver_platform_state
     actually holds a row saying the account cannot take work. An ABSENT row
     means "we do not know", and this says nothing at all in that case. */
  /* format() renders a NULL argument as an empty string rather than returning
     NULL, so a coalesce() around it never fires and every row printed "recorded
     as  and cannot currently take work" about a person nothing is known about.
     The absence has to be tested explicitly, on the value rather than on the
     formatted sentence. */
  const ROSTER_CLAUSE = `CASE WHEN named.off_roster IS NOT NULL THEN format(
      ' One thing to know before ringing round: this person’s Uber account is recorded as '
      || '%s and cannot currently take work, so they may no longer be on the active roster.',
      named.off_roster) ELSE '' END`;
  /* WHAT THE CLOCK ACTUALLY FOUND — NEVER A DENIAL OF A TRIP THE QUERY SAW.
     ───────────────────────────────────────────────────────────────────────
     This replaces a fixed string that asserted a measurement the SQL had not
     made. See the 'gaps' CTE for the four distinct causes that reach these
     rungs and for the two failure shapes it produced. Each cause now has its
     own sentence, and every sentence quotes the gaps the query actually
     measured, so an operator who opens the car's trip list to check finds what
     the row said they would find.

     THE HANDOVER BRANCH IS THE IMPORTANT ONE. Trips either side belonging to
     DIFFERENT people is not an absence of evidence — it is the strongest
     available evidence that the car changed hands across the journey, and the
     old sentence denied the existence of the two bookings that showed it. */
  const TIME_SAYS = `CASE
      WHEN named.skew IS NOT NULL THEN format(
        '%s Time cannot be used on this journey at all: this car’s tracker reports a clock %s '
        || 'minutes behind wall time (%s), so no comparison against a booking clock would be '
        || 'trustworthy.',
        CASE WHEN named.both_sides > 0
          THEN 'One person’s Uber trips DO sit on both sides of this journey, and the bracket was '
               || 'deliberately refused.'
          ELSE '' END,
        named.skew, coalesce(named.skew_basis, 'basis not recorded'))
      WHEN named.brackets > 1 THEN format(
        '%s different people’s Uber trips each bracket this journey. Two brackets are a '
        || 'contradiction rather than a narrower answer, so neither is used.', named.brackets)
      WHEN named.both_sides > 0 THEN format(
        'One person’s Uber trips DO bracket this journey — the nearest ends %s before it started '
        || 'and the nearest begins %s after it ended — and the bracket is refused, because '
        || 'another driver has a booking on this car between those two. That booking is itself '
        || 'the evidence of a handover inside the window, which is why more than one name is in '
        || 'play here rather than one.',
        ${GAP_SAY('named.nearest_before')}, ${GAP_SAY('named.nearest_after')})
      WHEN named.before_people > 0 AND named.after_people > 0 THEN format(
        'Uber trips on %s sit on both sides of this journey — the nearest ends %s before it '
        || 'started, the nearest begins %s after it ended — but they belong to DIFFERENT people, '
        || 'so nothing brackets it. That is the signature of a handover across this journey, and '
        || 'it is why the names below are listed rather than narrowed to one.',
        ${o}.plate, ${GAP_SAY('named.nearest_before')}, ${GAP_SAY('named.nearest_after')})
      WHEN named.before_people > 0 THEN format(
        'The nearest Uber trip on %s ended %s before this journey started, and no completed Uber '
        || 'trip on this car begins within %s minutes after it ended. A trip before and nothing '
        || 'after is half a bracket, which is not evidence about who was in the car.',
        ${o}.plate, ${GAP_SAY('named.nearest_before')}, ${BRACKET_CAP_MIN})
      WHEN named.after_people > 0 THEN format(
        'The nearest Uber trip on %s began %s after this journey ended, and no completed Uber '
        || 'trip on this car ends within %s minutes before it started. A trip after and nothing '
        || 'before is half a bracket, which is not evidence about who was in the car.',
        ${o}.plate, ${GAP_SAY('named.nearest_after')}, ${BRACKET_CAP_MIN})
      ELSE format(
        'No completed Uber trip on %s ends within %s minutes before this journey or begins '
        || 'within %s minutes after it.', ${o}.plate, ${BRACKET_CAP_MIN}, ${BRACKET_CAP_MIN})
    END`;
  /* THE CUSTODY RECORDS THIS PRODUCT CANNOT PUT A NAME TO.
     Stated wherever a custodian count is used to claim exhaustiveness, because
     the name filter runs before the count. The same discipline the unknown
     branch already applies to its two absences. */
  const UNNAMED_CLAUSE = `CASE WHEN named.unnamed_custodians > 0 THEN format(
      ' There %s also %s custody record(s) on this car for %s that carry an account but no name, '
      || 'so this product cannot say who they are — that is why this journey is not reported as '
      || 'having a single custodian.',
      CASE WHEN named.unnamed_custodians = 1 THEN 'is' ELSE 'are' END,
      named.unnamed_custodians, ${DAYS}) ELSE '' END`;

  return `
LEFT JOIN LATERAL (
  WITH cust AS (
    /* Who held the car across the Dubai day(s) this journey touches, ONE ROW
       PER HUMAN. DISTINCT ON the person key, ordered exactly as
       api/custody_sql.js custodyRefs() orders it, so the name and id this
       surface shows for a person are the same name and id the vehicle page and
       the segment page show.

       TWO CHANGES HERE, BOTH OF WHICH CHANGED A VERDICT RATHER THAN A LABEL.

       (a) THE DAY RANGE. See SEG_END_DAY above: keyed on the START day alone,
           a journey running 23:50 to 00:40 saw only the opening day's
           custodian, reported custodians = 1, and printed "there is nobody
           else it could have been" about a car whose keys had changed inside
           the window.

       (b) THE EMPTY NAME. 'v.driver_name IS NOT NULL' admits ''. An empty name
           folds to person_key NULL, personKeyStored falls back to the raw id,
           and the row is then a DISTINCT person as far as the ladder is
           concerned — so a plate-day with one real custodian plus one
           blank-named channel row reported custodians = 2 and read as
           'ambiguous' with a leading empty name in the list ("2 people held
           L44251 on 2026-09-03 — , Kashif Ali Muhammad Ali"), and a plate-day
           whose only custody row is blank-named read as 'sole_custodian' and
           named nobody at all. A record is not a human. */
    SELECT DISTINCT ON (${personKeyStored('v')})
           ${personKeyStored('v')} AS pkey, v.driver_name AS name, v.driver_ext_id AS id,
           v.day AS day
      FROM vehicle_driver_day v
     WHERE v.plate = ${o}.plate
       AND v.day BETWEEN ${SEG_DAY(o)} AND ${SEG_END_DAY(o)}
       AND coalesce(btrim(v.driver_name), '') <> ''
     ORDER BY ${personKeyStored('v')}, v.is_primary DESC, v.trips DESC
  ),
  cust_any AS (
    /* THE SAME POPULATION WITHOUT THE NAME FILTER, because the count above is
       used to claim EXHAUSTIVENESS and the filter above is applied first.
       ───────────────────────────────────────────────────────────────────────
       sql/schema_v19.sql:68 admits a custody row carrying an id and no name
       ('coalesce(btrim(driver_ext_id),'') <> '' OR coalesce(btrim(driver_name),'')
       <> ''', with 'max(t.driver_name)' NULL when no row in the group names
       anybody). Counting custodians over the NAMED rows alone therefore
       removed an unnamed custodian from the population, and the row then
       printed "<Name> is the only person the trip record shows holding this
       car on 2026-08-24, so there is nobody else it could have been" when
       there demonstrably WAS somebody else and the product simply could not
       name them. A day that should have read 'ambiguous' read as a single
       accusation.

       So both counts exist. 'cust' stays name-filtered because it is the list
       that gets DISPLAYED — a blank entry in a candidate list is its own
       defect — and the two are compared below. Where they differ the tier may
       not be sole_custodian, and the sentence says how many custody records
       this product cannot put a name to. It is the same discipline the
       'unknown' branch already applies to its two absences. */
    SELECT DISTINCT ${personKeyStored('v')} AS pkey
      FROM vehicle_driver_day v
     WHERE v.plate = ${o}.plate
       AND v.day BETWEEN ${SEG_DAY(o)} AND ${SEG_END_DAY(o)}
       AND coalesce(btrim(${personKeyStored('v')}), '') <> ''
  ),
  near AS (
    /* Every bracketing-channel booking on THIS CAR anywhere near the window,
       folded to a person. The lower bound is deliberately wider than the cap:
       the BEFORE side is tested on ended_at, and the only index that exists is
       trip (plate, requested_at) — so the scan is bounded on requested_at by
       the cap plus RULES.maxDurationHr, which is the longest journey the
       reconciler will entertain. A booking requested more than eight hours
       before the window and still ending inside the cap would be missed; it
       would also be an eight-hour Uber ride, and missing it can only make this
       module MORE conservative, which is the safe direction for an accusation.
       That is why no schema file was added for a (plate, ended_at) index. */
    /* NAMED, and COMPLETED, and both were defects rather than tidying.

       A NAME IS REQUIRED. This asked for a non-blank driver_ext_id and not for
       a non-blank driver_name, although trip.driver_name is nullable and
       nearestJoin() below guards exactly this with
       'coalesce(btrim(t.driver_name),'') <> '''. An Uber export row carrying an
       id and a NULL name generates a NULL person_key, so personKeyStored falls
       back to the id and the row is its own "person"; two such rows either side
       of a window produced tier='bracketed' with
       candidates=[{"name":null,...}] and the sentence "Named by time: ." —
       a nameless accusation with a tier pill on it, because Postgres format()
       renders a NULL argument as an empty string rather than failing. The
       second-order damage was worse: a nameless row belonging to a driver whose
       other rows ARE named keys as a different person, so it counted as
       "another driver's booking in between" and destroyed correct brackets.

       COMPLETED ONLY — see COMPLETED() above for the measurement and for why
       'arrived' was safe by accident and 'resumed' was not. */
    SELECT ${personKeyStored('t')} AS pkey, t.driver_name AS name, t.driver_ext_id AS id,
           t.platform, t.external_id, t.requested_at, t.ended_at
      FROM trip t
     WHERE t.plate = ${o}.plate
       AND t.platform IN ${PV}
       AND coalesce(btrim(t.driver_ext_id), '') <> ''
       AND coalesce(btrim(t.driver_name), '') <> ''
       AND ${COMPLETED('t')}
       AND t.requested_at BETWEEN ${o}.started_at
                                  - interval '${BRACKET_CAP_MIN} minutes' - interval '8 hours'
                              AND ${END} + interval '${BRACKET_CAP_MIN} minutes'
  ),
  others AS (
    /* THE EXCLUSION SET, AND IT IS NOT 'near'.
       ───────────────────────────────────────────────────────────────────────
       THE DEFECT. The clause that turns a bracket from coincidence into
       evidence — "NOBODY ELSE'S booking on this car between the two" — was
       evaluated over 'near', which is filtered to Uber AND to rows carrying a
       driver_ext_id. The sentence it produced nevertheless asserted, without
       qualification, "No other driver has a booking on this car between those
       two." Another person's hotel, Yango or Bolt booking inside the gap was
       invisible to the NOT EXISTS, so the exclusion was silently
       platform-scoped while the claim was not.

       This is not hypothetical. This module's own header records that letting
       the other channels bracket moves the distribution from 13 to 22 at the
       same cap, so those channels carry material bookings on these plates; and
       src/custody.js records that the hotel channel names a driver on every
       booking and does not always carry an id. The failure shape: Zain's Uber
       trip ends 08:39 and his next begins 11:03, so he brackets; at 09:20
       Waseem takes the car on a hotel booking that names him and carries no id;
       the bracket fires anyway and the page prints the strongest claim this
       product makes against a man who was at home.

       So the exclusion runs over EVERY channel and does not require an id —
       a hotel row named without a number is still a person who had the car —
       while the two bracket SIDES stay Uber-only, as the operator asked. This
       moves segments out of 'bracketed' and into 'ambiguous', which is the
       honest direction.

       Deliberately NOT completed-filtered, and that is the conservative
       direction here rather than an oversight: another driver having been
       OFFERED a ride in that car and cancelled it is still evidence they had
       the car, and on this side the looser set refuses more brackets. Keyed on
       the person AND on the raw id, so a row of the bracketed driver's own
       account never counts against them however it folds. */
    SELECT ${personKeyStored('t')} AS pkey, t.driver_ext_id AS id, t.platform,
           t.driver_name AS name, t.requested_at, t.ended_at
      FROM trip t
     WHERE t.plate = ${o}.plate
       AND coalesce(btrim(t.driver_name), '') <> ''
       AND t.requested_at BETWEEN ${o}.started_at
                                  - interval '${BRACKET_CAP_MIN} minutes' - interval '16 hours'
                              AND ${END} + interval '${BRACKET_CAP_MIN} minutes'
  ),
  arrived AS (
    /* The LAST booking each person finished before the journey opened. A
       cancelled ride carries no ended_at — measured, 78 of 772 Uber rows on
       the flagged plate-days — and duration_s is null on 100% of rows on every
       platform, so an end cannot be derived. A trip with no end can only ever
       serve as the AFTER side of a bracket, and that is what this predicate
       enforces rather than assuming. */
    SELECT DISTINCT ON (pkey) pkey, name, id, ended_at,
           round(extract(epoch FROM (${o}.started_at - ended_at)) / 60)::int AS gap_min
      FROM near
     WHERE ended_at IS NOT NULL
       AND ended_at <= ${o}.started_at
       AND ended_at >= ${o}.started_at - interval '${BRACKET_CAP_MIN} minutes'
     ORDER BY pkey, ended_at DESC
  ),
  resumed AS (
    -- …and the FIRST each of them started after it closed.
    SELECT DISTINCT ON (pkey) pkey, name, id, requested_at,
           round(extract(epoch FROM (requested_at - ${END})) / 60)::int AS gap_min
      FROM near
     WHERE requested_at >= ${END}
       AND requested_at <= ${END} + interval '${BRACKET_CAP_MIN} minutes'
     ORDER BY pkey, requested_at
  ),
  bracket AS (
    /* Both sides, same person, and NOBODY ELSE'S booking on this car between
       the two. The exclusion is what makes the bracket evidence rather than
       coincidence: without it, a car handed over inside the gap brackets the
       person who handed it on.

       IT IS AN INTERVAL TEST NOW, NOT A POINT TEST. The clause read
       'x.requested_at > b.ended_at AND x.requested_at < r.requested_at' — only
       the REQUEST instant of the intervening booking. A bracket is a claim
       about an interval and this compared it against one end of the other
       interval, so another driver's booking REQUESTED before the bracket's
       left edge and still running through the gap did not break it: driver A
       ends 11:00, driver B is requested 10:55 and ends 11:40, the journey runs
       12:00-12:20 and A's next starts 13:00. B's own booking record put B in
       that car until twenty minutes before the journey started, the bracket
       fired for A anyway, and B was not even offered as a candidate. Testing
       'coalesce(x.ended_at, x.requested_at) > b.ended_at' closes it, and
       'others'' lower bound was widened by RULES.maxDurationHr twice over so
       that a long intervening trip is actually in the scanned set.

       The bracketing person's OWN rows can never disqualify them — matched on
       the person key and, for the nameless-but-identified rows 'near' no
       longer admits, on the raw account id as well. */
    SELECT b.pkey, b.name, b.id, b.gap_min AS before_min, r.gap_min AS after_min,
           b.ended_at AS before_at, r.requested_at AS after_at
      FROM arrived b JOIN resumed r USING (pkey)
     WHERE NOT EXISTS (
       SELECT 1 FROM others x
        WHERE x.pkey <> b.pkey
          AND coalesce(x.id, '') <> coalesce(b.id, '')
          AND coalesce(x.ended_at, x.requested_at) > b.ended_at
          AND x.requested_at < r.requested_at)
  ),
  /* WHAT THE CLOCK ACTUALLY FOUND, WHETHER OR NOT IT BRACKETED.
     ───────────────────────────────────────────────────────────────────────
     THE DEFECT THESE EXIST FOR. The 'sole_custodian' and 'ambiguous' evidence
     sentences were fixed strings asserting a measurement the query had never
     made: "no Uber trip on %s ends within 240 minutes before this journey or
     begins within 240 minutes after it". The ladder reaches those rungs
     whenever the bracket count is not exactly one — and that has four distinct
     causes, none of which is that sentence's claim: only ONE side exists; the
     earlier trip carries no ended_at so 'arrived' drops it although it is
     twenty minutes before; another driver's booking sits between the two and
     kills an otherwise valid bracket; or a clock skew refuses a textbook
     bracket outright.

     The repo's own fixture proved it. A segment with, in the test's words, "a
     textbook bracket — 30 minutes on each side, the same person, no intruder"
     printed the sentence DENYING the two trips thirty minutes either side that
     the query itself had found. An operator does exactly what this module's
     header invites — opens the car's trip list to check — and finds them. On
     the handover shape it is worse: person A's trip ends 30 minutes before and
     person B's begins 20 minutes after, so nobody brackets and the tier is
     'ambiguous', and the sentence denied the exact two bookings that are the
     strongest available evidence of a handover DURING the journey.

     So the two real gaps are measured here and the sentence is built from
     them. NEVER DENY A TRIP THE QUERY FOUND. */
  gaps AS (
    SELECT (SELECT min(gap_min) FROM arrived) AS nearest_before,
           (SELECT min(gap_min) FROM resumed) AS nearest_after,
           (SELECT count(*) FROM arrived)::int AS before_people,
           (SELECT count(*) FROM resumed)::int AS after_people,
           /* Did one person have BOTH sides, before the exclusion ran? That is
              what separates "no bracket existed" from "a bracket existed and
              another driver's booking between the two refused it". */
           (SELECT count(*) FROM arrived b JOIN resumed r USING (pkey))::int AS both_sides
  ),
  last_near AS (
    /* THE OPERATOR'S RULE, first half: every COMPLETED Uber trip on this car
       that finished before the journey opened and is not older than the cap.

       Its own lookback, deliberately NOT the report window's 'from' and not
       'near''s narrower one. Measured: the case "this plate has Uber trips but
       none before the journey" was 1 of 120 under a lookback bounded at
       2026-06-01 and 0 of 120 once the lookback was widened to 2025-10-01 —
       i.e. it was a LOOKBACK ARTEFACT, a statement about the query rather than
       about the car, and it would have printed as a fact about the car. So the
       bound here is STALE_CAP_MIN, plus RULES.maxDurationHr on requested_at
       for the (plate, requested_at) index, exactly as 'near' does and for
       exactly the same reason.

       Completed only, as the bracket is. Measured: 3,490 of 25,451 Uber rows
       (13.7%) carry no ended_at and every one of them is rider_cancelled or
       driver_cancelled, never completed; on 11 of the 120 journeys a cancelled
       Uber ride on that plate is MORE RECENT than the last completed one, and
       counting it would cut staleness materially on 7 of them (L44305 787 min
       -> 3, L45243 2,543 -> 62, L63960 2,513 -> 190, L64009 149 -> 49) and
       CHANGE THE NAMED PERSON on 2 (both L45243, both handover days). A driver
       who accepted a ride and had it cancelled was in that car, so this is a
       real question and not a technicality — and it is the operator's to
       answer, not this file's. The conservative direction is implemented, the
       measurement is written down, and the question is open. A cancelled ride
       has no end time, so if it ever counts it must be timestamped on
       requested_at and the sentence must say "a ride that was cancelled,
       requested 3 minutes before" rather than "their trip ended 3 minutes
       before" — a different and weaker claim that must not be printed as the
       stronger one. */
    /* Named, for the same reason 'near' is: an Uber export row carrying an
       account and a NULL name folds to its own person key and would be named
       as the responsible person with an empty string where the name goes.
       format() renders NULL as '' rather than failing, so the row would have
       read 'The last Uber trip on L55503 before this journey was 's' under a
       tier pill, with the driver link pointing nowhere. */
    SELECT ${personKeyStored('t')} AS pkey, t.driver_name AS name, t.driver_ext_id AS id,
           t.ended_at
      FROM trip t
     WHERE t.plate = ${o}.plate
       AND t.platform IN ${PV}
       AND coalesce(btrim(t.driver_ext_id), '') <> ''
       AND coalesce(btrim(t.driver_name), '') <> ''
       AND t.ended_at IS NOT NULL
       AND t.ended_at <= ${o}.started_at
       AND t.ended_at >= ${o}.started_at - interval '${STALE_CAP_MIN} minutes'
       AND t.requested_at <= ${o}.started_at
       AND t.requested_at >= ${o}.started_at
                             - interval '${STALE_CAP_MIN} minutes' - interval '8 hours'
  ),
  last_at AS (SELECT max(ended_at) AS at FROM last_near),
  last_ppl AS (
    /* THE OPERATOR'S RULE, second half: whoever finished at that instant,
       folded to a human. Everyone who ties is kept.

       A DISTINCT ON (ended_at) with a LIMIT 1 would have been shorter and
       would have made the tie a coin flip resolved by the planner's row order,
       which reads to an operator as a finding. This file's own header records
       the identical trap on the bracket tier. Measured: 0 occurrences across
       21,961 distinct (plate, Uber ended_at) instants on the flagged plates,
       so the case is theoretical — and a theoretical tie broken at random is
       still an accusation chosen at random. The tie is DETECTED and the ladder
       refuses to choose; see 'named' below. */
    SELECT DISTINCT ON (pkey) pkey, name, id, ended_at,
           round(extract(epoch FROM (${o}.started_at - ended_at)) / 60)::int AS gap_min
      FROM last_near
     WHERE ended_at = (SELECT at FROM last_at)
     ORDER BY pkey, ended_at DESC
  ),
  ever AS (
    /* The last completed Uber trip on this car before the journey AT ANY AGE,
       so that a row the cap refused can say WHOSE trip it refused and how old
       it was. This is the only lookback in the module with no time bound, and
       it rides trip_plate_idx exactly as the day_bookings probe below already
       does — one plate's trips, not a table scan. It is CONTEXT and never a
       candidate; nothing here reaches 'candidates' or 'candidate_keys'. */
    SELECT ${personKeyStored('t')} AS pkey, t.driver_name AS name, t.driver_ext_id AS id,
           t.ended_at,
           round(extract(epoch FROM (${o}.started_at - t.ended_at)) / 60)::int AS gap_min
      FROM trip t
     WHERE t.plate = ${o}.plate
       AND t.platform IN ${PV}
       AND coalesce(btrim(t.driver_ext_id), '') <> ''
       /* This row is quoted BY NAME in the sentence that explains a refused
          name. A nameless one would print 'last Uber driver of record: ,'. */
       AND coalesce(btrim(t.driver_name), '') <> ''
       AND t.ended_at IS NOT NULL
       AND t.ended_at <= ${o}.started_at
     ORDER BY t.ended_at DESC
     LIMIT 1
  ),
  hist AS (
    /* What this car has EVER done, split by channel, so the three absences the
       rule can hit read as three different sentences: no Uber history at all,
       Uber history that postdates the journey, and Uber history too old to
       use. Bounded to the plate and therefore to trip_plate_idx.

       The Uber-only figures are strictly "no Uber trips in the record", not
       "no Uber trips ever": the measurement's own lookback stopped at
       2025-10-01, so L46706's "no Uber trips at all" is really "none across
       491 hotel trips in 11.5 months". That is strong enough to act on and it
       is not the same statement, so the sentence says what was checked. */
    SELECT count(*) FILTER (WHERE t.platform IN ${PV})::int AS uber_trips,
           /* Prior Uber trips this car HAS that the rule cannot read because
              nobody is named on them. Without this the row fell through to the
              'every earlier ride was CANCELLED' sentence, which is a different
              reason and a false one — the house rule is the TRUE reason, never
              a plausible one. */
           count(*) FILTER (WHERE t.platform IN ${PV}
                              AND t.requested_at <= ${o}.started_at
                              AND coalesce(btrim(t.driver_name), '') = '')::int AS uber_nameless,
           count(*) FILTER (WHERE t.platform IN ${PV}
                              AND t.requested_at <= ${o}.started_at)::int AS uber_prior,
           min(t.requested_at) FILTER (WHERE t.platform IN ${PV}) AS uber_first_at,
           count(*) FILTER (WHERE t.platform NOT IN ${PV})::int AS other_trips,
           count(DISTINCT ${personKeyStored('t')})
             FILTER (WHERE t.platform NOT IN ${PV})::int AS other_people
      FROM trip t
     WHERE t.plate = ${o}.plate
       AND coalesce(btrim(t.driver_ext_id), '') <> ''
  ),
  tally AS (
    SELECT (SELECT count(*) FROM cust)::int    AS custodians,
           /* The unnamed custody records the displayed list cannot show. See
              cust_any: this is the difference between "one custodian" and "one
              custodian we can name", and only the first of those licenses the
              sentence "there is nobody else it could have been". */
           ((SELECT count(*) FROM cust_any) - (SELECT count(*) FROM cust))::int AS unnamed_custodians,
           /* The two Dubai days this journey touches. Equal on all but the
              night-shift shape, and where they differ the sentences name both:
              a reader checking one day's trip list would not find the other. */
           ${SEG_DAY(o)}     AS day_open,
           ${SEG_END_DAY(o)} AS day_close,
           (SELECT count(*) FROM bracket)::int AS brackets,
           gaps.nearest_before, gaps.nearest_after,
           gaps.before_people, gaps.after_people, gaps.both_sides,
           /* THE CLOCK GATE, DERIVED PER PLATE RATHER THAN OFF THIS ROW.
              ─────────────────────────────────────────────────────────────
              THE DEFECT. This read SKEW() out of THIS segment's own
              verdict_reason — and src/reconcile.js writes "N min behind" ONLY
              on its 'clockSuspect' branch, which sets verdict='unverifiable',
              never 'unauthorized'. An unauthorized segment's reason is always
              "no completed booking overlaps; nearest is a <p> trip N min away"
              or "no booking of any kind on this plate in the window, across
              …". So on this endpoint's default verdict='unauthorized' the skew
              was NULL on EVERY row and the guard 'skew IS NULL AND brackets =
              1' was a no-op. The passing test proved the regex, not the guard:
              its fixture seeds a reason string reconcile.js cannot produce for
              an unauthorized segment.

              Worse, 'clockSuspect' is computed FLEET-WIDE — clockSkewMin() is
              the median over every fix in the run, threshold 60 minutes — so a
              single plate whose tracker is hours out never trips it and its
              segments are issued as accusations with timestamps that are hours
              wrong. api/segment_routes.js records exactly that case: "thirteen
              accusations each showing a nearest booking exactly 240 minutes
              away is a clock skew … four hours is the actual observed skew".
              Those thirteen rows are unauthorized, carry no "min behind" text,
              and were bracketed against a cap of exactly 240 minutes.

              So the refusal is derived from data an unauthorized row actually
              carries, in two independent ways, and either one refuses:

              (1) THE PLATE'S OWN CONFESSION. Any segment on this plate within
                  a week either side that the reconciler DID mark unverifiable
                  for a clock behind wall time. A tracker does not misreport
                  the time for one segment and not its neighbours.
              (2) THE OFFSET CLUSTER. Three or more unauthorized segments on
                  this plate in the same fortnight whose nearest booking sits
                  at the SAME distance, within RULES.matchToleranceMin of each
                  other and beyond it in magnitude, is a constant offset — one
                  bug, not three dishonest drivers. This row's own
                  nearest_gap_min is the visible signature and the module used
                  to ignore it.

              'skew' keeps its meaning (minutes behind, an int) where it is
              known, so every sentence downstream is unchanged; where only the
              cluster fired the minutes are the cluster's own median offset and
              'skew_basis' says which of the two found it. */
           coalesce(${SKEW(`${o}.verdict_reason`)}, plate_skew.min_behind,
                    offset_cluster.offset_min) AS skew,
           CASE
             WHEN ${SKEW(`${o}.verdict_reason`)} IS NOT NULL THEN 'this segment’s own recorded reason'
             WHEN plate_skew.min_behind IS NOT NULL THEN format(
               'another segment on %s within a week either side, which the reconciler refused to '
               || 'judge at all because this tracker’s clock was %s minutes behind wall time',
               ${o}.plate, plate_skew.min_behind)
             WHEN offset_cluster.offset_min IS NOT NULL THEN format(
               '%s unexplained journeys on %s in this fortnight whose nearest booking sits at the '
               || 'same distance, within %s minutes of each other — a constant offset is one clock '
               || 'bug, not %s dishonest drivers',
               offset_cluster.n, ${o}.plate, ${MATCH_TOLERANCE_MIN}, offset_cluster.n)
           END AS skew_basis,
           (SELECT count(*) FROM last_ppl)::int AS last_people,
           (SELECT gap_min FROM last_ppl LIMIT 1) AS last_gap,
           (SELECT at FROM last_at)               AS last_at,
           (SELECT count(*) FROM last_ppl l JOIN cust c ON c.pkey = l.pkey)::int AS last_in_cust,
           /* A BOOKING THE RULE DOES NOT READ, BY SOMEBODY ELSE, MORE RECENT
              THAN THE ONE IT DOES.
              ─────────────────────────────────────────────────────────────
              The operator's rule is Uber-only, by the operator's own words.
              That is a decision, not a defect — but when a hotel or Bolt
              booking on the same car, by a DIFFERENT person, sits between the
              last Uber trip and the journey, the rule names the person the car
              was taken FROM. The bracket refuses itself in exactly that
              situation (see 'others'); the rule cannot, without overruling the
              operator. So it is STATED on the row instead of being silently
              absent, which is the same treatment the disagreement with
              day-custody already gets. */
           (SELECT jsonb_build_object('name', x.name, 'platform', x.platform,
                     'at', coalesce(x.ended_at, x.requested_at),
                     'gap_min', round(extract(epoch FROM (${o}.started_at
                                 - coalesce(x.ended_at, x.requested_at))) / 60)::int)
              FROM others x
             WHERE x.platform NOT IN ${PV}
               AND coalesce(x.ended_at, x.requested_at) <= ${o}.started_at
               AND coalesce(x.ended_at, x.requested_at) > (SELECT at FROM last_at)
               AND x.pkey NOT IN (SELECT pkey FROM last_ppl)
             ORDER BY coalesce(x.ended_at, x.requested_at) DESC LIMIT 1) AS later_other,
           (SELECT gap_min  FROM ever) AS ever_gap,
           (SELECT name     FROM ever) AS ever_name,
           (SELECT ended_at FROM ever) AS ever_at,
           hist.uber_trips, hist.uber_prior, hist.uber_first_at, hist.uber_nameless,
           hist.other_trips, hist.other_people,
           /* The channel this car actually runs on, for the sentence that has
              to say "this car does not run on Uber" without guessing which
              channel it does run on. */
           (SELECT t4.platform FROM trip t4
             WHERE t4.plate = ${o}.plate
               AND t4.platform NOT IN ${PV}
               AND coalesce(btrim(t4.driver_ext_id), '') <> ''
             GROUP BY t4.platform ORDER BY count(*) DESC, t4.platform LIMIT 1) AS other_platform,
           /* Roster state for the ONE person the rule may be about to name.
              The last trip is by construction an Uber trip, so its
              driver_ext_id IS that person's Uber account and this is a primary
              key lookup — no fold needed and none of statusJoin()'s cost.
              Only a row that says outright the account cannot take work counts;
              a missing row is "we do not know" and says nothing. */
           (SELECT ps.state FROM driver_platform_state ps
             WHERE ps.platform = 'uber'
               AND ps.driver_ext_id = (SELECT id FROM last_ppl LIMIT 1)
               AND ps.can_earn IS FALSE LIMIT 1) AS off_roster,
           /* How many bookings of ANY kind name a driver on this car on this
              Dubai day. It separates the two unknowns: a car nothing booked at
              all, and a car with bookings whose custody row was never built.
              Those are different absences and must read as different
              sentences — the discipline api/status_routes.js records after
              sixty-six drivers Uber had said nothing about were reported as
              offline. The last-trip rule is a second, independent read on the
              same distinction: 33 of 33 unknowns get a name uncapped and 20
              under the cap, which is itself evidence that most unknowns are
              vehicle_driver_day gaps rather than cars nobody booked. */
           /* Both days, for the same reason 'cust' reads both: a journey that
              opens before Dubai midnight and closes after it is not a fact
              about one day. */
           (SELECT count(*)::int FROM trip t2
             WHERE t2.plate = ${o}.plate
               AND (t2.requested_at AT TIME ZONE 'Asia/Dubai')::date
                     BETWEEN ${SEG_DAY(o)} AND ${SEG_END_DAY(o)}
               AND coalesce(btrim(t2.driver_ext_id), '') <> '') AS day_bookings
      FROM hist CROSS JOIN gaps
           /* (1) above: this plate's own unverifiable neighbours. */
           LEFT JOIN LATERAL (SELECT max(${SKEW('s2.verdict_reason')}) AS min_behind
                      FROM occupancy_segment s2
                     WHERE s2.plate = ${o}.plate
                       AND s2.started_at BETWEEN ${o}.started_at - interval '7 days'
                                             AND ${o}.started_at + interval '7 days'
                       AND s2.verdict_reason ~ '[0-9]+ min behind') plate_skew ON true
           /* (2) above: the constant-offset signature. Counted only when THIS
              row is itself part of the cluster, so a plate with one distant
              booking and two close ones does not refuse the close ones. */
           LEFT JOIN LATERAL (SELECT count(*)::int AS n,
                           round(avg(abs(s3.nearest_gap_min)))::int AS offset_min
                      FROM occupancy_segment s3
                     WHERE s3.plate = ${o}.plate
                       AND s3.verdict = 'unauthorized'
                       AND s3.nearest_gap_min IS NOT NULL
                       AND ${o}.nearest_gap_min IS NOT NULL
                       AND abs(${o}.nearest_gap_min) > ${MATCH_TOLERANCE_MIN}
                       AND abs(abs(s3.nearest_gap_min) - abs(${o}.nearest_gap_min))
                             <= ${MATCH_TOLERANCE_MIN}
                       AND s3.started_at BETWEEN ${o}.started_at - interval '7 days'
                                             AND ${o}.started_at + interval '7 days'
                    HAVING count(*) >= 3) offset_cluster ON true
  ),
  named AS (
    /* THE LADDER.
       ───────────────────────────────────────────────────────────────────────
       A bracket only counts when exactly one person brackets and the tracker's
       clock is trustworthy; two bracketing people is not a narrower answer
       than custody, it is a contradiction, and it falls through to be reported
       as what it is.

       The operator's rule sits second. It is gated on the same skew, because
       it is one clock comparison and a tracker days out of true makes it
       exactly as worthless as it makes the bracket — on a skewed segment the
       row falls through to day-custody and the sentence says why.

       A TIE ON THE LAST TRIP DOES NOT FALL THROUGH TO DAY-CUSTODY. It is
       reported as 'ambiguous' with the TIED DRIVERS as the candidates, because
       day-custody is the weaker source and letting it choose here would
       silently overrule the operator's rule with a worse answer. */
    SELECT CASE
             WHEN tally.skew IS NULL AND tally.brackets = 1    THEN 'bracketed'
             WHEN tally.skew IS NULL AND tally.last_people = 1 THEN 'last_trip'
             WHEN tally.skew IS NULL AND tally.last_people > 1 THEN 'ambiguous'
             /* ONE NAMED CUSTODIAN IS NOT THE SAME AS ONE CUSTODIAN.
                sql/schema_v19.sql admits a custody row carrying an id and no
                name, and the name filter ran BEFORE this count — so a plate-day
                held by one named person plus one id-only account reported
                custodians = 1 and printed 'there is nobody else it could have
                been'. There demonstrably was; the product simply cannot name
                them. Where any custody record on these days cannot be put to a
                name, the answer is not a single accusation. */
             WHEN tally.custodians = 1 AND tally.unnamed_custodians = 0 THEN 'sole_custodian'
             WHEN tally.custodians >= 1 THEN 'ambiguous'
             ELSE 'unknown'
           END AS tier,
           (tally.skew IS NULL AND tally.brackets <> 1
              AND tally.last_people > 1) AS last_tie,
           tally.*
      FROM tally
  )
  SELECT
    named.tier,
    named.custodians AS custodian_count,
    /* How many custody records on these days carry an account and no name.
       Zero on almost every row; where it is not zero it is the reason the tier
       is not sole_custodian, and a page that prints the count can say so. */
    named.unnamed_custodians AS unnamed_custodian_count,
    named.skew       AS clock_skew_min,
    /* WHERE THE SKEW CAME FROM. It is no longer read off this row's own
       verdict_reason — which the reconciler never writes on an unauthorized
       segment — so the row has to say which of the three probes found it or
       the number is unfalsifiable. See tally above. */
    named.skew_basis AS clock_skew_basis,
    /* The two gaps, and ONLY on the row the bracket actually decided.
       ───────────────────────────────────────────────────────────────────────
       The bracket CTE runs whatever the ladder concludes, so these were being
       emitted on rows the bracket did NOT name — a clock-skewed segment whose
       skew disqualifies the comparison, and an ambiguous one where two
       different people bracket and a LIMIT 1 would pick whichever the planner
       returned first. Both would put a checkable-looking measurement ("their
       trip ended 34 minutes before") on a row whose tier says time decided
       nothing, which is a false evidence claim dressed as a number. They are
       gated on the tier for the same reason the evidence sentence is: a figure
       that is not the basis of the verdict beside it does not belong on the
       row. */
    CASE WHEN named.tier = 'bracketed' THEN (SELECT before_min FROM bracket LIMIT 1) END AS before_min,
    CASE WHEN named.tier = 'bracketed' THEN (SELECT after_min  FROM bracket LIMIT 1) END AS after_min,
    /* The staleness of the trip the operator's rule read, on the rows it
       decided and nowhere else, for the identical reason. A gap of forty
       minutes and a gap of six days are different claims and this is the
       number that tells them apart, so it is on the row as an integer as well
       as in the sentence as words. */
    CASE WHEN named.tier = 'last_trip' THEN named.last_gap END AS last_trip_gap_min,
    /* THE CANDIDATES. One object per human, never one per platform account.
       On 'bracketed' this is the single person time named; on 'last_trip' the
       single person the operator's rule named; on a last-trip TIE the drivers
       who tied, in name order, and NOT the day's custodians; on
       'sole_custodian' and 'ambiguous' it is every custodian, in NAME order —
       never in trip-count order, because any ordering of an ambiguous list is
       read as a ranking and there is no ranking here. On 'unknown' it is an
       empty array, and it is an empty array rather than NULL so that a column
       keyed on it survives api/public/ui.js tableFrom's blank-column pruning
       on a page whose rows are all unknown, which is precisely when a reader
       needs to see it. */
    CASE
      WHEN named.tier = 'bracketed' THEN
        (SELECT jsonb_agg(jsonb_build_object('name', name, 'id', id, 'key', pkey))
           FROM bracket)
      WHEN named.tier = 'last_trip' OR named.last_tie THEN
        (SELECT jsonb_agg(jsonb_build_object('name', name, 'id', id, 'key', pkey)
                          ORDER BY name) FROM last_ppl)
      WHEN named.tier = 'unknown' THEN '[]'::jsonb
      /* AN ID THE DRIVER PAGE CAN ACTUALLY RESOLVE.
         ─────────────────────────────────────────────────────────────────────
         vehicle_driver_day.driver_ext_id is NOT NULL but may be the EMPTY
         STRING, because a channel that names a driver and does not number them
         still gets a custody row. This emitted that empty string as the
         candidate's id, and every shell renders a candidate as
         entity('driver', c.id, c.name) — so the one rung where a hotel-only
         driver is the answer produced a name linking nowhere. This file's own
         rule, quoted in api/public/driver.js: a name on this page that leads
         nowhere is a name nobody can check.

         The synthesised form is exactly what api/driver_routes.js resolve()
         expects for a person the provider never numbered: 'name:' followed by
         the stored person fold, which is the same expression resolve() looks
         the seed row up by. */
      ELSE (SELECT jsonb_agg(jsonb_build_object(
                     'name', name,
                     'id', coalesce(nullif(btrim(id), ''), 'name:' || pkey),
                     'key', pkey) ORDER BY name) FROM cust)
    END AS candidates,
    CASE
      WHEN named.tier = 'bracketed' THEN (SELECT array_agg(pkey) FROM bracket)
      WHEN named.tier = 'last_trip' OR named.last_tie THEN (SELECT array_agg(pkey) FROM last_ppl)
      WHEN named.tier = 'unknown'   THEN ARRAY[]::text[]
      ELSE (SELECT array_agg(pkey) FROM cust)
    END AS candidate_keys,
    CASE
      WHEN named.tier = 'bracketed' THEN 1
      WHEN named.tier = 'last_trip' THEN 1
      WHEN named.last_tie           THEN named.last_people
      WHEN named.tier = 'unknown'   THEN 0
      ELSE named.custodians
    END AS candidate_count,
    /* THE ONE NAME A PAGE PRINTS IN ITS RESPONSIBLE-PERSON COLUMN, or the
       operator's own words for its absence. Emitted here rather than left to
       each shell so that two pages cannot word the same absence differently —
       the defect api/status_routes.js was rewritten to stop. It is the name
       only where the ladder reached exactly one person; where the cap refused
       a name it is "Nobody — the trail is too old." and the name that was
       refused is returned under its own key, never here. NULL everywhere else,
       so a shell falls back to its own rendering of the candidate list rather
       than to a phrase this file invented for it. */
    CASE
      WHEN named.tier IN ('bracketed', 'last_trip', 'sole_custodian')
        AND NOT named.last_tie THEN (
          SELECT c.name FROM jsonb_to_recordset(
            CASE named.tier
              WHEN 'bracketed' THEN (SELECT jsonb_agg(jsonb_build_object('name', name)) FROM bracket)
              WHEN 'last_trip' THEN (SELECT jsonb_agg(jsonb_build_object('name', name)) FROM last_ppl)
              ELSE (SELECT jsonb_agg(jsonb_build_object('name', name)) FROM cust)
            END) AS c(name text) LIMIT 1)
      WHEN named.tier = 'unknown' AND named.last_people = 0 AND named.ever_gap IS NOT NULL
        THEN 'Nobody — the trail is too old.'
    END AS responsible,
    /* THE NAME THE CAP REFUSED, under its own key and with its own sentence.
       ───────────────────────────────────────────────────────────────────────
       This is not a new invention: nearestJoin() below already does exactly
       this for the reconciler's nearest booking, and for the same reason — an
       unknown row is where a plausible name gets mistaken for an answer. The
       over-cap name belongs in the same place under the same discipline, and
       it is kept out of candidate_keys so that /api/driver/unauthorized never
       files one of these journeys against that person's page. Measured: 15 of
       120 journeys are in this state, and the person named on the worst of
       them (L63970, 304 days) is contradicted by day-custody, is the only one
       of the 21 people the rule names who is not currently working, and is
       named off a channel that car stopped using a year ago. Three independent
       signals say that name is worthless; it is still returned, because an
       operator ringing round wants to know it exists. */
    CASE WHEN named.last_people = 0 AND named.ever_gap IS NOT NULL THEN
      (SELECT jsonb_build_object(
         'name', e.name, 'id', e.id, 'key', e.pkey,
         'ended_at', e.ended_at, 'gap_min', e.gap_min,
         'means', format(
           'Context, not a candidate — last Uber driver of record: %s, trip ended %s, %s '
           || 'before this journey. That is beyond the %s-minute cap (21.97 days), which is '
           || 'the 99.9th percentile of this fleet’s own gap between consecutive Uber trips, '
           || 'so this name is deliberately absent from the candidate list and this journey '
           || 'is filed against nobody’s profile anywhere in the product.',
           e.name, to_char(e.ended_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
           ${GAP_SAY('e.gap_min')}, ${STALE_CAP_MIN}))
         FROM ever e)
    END AS last_uber_driver,
    /* THE EVIDENCE, AS A SENTENCE SOMEBODY CAN GO AND CHECK.
       "Bracketed" is not checkable; "their trip ended 34 minutes before and
       the next began 19 minutes after" is — the reader can open the car's trip
       list and see those two rows. Every sentence therefore carries the
       measurement, not the conclusion, and the ones that name nobody say which
       kind of nothing they found.

       The last-trip sentences come in TWO VOICES, split at FRESH_BAND_MIN.
       Under it the car was in continuous normal Uber service and the name
       leads; over it the car was in an abnormally quiet spell and the AGE OF
       THE TRIP leads, because "their trip ended 44 minutes earlier" and "their
       trip ended 13 days earlier" are different claims and one uniform
       sentence flattens the difference into a single confident-sounding line. */
    CASE named.tier
      WHEN 'bracketed' THEN format(
        'Named by time: %s. Their Uber trip on %s ended %s minutes before this journey '
        || 'started, and their next Uber trip on the same car began %s minutes after it '
        || 'ended. No other driver has a booking of ANY kind on this car between those two — '
        || 'the exclusion is checked across every channel collected, including the ones that '
        || 'name a driver without an account number, because a car handed over inside the gap '
        || 'would otherwise bracket the person who handed it on. The two bracket SIDES are '
        || 'Uber, as the operator asked, and both gaps are within %s minutes. '
        || 'This is stronger evidence than the '
        || 'operator’s last-trip rule, which reads only the trip BEFORE, so it is reported '
        || 'as a bracket even though the last-trip rule would name the same person.',
        (SELECT name FROM bracket LIMIT 1), ${o}.plate,
        (SELECT before_min FROM bracket LIMIT 1), (SELECT after_min FROM bracket LIMIT 1),
        ${BRACKET_CAP_MIN})
      WHEN 'last_trip' THEN
        CASE WHEN named.last_gap <= ${FRESH_BAND_MIN} THEN format(
          'The last Uber trip on %s before this journey was %s’s, ending %s earlier — it '
          || 'finished at %s. That is the operator’s rule: usually one person drives a car, '
          || 'so whoever did the last Uber trip on it is the one responsible. It is an '
          || 'inference from this car’s Uber record and NOT a record of this journey — no '
          || 'booking places anyone behind the wheel while it was happening. The car was in '
          || 'continuous normal Uber service across it: %s minutes is inside the %s minutes '
          || 'that covers 98%% of this fleet’s gaps between consecutive Uber trips. %s%s',
          ${o}.plate, (SELECT name FROM last_ppl LIMIT 1), ${GAP_SAY('named.last_gap')},
          to_char(named.last_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
          named.last_gap, ${FRESH_BAND_MIN}, ${CUSTODY_CLAUSE},
          ${LATER_OTHER_CLAUSE} || ${ROSTER_CLAUSE})
        ELSE format(
          'Read the age of this first: the trip it rests on ended %s before the journey '
          || 'began. The last Uber trip on %s before this journey was %s’s, finishing at %s. '
          || 'That is the operator’s rule — whoever did the last Uber trip on a car is the '
          || 'one responsible — and it is an inference from this car’s Uber record, NOT a '
          || 'record of this journey. A gap that long is past the %s minutes that covers 98%% '
          || 'of this fleet’s gaps between consecutive Uber trips, so the car was in an '
          || 'abnormally quiet spell: still inside the %s-minute cap and still in Uber '
          || 'service, but the claim is weaker in proportion to the age of that trip. %s%s',
          ${GAP_SAY('named.last_gap')}, ${o}.plate, (SELECT name FROM last_ppl LIMIT 1),
          to_char(named.last_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI'),
          ${FRESH_BAND_MIN}, ${STALE_CAP_MIN}, ${CUSTODY_CLAUSE},
          ${LATER_OTHER_CLAUSE} || ${ROSTER_CLAUSE}) END
      WHEN 'sole_custodian' THEN format(
        'Not named by time. %s %s is the only person the trip record shows holding this car on '
        || '%s, so there is nobody else it could have been — but this is custody, not driving. %s',
        ${TIME_SAYS}, (SELECT name FROM cust LIMIT 1), ${DAYS}, ${WHY_NO_LAST})
      WHEN 'ambiguous' THEN
        CASE WHEN named.last_tie THEN format(
          '%s drivers’ Uber trips on %s both ended at %s — %s — so the last trip does not '
          || 'identify one person. Both are listed; neither is chosen. Day-custody is NOT '
          || 'used to break this tie: it is the weaker source, and letting it choose here '
          || 'would silently overrule the operator’s rule with a worse answer.',
          named.last_people, ${o}.plate,
          to_char(named.last_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI:SS'),
          (SELECT string_agg(name, ', ' ORDER BY name) FROM last_ppl))
        ELSE format(
          '%s held %s on %s — %s — and the evidence cannot separate them. %s%s Every candidate is '
          || 'listed; none is chosen. %s',
          CASE WHEN named.custodians = 1 THEN 'One named person'
               ELSE named.custodians || ' people' END,
          ${o}.plate, ${DAYS},
          (SELECT string_agg(name, ', ' ORDER BY name) FROM cust),
          ${TIME_SAYS}, ${UNNAMED_CLAUSE}, ${WHY_NO_LAST}) END
      ELSE CASE WHEN named.day_bookings > 0 THEN format(
        'Nobody can be named. No custody record names anybody for %s on %s, although the trip '
        || 'record holds %s booking(s) naming a driver on this car that day — so this is a '
        || 'gap in vehicle_driver_day, not a car nobody drove.%s %s',
        ${o}.plate, ${DAYS}, named.day_bookings, ${UNNAMED_CLAUSE}, ${WHY_NO_LAST})
        ELSE format(
        'Nobody can be named. No booking on any channel names a driver for %s on %s. The car '
        || 'has a seat sensor and a GPS trace and no booking identity whatsoever; the car’s '
        || 'usual driver is deliberately NOT shown, because naming them would be invention.%s %s',
        ${o}.plate, ${DAYS}, ${UNNAMED_CLAUSE}, ${WHY_NO_LAST}) END
    END AS evidence
  FROM named
) att ON true`;
};

/** The columns attributionJoin() contributes, for a caller's SELECT list. */
export const ATTRIBUTION_COLS = `att.tier AS attribution_tier,
  att.unnamed_custodian_count,
  att.clock_skew_basis,
  att.candidates AS attribution_candidates,
  att.candidate_count AS attribution_candidate_count,
  att.candidate_keys AS attribution_candidate_keys,
  att.evidence AS attribution_evidence,
  att.responsible AS attribution_responsible,
  att.before_min AS bracket_before_min,
  att.after_min AS bracket_after_min,
  att.last_trip_gap_min AS attribution_last_trip_gap_min,
  att.last_uber_driver AS attribution_last_uber_driver,
  att.custodian_count,
  att.clock_skew_min`;

/* ── the hint that is already on the row, and is NOT a tier ───────────────
   occupancy_segment.nearest_trip_id and nearest_platform are populated on 106
   of production's 120 unauthorized segments: the booking the reconciler found
   closest to the window before deciding it did not explain it. Joining trip on
   that id names a person with no new query, and nearest_gap_min is already on
   the row to state beside them.

   IT IS NOT A CANDIDATE AND MUST NEVER BECOME ONE. The median gap over those
   106 is 97 minutes and the maximum is 11,309 — a booking an hour and a half
   away is a fact about the car's day, not about who was in the car — and on an
   UNKNOWN segment it is precisely the plausible name a reader would take for
   an answer. So it comes back under its own key, never in `candidates` and
   never in `candidate_keys`, carrying its own gap and its own sentence saying
   what it is. test/unauthorized_attribution.test.mjs asserts that a segment
   whose nearest booking names somebody still reports NOBODY when the ladder
   cannot reach a person, because that is the row where the temptation lives. */
export const nearestJoin = (o = 'o') => `
LEFT JOIN LATERAL (
  SELECT jsonb_build_object(
           'platform', t.platform, 'external_id', t.external_id,
           'name', t.driver_name, 'id', t.driver_ext_id,
           'key', ${personKeyStored('t')},
           'requested_at', t.requested_at, 'ended_at', t.ended_at,
           'gap_min', ${o}.nearest_gap_min,
           'means', format(
             'Context, not a candidate. The nearest booking the reconciler could find is a '
             || '%s trip %s minutes from this window, and it did NOT explain the journey — '
             /* Worded around test/collector_invariants.test.mjs's bare-interval-keyword
                rule, which reads any token followed by a bare unit and a comma,
                inside a template literal containing SELECT, as a column alias. It
                cannot tell an English sentence inside format() from a select
                list, and it is right to be blunt about it. */
             || 'that is why the verdict stands. A booking that far from the window describes '
             || 'the car’s movements rather than who was in the car, so this name is '
             || 'deliberately absent from the candidate list above.',
             t.platform, abs(coalesce(${o}.nearest_gap_min, 0)))) AS nearest_booking
    FROM trip t
   WHERE t.external_id = ${o}.nearest_trip_id
     AND t.platform = ${o}.nearest_platform
     AND coalesce(btrim(t.driver_name), '') <> ''
   LIMIT 1
) nb ON true`;

/* ── corroboration, which is not attribution ──────────────────────────────
   For each candidate the ladder ALREADY named, what Uber's own status feed
   said about them when the journey began. It promotes nobody, it names nobody
   the ladder did not name, and on the great majority of segments it will say
   nothing at all — driver_status_event starts 2026-09-14 and is append-only
   with no backfill, so 113 of 120 measured segments predate its first row.

   Matched through the PERSON, not through the one id the candidate list
   happens to carry: DISTINCT ON in cust picks a single account per human, and
   on a driver whose chosen row is their Bolt record a lookup keyed on that id
   would report "no status" for somebody Uber was reporting on all day. The
   join through trip.person_key is the register-aware way back to their Uber
   account, and is why this is a separate lateral rather than a column above. */
export const statusJoin = (o = 'o') => `
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
           'name', c.name, 'id', c.id, 'key', c.key,
           'status', s.status, 'since', s.at) ORDER BY c.name) AS statuses
    FROM jsonb_to_recordset(coalesce(att.candidates, '[]'::jsonb))
           AS c(name text, id text, key text)
    LEFT JOIN LATERAL (
      SELECT e.status, e.at
        FROM driver_status_event e
       WHERE e.at <= ${o}.started_at
         AND e.driver_ext_id IN (
           SELECT DISTINCT t3.driver_ext_id FROM trip t3
            WHERE ${personKeyStored('t3')} = c.key
              AND coalesce(btrim(t3.driver_ext_id), '') <> '')
       ORDER BY e.at DESC LIMIT 1) s ON true
) st ON true`;

/** The sentence that goes with statusJoin()'s rows — built in Node because it
    is a statement about the ABSENCE of rows as often as about rows, and the
    thing that decides which absence it is (how far back the feed reaches) is
    one fact about the whole table rather than about this segment.

    `historyFrom` is the first instant driver_status_event holds, or null when
    the table is empty. Returns null when there is nothing worth saying. */
export const statusNote = (statuses, historyFrom, startedAt) => {
  const rows = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
  if (!rows.length) return null;                     // nobody was named; nothing to corroborate
  const began = startedAt ? new Date(startedAt) : null;
  if (!historyFrom || (began && began < new Date(historyFrom))) {
    return historyFrom
      ? `Uber’s own driver-status feed does not reach back this far: it begins `
        + `${String(historyFrom).slice(0, 10)} and is append-only, with no backfill. `
        + 'So nothing here either confirms or contradicts the name above.'
      : 'Uber’s own driver-status feed holds nothing yet, so nothing here either '
        + 'confirms or contradicts the name above.';
  }
  const seen = rows.filter((r) => r.status);
  if (!seen.length) {
    return 'Uber’s driver-status feed covers this date but recorded no status change for '
      + (rows.length === 1 ? 'this person' : 'any of these people')
      + ' at or before this journey began, so it neither confirms nor contradicts the name above.';
  }
  const say = seen.map((r) => `${r.name} was ${r.status} on Uber`).join(', and ');
  return `Corroboration only, and it names nobody: when this journey began, ${say}`
    + ' — read off Uber’s own status feed, which reports the driver and not the car. '
    + 'An unexplained journey is by construction one the app did not book, so being off '
    + 'the app is what this feed is expected to show and is not evidence of driving.';
};

/* ── matching a segment to ONE PERSON, the way /api/driver/* does ──────────
   A driver-scoped page cannot filter on a name and must not filter on one
   driver_ext_id: api/driver_routes.js resolve() exists because one human is
   several records, and a filter that does not fold them shows a person two
   thirds of their own page. This is the set-based form of that fold — every
   person key the resolved key set touches on the trip table, where person_key
   is the stored, register-aware column.

   $1 is the resolved key array (d.keys). Both forms are matched because
   d.keys holds provider ids AND the synthesised `name:<fold>` keys for the
   spellings a channel names without numbering. */
export const personKeysForDriver = (keys = '$3') => `
  SELECT DISTINCT pkey FROM (
    SELECT ${personKeyStored('t')} AS pkey
      FROM trip t
     WHERE t.driver_ext_id = ANY(${keys})
        /* THE PLAIN FOLD ON BOTH SIDES, WHICH IS WHAT THE REST OF THE PRODUCT
           COMPARES. This read trip.person_key — built with custody_sql.js
           personFold, which collapses repeated adjacent words via
           '(\\m\\w+)( \\1)+' — against keys built by driver_routes.js
           nameKey() out of canonSql(), the PLAIN fold, which does not collapse
           repeats. Two different folds, compared for equality. driver_routes.js
           states the rule outright: "Never build a name: key with
           canonName()", and reading person_key here does the equivalent.

           MEASURED RATHER THAN ASSUMED, because the obvious story here is not
           quite the true one: driverScope() puts BOTH forms into 'keys' — the
           collapsing fold arrives through 'ids' (which renders an id-less row
           as 'name:' || person_key) and the plain fold through nameKey() — so
           the single-fold comparison did in fact match on the fixture that was
           built to break it. The defect is therefore latent rather than live:
           the comparison was correct only because the OTHER side happened to
           be a superset. Both forms are compared now, so this branch no longer
           depends on which of a person's spellings reached which list. */
        /* BOTH FOLDS, because driverScope() builds 'keys' out of both and the
           two are not the same string. 'ids' carries 'name:' || person_key for
           every row the provider named without numbering — the COLLAPSING fold,
           which turns 'Sajid Gul Gul Muhammad' into 'sajid gul muhammad' —
           while nameKey() adds 'name:' || CANON(driver_name), the PLAIN fold,
           which leaves the repeat in. Matching on one of the two is matching on
           whichever of a person's spellings happened to reach that branch, and
           driver_routes.js records the cost of getting this wrong: the
           Unauthorized tab shows a different person from the Trips tab beside
           it. A key that matches nothing costs one comparison — the same
           reasoning driverScope() gives for building 'keys' as a superset. */
        OR ('name:' || coalesce(t.person_key, '')) = ANY(${keys})
        OR ('name:' || lower(regexp_replace(btrim(t.driver_name), '\\s+', ' ', 'g'))) = ANY(${keys})
    UNION ALL
    /* The resolved keys themselves. A custody row whose driver_name is present
       always carries a folded person_key, but a person key FALLS BACK to the
       raw id (api/custody_sql.js personKeyStored) wherever the name is not, and
       a person whose every trip is on a channel that numbers them would
       otherwise be reachable only through the fold. A key that matches nothing
       costs one comparison — the same reasoning driver_routes.js records for
       building the key list as a superset of the account list. */
    SELECT unnest(${keys}::text[])
  ) s WHERE coalesce(btrim(pkey), '') <> ''`;
