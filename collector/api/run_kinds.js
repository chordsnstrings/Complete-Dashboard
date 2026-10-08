/* WHICH RUNS FETCHED BOOKINGS.
   ═══════════════════════════════════════════════════════════════════════════
   collection_run holds one row per run of anything, and two kinds of 'uber'
   run fetch no trips at all:

     'fares'       the hourly price pass (src/run.js fareRefresh), which asks
                   Uber's payments report and writes prices onto trips
                   already held;
     '<x>:payout'  the payout walk and its catch-up and backfill siblings
                   (src/sources/uber_payout.js), which read statements.

   Every check that asks "was this channel's day collected?" — the SMS
   freshness gates, the Target page's settled rule, the morning report's data
   health, the channel-health and compare panels, the money workbook's
   "latest collection" — read ANY ok row as yes. The payout walk has been
   saying yes for trips it never fetched every two hours; the hourly fares pass
   (2026-10-08) would have said it every hour, so a trip collector dead since
   breakfast would read as current all day. Those checks now count only runs
   of a booking-fetching kind.

   Not used by the credential banner (api/auth_routes.js): a fares run DOES
   prove the Uber login works, which is the only thing that banner measures.

   NULL-safe: `mode` is a nullable column, and a bare `mode <> 'fares'` is
   NULL — so false — for a run logged without one, which would drop it from
   every check above as though it had never run.

   No imports, so any module — src/ or api/ — can use it without a cycle. */
export const TRIP_RUN_SQL = "(coalesce(mode, '') <> 'fares' AND coalesce(mode, '') NOT LIKE '%:payout')";
