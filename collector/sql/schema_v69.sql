/* Repair every Yango trip that was filed as ending before it started.
   ──────────────────────────────────────────────────────────────────────────
   src/sources/yango.js mapped `requested_at` from Yango's `booked_at`, which
   is that provider's CLOSING stamp rather than the request. Measured on the
   raw order 2026-09-10: created_at 08:54:08, driving_at 08:54:11, ended_at
   08:54:21, booked_at 08:55:07 — the booking stamp lands AFTER the end, and
   `order_time_interval.to` equals it to the millisecond.

   So every Yango trip in the table has a negative duration. The collector is
   fixed for new rows; this repairs the history, which is possible only because
   the whole order is stored in trip.raw.

   Guarded three ways rather than run blind:
     - only platform 'yango', because no other source maps this field;
     - only where raw carries a created_at, so an order without one keeps the
       booked_at fallback rather than becoming null;
     - only where the stored requested_at actually disagrees with created_at,
       so a re-run after the collector has refiled a row is a no-op.

   Not conditional on ended_at < requested_at: an order whose two stamps happen
   to sit the right way round was still filed from the wrong field, and leaving
   those would keep two different meanings in one column. */
UPDATE trip
   SET requested_at = (raw ->> 'created_at')::timestamptz
 WHERE platform = 'yango'
   AND raw ? 'created_at'
   AND raw ->> 'created_at' <> ''
   AND (requested_at IS DISTINCT FROM (raw ->> 'created_at')::timestamptz);
