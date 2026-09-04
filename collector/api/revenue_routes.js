/* Every source of money this fleet has, side by side.
   ─────────────────────────────────────────────────────────────────────────
   "Revenue" was one number, and it was the sum of trip.price. That is honest
   arithmetic over a dishonest population: Uber's trip export has no fare column
   at all, and Uber is 165,000 of the fleet's 175,000 trips. So the figure
   covered around a tenth of the work and was printed against the whole of it —
   a vehicle with 277 bookings showed AED 525.

   The fix is not a bigger number. It is to stop pretending there is one
   number, and to report what each channel actually tells us:

     FARES        trip.price — what the rider was charged, per booking. The
                  hotel channel reports one on every booking; Uber reports none
                  at all; Yango and Bolt report some.

     PAYOUTS      driver_performance.earnings — what the platform says it paid
                  the fleet, per driver per period. This is NET, after the
                  platform's commission, so it is a smaller number describing a
                  different thing.

     COMPONENTS   driver_earnings_component — the payout broken into net fare,
                  tips, tolls, cash collected and fees. Uber only.

   Fares and payouts are not the same quantity and are never summed into one
   figure here. What IS combined is coverage: for each platform, the best
   figure we hold and the basis it rests on, so a reader can see at a glance
   which channels are measured, which are estimated from a payout, and which
   are simply dark — and how much of the fleet's work each of those covers.

   A platform contributing nothing is the most important row on the page,
   because it is the one somebody can fix. */
import { chooseBasis, fleetIncome, platformStatements } from './income_sql.js';
import { peopleCountStored, JOIN_TRIP } from './custody_sql.js';
import { BOOKING_CHANNELS, channelHealthSql, channelHealth } from './channels_sql.js';

