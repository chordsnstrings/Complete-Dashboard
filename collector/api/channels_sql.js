/* The channels this deployment collects bookings from — including the ones
   that answer with nothing.
   ─────────────────────────────────────────────────────────────────────────
   Two pages exist to inventory the sources: the Revenue page's channel tables
   and the Platforms page's coverage table. Both were built by GROUPing over
   rows that arrived, so a channel that delivered nothing had no row and was
   invisible on precisely the two screens whose job is to say what is missing.
   The Revenue page's own docstring says "a platform contributing nothing is
   the most important row on the page, because it is the one somebody can fix",
   and that row did not exist: /api/revenue returned exactly three platforms at
   7, 30 and 365 days, and Bolt — which has never written a booking, because
   Ecosine is refused with COMPANIES_NOT_ALLOWED and Egari's token expired —
   appeared nowhere.

   So the channel list is declared, not inferred, and the collection run's own
   verdict is carried beside each one. An empty row that says why it is empty
   is a work item; an absent row is a page quietly agreeing that nothing is
   wrong.

   FMS is deliberately not here. Its rows are telematics twins of bookings
   other channels already reported (is_booking = platform <> 'fms', see
   sql/schema_v7.sql), so it is a source of journeys, never of demand or
   money, and listing it as a revenue channel would invite somebody to ask
   where its fares went. */
export const BOOKING_CHANNELS = ['uber', 'yango', 'bolt', 'hotel'];

/** The latest collection run per source: what it said, and what went wrong.
    DISTINCT ON over one index-ordered scan rather than a correlated subquery
    per channel — /api/status already reads the table exactly this way. */
export function channelHealthSql() {
  return `SELECT DISTINCT ON (source) source, status, error, rows_written, finished_at
            FROM collection_run
           ORDER BY source, finished_at DESC NULLS LAST`;
}

/** Fold a channelHealthSql() result set into a lookup keyed by channel. */
export function channelHealth(rows) {
  const by = new Map();
  for (const r of rows || []) {
    by.set(r.source, {
      collection_status: r.status || null,
      /* The provider's own words, trimmed but not summarised. "code=503
         NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED" is the whole diagnosis; a
         tidied "collection failed" is not. */
      collection_error: r.error ? String(r.error).slice(0, 240) : null,
      collection_at: r.finished_at || null,
    });
  }
  return by;
}
