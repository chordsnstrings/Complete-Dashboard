/* GET /api/status/uber-live-money — what Uber's live per-trip feed holds, per fleet,
   and whether its fares agree with the statement-grade ones.
   ═════════════════════════════════════════════════════════════════════════
   Each run already reports itself in /api/status (source uber_transactions,
   mode realtime — src/sources/uber_transactions.js says why that mode). That
   says whether the feed was ASKED. It cannot say the two things an operator
   needs before trusting a price this feed wrote:

     1. how many trips carry a provisional price from it right now, and
     2. once Uber's payments report has priced the same trips (the fare walk,
        hours later), whether the two agree.

   The second is the proof the fill rule is safe. The feed's fare is the
   BRANCH of the same category tree the payments report carries, so on a trip
   both have priced the figures should be equal to the fils; a run of
   disagreement would mean the feed is reading a different node, and every
   provisional price it writes is wrong by the same amount. It is measured
   here, on the trips themselves, rather than asserted in a comment.

   ABSENT WITH A REASON, never zero: a fleet with no run says it has none and
   why that can be; an agreement nobody can measure yet says what is missing
   (the payments walk prices a trip hours after the live feed does).

   UNDER /api/status/, WHICH THE RESPONSE CACHE NEVER HOLDS. api/cache.js keys
   every cached answer on a version that a collection run or a rollup moves —
   and this feed's runs are logged in mode 'realtime' precisely so that they do
   NOT move it. Anywhere else this answer would be served from the cache until
   some other pass happened to run, describing a feed that had moved on: the
   defect api/cache.js records for /api/coverage/verified, whose nightly writer
   bumped no version either. /api/status is on its NEVER list by prefix, and an
   answer about whether a feed is fresh belongs there anyway. */

const FLEETS = ['ecosine', 'egari'];
const n = (v) => (v == null ? null : Number(v));

export function uberLiveMoneyRoutes(app, { q, wrap }) {
  app.get('/api/status/uber-live-money', wrap(async (req, res) => {
    const fleet = FLEETS.includes(String(req.query.fleet)) ? String(req.query.fleet) : null;
    const P = [fleet];
    const [runs, lastOk, held, trips] = await Promise.all([
      q(`SELECT DISTINCT ON (fleet_id) fleet_id, status, finished_at, rows_written, error,
                chunks_total, chunks_failed, detail
           FROM collection_run
          WHERE source = 'uber_transactions' AND ($1::text IS NULL OR fleet_id = $1)
          ORDER BY fleet_id, finished_at DESC NULLS LAST`, P),
      q(`SELECT fleet_id, max(finished_at) AS at FROM collection_run
          WHERE source = 'uber_transactions' AND status = 'ok'
            AND ($1::text IS NULL OR fleet_id = $1)
          GROUP BY 1`, P),
      q(`SELECT fleet_id, count(*)::int AS transactions,
                count(DISTINCT trip_uuid)::int AS trips,
                max(processed_at) AS newest
           FROM uber_live_transaction
          WHERE processed_at > now() - interval '24 hours'
            AND ($1::text IS NULL OR fleet_id = $1)
          GROUP BY 1`, P),
      /* Over the trips the feed has priced (its money joined to the trip by
         the trip UUID): which still carry its provisional price, and which the
         payments report has since stated — the second set is where agreement
         can be measured. */
      q(`SELECT m.fleet_id,
                count(*) FILTER (WHERE t.price_source = 'uber_live')::int AS provisional,
                sum(t.price) FILTER (WHERE t.price_source = 'uber_live') AS provisional_aed,
                count(*) FILTER (WHERE t.price_source = 'uber_payments'
                                   AND m.fare IS NOT NULL)::int AS confirmed,
                count(*) FILTER (WHERE t.price_source = 'uber_payments' AND m.fare IS NOT NULL
                                   AND abs(t.price - round(m.fare, 2)) <= 0.01)::int AS agreed,
                max(abs(t.price - round(m.fare, 2)))
                  FILTER (WHERE t.price_source = 'uber_payments' AND m.fare IS NOT NULL) AS worst_gap
           FROM uber_live_trip_money m
           JOIN trip t ON t.platform = 'uber' AND t.external_id = m.trip_uuid
                      AND t.fleet_id = m.fleet_id
          WHERE ($1::text IS NULL OR m.fleet_id = $1)
          GROUP BY 1`, P),
    ]);
    const by = (rows) => new Map(rows.map((r) => [r.fleet_id, r]));
    const R = by(runs), OK = by(lastOk), H = by(held), T = by(trips);
    const fleets = (fleet ? [fleet] : FLEETS).map((f) => {
      const r = R.get(f), h = H.get(f), t = T.get(f);
      if (!r) {
        return { fleet: f, last_run: null,
          absent: 'the live feed has not run for this fleet: it needs an OAuth client and the '
            + 'encrypted org id (UBER_ORG_ENCRYPTED, or UBER_ORG_ENCRYPTED_EGARI for Egari), and '
            + 'it first runs at the quarter hour after the collector starts' };
      }
      const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : (r.detail || []);
      const confirmed = t?.confirmed ?? 0;
      return {
        fleet: f,
        last_run: { status: r.status, finished_at: r.finished_at, written: r.rows_written,
          error: r.error, windows: detail },
        last_ok_at: OK.get(f)?.at ?? null,
        last_24h: h ? { transactions: h.transactions, trips: h.trips, newest: h.newest }
          : { transactions: 0, trips: 0, newest: null,
            why: 'Uber reported no transaction for this fleet in the last 24 hours' },
        provisional: { trips: t?.provisional ?? 0, aed: n(t?.provisional_aed) ?? 0 },
        agreement: confirmed
          ? { confirmed, agreed: t.agreed, pct: Math.round((t.agreed / confirmed) * 1000) / 10,
            worst_gap_aed: n(t.worst_gap) }
          : { confirmed: 0, agreed: null, pct: null, worst_gap_aed: null,
            why: 'no trip yet carries both this feed\'s fare and the payments report\'s: the '
              + 'fare walk prices a trip hours after the live feed does' },
      };
    });
    res.json({ fleets, source: 'uber_transactions',
      basis: 'fare = the BRANCH of Uber\'s category tree (paid_to_you > your_earnings > fare), '
        + 'the same node the payments report states; agreement is within AED 0.01' });
  }));
}
