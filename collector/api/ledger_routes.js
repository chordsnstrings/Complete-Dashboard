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

import express from 'express';
import { createHash } from 'node:crypto';
import { resolvePerson, personKey } from './ledger_person.js';

const round2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

/* WHO MAY RECORD MONEY, until ULM exists.
   A fixed list and not free text, because `requested_by` elsewhere in this
   codebase already proved what free text does to an audit column: one person
   becomes three spellings and the column stops answering "who". Stored as a
   code so the ULM actor id can point at it later without rewriting history. */
export const SUPERVISORS = Object.freeze(['ahsan', 'haseeb', 'hossam', 'shohaib']);

export function ledgerRoutes(app, { q, wrap, tx }) {
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

/* ─────────────────────────────────────────────────────────────────────────
   THE WRITE PATH.
   ───────────────────────────────────────────────────────────────────────── */
/* GET /api/ledger/entries — the register itself.
   ─────────────────────────────────────────────────────────────────────────
   Every entry, newest first, with the person it is against and whether its
   receipt is still held. Windowed, filterable by person, book and type.

   THE LIST IS CAPPED AND THE COUNTS ARE NOT. #payouts shipped reading
   "AED 319,015 · 6 transfers on 2 dates" over a register of 217 transfers and
   AED 3.46m, because a route returned a slice and the page totalled what it
   was given. So the totals here are computed over the WHOLE window in SQL and
   the row list says how many it is showing of how many there are.

   VERIFICATION ROWS ARE INCLUDED AND FLAGGED, not hidden. They exist so this
   repo's production ritual can fill a modal without recording a real debt, and
   a reviewer looking at the register needs to see that one was written — a row
   excluded everywhere is a row nobody can audit. Every TOTAL excludes them. */
/* GET /api/ledger/people — everybody an entry could be made against.
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS, and it is a defect found by deploying: people are minted
   LAZILY, by the first entry recorded against them (api/ledger_person.js). On
   a fresh database the `driver` table is therefore empty — which is correct,
   and left the whole feature unusable, because every entry screen listed its
   drivers from /api/ledger/exposure, which reads that table. Nobody to pick,
   so no entry, so nobody ever minted. A closed loop, and none of the 270 test
   files could see it: every one of them seeds a person first.

   So the picker's source is the union of two things:

     people this ledger already knows      driver + driver_platform_id
     accounts it does not                  the roster, unmapped

   Choosing an unmapped account sends platform + ext_id to /api/ledger/entry,
   which resolves and mints inside the same transaction as the entry — so a
   person comes into existence exactly when money is first recorded against
   them, and never on a dry run.

   The roster half is deliberately the same two tables api/ledger_person.js
   consults for siblings, rather than the driver directory: the directory folds
   names, and a picker that offered a FOLD would let somebody choose a group
   where they meant a person. */
export function ledgerPeopleRoutes(app, { q, wrap }) {
  app.get('/api/ledger/people', wrap(async (req, res) => {
    const known = await q(
      `SELECT dr.id AS person_id, dr.full_name AS name, dr.cash_rule,
              count(a.external_id)::int AS accounts,
              min(a.external_id) AS ext_id, min(a.platform) AS platform
         FROM driver dr
         LEFT JOIN driver_platform_id a
           ON a.driver_id = dr.id AND a.detached_at IS NULL
        GROUP BY dr.id, dr.full_name, dr.cash_rule`);

    const unmapped = await q(
      `SELECT r.platform, r.driver_ext_id AS ext_id, max(r.name) AS name
         FROM (SELECT platform, driver_ext_id, full_name AS name
                 FROM driver_platform_state WHERE driver_ext_id IS NOT NULL
               UNION ALL
               SELECT platform, driver_ext_id, full_name FROM driver_compliance
                WHERE driver_ext_id IS NOT NULL) r
        WHERE NOT EXISTS (
          SELECT 1 FROM driver_platform_id m
           WHERE m.platform = r.platform AND m.external_id = r.driver_ext_id
             AND m.detached_at IS NULL)
        GROUP BY r.platform, r.driver_ext_id
        HAVING max(r.name) IS NOT NULL
        ORDER BY 3`);

    res.json({
      people: [
        ...known.map((p) => ({
          person_id: Number(p.person_id), name: p.name, accounts: p.accounts,
          ext_id: p.ext_id, platform: p.platform, cash_rule: p.cash_rule,
          on_the_ledger: true,
          key: personKey({ person_id: Number(p.person_id) }),
        })),
        ...unmapped.map((r) => ({
          /* No person id, and that is the point: an entry against this row
             sends the ACCOUNT, and the write path mints the person. */
          person_id: null, name: r.name, accounts: 0,
          ext_id: r.ext_id, platform: r.platform, cash_rule: null,
          on_the_ledger: false,
          /* The same key /api/ledger/import/preview puts on its candidates,
             from the same function — see personKey in api/ledger_person.js for
             why that matters. */
          key: personKey({ person_id: null, platform: r.platform, ext_id: r.ext_id }),
        })),
      ],
      known: known.length,
      unmapped: unmapped.length,
      note: 'People are minted by the first entry recorded against them, so a fresh ledger has '
        + 'none. The second list is the roster — choosing somebody from it sends the account, '
        + 'and the write path creates the person inside the same transaction as the entry.',
    });
  }));
}


/* ADDRESSING A PERSON FROM A PAGE THAT DOES NOT KNOW THEIR PERSON ID.
   ═════════════════════════════════════════════════════════════════════════
   Every driver page in this product is addressed by a PROVIDER account —
   #driver/U-TARIQ — because that is what a link from a trip, a payout or a
   roster carries. This ledger keys on a person. So a read from a driver page
   arrives holding the one thing the ledger does not use.

   READ-ONLY, AND NEVER A MINT. api/ledger_person.js creates a person when it
   cannot find one, which is right at write time and wrong here: opening
   somebody's page would silently create their ledger record, and a fleet
   browsed end to end would mint four hundred people who have never had a
   dirham recorded against them. Every figure on every money page would then be
   counted over a population the act of looking created.

   So this looks the account up and, finding nothing, says so. "Nothing has
   been recorded against this driver" is the true answer and the useful one.

   NO NAME MATCHING, for the reason api/ledger_person.js gives at length. */
async function personFor(q, req) {
  const explicit = Number(req.query.person_id) || null;
  if (explicit) return { person_id: explicit, from: 'person_id', absent_reason: null };

  const extId = String(req.query.ext_id || '').trim();
  if (!extId) return { person_id: null, from: null, absent_reason: null };
  const platform = String(req.query.platform || '').trim().toLowerCase() || null;

  const [row] = await q(
    `SELECT driver_id, platform, basis FROM driver_platform_id
      WHERE external_id = $1 AND ($2::text IS NULL OR platform = $2::text)
        AND detached_at IS NULL
      ORDER BY driver_id LIMIT 1`, [extId, platform]);

  if (row) {
    return { person_id: Number(row.driver_id),
      from: `account:${row.platform}:${extId}`, absent_reason: null };
  }
  return { person_id: null, from: null,
    /* The distinction a reader needs: this account exists and has no ledger
       record, which is not the same as the ledger failing to answer. */
    absent_reason: 'nothing has ever been recorded against this driver on the money ledger, so '
      + 'they have no record here. A record is created by the first entry made against them — '
      + 'an advance, a deposit, a salary or a starting balance — and not by opening this page.' };
}

export function ledgerRegisterRoutes(app, { q, wrap }) {
  const LIMIT = 200;
  app.get('/api/ledger/entries', wrap(async (req, res) => {
    const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
    const from = d(req.query.from);
    const to = d(req.query.to);
    /* person_id OR ext_id — the driver pages carry the second. Resolved
       read-only; opening a page never creates a ledger record. */
    const who = await personFor(q, req);
    const personId = who.person_id;
    const book = ['advance', 'cash', 'deduction', 'pay'].includes(String(req.query.book))
      ? String(req.query.book) : null;
    /* ONE TYPE, AND WHY IT IS ITS OWN FILTER RATHER THAN A CLIENT-SIDE SLICE.
       ───────────────────────────────────────────────────────────────────
       #charging asks about charging advances alone. A page that pulled
       book=advance and filtered the ARRAY would be computing its totals from
       the 200-row cap this route returns, which is precisely the defect
       test/ledger_register.test.mjs exists to prevent: #payouts shipped
       reading "AED 319,015 · 6 transfers" over a register of 217 transfers and
       AED 3.46m, because the route returned a slice and the page added up what
       it was given.

       Validated against the registry rather than a hardcoded list, so a type
       added to ledger_type is filterable the day it is seeded and a typo is
       refused instead of silently matching nothing — an unknown code in a
       plain `= $5` would return an empty register that looks exactly like a
       type nobody has used. */
    const typeCode = String(req.query.type_code || '').trim() || null;

    /* An account that resolves to nobody must not fall through to the
       UNFILTERED register. `$3::bigint IS NULL OR e.person_id = $3` treats a
       null person as "no filter", so asking about a driver with no ledger
       record would have answered with EVERY entry in the fleet, under their
       name, on their page. Answered as empty, with the reason. */
    if (who.absent_reason) {
      return res.json({
        from, to, person_id: null, book, type_code: null,
        totals: { rows: 0, verification_rows: 0, advance: null, cash: null,
          deduction: null, pay: null, excludes_verification: true },
        shown: 0, listed_why: null, entries: [], by_person: [],
        absent_reason: who.absent_reason,
      });
    }

    if (typeCode) {
      const [known] = await q(`SELECT code FROM ledger_type WHERE code = $1`, [typeCode]);
      if (!known) {
        const all = (await q(`SELECT code FROM ledger_type ORDER BY sort, code`)).map((r) => r.code);
        return res.status(400).json({
          error: `"${typeCode}" is not a type this ledger holds`,
          detail: 'Refused rather than answered with an empty register, which would look '
            + 'exactly like a type nobody has used yet.',
          types: all,
        });
      }
    }

    const W = `($1::date IS NULL OR e.effective_on >= $1::date)
           AND ($2::date IS NULL OR e.effective_on <= $2::date)
           AND ($3::bigint IS NULL OR e.person_id = $3::bigint)
           AND ($4::text IS NULL OR e.book = $4::text)
           AND ($5::text IS NULL OR e.type_code = $5::text)`;
    const p = [from, to, personId, book, typeCode];

    const [tot] = await q(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE e.entry_source = 'verification')::int AS verification_rows,
              round(sum(e.amount) FILTER (WHERE e.entry_source <> 'verification'
                AND e.book = 'advance')::numeric, 2) AS advance,
              round(sum(e.amount) FILTER (WHERE e.entry_source <> 'verification'
                AND e.book = 'cash')::numeric, 2) AS cash,
              round(sum(e.amount) FILTER (WHERE e.entry_source <> 'verification'
                AND e.book = 'deduction')::numeric, 2) AS deduction,
              round(sum(e.amount) FILTER (WHERE e.entry_source <> 'verification'
                AND e.book = 'pay')::numeric, 2) AS pay
         FROM driver_ledger e WHERE ${W}`, p);

    const rows = await q(
      `SELECT e.id, e.person_id, e.person_name, e.type_code, t.label, e.book, e.amount,
              /* The account the entry was made THROUGH, so a driver name in the
                 register opens the person it is about. acct_ext_id is evidence
                 on the row and not the key, which is why it may be null — a
                 person minted by a salary advance has no account yet, and
                 entity() degrades to plain text for them. */
              e.acct_ext_id AS ext_id,
              e.settles_via, to_char(e.effective_on,'YYYY-MM-DD') AS effective_on,
              to_char(e.period_start,'YYYY-MM-DD') AS period_start,
              to_char(e.period_end,'YYYY-MM-DD') AS period_end,
              e.entered_by, to_char(e.entered_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS entered_at,
              e.note, e.source_ref, e.entry_source, e.reverses_id, e.receipt_sha,
              /* Whether the PROOF is still there. The entry is permanent and
                 the image is not — twelve months — so a reader must be able to
                 tell "no photograph was ever taken" from "it was held until a
                 date and has since gone". */
              (r.sha256 IS NOT NULL) AS receipt_held,
              to_char(r.expires_on,'YYYY-MM-DD') AS receipt_expires_on,
              (r.sha256 IS NOT NULL AND r.expires_on < (now() AT TIME ZONE 'Asia/Dubai')::date)
                AS receipt_expired,
              t.needs_proof
         FROM driver_ledger e
         LEFT JOIN ledger_type t ON t.code = e.type_code
         LEFT JOIN driver_ledger_receipt r ON r.sha256 = e.receipt_sha
        WHERE ${W}
        ORDER BY e.effective_on DESC, e.id DESC
        LIMIT ${LIMIT}`, p);

    /* WHO, OVER THE WHOLE WINDOW — not over the 200 rows above.
       ───────────────────────────────────────────────────────────────────
       #charging needs "what has each driver been advanced for charging",
       and deriving that from `entries` would be the capped-list defect
       again: correct until the 201st entry, then quietly wrong, and wrong in
       the direction that understates what somebody owes. GROUP BY in SQL over
       the same WHERE the totals use, so the two cannot disagree.

       Verification rows are excluded here exactly as they are from the totals.
       They exist so this repo's production ritual can fill a modal without
       recording a real debt, and a person whose only row is a verification row
       has been advanced nothing. */
    const byPerson = await q(
      `SELECT e.person_id, max(e.person_name) AS person_name,
              max(e.acct_ext_id) AS ext_id,
              count(*)::int AS entries,
              round(sum(e.amount)::numeric, 2) AS net,
              round(sum(e.amount) FILTER (WHERE e.direction > 0)::numeric, 2) AS out,
              round(sum(-e.amount) FILTER (WHERE e.direction < 0)::numeric, 2) AS back,
              to_char(max(e.effective_on),'YYYY-MM-DD') AS last_on
         FROM driver_ledger e
        WHERE ${W} AND e.entry_source <> 'verification'
        GROUP BY e.person_id
        ORDER BY sum(e.amount) DESC NULLS LAST`, p);

    res.json({
      from, to, person_id: personId, book, type_code: typeCode,
      resolved_from: who.from,
      absent_reason: null,
      by_person: byPerson.map((r) => ({
        person_id: Number(r.person_id),
        person_name: r.person_name,
        ext_id: r.ext_id,
        entries: r.entries,
        net: r.net == null ? null : Number(r.net),
        out: r.out == null ? null : Number(r.out),
        back: r.back == null ? null : Number(r.back),
        last_on: r.last_on,
      })),
      totals: {
        rows: tot.rows,
        verification_rows: tot.verification_rows,
        advance: tot.advance == null ? null : Number(tot.advance),
        cash: tot.cash == null ? null : Number(tot.cash),
        deduction: tot.deduction == null ? null : Number(tot.deduction),
        pay: tot.pay == null ? null : Number(tot.pay),
        excludes_verification: true,
      },
      shown: rows.length,
      /* Said whenever it is true, and never implied by a count that happens to
         equal the cap. */
      listed_why: rows.length < tot.rows
        ? `showing the ${rows.length} most recent of ${tot.rows} entries in this window. `
          + 'The totals above are over all of them, not over this list.'
        : null,
      entries: rows.map((r) => ({
        ...r,
        amount: Number(r.amount),
        receipt: r.receipt_sha
          ? { sha256: r.receipt_sha, held: r.receipt_held, expired: r.receipt_expired,
            expires_on: r.receipt_expires_on,
            absent_reason: r.receipt_held ? null
              : 'the photograph has passed its twelve-month retention and been removed. The '
                + 'entry is permanent and still records that one was held.' }
          : { sha256: null, held: false, expired: false, expires_on: null,
            absent_reason: r.needs_proof === false
              ? 'this type carries no photograph — it records a decision or a period figure, '
                + 'which has none to take'
              : 'no photograph is attached to this entry' },
      })),
    });
  }));
}

export function ledgerWriteRoutes(app, { wrap, tx }) {
  /* POST /api/ledger/entry
     ─────────────────────────────────────────────────────────────────────
     DRY RUN IS THE DEFAULT. A caller must send `dry_run: false` to write. The
     credential paste at /api/settings/paste takes the same posture and for the
     same reason: the expensive mistake here is writing something nobody meant
     to write, and a mis-wired client that forgets the flag previews instead of
     recording a debt against a real person.

     THE CALLER SENDS A MAGNITUDE, NEVER A SIGN. sql/schema_v78.sql ties the
     sign of `amount` to the type's own direction through a composite foreign
     key, so a row entered the wrong way round is impossible — but only if the
     sign is decided by the type. Letting a client send one would reintroduce
     the whole class of error at the boundary: a repayment sent as +3000 would
     be refused with a constraint violation rather than simply recorded
     correctly. The server multiplies by the registry's direction, and a
     negative amount in the request is refused by name rather than negated,
     because somebody sending one has misunderstood something. */
  app.post('/api/ledger/entry', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const dryRun = b.dry_run !== false;
    const refusals = [];
    const refuse = (why) => refusals.push(why);

    const by = String(b.entered_by || '').trim().toLowerCase();
    if (!SUPERVISORS.includes(by)) {
      refuse(`"${b.entered_by || '(none)'}" is not one of the people who may record money. `
        + `They are ${SUPERVISORS.join(', ')}. This is attribution and not authentication — `
        + 'until ULM exists, anybody who can reach this URL can write here, and the name, IP '
        + 'and timestamp are what make an entry traceable afterwards.');
    }

    const typeCode = String(b.type_code || '').trim();
    const amount = Number(b.amount);
    if (!Number.isFinite(amount)) refuse('amount must be a number');
    else if (amount <= 0) {
      refuse(`amount is ${amount} and must be a positive magnitude. The direction comes from `
        + 'the type, not from the sign you send — a repayment is entered as a positive number '
        + 'of a repayment type, and the server applies the sign. A negative amount here means '
        + 'something has been misunderstood, so it is refused rather than quietly negated.');
    }

    const day = String(b.effective_on || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      refuse('effective_on must be a YYYY-MM-DD date — the day the money moved, in Dubai, '
        + 'which is not necessarily the day this is being typed');
    }
    const ps = b.period_start ? String(b.period_start).trim() : null;
    const pe = b.period_end ? String(b.period_end).trim() : null;
    if ((ps && !pe) || (pe && !ps)) refuse('a period needs both a start and an end, or neither');
    if (ps && pe && ps > pe) refuse(`the period ends (${pe}) before it starts (${ps})`);

    const note = String(b.note || '').trim();
    if (note.length < 3) {
      refuse('a note is required, and it is the sentence a page prints beside this entry. '
        + 'It is what makes the row arguable by somebody who was not here when it was made.');
    }

    if (refusals.length) {
      return res.status(400).json({ ok: false, dry_run: dryRun, refused: refusals });
    }

    try {
      const out = await tx(async (tq) => {
        const [type] = await tq(
          `SELECT code, book, label, direction, needs_proof, active
             FROM ledger_type WHERE code = $1`, [typeCode]);
        if (!type) {
          const all = await tq(`SELECT code FROM ledger_type WHERE active ORDER BY sort`);
          return { refused: [`"${typeCode || '(none)'}" is not a type this ledger holds. `
            + `The active ones are ${all.map((t) => t.code).join(', ')}.`] };
        }
        if (!type.active) {
          return { refused: [`"${typeCode}" is no longer in use. It is kept so the entries `
            + 'already made against it still read, but new ones are not accepted.'] };
        }
        if (type.needs_proof && !b.receipt_sha && b.entry_source !== 'import') {
          return { refused: [`${type.label} requires a photograph of the proof. Types exempt `
            + 'from one are the ones that cannot have it — an opening balance carried in from a '
            + 'spreadsheet, a period figure read off a statement, a decision such as a write-off '
            + 'or a waiver. Money or goods changing hands is not one of those.'] };
        }

        /* THE PERSON, resolved once and recorded with the evidence. Inside the
           transaction, so a dry run's minted person is rolled back with
           everything else and a real refusal leaves nobody behind. */
        let personId = Number(b.person_id) || null;
        let resolvedFrom = 'person_id';
        let personName = String(b.person_name || '').trim() || null;
        if (!personId) {
          const r = await resolvePerson(tq, {
            platform: b.platform, extId: b.ext_id, name: b.person_name, by,
          });
          if (r.refused) return { refused: [r.why] };
          personId = r.person_id; resolvedFrom = r.resolved_from;
        }
        const [person] = await tq(`SELECT id, full_name FROM driver WHERE id = $1`, [personId]);
        if (!person) return { refused: [`no person with id ${personId}`] };
        personName = personName || person.full_name;
        if (!personName) {
          return { refused: ['this entry has no name for the person it is against, and a row '
            + 'that cannot be read back to a human being is not an audit trail'] };
        }

        /* Balances BEFORE, per book, excluding verification rows by
           construction rather than by a WHERE somebody has to remember. */
        const bookRows = await tq(
          `SELECT book, round(sum(amount)::numeric, 2) AS bal
             FROM driver_ledger
            WHERE person_id = $1 AND entry_source <> 'verification'
            GROUP BY book`, [personId]);
        const before = Object.fromEntries(bookRows.map((r) => [r.book, Number(r.bal)]));

        /* A DUPLICATE IS WARNED ABOUT, NOT REFUSED. Two supervisors logging one
           handover is the commonest real error, and refusing outright would
           also refuse the genuine case of a driver taking the same amount twice
           in a day. */
        const [dupe] = await tq(
          `SELECT id, entered_by, to_char(entered_at, 'YYYY-MM-DD HH24:MI') AS at
             FROM driver_ledger
            WHERE person_id = $1 AND type_code = $2 AND abs(amount) = $3
              AND effective_on = $4::date AND entry_source <> 'verification'
            ORDER BY id DESC LIMIT 1`, [personId, type.code, amount, day]);
        if (dupe && b.allow_duplicate !== true) {
          return { refused: [`${personName} already has a ${type.label} of ${amount} on ${day}, `
            + `entered by ${dupe.entered_by} at ${dupe.at} (entry ${dupe.id}). If this is a `
            + 'second, genuine one, send allow_duplicate: true. Two people logging one handover '
            + 'is the commonest way this ledger goes wrong.'] };
        }

        const signed = amount * type.direction;
        const [row] = await tq(
          `INSERT INTO driver_ledger
             (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
              type_code, direction, book, amount, settles_via, effective_on,
              period_start, period_end, entered_by, entered_ip, note, source_ref,
              entry_source, reverses_id, receipt_sha)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13::date,
                   $14,$15,$16,$17,$18,$19,$20)
           RETURNING id, to_char(entered_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS entered_at`,
          [personId, personName, resolvedFrom, b.platform || null, b.ext_id || null,
            type.code, type.direction, type.book, signed, b.settles_via || null, day,
            ps, pe, by, req.ip || null, note, b.source_ref || null,
            b.entry_source || 'manual', b.reverses_id || null, b.receipt_sha || null]);

        const afterRows = await tq(
          `SELECT book, round(sum(amount)::numeric, 2) AS bal
             FROM driver_ledger
            WHERE person_id = $1 AND entry_source <> 'verification'
            GROUP BY book`, [personId]);
        const after = Object.fromEntries(afterRows.map((r) => [r.book, Number(r.bal)]));

        await tq(
          `INSERT INTO driver_ledger_audit (actor, ip, action, outcome, why, entry_id, person_id, payload)
           VALUES ($1,$2,$3,'accepted',$4,$5,$6,$7::jsonb)`,
          [by, req.ip || null, dryRun ? 'dry_run' : 'insert',
            dryRun ? 'previewed and rolled back' : null,
            dryRun ? null : row.id, personId, JSON.stringify({
              type: type.code, amount, effective_on: day, settles_via: b.settles_via || null })]);

        return {
          entry: {
            id: dryRun ? null : row.id,
            person_id: personId, person_name: personName, resolved_from: resolvedFrom,
            type: type.code, label: type.label, book: type.book,
            amount: round2(signed), magnitude: amount, direction: type.direction,
            settles_via: b.settles_via || null, effective_on: day,
            period_start: ps, period_end: pe,
            entered_by: by, entered_at: dryRun ? null : row.entered_at, note,
            entry_source: b.entry_source || 'manual',
          },
          balances: { before, after },
          /* THE SENTENCE A SCREEN PRINTS BEFORE SAVING, assembled here rather
             than in the front end so the desktop and the phone cannot say two
             different things about the same entry. */
          sentence: `${by} is recording ${type.label.toLowerCase()} of AED ${amount.toFixed(2)} `
            + `${type.direction > 0 ? 'to' : 'from'} ${personName}, effective ${day}`
            + `${b.settles_via ? `, ${String(b.settles_via).replace(/_/g, ' ')}` : ''}. `
            + `Their ${type.book} book moves from AED ${(before[type.book] || 0).toFixed(2)} to `
            + `AED ${(after[type.book] || 0).toFixed(2)}.`,
        };
      }, { rollback: dryRun });

      if (out?.refused) return res.status(400).json({ ok: false, dry_run: dryRun, refused: out.refused });
      return res.json({
        ok: true,
        dry_run: dryRun,
        /* Said out loud on every preview, because a screen that does not
           distinguish the two will eventually let somebody believe they saved
           something they did not. */
        wrote: dryRun ? false : true,
        note: dryRun
          ? 'Nothing was written. Every statement below ran against the real constraints inside '
            + 'a transaction that was then rolled back, so this is what WOULD have happened — '
            + 'send dry_run: false to record it.'
          : null,
        ...out,
      });
    } catch (e) {
      /* A constraint refusal is not an internal error: it is the database
         telling the operator the row is wrong, and it must reach them. */
      const msg = String(e?.message || e);
      const constraint = e?.constraint || null;
      return res.status(400).json({
        ok: false, dry_run: dryRun,
        refused: [constraint
          ? `the database refused this row on ${constraint}. ${msg}`
          : msg],
      });
    }
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
   THE PROOF: uploading a receipt, and serving one back.
   ───────────────────────────────────────────────────────────────────────── */
/* THE BODY PARSER IS BUILT HERE, NOT INJECTED.
   ─────────────────────────────────────────────────────────────────────────
   It was a dependency, and a mount that did not supply it threw
   `Route.post() requires a callback function but got a [object Undefined]` —
   which does not fail one route, it fails the whole app at registration and
   the API never binds a port. Caught by the suite while the harness and the
   server were momentarily out of step, which is exactly the shape the real
   accident would take: a route file and a mount edited in different commits.

   There is no reason for a caller to supply this. The limit and the accepted
   types are facts about what this route stores, and they belong beside it. */
const RECEIPT_TYPES = ['image/jpeg', 'image/webp', 'image/png'];
/* 1MB is the route's own limit and NOT the process-wide JSON limit, which
   stays at 256kb (api/server.js). Raising the shared one to fit a photograph
   would raise the DoS budget for every other route in the API. */
const receiptBody = express.raw({ type: RECEIPT_TYPES, limit: '1mb' });

export function ledgerReceiptRoutes(app, { q, wrap }) {
  /* POST /api/ledger/receipt — the image bytes, raw.
     ─────────────────────────────────────────────────────────────────────
     NOT JSON. api/server.js:106 sets a 256kb JSON limit for every route in the
     process, and base64 inflates by a third — so the largest photograph that
     could arrive inside the shared body parser is about 190KB, while a phone
     camera produces two to five megabytes. Raising the shared limit would
     raise it for every other route too, which is the DoS budget for the whole
     API; a per-route raw parser raises it for exactly this one.

     COMPRESSION HAPPENS IN THE BROWSER. A basic-xxs instance is 512MB and also
     serves every page in this product; decoding a twelve-megapixel image there
     to resize it is how that container dies. The phone does it with a canvas
     before the POST, which also means the work happens on the device that took
     the picture rather than over a car-park connection.

     THE DIGEST IS THE KEY, and a repeat upload of the same bytes returns the
     row that already exists rather than writing a second copy. That dedupe is
     reported — `already_held`, and how many entries point at it — because a
     silent one turns "every entry carries proof" into a claim about BYTES
     rather than about events: the same photograph attached to five handovers
     is a thing a reviewer must be able to see. */
  app.post('/api/ledger/receipt', receiptBody, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const by = String(req.query.by || '').trim().toLowerCase();
    if (!SUPERVISORS.includes(by)) {
      return res.status(400).json({ error: `"${req.query.by || '(none)'}" is not one of the `
        + `people who may record money. They are ${SUPERVISORS.join(', ')}.` });
    }
    const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!RECEIPT_TYPES.includes(type)) {
      return res.status(415).json({ error: `${type || 'no content-type'} is not an image type `
        + 'this route stores. It takes image/jpeg, image/webp or image/png — the three a phone '
        + 'camera and a canvas re-encode produce.' });
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || !bytes.length) {
      return res.status(400).json({ error: 'no image arrived in the body' });
    }
    const sha = createHash('sha256').update(bytes).digest('hex');

    const [held] = await q(
      `SELECT sha256, byte_len, to_char(expires_on,'YYYY-MM-DD') AS expires_on
         FROM driver_ledger_receipt WHERE sha256 = $1`, [sha]);
    if (held) {
      const [{ n }] = await q(
        `SELECT count(*)::int n FROM driver_ledger WHERE receipt_sha = $1`, [sha]);
      return res.json({
        sha256: sha, byte_len: held.byte_len, expires_on: held.expires_on,
        already_held: true, used_by_entries: n,
        note: n > 0
          ? `these exact bytes are already attached to ${n} entr${n === 1 ? 'y' : 'ies'}. `
            + 'That is not refused — a receipt can legitimately cover more than one line — but '
            + 'it is said out loud, because a silent dedupe turns "every entry carries proof" '
            + 'into a claim about bytes rather than about events.'
          : 'these exact bytes were already uploaded and are not stored twice.',
      });
    }

    /* Twelve months, by the operator's instruction. THE ENTRY OUTLIVES ITS
       PROOF: the ledger row is permanent and this is not, so an expired
       receipt must render "held until <date>, since expired" rather than
       looking like an entry that never had one. */
    const [row] = await q(
      `INSERT INTO driver_ledger_receipt
         (sha256, bytes, content_type, byte_len, uploaded_by, uploaded_ip, expires_on)
       VALUES ($1,$2,$3,$4,$5,$6,
               ((now() AT TIME ZONE 'Asia/Dubai')::date + interval '12 months')::date)
       RETURNING to_char(expires_on,'YYYY-MM-DD') AS expires_on`,
      [sha, bytes, type, bytes.length, by, req.ip || null]);
    return res.json({
      sha256: sha, byte_len: bytes.length, content_type: type,
      expires_on: row.expires_on, already_held: false, used_by_entries: 0,
      note: `stored. Attach it to an entry with receipt_sha. Held until ${row.expires_on} — `
        + 'the entry it belongs to is permanent and this image is not.',
    });
  }));

  /* GET /api/ledger/receipt/:sha — the bytes back.
     ─────────────────────────────────────────────────────────────────────
     ACCESS IS THE DIGEST. There is no user authentication in this product
     (api/redact.js:1-8 states the posture), so there is no session to check a
     receipt against. The address is a 64-character SHA-256 that appears only
     on the entry it belongs to, which is itself only reachable from the ledger
     — an unguessable capability rather than an ACL.

     That is weaker than a receipt of a cash handover deserves, and it is
     written down here rather than glossed: these images are bank slips and
     photographs of named people holding money. When ULM lands this route takes
     a real check. Until then the digest is the whole of it.

     ETag on the digest, and immutable: unlike driver_photo, whose address is
     stable while its content changes, this address IS the content — so a
     promise of immutability is true here. */
  app.get('/api/ledger/receipt/:sha', wrap(async (req, res) => {
    const sha = String(req.params.sha || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return res.status(400).json({ error: 'not a sha-256 digest' });
    }
    const [row] = await q(
      `SELECT bytes, content_type, byte_len, to_char(expires_on,'YYYY-MM-DD') AS expires_on,
              expires_on < (now() AT TIME ZONE 'Asia/Dubai')::date AS expired
         FROM driver_ledger_receipt WHERE sha256 = $1`, [sha]);
    if (!row) {
      /* An <img> cannot read a body, so the reason goes in a header where
         somebody debugging can still find it — the same thing
         api/driver_routes.js:1009 does for a driver photograph. */
      res.set('x-receipt', 'no receipt on file for this digest');
      return res.status(404).json({ error: 'no receipt on file for this digest',
        detail: 'Either it was never uploaded, or it has passed its twelve-month retention and '
          + 'been removed. The entry it belonged to is permanent and says which.' });
    }
    if (row.expired) {
      res.set('x-receipt', `expired ${row.expires_on}`);
      return res.status(410).json({ error: 'this receipt has passed its retention',
        expires_on: row.expires_on,
        detail: 'The entry it belongs to is permanent and still carries the fact that a '
          + 'photograph was held until this date. It is not an entry that never had one.' });
    }
    res.set('Content-Type', row.content_type);
    res.set('Content-Length', String(row.byte_len));
    res.set('ETag', `"${sha}"`);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    if (req.get('if-none-match') === `"${sha}"`) return res.status(304).end();
    return res.end(row.bytes);
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
   EXPOSURE: what a person is holding or owes, against what they generate.
   ───────────────────────────────────────────────────────────────────────── */
export function ledgerExposureRoutes(app, { q, wrap }) {
  /* GET /api/ledger/exposure?from=&to=&person_id=
     ─────────────────────────────────────────────────────────────────────
     THE POLICY. The operator keeps a driver's total within a percentage of the
     revenue they generate — 35% at the time of writing, stored and
     effective-dated in ledger_policy rather than compiled in, because it
     changes and will later belong to a user group. Over the line the answer
     says so and blocks nothing: the approval flow waits for ULM.

     ── BOTH HALVES FOLD ON ONE KEY, WHICH IS THE POINT ──────────────────
     docs/COVERAGE.md records the defect this is written to avoid, from
     /api/alerts/by-driver: "worse than a plain divisor is a numerator and
     denominator folded on DIFFERENT keys". It was unavoidable before —
     advances would have resolved through the boundary precedence while revenue
     came off tables keyed on the stored person_key, which never carries the
     link table (COVERAGE.md:480-484), so for every link-folded-but-unpromoted
     person the numerator would be the whole human and the denominator one
     account, and the ratio would read high on the one figure the policy is
     enforced with.

     driver_platform_id ends that. A person's accounts are a stored list, and
     BOTH sides are summed over exactly that list.

     ── WHAT IS IN THE NUMERATOR, by the operator's instruction ──────────
     "overall 35% can be with the driver — including cash advance and cash
     trips." So: advances outstanding, deductions outstanding, AND the cash
     they are holding. Pay is NOT in it — money going to a driver is not money
     they owe, and keeping those apart is what `book` is for.

     ── AND THE CASH HALF IS THE WEAK ONE, SO IT IS REPORTED SEPARATELY ──
     Measured on production 2026-09-21: driver_statement_day.unremitted is a
     DAILY figure, not a balance, and nothing in this database records a
     remittance — so accumulating it gives cash collected and not handed in the
     same day, which overstates by every dirham ever returned. Until deposits
     are being recorded, the honest cash figure is an opening position stated
     by the accounts team plus deposits since. Where neither exists this route
     returns the cash component as null WITH A REASON and marks the whole ratio
     unmeasured, rather than quietly computing an exposure that is missing its
     largest term. */
  app.get('/api/ledger/exposure', wrap(async (req, res) => {
    const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
    const from = d(req.query.from);
    const to = d(req.query.to);
    /* person_id OR ext_id, the second resolved READ-ONLY — see personFor().
       Opening a driver page must never mint that driver a ledger record. */
    const who = await personFor(q, req);
    const onePerson = who.person_id;
    if (who.absent_reason) {
      /* AN ACCOUNT THAT RESOLVES TO NOBODY MUST NOT FALL THROUGH TO THE WHOLE
         FLEET. The filter is `$3::bigint IS NULL OR dr.id = $3`, which reads a
         null person as "no filter" — so a question about one driver with no
         ledger record would have been answered with every person on the
         ledger, summed, on that driver's page. */
      return res.json({
        from, to, person_id: null, people: [],
        policy: null, policy_absent_reason: null,
        summary: { people: 0, measurable: 0, not_measurable: 0, over_policy: 0,
          fleet_ratio: null,
          fleet_ratio_reason: 'exposure is a per-person measure by instruction.' },
        absent_reason: who.absent_reason,
      });
    }

    /* The threshold in force. Effective-dated and append-only, so a decision
       taken in September can be explained against September's policy rather
       than today's. */
    const [policy] = await q(
      `SELECT pct, to_char(effective_from,'YYYY-MM-DD') AS effective_from, set_by, note
         FROM ledger_policy
        WHERE scope = 'global'
          AND effective_from <= coalesce($1::date, (now() AT TIME ZONE 'Asia/Dubai')::date)
        ORDER BY effective_from DESC, id DESC LIMIT 1`, [to]);

    const rows = await q(
      `WITH acct AS (
         SELECT driver_id, platform, external_id
           FROM driver_platform_id WHERE detached_at IS NULL
       ),
       /* The numerator, per book, over the person. entry_source 'verification'
          is excluded by construction — see sql/schema_v78.sql. */
       /* THE NUMERATOR IS A POSITION, AND POSITIONS ARE NOT WINDOWED.
          ─────────────────────────────────────────────────────────────────
          from governs the DENOMINATOR only. What a driver owes today is
          everything ever recorded against them up to the as-of date — bounding
          it below would answer "what did they take during September", which is
          a different question and a smaller number, and the policy would then
          be enforced against a fraction of the real balance.

          The ratio is deliberately a stock over a flow: what they are holding
          now, against what they generate in a period. That is the shape the
          operator described and it is the only one that makes the 35% mean
          anything. */
       book AS (
         SELECT person_id,
                sum(amount) FILTER (WHERE book = 'advance')   AS advance,
                sum(amount) FILTER (WHERE book = 'deduction') AS deduction,
                sum(amount) FILTER (WHERE book = 'cash')      AS cash_entries,
                sum(amount) FILTER (WHERE book = 'pay')       AS pay,
                count(*) FILTER (WHERE book = 'cash')::int    AS cash_rows,
                max(effective_on)                             AS last_entry
           FROM driver_ledger
          WHERE entry_source <> 'verification'
            AND ($2::date IS NULL OR effective_on <= $2::date)
          GROUP BY person_id
       ),
       /* ── THE CASH TERM, AS THE OPERATOR DESCRIBED IT ──────────────────
          "We will ask the accountant team to update each driver's cash
          position as of the date that they will input. The new ones will take
          into account since that day."

          So a person's cash is a POSITION stated by a human, plus what they
          have collected since that date, minus what they have handed in since
          that date. Three terms, one stated and two measured, and the stated
          one is what makes the other two mean anything: without it, collected
          cash accumulates from the beginning of the record against no starting
          balance at all.

          WHY THE COLLECTED HALF COMES FROM TRIPS AND NOT FROM THE STATEMENT
          LEDGER. driver_statement_day.unremitted is the obvious source and it
          cannot be joined to a person: it is keyed on a normalised NAME, and
          measured on production 2026-09-21, only 236 of 405 people on it carry
          a driver_ext_id at all — AED 315,771 of AED 1,935,693, or 16.3% of
          the total, is reachable by id. A cash figure that silently omitted
          five-sixths of the collections would UNDERSTATE exposure, which is
          the direction that gets somebody lent more than they should be.

          trip_ext keys on driver_ext_id, which driver_platform_id maps
          cleanly, so every person with an account is covered. One basis, named
          on the response — docs/COVERAGE.md is explicit that the three cash
          figures never agree and must never be summed. */
       opening AS (
         SELECT DISTINCT ON (person_id) person_id, amount, effective_on
           FROM driver_ledger
          WHERE type_code = 'cash_opening' AND entry_source <> 'verification'
          ORDER BY person_id, effective_on DESC, id DESC
       ),
       collected AS (
         SELECT a.driver_id AS person_id,
                sum(t.price)                                        AS value,
                count(*)::int                                       AS trips,
                count(*) FILTER (WHERE t.price IS NOT NULL)::int     AS priced
           FROM acct a
           JOIN opening o ON o.person_id = a.driver_id
           JOIN trip_ext t ON t.driver_ext_id = a.external_id
          WHERE t.driver_holds_cash
            AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date > o.effective_on
            /* Bounded ABOVE only, by the as-of. The lower bound is the day the
               accounts team stated the position — that is the whole point of
               their date — and from has no business here: a position asked
               for on the 30th includes what was collected on the 6th. */
            AND ($2::date IS NULL OR (t.requested_at AT TIME ZONE 'Asia/Dubai')::date <= $2::date)
          GROUP BY a.driver_id
       ),
       /* Everything in the cash book that is NOT the opening — deposits, and
          anything else that settles cash — on or after the day it was stated. */
       handed AS (
         SELECT e.person_id, sum(e.amount) AS amount, count(*)::int AS n
           FROM driver_ledger e JOIN opening o ON o.person_id = e.person_id
          WHERE e.book = 'cash' AND e.type_code <> 'cash_opening'
            AND e.entry_source <> 'verification'
            AND e.effective_on > o.effective_on
            AND ($2::date IS NULL OR e.effective_on <= $2::date)
          GROUP BY e.person_id
       ),
       /* The denominator, summed over THE SAME account list. */
       rev AS (
         SELECT a.driver_id AS person_id,
                sum(p.earnings)      AS earned,
                sum(p.cash_earnings) AS cash_earned,
                count(DISTINCT p.day)::int AS days,
                count(DISTINCT a.external_id)::int AS accounts_with_revenue
           FROM acct a
           JOIN driver_payout_day p ON p.driver_ext_id = a.external_id
          WHERE ($1::date IS NULL OR p.day >= $1::date)
            AND ($2::date IS NULL OR p.day <= $2::date)
          GROUP BY a.driver_id
       ),
       n AS (SELECT driver_id, count(*)::int AS accounts FROM acct GROUP BY driver_id),
       /* ONE ACCOUNT ID PER PERSON, so a name on a screen can be opened.
          test/interlinking.test.mjs: "a column whose LABEL names an entity must
          RENDER a link to it", and four of the eight dead ends it once found by
          hand were dead because the SQL never selected an id — the render could
          not have linked even if it wanted to.

          The driver pages are addressed by a PROVIDER account, not by the
          person id this ledger keys on, so the link needs one of the person's
          accounts. Deterministic rather than arbitrary: lowest platform then
          lowest id, so the same person opens the same page every time. A person
          with no account returns null and entity() degrades to plain text
          rather than to a broken link — the first-week salary advance case,
          and exactly why it must not become a dead anchor. */
       link AS (
         SELECT DISTINCT ON (driver_id) driver_id, external_id, platform
           FROM acct ORDER BY driver_id, platform, external_id
       )
       SELECT dr.id AS person_id, dr.full_name, dr.cash_rule,
              coalesce(n.accounts, 0)                    AS accounts,
              coalesce(rev.accounts_with_revenue, 0)     AS accounts_with_revenue,
              b.advance, b.deduction, b.cash_entries, b.pay, b.cash_rows,
              to_char(b.last_entry,'YYYY-MM-DD')         AS last_entry,
              rev.earned, rev.cash_earned, rev.days,
              link.external_id AS link_ext_id, link.platform AS link_platform,
              o.amount AS opening_amount,
              to_char(o.effective_on,'YYYY-MM-DD') AS opening_on,
              c.value AS collected_value, c.trips AS collected_trips,
              c.priced AS collected_priced,
              h.amount AS handed_amount, h.n AS handed_n
         FROM driver dr
         LEFT JOIN n   ON n.driver_id = dr.id
         LEFT JOIN book b ON b.person_id = dr.id
         LEFT JOIN rev ON rev.person_id = dr.id
         LEFT JOIN link ON link.driver_id = dr.id
         LEFT JOIN opening o ON o.person_id = dr.id
         LEFT JOIN collected c ON c.person_id = dr.id
         LEFT JOIN handed h ON h.person_id = dr.id
        WHERE ($3::bigint IS NULL OR dr.id = $3::bigint)
        ORDER BY dr.full_name NULLS LAST`, [from, to, onePerson]);

    const pct = policy ? Number(policy.pct) : null;
    const people = rows.map((r) => {
      const advance = r.advance == null ? 0 : Number(r.advance);
      const deduction = r.deduction == null ? 0 : Number(r.deduction);
      const cashEntries = r.cash_entries == null ? null : Number(r.cash_entries);
      const earned = r.earned == null ? null : Number(r.earned);

      /* THE CASH TERM: a position somebody stated, plus what has been
         collected since, minus what has come back since.

         THE OPENING IS WHAT MAKES THE OTHER TWO MEAN ANYTHING. Without a
         stated starting balance there is nothing for collections to accumulate
         ONTO — they would run from the beginning of the record, which for a
         driver of two years is a number nobody should act on. So a person with
         no opening has an unknown cash position, and unknown is not zero. */
      const cashKnown = r.opening_on != null;
      const opening = cashKnown ? Number(r.opening_amount) : null;
      const collected = r.collected_value == null ? 0 : Number(r.collected_value);
      const handed = r.handed_amount == null ? 0 : Number(r.handed_amount);
      const cash = cashKnown ? round2(opening + collected + handed) : null;
      const cashReason = cashKnown ? null
        : 'no opening cash position has been stated for this person, so how much fare cash '
          + 'they are holding is unknown. It is not zero, and it cannot be derived: '
          + 'driver_statement_day.unremitted is a daily figure, nothing in this database '
          + 'records a remittance, and only 16.3% of that ledger can be joined to a person by '
          + 'id at all (measured 2026-09-21). The accounts team states the position and the '
          + 'date it is as of; everything after that date is counted from here.';

      /* THE FLOOR, stated rather than implied. Not every cash trip carries a
         price — 74.9% did over seven weeks measured on production — so the
         collected half is what we can PROVE was taken, and the true figure is
         at least this. A ratio built on it errs low, and the row says by how
         many trips. */
      const unpriced = cashKnown && r.collected_trips
        ? r.collected_trips - r.collected_priced : 0;

      const owed = cashKnown ? round2(advance + deduction + cash) : null;
      const owedReason = cashKnown ? null
        : 'the cash component is unknown, and the operator\'s policy counts cash the driver '
          + 'holds inside the 35%. A figure without it would understate exposure, which is '
          + 'the dangerous direction.';

      /* THE DENOMINATOR, and why it may be missing. */
      const revReason = earned != null ? null
        : (r.accounts === 0
          ? 'this person has no platform account linked, so no revenue can be attributed to '
            + 'them. A new hire, or somebody paid only a salary.'
          : 'none of this person\'s linked accounts reported earnings in this window.');

      const measurable = owed != null && earned != null && earned > 0 && pct != null;
      const ratio = measurable ? round2((owed / earned) * 100) : null;

      return {
        person_id: r.person_id,
        name: r.full_name,
        /* The account a screen opens this person by, or null — never a broken
           link. */
        ext_id: r.link_ext_id || null,
        link_platform: r.link_platform || null,
        cash_rule: r.cash_rule,
        accounts: r.accounts,
        accounts_with_revenue: r.accounts_with_revenue,
        /* Every term shown, so a reader can see which one is doing the work
           and which one is missing. */
        owes: {
          advance: round2(advance), deduction: round2(deduction),
          cash: cash,
          cash_absent_reason: cashReason,
          /* Every term, so a reader can see which one is doing the work. */
          cash_basis: cashKnown ? {
            opening: round2(opening),
            opening_on: r.opening_on,
            collected_since: round2(collected),
            collected_trips: r.collected_trips || 0,
            collected_unpriced_trips: unpriced,
            handed_in_since: round2(handed),
            handed_in_entries: r.handed_n || 0,
            is_a_floor: unpriced > 0,
            floor_reason: unpriced > 0
              ? `${unpriced} of ${r.collected_trips} cash trips since ${r.opening_on} carry no `
                + 'price, so the collected half is what can be proved and the true figure is at '
                + 'least this. The exposure below therefore errs LOW.'
              : null,
            from: 'an opening position stated by the accounts team, plus fares on cash-marked '
              + 'trips since that date over this person\'s accounts, minus deposits recorded '
              + 'since. Trips and not driver_statement_day.unremitted, which is keyed on a name '
              + 'and joinable to a person for only 16.3% of its value.',
          } : null,
          total: owed, total_absent_reason: owedReason,
        },
        pay_book: r.pay == null ? null : round2(Number(r.pay)),
        earned: earned == null ? null : round2(earned),
        earned_absent_reason: revReason,
        earning_days: r.days ?? null,
        exposure_pct: ratio,
        exposure_absent_reason: measurable ? null
          : (owed == null ? owedReason
            : earned == null ? revReason
              : earned === 0 ? 'this person generated no revenue in this window, so an exposure '
                + 'ratio has no denominator. That is not a ratio of zero.'
                : 'no policy threshold is on file, so nothing can be judged against one.'),
        policy_pct: pct,
        over_policy: measurable ? ratio > pct : null,
        /* Said in words rather than left to a colour, because the action this
           implies is a person deciding to lend or not. */
        verdict: !measurable ? 'not measurable'
          : ratio > pct
            ? `over the ${pct}% line — an override is needed. Nothing is blocked: the approval `
              + 'flow arrives with user management.'
            : `within the ${pct}% line`,
        last_entry: r.last_entry,
      };
    });

    const measured = people.filter((p) => p.exposure_pct != null);
    res.json({
      from, to,
      person_id: onePerson,
      resolved_from: who.from,
      absent_reason: null,
      policy: policy
        ? { pct, effective_from: policy.effective_from, set_by: policy.set_by, note: policy.note }
        : null,
      policy_absent_reason: policy ? null
        : 'no threshold has been stored, so no exposure can be judged. One is set through '
          + 'ledger_policy, effective-dated, so a decision taken in September can be explained '
          + 'against September\'s policy rather than today\'s.',
      summary: {
        people: people.length,
        measurable: measured.length,
        not_measurable: people.length - measured.length,
        over_policy: measured.filter((p) => p.over_policy).length,
        /* NOT a fleet ratio. The operator's instruction is that percentages are
           always personal; a ratio of summed balances over summed revenue would
           be the same numerator/denominator-key defect at fleet scale. A COUNT
           of people over the line is the honest fleet-level figure. */
        fleet_ratio: null,
        fleet_ratio_reason: 'exposure is a per-person measure by instruction. A fleet figure '
          + 'would divide a sum of balances by a sum of revenue, which folds two different '
          + 'populations — the people who owe and the people who earn are not the same set — '
          + 'so the fleet number here is a COUNT of people over the line, not a percentage.',
      },
      basis: 'Numerator: the advance, deduction and cash books of driver_ledger, excluding '
        + 'verification rows. Pay is deliberately not in it — money going to a driver is not '
        + 'money they owe. Denominator: driver_payout_day.earnings summed over THE SAME list of '
        + 'accounts from driver_platform_id, so both halves fold on one key.',
      people,
    });
  }));
}

/* THE LINE ITSELF — reading it, and moving it.
   ═════════════════════════════════════════════════════════════════════════
   The operator: "that percentage will change based on admin / operational head
   / management - so don't hardcode it keep it as a variable in settings which
   will be allocated to the usergroup later."

   So it is a stored, effective-dated row and not a constant — and until this
   was written there was no way to store one. Every exposure figure on
   production rendered absent with the reason "no threshold has been stored, so
   no exposure can be judged", which was true, honest, and useless: the whole
   ledger was measuring against a line nobody could draw.

   ── APPEND-ONLY, AND EFFECTIVE-DATED, AND THOSE ARE TWO DIFFERENT THINGS ──
   APPEND-ONLY means a policy is never edited. A decision taken in September
   was taken against September's line, and an UPDATE would rewrite the reason
   somebody was told they were over it. sql/schema_v78.sql gives this table no
   update path at all; this route adds none.

   EFFECTIVE-DATED means the row carries the day it starts applying, which is
   not the day it was typed. Management deciding on the 20th that the line has
   been 30% since the 1st is a real thing that happens, and the alternative —
   backdating by lying about when it was recorded — is how an audit trail stops
   being one. Both dates are kept: `effective_from` is the policy's, `set_at`
   is the typing's.

   ── WHO MAY MOVE IT, AND WHY THAT IS NOT THE SUPERVISOR LIST ─────────────
   Deliberately NOT checked against SUPERVISORS. Those four are the people who
   record money at a car; moving the lending line is a management decision and
   pretending the two lists are one would write a false attribution into the
   permanent record. Until ULM there is no list to check against and no way to
   check it — so this asks for a name and a reason, records the IP and the
   timestamp, and says in the response, in words, that what it has is
   attribution and not authentication. A guard that cannot enforce anything is
   worse than none, because it reads as one that can. */
export function ledgerPolicyRoutes(app, { q, wrap, tx }) {
  app.get('/api/ledger/policy', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const scope = String(req.query.scope || 'global');
    const rows = await q(
      `SELECT id, scope, pct, to_char(effective_from,'YYYY-MM-DD') AS effective_from,
              set_by, to_char(set_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS set_at, note,
              /* Whether this row is the one in force TODAY. Computed here
                 rather than left to a page to work out from the list, because
                 "the newest row" and "the row in force" are different whenever
                 one has been filed ahead of its start date — which is the
                 normal way a planned change is recorded.

                 THE SUBQUERY ALONE DECIDES IT. The first draft also tested
                 "effective_from <= today" on the outer row, which reads as the
                 guard doing the work and is dead: the subquery can only ever
                 return the id of a row that already passed that test, so a
                 future-dated row fails the id comparison by construction.
                 Reverting the outer clause left the suite green, which is how
                 it was found. Removed rather than kept, for the reason
                 api/import_routes.js gives about its own dead cap — a check
                 that cannot fire is worse than none, because it reads as a
                 considered one.

                 coalesce, because with nothing yet in force the subquery is
                 NULL and "id = NULL" is NULL, not false — and a boolean field
                 that answers null is one a caller writing "=== false" gets
                 wrong. */
              coalesce(id = (SELECT id FROM ledger_policy p2
                              WHERE p2.scope = ledger_policy.scope
                                AND p2.effective_from <= (now() AT TIME ZONE 'Asia/Dubai')::date
                              ORDER BY p2.effective_from DESC, p2.id DESC LIMIT 1),
                       false) AS in_force,
              (effective_from > (now() AT TIME ZONE 'Asia/Dubai')::date) AS starts_later
         FROM ledger_policy WHERE scope = $1
        ORDER BY effective_from DESC, id DESC`, [scope]);

    const current = rows.find((r) => r.in_force) || null;
    res.json({
      scope,
      current: current ? { ...current, pct: Number(current.pct) } : null,
      absent_reason: current ? null
        : (rows.length
          ? 'every policy on file starts in the future, so none is in force today. Exposure is '
            + 'refused rather than judged against a line that has not begun.'
          : 'no threshold has ever been stored, so no exposure can be judged. Until one is, '
            + 'every driver\'s exposure reads as not measurable — which is the honest answer '
            + 'and not a useful one.'),
      history: rows.map((r) => ({ ...r, pct: Number(r.pct) })),
      /* Said plainly rather than left for somebody to infer from the absence
         of a login. */
      attribution_only: 'anybody who can reach this URL can move this line. The name, address '
        + 'and timestamp on each row are what make the change traceable afterwards — they are '
        + 'not authentication, and will not be until user management lands.',
    });
  }));

  app.post('/api/ledger/policy', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const dryRun = b.dry_run !== false;
    const refused = [];

    const by = String(b.set_by || '').trim();
    if (by.length < 2) {
      refused.push('say who is setting this, by name. It is attribution and not authentication '
        + '— until user management lands anybody who can reach this URL can move the line, and '
        + 'the name, address and timestamp are the whole of what makes the change traceable.');
    }

    const pct = Number(b.pct);
    if (!Number.isFinite(pct)) refused.push('pct must be a number — the percentage itself, so 35 and not 0.35');
    else if (pct <= 0 || pct > 1000) {
      refused.push(`pct is ${pct}, and the stored range is above 0 and at most 1000. A figure `
        + 'below 1 is almost always a fraction sent where a percentage was meant: 0.35 would '
        + 'store a line of a third of one percent, under which every driver in the fleet is '
        + 'over it.');
    } else if (pct < 1) {
      refused.push(`pct is ${pct}. That is a valid percentage but an implausible lending line, `
        + 'and it is the exact shape of 0.35 sent where 35 was meant — under it every driver in '
        + 'the fleet reads as over the line. If it is genuinely intended, send it as '
        + `${pct} with allow_implausible: true.`);
    }

    const from = String(b.effective_from || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      refused.push('effective_from must be a YYYY-MM-DD date — the day this line starts '
        + 'applying, which is not necessarily the day it is being typed. A line decided on the '
        + '20th that has applied since the 1st is a real thing; backdating it by misreporting '
        + 'when it was recorded is not.');
    } else {
      const d = new Date(`${from}T00:00:00Z`);
      if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== from) {
        refused.push(`"${from}" is not a real date. A shape check passes "2026-13-99" — `
          + 'thirteen is two digits and so is ninety-nine.');
      }
    }

    const note = String(b.note || '').trim();
    if (note.length < 3) {
      refused.push('a note is required, and it is the sentence somebody reads a year from now '
        + 'when they ask why the line moved. "changed" is not that sentence.');
    }

    const scope = String(b.scope || 'global').trim() || 'global';
    if (scope !== 'global') {
      refused.push(`scope "${scope}" cannot be stored yet. The column exists and is reserved `
        + 'for the user group that will own this line, but nothing reads a non-global scope — '
        + 'so a row written under one would be a policy in force over nobody, silently. '
        + 'Refused rather than accepted and ignored.');
    }

    if (pct < 1 && b.allow_implausible === true && Number.isFinite(pct) && pct > 0) {
      /* The operator has said they meant it. Drop only THAT refusal. */
      const i = refused.findIndex((x) => /implausible lending line/.test(x));
      if (i >= 0) refused.splice(i, 1);
    }

    if (refused.length) return res.status(400).json({ ok: false, dry_run: dryRun, refused });

    /* THE DRY RUN IS A REAL TRANSACTION, ROLLED BACK — the same posture as
       /api/ledger/entry, and for the same reason: a preview computed by
       different code from the write is a preview of something else. */
    const out = await tx(async (tq) => {
      const [prior] = await tq(
        `SELECT pct, to_char(effective_from,'YYYY-MM-DD') AS effective_from, set_by
           FROM ledger_policy
          WHERE scope = $1 AND effective_from <= $2::date
          ORDER BY effective_from DESC, id DESC LIMIT 1`, [scope, from]);

      const [row] = await tq(
        `INSERT INTO ledger_policy (scope, pct, effective_from, set_by, set_ip, note)
         VALUES ($1,$2,$3::date,$4,$5,$6)
         RETURNING id, to_char(set_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS set_at`,
        [scope, pct, from, by, req.ip || null, note]);

      /* HOW MANY PEOPLE THIS MOVES ACROSS THE LINE, counted against the row
         just written, inside the transaction that wrote it. The operator
         asked for a line that management can change; what they need to see
         before changing it is who that change is about. */
      const [moved] = await tq(
        `WITH acct AS (SELECT driver_id, external_id FROM driver_platform_id
                        WHERE detached_at IS NULL),
             book AS (SELECT person_id, sum(amount) AS owed FROM driver_ledger
                       WHERE entry_source <> 'verification' AND book IN ('advance','deduction')
                       GROUP BY person_id),
             rev AS (SELECT a.driver_id AS person_id, sum(p.earnings) AS earned
                       FROM acct a JOIN driver_payout_day p ON p.driver_ext_id = a.external_id
                      GROUP BY a.driver_id)
         SELECT count(*) FILTER (WHERE r.earned > 0
                  AND (b.owed / r.earned) * 100 > $1::numeric)::int AS over_new,
                count(*) FILTER (WHERE r.earned > 0
                  AND $2::numeric IS NOT NULL
                  AND (b.owed / r.earned) * 100 > $2::numeric)::int AS over_old,
                count(*) FILTER (WHERE r.earned IS NULL OR r.earned = 0 OR b.owed IS NULL)::int
                  AS not_measurable,
                count(*)::int AS people
           FROM driver dr
           LEFT JOIN book b ON b.person_id = dr.id
           LEFT JOIN rev r ON r.person_id = dr.id`,
        [pct, prior ? Number(prior.pct) : null]);

      return { row, prior, moved };
    }, { rollback: dryRun });

    const { row, prior, moved } = out;
    const priorLine = prior
      ? `The line in force on ${from} was ${Number(prior.pct)}%, set by ${prior.set_by} `
        + `effective ${prior.effective_from}.`
      : `No line was in force on ${from}; this is the first.`;

    /* THE SENTENCE, ASSEMBLED SERVER-SIDE. Same rule as /api/ledger/entry: two
       shells must not be able to describe one change differently. */
    const measured = moved.people - moved.not_measurable;
    const effect = measured === 0
      ? 'Nobody\'s exposure can be measured yet, so this line changes what nothing is judged '
        + 'against — which is still worth storing, because it is what every figure recorded '
        + 'from here will be read against.'
      : `Of ${measured} people whose exposure can be measured, ${moved.over_new} are over `
        + `${pct}%` + (prior ? ` — against ${moved.over_old} over the ${Number(prior.pct)}% it `
          + 'replaces.' : '.')
        + ' Nothing is blocked either way: the approval step arrives with user management.';

    res.json({
      ok: true,
      dry_run: dryRun,
      policy: { id: dryRun ? null : Number(row.id), scope, pct, effective_from: from,
        set_by: by, set_at: dryRun ? null : row.set_at, note },
      prior: prior ? { pct: Number(prior.pct), effective_from: prior.effective_from,
        set_by: prior.set_by } : null,
      not_measurable: moved.not_measurable,
      sentence: `${dryRun ? 'Would set' : 'Set'} the line to ${pct}% of what a driver generates, `
        + `from ${from}, recorded against ${by}. ${priorLine} ${effect}`,
      /* Said on every write, not only the first. */
      append_only: 'this is a new row and nothing was edited. The line that applied in an '
        + 'earlier month still reads as it did, so a decision taken then can be explained '
        + 'against the policy it was taken under.',
      note: dryRun
        ? 'Nothing was written. This ran against the real constraints inside a transaction that '
          + 'was rolled back — send dry_run: false to store it.'
        : null,
    });
  }));
}
