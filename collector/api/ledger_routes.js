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

   ── IT IS NOT A BALANCE. MEASURED 2026-09-21, THE FIRST TIME ANYTHING READ IT.
   sql/schema_v25.sql:14 calls the column a "still-unremitted balance" and this
   route's first version took it at its word, reporting the latest filed value
   as the position. The aggregate columns it returned beside that figure — min,
   max, sum and day-count — contradicted it, which is why they were built:

     sum of every daily figure          AED 1,935,693.47
     sum of each person's LATEST        AED     6,243.06
     people whose latest is 0.00        146 of 217
     every person's minimum             0.00
     negative figures                   none

   A running balance does not behave like that. One person carries 444 days of
   figures oscillating between 0 and 546.61.

   WHAT IT ACTUALLY IS, from the day-by-day series: of the cash a driver
   collected ON THAT DAY, the part still with them when the ledger row was
   written. It is not a duplicate of `cash` — 133 of 217 people differ, and
   across the ledger cash totals AED 2,284,860 against unremitted's
   AED 1,935,693, the AED 349,167 gap being cash handed in the same day.

   AND IT CANNOT BE ACCUMULATED INTO A POSITION. A row is written once for its
   day and nothing reduces it when the driver hands that cash in later, because
   NOTHING IN THIS DATABASE RECORDS A REMITTANCE EVENT AT ALL. So the sum
   overstates by every dirham ever handed back, the latest figure is one day's
   leftovers, and neither is what a person is holding today.

   The headline is therefore reported as what it is — the last daily figure —
   and the summary refuses to call any of it a position. A cash position has to
   be stated by the accounts team per driver, and kept current by the deposit
   entries in sql/schema_v78.sql. This route's job was to find that out.

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
    /* THE WINDOW. The operator's model, stated 2026-09-21: "how much the driver
       earned for the duration and how much the guy has daily will give us the
       accumulated figure and we can see for any duration of our choosing."
       That is the right shape once this column is understood as a FLOW rather
       than a balance — summing a flow over a window is what a flow is for.
       `from` defaults to the first ledger day, so an unasked request
       accumulates the whole record rather than a silent 30 days. */
    const dstr = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim())
      ? String(v).trim() : null);
    const from = dstr(req.query.from);
    /* THE UPPER BOUND, and it is `to` — not `asOf`.
       SHIPPED WRONG ON 2026-09-21 AND CAUGHT BY THE FIRST PRODUCTION
       MEASUREMENT. `to` was parsed, echoed back in the response, and never
       bound into a query: every statement still read `coalesce($1::date, …)`
       with asOf. A request for 2026-08-01..2026-08-21 answered
       `"to": "2026-08-21"` over data running to TODAY, and the giveaway was a
       driver reporting 51 days_worked inside a 21-day window.

       A window that is stated and not applied is the defect this product
       exists to prevent: the figure is not merely wrong, it is wrong under a
       caption asserting it is right. `as_of` is kept as an alias so the
       parameter that shipped first keeps working. */
    const to = dstr(req.query.to) || asOf;

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
        ORDER BY source`, [to]);

    const people = await q(
      `WITH live AS (
         SELECT * FROM driver_statement_day
          WHERE NOT pseudo
            AND day >= coalesce($2::date, '1900-01-01'::date)
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
                /* WHAT THE DRIVER EARNED over the same window, both sides of
                   the commission, because they are different questions and this
                   product has printed one under the other's caption before.
                   net = gross - fees (sql/schema_v25.sql). */
                sum(gross)                                         AS gross_sum,
                sum(net)                                           AS net_sum,
                count(DISTINCT day)::int                           AS days_worked,
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
      [to, from]);

    /* ?person=<name_key> — the day-by-day series for one person, which is the
       only thing that settles what this column IS.

       MEASURED on production 2026-09-21, before this parameter existed: every
       person's minimum unremitted figure is 0.00, the sum of all daily figures
       is AED 1,935,693 against AED 6,243 for the latest-per-person, and 146 of
       217 people carry a latest of exactly zero. One person has 444 days of
       figures oscillating between 0 and 546.61 and summing to 19,306.40. A
       running balance does not behave like that; a daily quantity does.

       What that leaves open is whether it ACCUMULATES BETWEEN REMITTANCES — a
       balance that climbs for a few days and drops to zero when the driver
       hands the cash in — or whether each day stands alone. The two have
       different right answers for a cash position: the first makes the latest
       figure the position, the second makes the sum since the last zero the
       position. Only consecutive days can tell them apart. */
    const who = String(req.query.person || '').trim();
    if (who) {
      const days = await q(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, unremitted, cash, bank, network_cash,
                net, trips, source
           FROM driver_statement_day
          WHERE NOT pseudo AND name_key = $1
            AND day <= coalesce($2::date, (now() AT TIME ZONE 'Asia/Dubai')::date)
          ORDER BY day DESC LIMIT 60`, [who, to]);
      return res.json({
        person: who,
        as_of: asOf,
        days: days.map((r) => ({
          day: r.day,
          unremitted: round2(r.unremitted),
          cash: round2(r.cash),
          bank: round2(r.bank),
          network_cash: round2(r.network_cash),
          net: round2(r.net),
          trips: r.trips,
          source: r.source,
        })),
        note: days.length ? null
          : `no statement day on file under the ledger name key "${who}". This route keys on `
            + 'name_key, the normalised driver name the operator ledger uses, not on a platform id.',
      });
    }

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
      /* THE ACCUMULATED FIGURE the operator asked for: every daily unremitted
         amount added across the window. It is cash COLLECTED AND NOT HANDED IN
         THE SAME DAY over this period — a flow, correctly summed. It becomes
         "what they are holding" only once the other leg exists: nothing in this
         database records a remittance, so nothing here deducts cash handed back
         later. sql/schema_v78.sql's cash_deposit entries are that leg, and with
         them the position is opening + this - deposits. */
      cash_held_accumulated: round2(p.unremitted_sum),
      earned_gross: round2(p.gross_sum),
      earned_net: round2(p.net_sum),
      days_worked: p.days_worked,
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
      from,
      /* The bound the queries were actually given. */
      to,
      /* Said in words at the top, because this is the number the advance
         ledger will lean on and the first question about it is always "for how
         many of our people?". */
      summary: {
        people_on_the_ledger: people.length,
        people_with_a_daily_figure: held.length,
        /* Deliberately NOT called a position or a balance. It is the sum of
           each person's most recent DAILY unremitted figure, which is a
           quantity nobody should act on — see the header. */
        total_of_latest_daily_figures: totalUnremitted,
        is_a_cash_position: false,
        why_not: 'unremitted records, per day, the cash a driver had not handed in when that '
          + 'row was written, and nothing reduces it when they hand it in later because no '
          + 'remittance event is recorded anywhere in this database. The sum overstates by '
          + 'every dirham ever returned; the latest figure is one day\'s leftovers. A cash '
          + 'position must be stated per driver and kept current by deposit entries.',
        total_unremitted_reason: held.length ? null
          : 'no person on the statement ledger carries an unremitted balance, so there is '
            + 'no cash position to total. The column is written by /api/import/statement-days '
            + 'and may simply never have been filled.',
        /* The gap, named rather than implied. */
        people_without_any_figure: people.length - held.length,
        stalest_figure_days: held.length
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
