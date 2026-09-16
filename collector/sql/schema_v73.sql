/* THE INDEX min(at) READS, AND WHY AN EMPTY WINDOW COST 67 SECONDS.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT, MEASURED ON PRODUCTION RATHER THAN REASONED ABOUT.
   /api/unauthorized/attributed and /api/driver/unauthorized both call
   statusHistoryFrom() — `SELECT min(at) FROM driver_status_event`, with no
   WHERE — once per request, inside the same Promise.all as the rows, the
   total and the tier distribution. Timed against production 2026-09-16:

     window            segments   response
     days=1                   5      98.6 s
     days=3                  16      78.2 s
     days=30                123      84.1 s
     2020-01-01..02           0      67.0 s   <- the one that names the cause
     2019-01-01..02           0     109.1 s

   A window with NO segments in it still cost 67 to 109 seconds. Every other
   query behind the route is bound by $1/$2 and returns nothing on an empty
   window; the attribution ladder never runs at all, because there is no row
   to run it over. The ONE query in the route that does not look at the window
   is this min(), and it is what the whole response was waiting on.

   WHY AN UNFILTERED min() ON A TWO-DAY-OLD TABLE IS A SIXTY-SECOND QUERY.
   driver_status_event carries two indexes (sql/schema_v70.sql:88-89):
   (local_day, status) and (driver_ext_id, at DESC). Neither can serve a min()
   over the whole table — `at` is the SECOND column of the only index that
   mentions it — so this is a sequential scan, and the scan is over a heap far
   larger than the live row count.

   src/sources/uber.js:1919 upserts EVERY status entry the provider carries for
   EVERY driver on every live tick (LIVE_STATUS_SECONDS, default 120), and
   upsertMany's ON CONFLICT DO UPDATE rewrote each of those rows whether or not
   a single byte had changed. Each rewrite is a dead tuple a sequential scan
   still has to read. The table's own comment calls itself append-only and the
   call site calls the write "idempotent by construction" — it is idempotent in
   its RESULT and was not idempotent in its COST. src/db.js now suppresses the
   no-op update, which stops the heap growing; this index makes the read cheap
   whatever the heap looks like.

   BOTH FIXES, NOT EITHER. The index alone would leave a table bloating at
   roughly a tick's worth of rows every two minutes for every other reader.
   The write fix alone would leave min() a sequential scan that grows with the
   real table, which is append-only and therefore grows forever.

   PLAIN ASCENDING, NOT DESC. The two questions asked of this column are the
   FIRST instant the feed holds (this one — what statusNote() needs to say how
   far back the record reaches) and the LAST instant for one driver, which
   dse_driver_idx already serves. min() reads the leading edge of an ascending
   index in one page. `at` is NOT NULL, so there is no null-ordering subtlety
   and no partial predicate to keep in step with a query. */
CREATE INDEX IF NOT EXISTS dse_at_idx ON driver_status_event (at);
