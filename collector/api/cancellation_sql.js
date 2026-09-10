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

/* THE DRIVER'S DOING. Every one of these is the driver ending or declining a
   job, across both channels that say so. */
const DRIVER_SET = [
  'driver_cancelled',               // uber
  'driver_cancelled_after_accept',  // bolt — accepted, then abandoned
  'driver_did_not_respond',         // bolt — offered, ignored
  'driver_rejected',                // bolt — offered, declined
];

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
    WHEN n.outcome <> 'not_completed' THEN NULL
    WHEN ${BARE} IN (${list(DRIVER_SET)}) THEN 'driver'
    WHEN ${BARE} IN (${list(RIDER_SET)})  THEN 'rider'
    ELSE 'unattributed'
  END`;

export const DRIVER_STATUSES = DRIVER_SET;
export const RIDER_STATUSES = RIDER_SET;

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
             (array_agg(DISTINCT n.driver_ext_id)
                FILTER (WHERE n.driver_ext_id IS NOT NULL))         AS driver_ext_ids,
             (array_agg(DISTINCT n.platform))                       AS platforms,
             count(*) FILTER (WHERE n.is_booking)::int              AS bookings,
             count(*) FILTER (WHERE n.outcome = 'completed')::int   AS completed,
             count(*) FILTER (WHERE ${CANCEL_CASE} IS NOT NULL)::int          AS cancelled,
             count(*) FILTER (WHERE ${CANCEL_CASE} = 'driver')::int           AS by_driver,
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
     ORDER BY b.cancelled DESC, b.bookings DESC`;
}
