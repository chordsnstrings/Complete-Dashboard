import { JOIN_TRIP } from './custody_sql.js';

/* WHO CANCELLED — one definition, and one honest refusal.
   ──────────────────────────────────────────────────────────────────────────
   Every channel names a cancellation differently, and one of them does not
   say who did it at all. The vocabulary below is MEASURED, not remembered —
   sampled across six drivers over thirty days on production, 2026-09-10:

     uber    completed 1021 · rider_cancelled 111 · driver_cancelled 3
     bolt    finished 20 · client_cancelled 11 · driver_cancelled_after_accept 2
             driver_did_not_respond 2 · driver_rejected 1
     yango   complete 23 · cancelled 6

   So Uber and Bolt attribute every cancellation and YANGO ATTRIBUTES NONE.
   Its status is the bare word `cancelled`, which is true of a rider changing
   their mind and of a driver refusing the job, and nothing in the payload
   separates them — the raw order carries no cancellation actor either.

   That third bucket is the whole reason this file exists. Folding Yango's
   cancellations into "rider" would flatter every driver who works it; folding
   them into "driver" would accuse people on the strength of a word that does
   not say so. Dropping them would make a driver's cancellation count disagree
   with their own trip list. So they are counted, kept apart, and named — and
   a page that shows a driver/rider split has to show this column beside it or
   it is publishing a split it cannot support.

   ── BOLT'S PREFIX ────────────────────────────────────────────────────────
   `optional_ride_` marks a ride offered as a BACKUP. It describes how the
   offer was made, not how it ended, and sql/schema_v18.sql strips it before
   deciding an outcome — 1,534 rows over 365 days were mis-bucketed before it
   did. The same strip happens here, for the same reason: a prefixed
   driver_did_not_respond is still the driver not responding.

   ── WHY `driver_rejected` AND `driver_did_not_respond` COUNT AS THE DRIVER ─
   Both are the driver declining work that was offered to them, which is the
   question an operator is asking when they open this page. They are kept
   DISTINCT from an outright cancel-after-accept in the detail, because
   refusing an offer and abandoning an accepted job are different behaviours,
   and only the second leaves a rider waiting. */

/* Bolt's backup-offer prefix, removed before matching. */
const BARE = "regexp_replace(lower(coalesce(n.status, '')), '^optional_ride_', '')";

/* THE DRIVER'S DOING — and it is TWO things, not one.
   ──────────────────────────────────────────────────────────────────────────
   A driver who accepts a job and then abandons it has left a rider standing
   in the street. A driver who lets a broadcast offer go past has not. Both
   were counted into one number, and that number was the page's headline and
   its sort key, so the list ranked people by WHICH APP THEY WORK.

   MEASURED on production over 2026 to date, from this endpoint's own output:

     "by the driver", fleet-wide            7,032
       of which offers declined or ignored  5,307   (Bolt files these; Uber does not)
       jobs accepted and then abandoned       566
       Uber driver_cancelled                1,159

   Three quarters of every driver-attributed cancellation in this product was a
   Bolt offer nobody picked up. The top of the list was Zain Ali Ghulam
   Hassnain on 440 — 433 of them offers he did not take and 7 jobs he dropped —
   ranked above every Uber driver who abandoned a real dispatch.

   It reaches the RATE too, because Bolt's offer rows are bookings: the median
   cancellation rate is 64% for the 53 people who only work Bolt and 15% for
   the 68 who only work Uber. That is not a four-fold difference in behaviour,
   it is two companies writing their logs differently, and no operator should
   be handed it as a ranking. `accepted` below is the denominator that can be
   compared — bookings minus the offers that never became a dispatch.

   So the two are counted apart, and the page shows them apart. The union is
   kept as `by_driver` because the three-bucket total still has to add up. */
const DROPPED_SET = [
  'driver_cancelled',               // uber — a dispatched trip, ended by the driver
  'driver_cancelled_after_accept',  // bolt — accepted, then abandoned
];
const DECLINED_SET = [
  'driver_did_not_respond',         // bolt — offered, ignored
  'driver_rejected',                // bolt — offered, declined
  /* The same act under a second name, and it was NOT on this list.
     sql/schema_v18.sql already reads offer_rejected as a non-completion, and
     the collector asks the portal for every state precisely so a new one is
     not silently dropped — but this file did not match it, so it fell through
     to `unattributed` and the page reported it as "nobody said who". On
     production over 2026 that was 19 rows (15 bare, 4 optional_ride_) out of
     an unattributed bucket of 40: HALF of what the page called unattributable
     was a status that names the actor in the word itself. */
  'offer_rejected',                 // bolt — offered, declined, said differently
];
const DRIVER_SET = [...DROPPED_SET, ...DECLINED_SET];

