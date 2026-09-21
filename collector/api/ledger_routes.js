/* THE OPERATOR'S OWN CASH LEDGER, WHICH THIS PRODUCT HAS NEVER SHOWN ANYBODY.
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS ROUTE EXISTS. The driver advance ledger needs to know how much cash
   a person is holding. There are three candidate sources and only one of them
   is a POSITION:

     trip fares on cash-marked bookings   a flow, and incomplete — measured on
                                          production 2026-09-21 over seven
                                          weeks, only 4,419 of 5,898 cash trips
                                          carry a price (74.9%), and 30 people
                                          have under half of theirs priced.
     driver_statement_day.cash            a flow. Uber's statement line, and
                                          +17.8% above the bookings figure for
                                          the 124 people who have both.
     driver_statement_day.unremitted      "still-unremitted balance"
                                          (sql/schema_v25.sql:14) — a POSITION,
                                          maintained by the operator's own
                                          accounts team.

   The third is the right source and **nothing in this product reads it**. A
   grep for `unremitted` across api/ and src/ before this file returned three
   hits, all of them inside the INSERT in /api/import/statement-days. The
   column has been written on every ledger import since sql/schema_v25.sql and
   never once served to a page, so nobody — including whoever maintains it —
   can see what it currently holds, for whom, or how current it is.

   This route answers exactly that and decides nothing. It is the measurement
   that comes before the cash design, not the cash design.

   ── IDENTITY HERE IS THE LEDGER'S, AND IT IS A DIFFERENT FOLD ─────────────
   driver_statement_day is keyed on (platform, fleet_id, name_key, day, source)
   where name_key is a NORMALISED NAME, and sql/schema_v25.sql:28 says why: the
   operator's ledger predates our ids and "its people must not vanish for want
   of a match". That makes this a different person fold from person_key, from
   api/identity_map.js and from driver_identity_link.

   This route does NOT reconcile them. It reports what the ledger holds under
   the ledger's own key and returns driver_ext_id where the import managed to
   attach one, so the join can be judged rather than assumed. Folding a cash
   BALANCE onto a key the ledger does not use is how a position lands on the
   wrong human, and that is a decision for the write path with a person_id, not
   for a read that exists to show what is there.

   ── A BALANCE IS NOT A SUM, AND THIS ROUTE DOES NOT ASSUME WHICH IT IS ────
   The schema's own words make unremitted a balance, so the headline figure is
   the LATEST non-null value on or before the as-of date, never a sum. But the
   only evidence for that is a sentence in a comment, so the row also carries
   the count of days that hold a figure, the min, the max and the sum. If it is
   a balance those will drift smoothly around the latest; if it is really a
   daily delta the sum is the meaningful number and the shape of these columns
   will say so. Measuring beats believing a comment.

   ── ABSENT WITH A REASON ─────────────────────────────────────────────────
   No coalesce to zero anywhere in this file. A person with no figure on file
   returns null with a sentence saying so, because "the accounts team has not
   filed a position for this person" and "this person is holding nothing" are
   different facts and only one of them is safe to lend against. */

const round2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