export function revenueRoutes(app, { q, wrap, range }) {
  /* ── where every figure came from ──────────────────────────────────────
     One row per API surface, per channel, per kind of money — what that call
     actually returned for this window, at the grain it returned it, and
     whether the headline uses it.

     This page exists because the headline is a CHOICE. api/income_sql.js picks
     one figure per channel — a fare total or a payout total, never both, since
     a payout is what is left of those same fares after commission — and
     discards the loser. That is the right rule and it was invisible: a reader
     had no way to see that Yango's AED 5,612 payout was excluded because its
     fares won, or that a channel showing nothing was a credential rather than
     a quiet week.

     Nothing here is derived, allocated or spread. Every row is a sum of
     amounts the provider itself sent, over rows that carry the call that sent
     them; `reported_days` counts the rows the provider reported as a single
     day, and `period_rows` counts the ones it reported as a span. A weekly
     statement shows as one period row, never as seven daily ones. */
  app.get('/api/money/sources', wrap(async (req, res) => {
    const p = range(req);
    /* Overlap, not containment: a weekly statement covering the window's first
       day is money that touches this window, and dropping it because its
       period starts earlier would understate every window that is not a whole
       number of the provider's own periods. `overlap_days` says how much of
       the row's period the window actually covers, so a reader can see that a
       week counted here is a week that only half belongs to them. */
    /* Restatements, marked rather than removed.
       ─────────────────────────────────────────────────────────────────────
       A provider does not send each figure once. Uber's breakdown serves the
       same driver-week as a weekly row AND, for recent days, as daily rows —
       both true, both the same money. Summed, the fleet's August payout comes
       to AED 1,411,620 against the AED 414,709 it was actually paid: three and
       a half times over, from an endpoint that lied about nothing.

       So a row is flagged where another row from the same call, for the same
       driver and the same category, covers days it also covers. Flagged, not
       dropped: this is the provenance record, and a restatement is a thing the
       provider did, which the page should be able to show. What the page must
       never do is add them up and call it a total.

       Detected with window functions rather than a self-join: over a year this
       CTE holds two hundred thousand rows, and a correlated EXISTS against a
       materialised CTE is quadratic.

       Only the kinds that REPORT A PERIOD are eligible. A fare row is one
       trip and a ledger row is one transaction: two of them on one day are two
       events, not one restated. */
    const rows = await q(
      `WITH w AS (
         SELECT * FROM money_event
          WHERE period_start <= $2::date AND period_end >= $1::date
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)
       ),
       marked AS (
         SELECT w.*,
                kind IN ('payout', 'component', 'statement') AND (
                  coalesce(max(period_end) OVER g_prev >= period_start, false)
                  OR coalesce(min(period_start) OVER g_next <= period_end, false)
                ) AS restated
           FROM w
         WINDOW g_prev AS (PARTITION BY source, platform, kind, category, driver_ext_id, external_ref
                           ORDER BY period_start
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                g_next AS (PARTITION BY source, platform, kind, category, driver_ext_id, external_ref
                           ORDER BY period_start
                           ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)
       )
       SELECT source, platform, fleet_id, kind,
              count(*)::int rows_seen,
              count(*) FILTER (WHERE day IS NOT NULL)::int reported_days,
              count(*) FILTER (WHERE day IS NULL)::int period_rows,
              count(*) FILTER (WHERE restated)::int restated_rows,
              count(DISTINCT category) FILTER (WHERE category <> '')::int categories,
              round(sum(amount)::numeric, 2) AS amount,
              /* How much of that total sits on rows that restate days another
                 row already covers. Reported as its own figure rather than as
                 a remainder: the components carry negative lines (fees,
                 commission), so the non-restated part can exceed the total,
                 and a column headed "of that, said once" showing more than the
                 whole reads as a bug however true it is. */
              round(sum(amount) FILTER (WHERE restated)::numeric, 2) AS restated_amount,
              round(sum(amount) FILTER (WHERE NOT restated)::numeric, 2) AS amount_not_restated,
              min(period_start) AS first_period, max(period_end) AS last_period,
              max(period_end - period_start + 1)::int AS max_period_days,
              count(DISTINCT driver_ext_id) FILTER (WHERE driver_ext_id <> '')::int drivers,
              max(ingested_at) AS last_seen
         FROM marked
        GROUP BY source, platform, fleet_id, kind
        ORDER BY sum(abs(amount)) DESC NULLS LAST`, p);

    /* And the categories inside the components, because "AED 406,893 of Uber
       payout" is not an answer to what the fleet was paid FOR. These are the
       provider's own words, unrenamed. */
    const categories = await q(
      `SELECT source, platform, category, count(*)::int rows_seen,
              round(sum(amount)::numeric, 2) AS amount
         FROM money_event
        WHERE period_start <= $2::date AND period_end >= $1::date
          AND kind IN ('component', 'ledger') AND category <> ''
          AND ($3::text IS NULL OR platform = $3)
          AND ($4::text IS NULL OR fleet_id = $4)
        GROUP BY source, platform, category
        ORDER BY sum(abs(amount)) DESC NULLS LAST
        LIMIT 60`, p);

    res.json({
      window: { from: p[0], to: p[1] },
      rows,
      categories,
      note: 'Every figure here is a sum of amounts a provider itself sent, grouped by the API '
        + 'call that sent them. Nothing is allocated, spread or estimated: a weekly statement '
        + 'appears as one period row covering seven days, never as seven daily figures.',
      /* Said in the response rather than only on the page, because the two
         ways this data can be misread are not obvious from its shape, and a
         caller reading the JSON deserves the same warning a reader gets. */
      caveats: {
        restatements: 'A provider may report the same days more than once — Uber serves a '
          + 'driver-week as a weekly figure and, for recent days, as daily ones. Both are true '
          + 'and they are the same money, so `amount` is what the call RETURNED and is not a '
          + 'total of anything. `restated_rows` counts the figures that restate days another '
          + 'figure already covers; where it is zero the call reported each day once and its '
          + 'amount may be added. Where it is not, resolving the overlap is what '
          + 'driver_payout_day does, and /api/revenue reports the result.',
        categories: 'The categories are a TREE in the provider\'s own shape — `your_earnings` '
          + 'contains `fare`, `tip` and the rest — so they are listed to show what the money was '
          + 'called, and their sum is not a total of anything.',
      },
    });
  }));

  app.get('/api/revenue', wrap(async (req, res) => {
    const p = range(req);
    const [from, to] = p;
    const windowDays = Math.max(1,
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1);

    const [fares, payouts, components, tips, stmts, health] = await Promise.all([
      /* Per platform, over BOOKINGS only — a telematics journey is the same
         physical trip seen by the tracker and has no fare by definition. */
      q(`SELECT n.platform,
                count(*)::int bookings,
                /* The days this channel worked in the window — the denominator
                   payout coverage is measured against. See api/income_sql.js. */
                count(DISTINCT n.local_day)::int booking_days,
                count(*) FILTER (WHERE n.has_fare)::int priced_bookings,
                /* The denominator fare coverage is taken over, and the rides
                   left out of it. See platformFares in api/income_sql.js —
                   this route has its own copy of the query and the two must
                   agree, or #revenue and #overview report different coverage
                   for the same month. */
                count(*) FILTER (WHERE n.outcome = 'completed' OR n.has_fare)::int chargeable_bookings,
                count(*) FILTER (WHERE n.outcome <> 'completed' AND NOT n.has_fare)::int uncharged_bookings,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,2) fares,
                round(sum(n.distance_km) FILTER (WHERE n.has_fare AND n.has_distance)::numeric,0) priced_km,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric,0) km,
                ${peopleCountStored()}::int drivers,
                count(DISTINCT n.plate) FILTER (WHERE nullif(btrim(n.plate), '') IS NOT NULL)::int vehicles,
                min(n.requested_at) first_at, max(n.requested_at) last_at
         FROM trip_norm n ${JOIN_TRIP}
         WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
           AND ($3::text IS NULL OR n.platform=$3) AND ($4::text IS NULL OR n.fleet_id=$4)
         GROUP BY 1`, p),

      /* What each platform says it paid. Periods overlap between platforms and
         a driver can appear in several, so this is summed per platform and
         never across them without saying so. */
      q(`WITH pay AS (
           /* Day grain, and the window on the day. Over driver_performance
              this summed overlapping report windows — the same payout week
              fetched by a backfill and a catch-up on different grids — so
              every platform total was inflated. It also required periods
              WHOLLY inside the window, which dropped the two straddling its
              edges. See sql/schema_v23.sql. */
           /* The fleet predicate was missing here, on the components query and
              on tips, while the fares query above has always carried it. So
              #revenue with a fleet chip selected counted ONE fleet's bookings
              against BOTH fleets' money. Measured on production at days=30:
              /api/kpis&fleet=egari reported accounted 105,038.19 and
              /api/revenue&fleet=egari reported 327,552.58 for the same window
              — 3.1×, because Egari's 3,501 bookings were being paid by
              Ecosine's payout rows as well as their own. driver_payout_day
              records fleet_id (sql/schema_v23.sql:112); it was simply never
              read. */
           SELECT * FROM driver_payout_day
            WHERE day BETWEEN $1::date AND $2::date
              AND ($3::text IS NULL OR platform=$3)
              AND ($4::text IS NULL OR fleet_id=$4)
         ),
         /* Which DAYS of the window the payout periods actually cover.
            Without this, three days of payout on a thirty-day window made a
            channel read as fully accounted for — the payout was real, the
            coverage was 10%, and the difference is a month of missing money
            presented as a month of measured money.

            It used to expand each period back out to its days with a lateral
            generate_series. pay is already one row per day, so that expansion
            would now re-expand every day into a whole period and count the
            window several times over; the days are simply counted instead. */
         covered AS (
           SELECT platform, count(DISTINCT day)::int days FROM pay GROUP BY 1
         )
         SELECT pay.platform,
                round(sum(pay.earnings)::numeric,2) payouts,
                round(sum(pay.cash_earnings)::numeric,2) cash,
                count(DISTINCT (pay.period_start, pay.period_end))::int periods,
                count(DISTINCT pay.driver_ext_id)::int drivers,
                min(pay.period_start) first_period, max(pay.period_end) last_period,
                max(covered.days) AS payout_days
           FROM pay LEFT JOIN covered ON covered.platform = pay.platform
          GROUP BY 1`, p),

      /* The payout tree. `parent IS NULL` are the top-level categories; summing
         every row would count a category and its children twice. */
      q(`SELECT platform, category, parent,
                round(sum(amount)::numeric,2) amount,
                count(DISTINCT driver_ext_id)::int drivers
         FROM driver_earnings_component
         WHERE period_start >= $1::date AND period_end <= $2::date
           AND ($3::text IS NULL OR platform=$3)
           AND ($4::text IS NULL OR fleet_id=$4)
         GROUP BY 1,2,3 ORDER BY abs(sum(amount)) DESC`, p),

      /* Tips carried NEITHER filter — not platform, not fleet — so every
         filtered Revenue page showed the whole fleet's tips. On production,
         /api/revenue?days=30&platform=bolt returned a platform row for `uber`
         with 0 bookings and tips 528: Bolt has no data at all, and the only
         thing that materialised the row was a tip total nothing had narrowed.

         Read from the RESOLVED statement days rather than the raw component
         tree. Uber now answers this fleet on two surfaces whose report windows
         overlap — the REST payments feed on short periods, the supplier
         GraphQL breakdown on weeks — and each carries its own `tip` row for
         the same day, so summing components adds one week's tips twice.
         driver_statement_day is those components with the overlap already
         settled to one row per driver-day (src/rollup.js), which also makes
         the window a range of DAYS rather than of report periods: a week whose
         Monday fell outside the window used to drag all seven days in. */
      q(`SELECT platform, round(sum(tips)::numeric,2) tips
         FROM driver_statement_day
         WHERE source <> 'ledger' AND day BETWEEN $1::date AND $2::date
           AND ($3::text IS NULL OR platform=$3)
           AND ($4::text IS NULL OR fleet_id=$4)
         GROUP BY 1`, p),
      /* The statement view — the operator's daily ledger and any provider
         statement surface that still answers. See api/income_sql.js on why it
         never merges into fares or payouts. */
      q(platformStatements(), p),
      /* What the collector last managed on each source, so a channel with no
         row can say why rather than not appear. See api/channels_sql.js. */
      q(channelHealthSql()),
    ]);

    const num = (v) => (v == null ? null : Number(v));
    const byPlatform = new Map();
    const row = (pl) => {
      if (!byPlatform.has(pl)) {
        byPlatform.set(pl, { platform: pl, bookings: 0, booking_days: 0, priced_bookings: 0, fares: null,
          priced_km: null, km: null, drivers: 0, vehicles: 0, payouts: null, cash: null,
          payout_periods: 0, components: null, tips: null });
      }
      return byPlatform.get(pl);
    };
    for (const f of fares) Object.assign(row(f.platform), {
      bookings: f.bookings, booking_days: f.booking_days, priced_bookings: f.priced_bookings, fares: num(f.fares),
      chargeable_bookings: f.chargeable_bookings, uncharged_bookings: f.uncharged_bookings,
      priced_km: num(f.priced_km), km: num(f.km), drivers: f.drivers, vehicles: f.vehicles,
      first_at: f.first_at, last_at: f.last_at,
    });
    for (const y of payouts) Object.assign(row(y.platform), {
      payouts: num(y.payouts), cash: num(y.cash), payout_periods: y.periods,
      payout_drivers: y.drivers, first_period: y.first_period, last_period: y.last_period,
      payout_days: y.payout_days ?? 0,
    });
    for (const c of components) {
      const r = row(c.platform);
      // Top-level categories only, or a category and its children both count.
      if (c.parent == null) r.components = (r.components || 0) + num(c.amount);
    }
    for (const t of tips) row(t.platform).tips = num(t.tips);
    /* Every configured booking channel gets a row, whether or not it delivered
       anything. This page's own docstring calls the empty row the most useful
       one on it, and there was no empty row: /api/revenue returned exactly
       three platforms at 7, 30 and 365 days and Bolt appeared on none of them.
       Narrowed to the selected platform when one is chosen, so asking for Uber
       does not conjure three channels nobody asked about. */
    const wanted = BOOKING_CHANNELS.filter((c) => !p[2] || c === p[2]);
    for (const pl of wanted) row(pl);
    const byHealth = channelHealth(health);
    for (const r of byPlatform.values()) Object.assign(r, byHealth.get(r.platform) || {
      collection_status: null, collection_error: null, collection_at: null,
    });
    for (const t of stmts) Object.assign(row(t.platform), {
      statement_net: num(t.statement_net), statement_gross: num(t.statement_gross),
      statement_fees: num(t.statement_fees), statement_tips: num(t.statement_tips),
      statement_salik: num(t.statement_salik), statement_cash: num(t.statement_cash),
      statement_bank: num(t.statement_bank), statement_days: t.statement_days,
      statement_drivers: t.statement_drivers });

    /* Which figure to believe for each platform, and why. Stated as a basis
       rather than blended, because a fare and a payout are different money and
       a reader who cannot tell them apart cannot check either.

       The rule moved to api/income_sql.js so /api/kpis can apply the same one.
       It had grown its own — sum(fares) + sum(payouts) across everything — and
       that double-counts any platform reporting both, so the Overview and this
       page printed different totals for the same month. */
    for (const r of byPlatform.values()) {
      chooseBasis(r, windowDays);
      /* Per km follows the BASIS, like every other figure on this row.
         ───────────────────────────────────────────────────────────────────
         It was fares over priced km and nothing else, so the fleet's largest
         channel printed a dash: Uber prices no booking, so it has no fares
         and no priced km. On production that was 2,890 of 3,109 bookings —
         93% of the work — with AED 99,430 of payout and 2,890 measured
         distances sitting unused beside an empty cell.

         A payout-basis row divides the payout by the distance of every
         booking with one, which is the same question the fares rows answer
         and the same one the Per-km column is headed with. The denominator
         differs between the two, so it is reported rather than assumed:
         `per_km_basis` says which money, `per_km_km` says over what.

         Both denominators exclude bookings with no distance, so neither
         reads as smaller than it is because a channel forgot to send one. */
      const paid = r.basis === 'payout' || r.basis === 'partial_payout';
      const r2 = (v) => Math.round(v * 100) / 100;
      if (paid && r.payouts != null && r.km) {
        r.revenue_per_km = r2(r.payouts / r.km);
        r.per_km_basis = 'payout';
        r.per_km_km = r.km;
      } else if (r.fares != null && r.priced_km) {
        r.revenue_per_km = r2(r.fares / r.priced_km);
        r.per_km_basis = 'fares';
        r.per_km_km = r.priced_km;
      } else {
        r.revenue_per_km = null;
        r.per_km_basis = null;
        r.per_km_km = null;
      }
    }

    const rows = [...byPlatform.values()].sort((a, b) => (b.bookings || 0) - (a.bookings || 0));
    /* partial_payout belongs here, with the measured. It is money we HOLD over
       a window shorter than the one on screen, which the row already reports as
       payout_coverage_pct — not money we are missing. Leaving it out made
       measured_platforms omit Uber on a 365-day window while `accounted` counted
       Uber's AED 2.4m. */
    const measured = rows.filter((r) => r.basis === 'fares' || r.basis === 'payout'
      || r.basis === 'partial_payout');
    /* A channel that delivered no booking at all is not "dark money" — it is a
       channel that did not run, and naming it in a sentence about how many
       bookings report no fare would read as "bolt accounts for 0 of 3,328
       bookings", which is true and useless. It gets its own list.

       And partial_payout is not dark either. This rule was the twin of the one
       in api/income_sql.js that counted a channel as both fully accounted and
       fully dark; that half is fixed, and leaving this half would put the
       tiles and the page's own red note in direct contradiction. Measured on
       production 2026-09-02T13:31Z the note read "uber account for 232,845 of
       234,512 bookings in this window and report little or no money over it"
       — about the channel whose collected net payout is AED 2,402,161. */
    const dark = rows.filter((r) => (r.basis === 'none' || r.basis === 'partial_fares')
      && r.bookings);
    const silent = rows.filter((r) => !r.bookings);
    const totalBookings = rows.reduce((a, r) => a + (r.bookings || 0), 0);
    const darkBookings = dark.reduce((a, r) => a + (r.bookings || 0), 0);

    res.json({
      window: [from, to],
      platforms: rows,
      window_days: windowDays,
      totals: {
        bookings: totalBookings,
        priced_bookings: rows.reduce((a, r) => a + (r.priced_bookings || 0), 0),
        /* Two totals, never one. Gross fares charged to riders and net payouts
           from the platforms are different money; adding them would produce a
           number that is neither and that nobody could check. These are the
           raw sums of each kind — what was REPORTED, across every platform. */
        fares: rows.reduce((a, r) => a + (r.fares || 0), 0) || null,
        payouts: rows.reduce((a, r) => a + (r.payouts || 0), 0) || null,
        cash: rows.reduce((a, r) => a + (r.cash || 0), 0) || null,
        statement_net: rows.reduce((a, r) => a + (r.statement_net || 0), 0) || null,
        statement_cash: rows.reduce((a, r) => a + (r.statement_cash || 0), 0) || null,
        statement_bank: rows.reduce((a, r) => a + (r.statement_bank || 0), 0) || null,
        tips: rows.reduce((a, r) => a + (r.tips || 0), 0) || null,
        /* And the fleet's income: the best figure per platform, summed. Honest
           only because every row says which of the two kinds of money it is,
           and because the share of the fleet's work it leaves out is reported
           beside it. Computed by api/income_sql.js, which /api/kpis calls too —
           the two pages disagreed by AED 40 on a fixture and by a great deal
           more on a fleet where Yango reports both fares and payouts. */
        ...fleetIncome(rows, windowDays),
      },
      components,
      /* The sentence a reader needs before believing any figure above it. */
      caveat: darkBookings
        ? `${dark.map((r) => r.platform).join(', ')} account for ${darkBookings} of `
          + `${totalBookings} bookings in this window and report little or no money over it. `
          + 'Every fleet-wide revenue figure in this product is over what did land, so all of '
          + 'them understate what the fleet took.'
        : null,
      measured_platforms: measured.map((r) => r.platform),
      /* The configured channels that delivered nothing in this window, each
         carrying the collector's last verdict. This is the work item the page
         was missing entirely. */
      silent_platforms: silent.map((r) => ({
        platform: r.platform,
        collection_status: r.collection_status,
        collection_error: r.collection_error,
        collection_at: r.collection_at,
      })),
    });
  }));
}
