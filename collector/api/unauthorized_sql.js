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
   unauthorized segments, not a sub-sample:

     bracketed        13   named by TIME, on Uber trips either side
     sole_custodian   48   one custodian that day; custody, not driving
     ambiguous        26   two or more candidates; NO choice is made
     unknown          33   no custody record at all; no name is invented

   Two thirds of this feature is therefore day-custody and absence, and the
   surfaces built on it must be designed for that rather than for the 11% where
   time helps. The distribution rides on the fleet endpoint's response for
   exactly that reason: an operator who reads "13 named by time, 48 by day
   custody alone, 26 with more than one candidate, 33 with nobody" understands
   what the page is before they read a single name.

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
   named by the ladder.

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
   sql/schema_v53.sql from api/identity_map.js. */
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

/* Uber only, because the operator asked for Uber — "we can match who drove
   that car using uber" — and because it is the channel whose coverage on this
   fleet is near total. Measured, for the record, so a later change is a
   decision rather than a discovery: letting Bolt and the hotel channel bracket
   as well moves the distribution to 50/30/22/13/5 at the five caps above, i.e.
   22 rather than 13 at this cap. Widening it is defensible; doing it silently
   is not. */
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
    "after" side of a bracket harder to satisfy, never easier. */
const SEG_END = (o = 'o') => `coalesce(${o}.ended_at, ${o}.started_at)`;

export const TIERS = ['bracketed', 'sole_custodian', 'ambiguous', 'unknown'];

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
  sole_custodian: 'One custodian. Exactly one person holds this car on this Dubai day '
    + 'across every channel, so there is nobody else it could have been — but this is '
    + 'custody, not driving: no booking places anyone behind the wheel during the '
    + 'journey itself.',
  ambiguous: 'More than one candidate, and nothing separates them. Every person who '
    + 'held the car that day is listed, equally weighted and in name order. No choice '
    + 'is made and none should be read into the ordering.',
  unknown: 'Nobody. No booking on any channel names a driver for this car on this day, '
    + 'so there is no candidate to offer. The car’s usual driver is NOT shown here: '
    + 'naming them would be invention.',
};