/* WHICH CHANNELS FILE AN OFFER AT ALL, which the page needs so that a blank in
   the offers column reads as "this channel does not report them" rather than
   as a clean record. A list, measured, in the same spirit as the status
   vocabulary above rather than a rule about names: over 2026 to date every one
   of the 5,307 declined-offer rows the fleet holds came from Bolt, and neither
   Uber, Yango, the hotel channel nor CABMAN has ever filed one. Uber's export
   contains dispatched trips; the offers that preceded them are not in it. */
export const OFFER_CHANNELS = ['bolt'];

/* THE RIDER'S DOING. `client_did_not_show` is here on purpose: the ride ended
   because the rider was not there, which is not the driver's cancellation
   however it is billed. */
const RIDER_SET = [
  'rider_cancelled',                // uber
  'client_cancelled',               // bolt
  'client_did_not_show',            // bolt
];

const list = (a) => a.map((s) => `'${s}'`).join(', ');

/* A cancellation is any not-completed booking. Read off trip_norm's `outcome`
   rather than re-deriving it: that view already strips Bolt's prefix, already
   excludes FMS telematics journeys from being bookings at all, and is the
   thing every other page counts cancellations with. Two definitions of
   "cancelled" in one product is how two pages come to disagree. */
export const CANCEL_CASE = `
  CASE
    /* IS DISTINCT FROM, not a plain inequality. A NULL outcome makes the
       inequality return NULL rather than true, so the branch does not fire and
       the row falls all the way
       through to ELSE — and every FMS telematics journey, which has no outcome
       at all because sql/schema_v18.sql gives one only to bookings, was
       classified as an unattributable CANCELLATION.

       It was invisible while the only caller filtered is_booking in its own
       WHERE, which api/cancellation_routes.js does. The moment a second surface
       used this expression without that filter it counted 9 telematics rows out
       of a fixture of 13 as cancellations nobody could attribute. An expression
       exported for reuse cannot depend on what its callers happen to filter. */
    WHEN n.outcome IS DISTINCT FROM 'not_completed' THEN NULL
    WHEN ${BARE} IN (${list(DRIVER_SET)}) THEN 'driver'
    WHEN ${BARE} IN (${list(RIDER_SET)})  THEN 'rider'
    ELSE 'unattributed'
  END`;

export const DRIVER_STATUSES = DRIVER_SET;
export const RIDER_STATUSES = RIDER_SET;

/* The two halves of the driver bucket, as SQL, exported because a second
   surface needs them and a second surface writing its own copy is how the
   Today screen and this page would come to disagree about one morning. The
   whole reason this file exists is that there is one definition of a
   cancellation; there is one of who caused it too. */
export const DROPPED_SQL = `${BARE} IN (${list(DROPPED_SET)})`;
export const DECLINED_SQL = `${BARE} IN (${list(DECLINED_SET)})`;

/* Per person, over the window the reader chose. Grouped on person_key so a
   driver who works two channels is one row — the same identity rule the rest
   of the product uses (api/identity_map.js), rather than a second one.

   person_key comes off the BASE TABLE, not the view: trip_norm is
   `SELECT t.*` and a view's star is frozen at creation, so the column added in
   sql/schema_v53.sql is not on it. api/custody_sql.js exports JOIN_TRIP for
   exactly this and says it has been needed in four places — this is the fifth,
   and it uses the export rather than writing the join a fifth time, because
   each hand-written copy is a chance to join on the wrong pair of columns. */