export function ledgerRoutes(app, { q, wrap }) {
  /* GET /api/ledger/cash-position?as_of=YYYY-MM-DD
     The as-of day defaults to today in Dubai, this fleet's calendar
     everywhere. A position has an "as at" and nothing else — a from/to window
     over a balance would invite "cash in hand for August", which is not a
     thing a balance can answer. */
  app.get('/api/ledger/cash-position', wrap(async (req, res) => {
    const asked = String(req.query.as_of || '').trim();
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null;

    /* What the table holds per source, before any per-person question. This is
       the half that says whether the ledger is being maintained at all: a
       source whose last_day is four months old is a source nobody is filing,
       and a cash position built on it would be stale without looking stale. */
    const sources = await q(
      `SELECT source,
              count(*)::int                                            AS rows,
              count(DISTINCT name_key)::int                            AS people,
              count(DISTINCT fleet_id)::int                            AS fleets,
              to_char(min(day), 'YYYY-MM-DD')                          AS first_day,
              to_char(max(day), 'YYYY-MM-DD')                          AS last_day,
              count(*) FILTER (WHERE unremitted   IS NOT NULL)::int     AS rows_unremitted,
              count(DISTINCT name_key) FILTER (WHERE unremitted IS NOT NULL)::int
                                                                        AS people_unremitted,
              count(*) FILTER (WHERE cash         IS NOT NULL)::int     AS rows_cash,
              count(*) FILTER (WHERE bank         IS NOT NULL)::int     AS rows_bank,
              count(*) FILTER (WHERE network_cash IS NOT NULL)::int     AS rows_network_cash,
              /* Statement lines the operator could not tie to a person, and the
                 org-level fee rows. Real money, not a driver — sql/schema_v25.sql:47.
                 Counted here and excluded from every per-person figure below. */
              count(*) FILTER (WHERE pseudo)::int                       AS pseudo_rows
         FROM driver_statement_day
        WHERE day <= coalesce($1::date, (now() AT TIME ZONE 'Asia/Dubai')::date)
        GROUP BY source
        ORDER BY source`, [asOf]);

    const people = await q(
      `WITH live AS (
         SELECT * FROM driver_statement_day
          WHERE NOT pseudo
            AND day <= coalesce($1::date, (now() AT TIME ZONE 'Asia/Dubai')::date)
       ),
       agg AS (
         SELECT name_key, fleet_id,
                min(driver_name)                                   AS driver_name,
                max(driver_ext_id)                                 AS driver_ext_id,
                count(*)::int                                      AS rows,
                to_char(min(day), 'YYYY-MM-DD')                    AS first_day,
                to_char(max(day), 'YYYY-MM-DD')                    AS last_day,
                count(*) FILTER (WHERE unremitted IS NOT NULL)::int AS unremitted_days,
                min(unremitted)                                    AS unremitted_min,
                max(unremitted)                                    AS unremitted_max,
                sum(unremitted)                                    AS unremitted_sum,
                sum(cash)                                          AS cash_sum,
                count(*) FILTER (WHERE cash IS NOT NULL)::int      AS cash_days,
                sum(bank)                                          AS bank_sum,
                sum(network_cash)                                  AS network_cash_sum,
                array_agg(DISTINCT source)                         AS sources
           FROM live GROUP BY name_key, fleet_id
       ),
       /* The headline. DISTINCT ON rather than an aggregate because a balance
          is the LAST one filed, not the largest or the total. */
       latest AS (
         SELECT DISTINCT ON (name_key, fleet_id)
                name_key, fleet_id, unremitted, day, source
           FROM live WHERE unremitted IS NOT NULL
          ORDER BY name_key, fleet_id, day DESC, source
       )
       SELECT a.*, l.unremitted AS unremitted_latest,
              to_char(l.day, 'YYYY-MM-DD') AS unremitted_latest_day,
              l.source AS unremitted_latest_source,
              /* How stale the position is, in days, against the same as-of the
                 rest of the answer uses. A balance filed in April is not a
                 balance today and the page must be able to say so. */
              (coalesce($1::date, (now() AT TIME ZONE 'Asia/Dubai')::date) - l.day)::int
                AS unremitted_age_days
         FROM agg a LEFT JOIN latest l USING (name_key, fleet_id)
        ORDER BY (l.unremitted IS NULL), l.unremitted DESC NULLS LAST, a.driver_name`,
      [asOf]);

    const held = people.filter((p) => p.unremitted_latest != null);
    const rows = people.map((p) => ({
      driver_name: p.driver_name,
      name_key: p.name_key,
      fleet_id: p.fleet_id,
      driver_ext_id: p.driver_ext_id,
      /* The position, and why there isn't one when there isn't. */
      unremitted: round2(p.unremitted_latest),
      unremitted_on: p.unremitted_latest_day,
      unremitted_source: p.unremitted_latest_source,
      unremitted_age_days: p.unremitted_age_days,
      unremitted_absent_reason: p.unremitted_latest != null ? null
        : `the ledger holds ${p.rows} statement day${p.rows === 1 ? '' : 's'} for this `
          + `person (${p.first_day} to ${p.last_day}) and an unremitted balance on none of `
          + 'them. That is a figure nobody has filed, not a person holding nothing.',
      /* The shape that says whether it behaves like a balance or a flow. */
      unremitted_days: p.unremitted_days,
      unremitted_min: round2(p.unremitted_min),
      unremitted_max: round2(p.unremitted_max),
      unremitted_sum: round2(p.unremitted_sum),
      /* The flows beside it, for comparison and never as a substitute. */
      cash_sum: round2(p.cash_sum),
      cash_days: p.cash_days,
      bank_sum: round2(p.bank_sum),
      network_cash_sum: round2(p.network_cash_sum),
      rows: p.rows,
      first_day: p.first_day,
      last_day: p.last_day,
      sources: p.sources,
    }));

    const totalUnremitted = held.length
      ? round2(held.reduce((n, p) => n + Number(p.unremitted_latest), 0)) : null;

    res.json({
      as_of: asOf,
      /* Said in words at the top, because this is the number the advance
         ledger will lean on and the first question about it is always "for how
         many of our people?". */
      summary: {
        people_on_the_ledger: people.length,
        people_with_a_position: held.length,
        total_unremitted: totalUnremitted,
        total_unremitted_reason: held.length ? null
          : 'no person on the statement ledger carries an unremitted balance, so there is '
            + 'no cash position to total. The column is written by /api/import/statement-days '
            + 'and may simply never have been filled.',
        /* The gap, named rather than implied. */
        people_without_a_position: people.length - held.length,
        stalest_position_days: held.length
          ? Math.max(...held.map((p) => p.unremitted_age_days)) : null,
      },
      /* What the whole table looks like, including the pseudo rows the
         per-person list excludes, so the two can be reconciled by eye. */
      sources,
      people: rows,
      basis: 'driver_statement_day.unremitted — the operator\'s own accounts ledger, keyed on '
        + 'a normalised driver NAME plus fleet, which is a different person fold from the one '
        + 'the driver pages use. Reported under the ledger\'s key and not reconciled here.',
    });
  }));
}