/* ── the ladder, as one lateral join ──────────────────────────────────────
   A LATERAL rather than a set of correlated scalar subqueries, because the
   tiers share their working: the custodian list decides three of the four
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
     before_min/after_min  the two gaps, stated rather than summarised
     custodian_count  how many people held the car that day, whatever the tier
     clock_skew_min   present when the tracker's clock makes time useless here
*/
export const attributionJoin = (o = 'o') => {
  const PV = `(${BRACKET_PLATFORMS.map((p) => `'${p}'`).join(', ')})`;
  const END = SEG_END(o);
  return `
LEFT JOIN LATERAL (
  WITH cust AS (
    /* Who held the car that Dubai day, ONE ROW PER HUMAN. DISTINCT ON the
       person key, ordered exactly as api/custody_sql.js custodyRefs() orders
       it, so the name and id this surface shows for a person are the same name
       and id the vehicle page and the segment page show. */
    SELECT DISTINCT ON (${personKeyStored('v')})
           ${personKeyStored('v')} AS pkey, v.driver_name AS name, v.driver_ext_id AS id
      FROM vehicle_driver_day v
     WHERE v.plate = ${o}.plate
       AND v.day = ${SEG_DAY(o)}
       AND v.driver_name IS NOT NULL
     ORDER BY ${personKeyStored('v')}, v.is_primary DESC, v.trips DESC
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
    SELECT ${personKeyStored('t')} AS pkey, t.driver_name AS name, t.driver_ext_id AS id,
           t.platform, t.external_id, t.requested_at, t.ended_at
      FROM trip t
     WHERE t.plate = ${o}.plate
       AND t.platform IN ${PV}
       AND coalesce(btrim(t.driver_ext_id), '') <> ''
       AND t.requested_at BETWEEN ${o}.started_at
                                  - interval '${BRACKET_CAP_MIN} minutes' - interval '8 hours'
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
       person who handed it on. */
    SELECT b.pkey, b.name, b.id, b.gap_min AS before_min, r.gap_min AS after_min,
           b.ended_at AS before_at, r.requested_at AS after_at
      FROM arrived b JOIN resumed r USING (pkey)
     WHERE NOT EXISTS (
       SELECT 1 FROM near x
        WHERE x.pkey <> b.pkey
          AND x.requested_at > b.ended_at
          AND x.requested_at < r.requested_at)
  ),
  tally AS (
    SELECT (SELECT count(*) FROM cust)::int    AS custodians,
           (SELECT count(*) FROM bracket)::int AS brackets,
           ${SKEW(`${o}.verdict_reason`)}      AS skew,
           /* How many bookings of ANY kind name a driver on this car on this
              Dubai day. It separates the two unknowns: a car nothing booked at
              all, and a car with bookings whose custody row was never built.
              Those are different absences and must read as different
              sentences — the discipline api/status_routes.js records after
              sixty-six drivers Uber had said nothing about were reported as
              offline. */
           (SELECT count(*)::int FROM trip t2
             WHERE t2.plate = ${o}.plate
               AND (t2.requested_at AT TIME ZONE 'Asia/Dubai')::date = ${SEG_DAY(o)}
               AND coalesce(btrim(t2.driver_ext_id), '') <> '') AS day_bookings
  ),
  named AS (
    /* THE LADDER. A bracket only counts when exactly one person brackets and
       the tracker's clock is trustworthy; two bracketing people is not a
       narrower answer than custody, it is a contradiction, and it falls
       through to be reported as what it is. */
    SELECT CASE
             WHEN tally.skew IS NULL AND tally.brackets = 1 THEN 'bracketed'
             WHEN tally.custodians = 1 THEN 'sole_custodian'
             WHEN tally.custodians > 1 THEN 'ambiguous'
             ELSE 'unknown'
           END AS tier, tally.*
      FROM tally
  )
  SELECT
    named.tier,
    named.custodians AS custodian_count,
    named.skew       AS clock_skew_min,
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
    /* THE CANDIDATES. One object per human, never one per platform account.
       On 'bracketed' this is the single person time named; on 'sole_custodian'
       and 'ambiguous' it is every custodian, in NAME order — never in trip-count
       order, because any ordering of an ambiguous list is read as a ranking and
       there is no ranking here. On 'unknown' it is an empty array, and it is an
       empty array rather than NULL so that a column keyed on it survives
       api/public/ui.js tableFrom's blank-column pruning on a page whose rows
       are all unknown, which is precisely when a reader needs to see it. */
    CASE named.tier
      WHEN 'bracketed' THEN
        (SELECT jsonb_agg(jsonb_build_object('name', name, 'id', id, 'key', pkey))
           FROM bracket)
      WHEN 'unknown' THEN '[]'::jsonb
      ELSE (SELECT jsonb_agg(jsonb_build_object('name', name, 'id', id, 'key', pkey)
                             ORDER BY name) FROM cust)
    END AS candidates,
    CASE named.tier
      WHEN 'bracketed' THEN (SELECT array_agg(pkey) FROM bracket)
      WHEN 'unknown'   THEN ARRAY[]::text[]
      ELSE (SELECT array_agg(pkey) FROM cust)
    END AS candidate_keys,
    CASE named.tier
      WHEN 'bracketed' THEN 1
      WHEN 'unknown'   THEN 0
      ELSE named.custodians
    END AS candidate_count,
    /* THE EVIDENCE, AS A SENTENCE SOMEBODY CAN GO AND CHECK.
       "Bracketed" is not checkable; "their trip ended 34 minutes before and
       the next began 19 minutes after" is — the reader can open the car's trip
       list and see those two rows. Every sentence therefore carries the
       measurement, not the conclusion, and the ones that name nobody say which
       kind of nothing they found. */
    CASE named.tier
      WHEN 'bracketed' THEN format(
        'Named by time: %s. Their Uber trip on %s ended %s minutes before this journey '
        || 'started, and their next Uber trip on the same car began %s minutes after it '
        || 'ended. No other driver has a booking on this car between those two. '
        || 'Uber only, both gaps within %s minutes.',
        (SELECT name FROM bracket LIMIT 1), ${o}.plate,
        (SELECT before_min FROM bracket LIMIT 1), (SELECT after_min FROM bracket LIMIT 1),
        ${BRACKET_CAP_MIN})
      WHEN 'sole_custodian' THEN format(
        'Not named by time: no Uber trip on %s ends within %s minutes before this journey '
        || 'or begins within %s minutes after it%s. %s is the only person the trip record '
        || 'shows holding this car on %s, so there is nobody else it could have been — but '
        || 'this is custody, not driving.',
        ${o}.plate, ${BRACKET_CAP_MIN}, ${BRACKET_CAP_MIN},
        CASE WHEN named.skew IS NULL THEN ''
             ELSE format(' (and this car’s tracker reports a clock %s minutes behind wall '
                         || 'time, so no comparison against a booking clock would be '
                         || 'trustworthy here)', named.skew) END,
        (SELECT name FROM cust LIMIT 1),
        to_char(${SEG_DAY(o)}, 'YYYY-MM-DD'))
      WHEN 'ambiguous' THEN format(
        '%s people held %s on %s — %s — and the evidence cannot separate them: no Uber trip '
        || 'on this car ends within %s minutes before this journey or begins within %s '
        || 'minutes after it%s. Every candidate is listed; none is chosen.',
        named.custodians, ${o}.plate, to_char(${SEG_DAY(o)}, 'YYYY-MM-DD'),
        (SELECT string_agg(name, ', ' ORDER BY name) FROM cust),
        ${BRACKET_CAP_MIN}, ${BRACKET_CAP_MIN},
        CASE WHEN named.skew IS NULL THEN ''
             ELSE format(' (and this car’s tracker reports a clock %s minutes behind wall '
                         || 'time, so no comparison against a booking clock would be '
                         || 'trustworthy here)', named.skew) END)
      ELSE CASE WHEN named.day_bookings > 0 THEN format(
        'Nobody can be named. No custody record exists for %s on %s, although the trip '
        || 'record holds %s booking(s) naming a driver on this car that day — so this is a '
        || 'gap in vehicle_driver_day, not a car nobody drove.',
        ${o}.plate, to_char(${SEG_DAY(o)}, 'YYYY-MM-DD'), named.day_bookings)
        ELSE format(
        'Nobody can be named. No booking on any channel names a driver for %s on %s. The car '
        || 'has a seat sensor and a GPS trace and no booking identity whatsoever; the car’s '
        || 'usual driver is deliberately NOT shown, because naming them would be invention.',
        ${o}.plate, to_char(${SEG_DAY(o)}, 'YYYY-MM-DD')) END
    END AS evidence
  FROM named
) att ON true`;
};

/** The columns attributionJoin() contributes, for a caller's SELECT list. */
export const ATTRIBUTION_COLS = `att.tier AS attribution_tier,
  att.candidates AS attribution_candidates,
  att.candidate_count AS attribution_candidate_count,
  att.candidate_keys AS attribution_candidate_keys,
  att.evidence AS attribution_evidence,
  att.before_min AS bracket_before_min,
  att.after_min AS bracket_after_min,
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
        OR ('name:' || coalesce(t.person_key, '')) = ANY(${keys})
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