export function cancellationsSql({ where = 'TRUE' } = {}) {
  return `
    WITH base AS (
      SELECT coalesce(nullif(t.person_key, ''), n.driver_ext_id)  AS person_key,
             max(n.driver_name)                                    AS driver_name,
             /* SINGULAR as well as the array, and it is not redundant.
                test/completeness.test.mjs enforces a product rule — "no driver
                name is returned without an id to open them by" — and it looks
                for driver_ext_id, driver_refs or id. This endpoint returned
                driver_ext_ids (plural) and nothing else, so every row named a
                person the page could not link to. min() rather than [1] so the
                id is stable between calls: array_agg over a set with no ORDER
                BY may come back in a different order, and a link that moves
                between refreshes is a link somebody reports as a bug. */
             min(n.driver_ext_id)                                   AS driver_ext_id,
             (array_agg(DISTINCT n.driver_ext_id)
                FILTER (WHERE n.driver_ext_id IS NOT NULL))         AS driver_ext_ids,
             /* WHAT THEY WERE DRIVING, which the same test requires of any list
                that names a driver — and which an operator ringing about a
                cancellation actually wants, because "which car were you in" is
                the next question after "why did you cancel". Only the plates on
                the CANCELLED bookings, not every car they touched in the
                window: a plate listed here is one a cancellation happened in. */
             (array_agg(DISTINCT n.plate)
                FILTER (WHERE ${CANCEL_CASE} IS NOT NULL AND n.plate IS NOT NULL
                          AND n.plate <> ''))                       AS plates,
             (array_agg(DISTINCT n.platform))                       AS platforms,
             count(*) FILTER (WHERE n.is_booking)::int              AS bookings,
             count(*) FILTER (WHERE n.outcome = 'completed')::int   AS completed,
             count(*) FILTER (WHERE ${CANCEL_CASE} IS NOT NULL)::int          AS cancelled,
             count(*) FILTER (WHERE ${CANCEL_CASE} = 'driver')::int           AS by_driver,
             /* The two halves of it, which are the columns the page draws. */
             count(*) FILTER (WHERE ${DROPPED_SQL})::int                      AS dropped,
             count(*) FILTER (WHERE ${DECLINED_SQL})::int                     AS declined,
             /* The only denominator a drop rate can honestly have: the jobs
                that actually reached this person as a dispatch. A Bolt driver's
                booking count includes offers they never took, so dropped over
                bookings compares a Bolt row against an Uber row and gets the
                wrong answer in Bolt's favour on the numerator and against it on
                the denominator at the same time. */
             (count(*) FILTER (WHERE n.is_booking)
              - count(*) FILTER (WHERE ${DECLINED_SQL}))::int                  AS accepted,
             /* Does this person work a channel that files offers in this
                window? Without it a zero in the offers column is unreadable:
                an Uber-only driver has no offers on record because Uber does
                not report them, not because they took everything they were
                shown. */
             (array_agg(DISTINCT n.platform) && ARRAY[${list(OFFER_CHANNELS)}]::text[]) AS on_offer_channel,
             count(*) FILTER (WHERE ${CANCEL_CASE} = 'rider')::int            AS by_rider,
             count(*) FILTER (WHERE ${CANCEL_CASE} = 'unattributed')::int     AS unattributed,
             /* Which channels the unattributed ones came from, so the reason
                names the provider instead of saying "some data is missing". */
             (array_agg(DISTINCT n.platform)
                FILTER (WHERE ${CANCEL_CASE} = 'unattributed'))     AS unattributed_platforms,
             /* The detail behind "by the driver": declining an offer and
                abandoning an accepted job are different behaviours. */
             count(*) FILTER (WHERE ${BARE} = 'driver_cancelled_after_accept')::int
               AS driver_after_accept,
             count(*) FILTER (WHERE ${BARE} IN ('driver_did_not_respond', 'driver_rejected'))::int
               AS driver_declined_offer,
             count(*) FILTER (WHERE ${BARE} = 'driver_cancelled')::int
               AS driver_cancelled_uber
        FROM trip_norm n
        ${JOIN_TRIP}
       WHERE ${where}
       GROUP BY 1)
    SELECT b.*,
           /* The platform's own rating and the phone the roster filed, both
              LATERAL … LIMIT 1: driver_platform_state is keyed
              (platform, driver_ext_id), so one person on two channels has two
              rows and a plain join would double every count above. That trap
              is why api/driver_routes.js does the same thing at :713. */
           r.rating, r.rating_platform,
           p.phone
      FROM base b
      LEFT JOIN LATERAL (
        /* Uber's rating first, because that is the one an operator means, and
           the column names which platform it came from so nobody reads a Bolt
           score as an Uber one. driver_platform_state DOES carry rating;
           only phone was the wrong guess. (No backticks in here: this is
           inside a template literal, and a backtick ends it — which is the
           second time that has bitten in this session.) */
        SELECT dps.rating, dps.platform AS rating_platform
          FROM driver_platform_state dps
         WHERE dps.driver_ext_id = ANY(b.driver_ext_ids) AND dps.rating IS NOT NULL
         ORDER BY (dps.platform = 'uber') DESC, dps.rating DESC
         LIMIT 1) r ON TRUE
      /* PHONE IS ON driver_compliance, not driver_platform_state — the latter
         has no such column and this query 500'd on "dps.phone does not exist"
         until route_smoke ran it. The roster is what files a number
         (api/driver_routes.js:1034 reads it from the same table), and
         src/identity_link.js joins two records of one person on it, which is
         why it is the reliable one. */
      LEFT JOIN LATERAL (
        SELECT dc.phone
          FROM driver_compliance dc
         WHERE dc.driver_ext_id = ANY(b.driver_ext_ids)
           AND dc.phone IS NOT NULL AND dc.phone <> ''
         LIMIT 1) p ON TRUE
     WHERE b.cancelled > 0
     /* Ordered by the jobs somebody was left waiting for, not by the sum that
        used to head this list. The sum ranked by which app a person works --
        see the measurement at the top of this file. The cancellation count
        stays as the tiebreak so the order is still total, and every column
        header on the page is sortable, so a reader who wants the old ranking
        can still ask for it. (No backticks in here: this is inside a template
        literal and a backtick ends it. Third time this session.) */
     ORDER BY b.dropped DESC, b.cancelled DESC, b.bookings DESC`;
}
