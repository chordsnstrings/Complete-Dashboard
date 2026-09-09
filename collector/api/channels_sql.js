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

/** The latest collection run per source AND FLEET: what it said, and what
    went wrong.
    ─────────────────────────────────────────────────────────────────────────
    PER FLEET, and it was not — this was `DISTINCT ON (source)`, so of the two
    runs a channel makes each pass, whichever finished last won and was then
    printed against BOTH fleets. Measured on production 2026-09-09,
    /api/platforms?days=1:

        bolt/ecosine  partial  "FI roster ecosine: BOLT_CLIENT_ID is not
                                entitled to company_id 142868 …"
        bolt/egari    partial  "FI roster ecosine: BOLT_CLIENT_ID is not
                                entitled to company_id 142868 …"

    Egari's row states an ECOSINE failure. Egari's own FI roster reads company
    142897 without complaint — the message even says so, "the same token read
    142897 (egari), so the secret is fine" — so the page accused a fleet of a
    fault its own run disproves, and an operator reading it concluded the Bolt
    credential they had just pasted had been rejected. It had not; a different
    credential on the other fleet had failed.

    /api/status was fixed for exactly this and says why in its own header:
    "Ecosine and Egari are separate businesses with separate credentials on the
    same providers … Keyed on (source, mode) alone, one fleet's row won and the
    other vanished." It became DISTINCT ON (source, mode, fleet_id). This
    module was left behind, and the two routes that read it kept the bug.

    DISTINCT ON over one index-ordered scan rather than a correlated subquery
    per channel — /api/status already reads the table exactly this way. */
export function channelHealthSql() {
  return `SELECT DISTINCT ON (source, fleet_id) source, fleet_id, status, error,
                 rows_written, finished_at
            FROM collection_run
           ORDER BY source, fleet_id, finished_at DESC NULLS LAST`;
}

/* Two keys in one map, and they are not interchangeable. A row that knows its
   fleet must never be answered from another fleet's run, and a caller with no
   fleet dimension at all still needs one honest answer for the channel. The
   marker keeps them apart: a run recorded with fleet_id null is a genuinely
   fleet-wide surface and keys on '', while ROLLUP is this module's own summary
   over the fleets and can never be mistaken for a run. */
const ROLLUP = '\u0000rollup';
const hkey = (source, fleet) => `${source}\u0000${fleet ?? ''}`;

/* Worst-first, because a channel is only as collected as its unhappiest fleet.
   Taking the latest run instead is what produced the defect above: it reported
   whichever fleet happened to finish second, which on a two-fleet channel is a
   coin toss. */
const RANK = { error: 3, partial: 2, ok: 1 };
const worseOf = (a, b) => ((RANK[b?.collection_status] || 0) > (RANK[a?.collection_status] || 0) ? b : a);

/** Fold a channelHealthSql() result set into a lookup. Read it with
    healthFor(), never with .get() — the key shape is this module's business. */
export function channelHealth(rows) {
  const by = new Map();
  const perSource = new Map();
  for (const r of rows || []) {
    const entry = {
      collection_status: r.status || null,
      /* The provider's own words, trimmed but not summarised. "code=503
         NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED" is the whole diagnosis; a
         tidied "collection failed" is not. */
      collection_error: r.error ? String(r.error).slice(0, 240) : null,
      collection_at: r.finished_at || null,
    };
    by.set(hkey(r.source, r.fleet_id), entry);
    perSource.set(r.source, worseOf(perSource.get(r.source), entry));
  }
  for (const [source, worst] of perSource) by.set(hkey(source, ROLLUP), worst);
  return by;
}

/** What to say about this channel, for this fleet.
    ─────────────────────────────────────────────────────────────────────────
    A row carrying a fleet gets that fleet's own run, or the fleet-wide run if
    the source records one, and NOTHING otherwise — deliberately. Falling back
    to the other fleet's run is the whole defect this replaces; a fleet with no
    run of its own has not been collected, and absent is the true answer.

    A row carrying no fleet — a declared channel with no rows behind it, or a
    caller like /api/revenue that folds the fleets together — gets the roll-up. */
export const ABSENT_HEALTH = {
  collection_status: null, collection_error: null, collection_at: null,
};
export function healthFor(by, source, fleet) {
  if (!by) return ABSENT_HEALTH;
  if (fleet) return by.get(hkey(source, fleet)) || by.get(hkey(source, null)) || ABSENT_HEALTH;
  return by.get(hkey(source, ROLLUP)) || ABSENT_HEALTH;
}
