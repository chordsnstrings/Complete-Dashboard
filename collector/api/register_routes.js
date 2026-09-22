/* THE REGISTER — one person's money as a bank statement reads.
   ══════════════════════════════════════════════════════════════════════════
   The operator asked for "everything that a person earns and spends in a
   ledger that looks similar to a bank statement which has specific
   transaction history", and later a payslip drawn from it.

   ── WHAT IS AND IS NOT A TRANSACTION IN THIS DATABASE ────────────────────
   Only two tables hold events. `trip` is one row per ride, timestamped,
   priced, carrying the payment type. `driver_ledger` is one row per thing
   somebody recorded, with the Dubai day the money moved.

   Everything else is an AGGREGATE and must never be drawn as a dated line:
   driver_payout_day is a weekly statement divided across days, so the money
   did not move on those dates; driver_statement_day is daily totals;
   money_event is period figures; platform_payout is a real wire but to the
   COMPANY, not the driver. A register that listed those would assert
   movements that never happened, on dates nobody transacted.

   ── TWO RUNNING BALANCES, AND ONE COLUMN THAT IS NOT A BALANCE ───────────
   The operator's rule, 2026-09-22: "Cash trips are cash to the driver unless
   they give it to the company." So:

     CASH IN HAND   rises when a cash fare is taken, falls on a cash_deposit.
                    A real liability account.
     OWED           advances and deductions up, repayments and write-offs
                    down. A real balance.
     EARNED         production. NOT a balance, never netted against either,
                    and never a running total of commission — an early draft
                    of this file admitted only service_fee rows into `earned`
                    and would have printed a column headed "earned to date"
                    reading -1,878.39.

   `book` on a line is one of driver_ledger's four ('advance','cash',
   'deduction','pay') or the two this register adds for things that are not
   ledger entries at all ('earning','fee'). The four are the schema's and are
   never renamed; the two extra are flagged `ledger: false` so nothing sums
   them into a book total.

   ── ONE LINE PER TRIP, NOT TWO ───────────────────────────────────────────
   A cash trip is one event with two facts: what the rider was charged, and
   what ended up in a hand. They are two COLUMNS on one row. Emitting a second
   "cash collected" line would turn 134 trips into 144 lines on a page whose
   whole purpose is that the operator can count the trips, and would invite a
   reader to add two numbers that describe one event.

   ── THE OPENING IS WHAT MAKES A BALANCE A BALANCE ────────────────────────
   Without a stated opening there is no starting figure, and a running column
   is then a running CHANGE wearing a balance's name. Measured 2026-09-22:
   driver_ledger holds zero rows on production, so this is every person today.
   The register returns its lines and reports both balances as null with the
   reason, rather than starting from an assumed nought. */
import { personParam } from './driver_routes.js';

const LIMIT_MAX = 1000;

/* THE KEY A TRIP IS MATCHED BY, and it is not always an account id.
   ─────────────────────────────────────────────────────────────────────────
   The hotel channel names a driver without numbering them, so this product
   synthesises `name:<canonical name>` as their id — api/driver_routes.js:117,
   and the same expression at :283. A register that matched only on
   driver_ext_id 404'd every one of those drivers while every other driver page
   opened for them; test/reachability.test.mjs caught exactly that.

   CANON here must be character-for-character the one in api/driver_routes.js,
   or a key built by one file will not match a key built by the other. */
const CANON = (col) => `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
const PKEY = `coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('driver_name')})`;
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

/* THE PERSON, AND THE ACCOUNTS THEY WERE FOLDED FROM.
   Read-only: opening somebody's register must never mint their ledger record,
   for the reason api/public/driverledger.js:20-25 gives — a fleet browsed end
   to end would create four hundred people who have never had a dirham
   recorded, and every money figure would then be counted over a population
   that looking created. */
/* THREE DIFFERENT NOs, AND THEY ARE NOT THE SAME STATUS.
   ─────────────────────────────────────────────────────────────────────────
   test/reachability.test.mjs enforces one rule across every driver page in
   this product: an id nobody has is a 404. This route shipped answering 200
   with an absent_reason for it, and the suite caught it — rightly, because a
   200 says "here is the answer about that driver" and there is no such driver
   to answer about. A caller cannot tell it from a real driver with an empty
   register, which is exactly the distinction the rest of the product spends
   its refusals maintaining.

   So:
     404  no such driver — the id resolves to nobody at all
     400  a question this route cannot take — no driver named, or a ?person=
          that is not a person id
     200  a real person, whatever their register holds. "Nothing has been
          recorded against them" IS an answer about somebody, and it comes
          back with the lines, the accounts and the reasons.

   `status` travels with the refusal so the caller sets it; returning the
   sentence without the code is how the two collapse back into one. */
async function who(q, req) {
  const asked = personParam(req);
  if (Number.isNaN(asked)) {
    return { person_id: null, accounts: [], status: 400,
      absent_reason: 'the person asked for is not a person id. This register takes ?person=p412 '
        + 'or ?person=412 for a person, or ?ext_id= for one of their platform accounts.' };
  }
  const extId = String(req.query.ext_id || req.query.id || '').trim();
  if (asked == null && !extId) {
    return { person_id: null, accounts: [], status: 400,
      absent_reason: 'no driver was named. A register is about one person; there is no '
        + 'fleet-wide version of it, because a running balance over everybody is not a balance '
        + 'of anything.' };
  }

  let personId = asked;
  if (personId == null) {
    const [row] = await q(
      `SELECT driver_id FROM driver_platform_id
        WHERE external_id = $1 AND detached_at IS NULL ORDER BY driver_id LIMIT 1`, [extId]);
    if (!row) {
      /* AN ACCOUNT THE SPINE HAS NOT PLACED STILL HAS A REGISTER.
         ─────────────────────────────────────────────────────────────────
         This returned 404 for any id without a driver_platform_id row, and
         test/reachability.test.mjs caught it: every other driver page in this
         product opens for a driver the directory names, and five of them —
         u-nauman, y-tariq, u-kashif, b-kashif, y-khalid — have trips and no
         spine row. A page that 404s where the rest of the product renders
         makes the register look broken for a driver who is merely unreviewed.

         It is the same principle the person-address work settled: an account
         the spine has not placed is NOT an error and does not lose its page.
         It keeps its provider address, its own trips are its register, and the
         page says why there is no person behind it — rather than implying the
         driver does not exist, which is what a 404 says.

         A 404 is still right for an id NOBODY has, which is why the existence
         probe is against work actually seen rather than against the spine. */
      const [seen] = await q(
        `SELECT 1 AS ok FROM trip WHERE ${PKEY} = $1 LIMIT 1`, [extId]);
      if (!seen) {
        return { person_id: null, accounts: [], status: 404,
          absent_reason: 'no driver in this fleet holds that platform account.' };
      }
      return {
        person_id: null, name: null, unplaced_ext_id: extId,
        accounts: [{ platform: null, external_id: extId, display_name: null,
          basis: 'account' }],
        absent_reason: null,
        person_absent_reason: 'this account has not been reviewed onto a person yet, so the '
          + 'register below is this ACCOUNT\'s work alone and not the whole human\'s. If they '
          + 'drive on another platform too, those trips are on another register until the '
          + 'same-person queue joins them. Ledger entries are recorded against a person, so '
          + 'there are none to show here.',
      };
    }
    personId = Number(row.driver_id);
  }

  const accounts = await q(
    `SELECT platform, external_id, display_name, basis
       FROM driver_platform_id WHERE driver_id = $1 AND detached_at IS NULL
      ORDER BY platform, external_id`, [personId]);
  const [person] = await q(`SELECT id, full_name FROM driver WHERE id = $1`, [personId]);
  if (!person) {
    return { person_id: null, accounts: [], status: 404,
      absent_reason: 'no person on the register carries that id.' };
  }
  return { person_id: personId, name: person.full_name, accounts, absent_reason: null };
}

export function registerRoutes(app, { q, wrap, winDays }) {
  app.get('/api/driver/register', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    const w = await who(q, req);

    if (w.absent_reason) {
      return res.status(w.status || 400).json({
        from, to, person_id: null, name: null, accounts: [],
        opening: null, carried_in: null, lines: [], totals: null,
        shown: 0, of: 0, truncated: false,
        error: w.status === 404 ? 'no such driver' : 'this register needs one driver',
        absent_reason: w.absent_reason,
      });
    }

    const ids = w.accounts.map((a) => a.external_id);
    /* An unplaced account has no person, so no ledger row can exist against it
       — driver_ledger is keyed on person_id at WRITE time. The trip half of
       the register is still real and is what this page shows. */
    const pid = w.person_id;
    const limit = Math.min(Number(req.query.limit) || 400, LIMIT_MAX);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    /* THE OPENING. Two of them, stated separately, because a person may have
       had their cash counted and not their debt, or the other way round. */
    const [opening] = await q(
      `SELECT max(effective_on) FILTER (WHERE type_code = 'cash_opening')    AS cash_on,
              sum(amount)       FILTER (WHERE type_code = 'cash_opening')    AS cash_amount,
              max(effective_on) FILTER (WHERE type_code = 'opening_balance') AS owed_on,
              sum(amount)       FILTER (WHERE type_code = 'opening_balance') AS owed_amount
         FROM driver_ledger
        WHERE person_id = $1 AND entry_source <> 'verification'`, [pid]);

    const cashOpen = opening?.cash_on != null;
    const owedOpen = opening?.owed_on != null;

    /* WHAT THE BALANCES STOOD AT THE DAY BEFORE THIS WINDOW.
       A window is a view onto a continuing account, not a fresh one. Summing
       only the window's own lines would restart both balances at every change
       of the date range — which reads as a driver repaying everything on the
       1st of every month. */
    const [carry] = await q(
      `WITH led AS (
         SELECT book, sum(amount) AS amt
           FROM driver_ledger
          WHERE person_id = $1 AND entry_source <> 'verification'
            AND effective_on < $2::date
          GROUP BY book
       ),
       cash_in AS (
         SELECT coalesce(sum(cash_amount), 0) AS amt
           FROM trip_cash
          WHERE driver_ext_id = ANY($3::text[])
            AND (requested_at AT TIME ZONE 'Asia/Dubai')::date < $2::date
       )
       SELECT coalesce((SELECT amt FROM led WHERE book = 'advance'), 0)
            + coalesce((SELECT amt FROM led WHERE book = 'deduction'), 0) AS owed_before,
              coalesce((SELECT amt FROM led WHERE book = 'cash'), 0)      AS cash_led_before,
              (SELECT amt FROM cash_in)                                   AS cash_trips_before`,
      [pid, from, ids]);

    /* WHAT CAME IN OVER THE WINDOW — the income half of the statement.
       ─────────────────────────────────────────────────────────────────────
       The operator asked for "the amount that has come in for the date range
       selected". Everything else on this route is a trip or a ledger line;
       none of them is earnings. `totals.fares` is what RIDERS WERE CHARGED
       and this route already says in words that it is not what the driver
       earned — so answering "income" with it would be the third wrong figure
       under the same word.

       driver_payout_day is the same table /api/ledger/exposure's `rev` CTE
       uses for its denominator, summed over the same account list and bounded
       by the same window, so the two surfaces cannot disagree about what a
       person generated. One definition, two surfaces.

       NOT coalesced to zero. A person with no payout row earned nothing that
       anybody RECORDED, which is not the same as having earned nought, and
       the row count below is what lets the response tell them apart. */
    const [income] = await q(
      `SELECT sum(earnings)              AS earned,
              sum(cash_earnings)         AS cash_earned,
              count(*)::int              AS rows,
              count(DISTINCT day)::int   AS days,
              count(DISTINCT driver_ext_id)::int AS accounts
         FROM driver_payout_day
        WHERE driver_ext_id = ANY($1::text[])
          AND day BETWEEN $2::date AND $3::date`, [ids, from, to]);

    /* ── THE THREE KINDS OF LINE ─────────────────────────────────────────
       Ordered by the day the money moved, then by a rank that puts a trip
       before the fee taken out of it and a ledger entry last, so a reader
       following the running balance down the page sees cause before effect. */
    const lines = await q(
      `WITH t AS (
         SELECT te.platform, te.external_id, te.requested_at, te.plate,
                te.price, te.payment_type, te.outcome,
                te.pickup_addr, te.dropoff_addr,
                tc.cash_amount, tc.cash_basis,
                (te.raw -> 'uber_payments' ->> 'service_fee')::numeric AS service_fee
           FROM trip_ext te
           LEFT JOIN trip_cash tc ON tc.platform = te.platform
                                 AND tc.external_id = te.external_id
          WHERE coalesce(nullif(btrim(te.driver_ext_id), ''),
                         'name:' || ${CANON('te.driver_name')}) = ANY($3::text[])
            AND (te.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
       )
       SELECT 'trip' AS kind, 0 AS rank,
              (t.requested_at AT TIME ZONE 'Asia/Dubai')::date AS on_day,
              t.requested_at AS at,
              t.platform, t.external_id AS ref, t.plate,
              coalesce(t.dropoff_addr, t.pickup_addr) AS detail,
              t.payment_type, t.outcome,
              t.price AS fare, t.cash_amount, t.cash_basis,
              NULL::numeric AS amount, NULL::text AS type_code, NULL::text AS book,
              NULL::text AS note, NULL::text AS entered_by, NULL::text AS receipt_sha,
              NULL::text AS entry_source,
              NULL::boolean AS receipt_row, NULL::text AS receipt_expires_on,
              NULL::boolean AS receipt_expired, NULL::boolean AS needs_proof
         FROM t
       UNION ALL
       /* THE COMMISSION, PER TRIP AND NOT PER PERIOD. src/sources/uber.js:649
          files a service_fee on every Uber trip whose payments week has been
          walked — measured at exactly 25% on every sampled trip. A period line
          would have to be allocated across trips to sit in a chronological
          register, and an allocation is a figure the platform never stated. */
       SELECT 'fee' AS kind, 1 AS rank,
              (t.requested_at AT TIME ZONE 'Asia/Dubai')::date, t.requested_at,
              t.platform, t.external_id, t.plate,
              'commission on the fare above' AS detail,
              NULL, NULL,
              NULL::numeric, NULL::numeric, NULL::text,
              abs(t.service_fee), 'service_fee', 'fee',
              NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL
         FROM t WHERE t.service_fee IS NOT NULL AND t.service_fee <> 0
       UNION ALL
       SELECT 'ledger' AS kind, 2 AS rank,
              e.effective_on, e.effective_on::timestamptz,
              e.acct_platform, e.id::text, NULL,
              coalesce(ty.label, e.type_code) AS detail,
              e.settles_via, NULL,
              NULL::numeric, NULL::numeric, NULL::text,
              e.amount, e.type_code, e.book,
              e.note, e.entered_by, e.receipt_sha, e.entry_source,
              (rc.sha256 IS NOT NULL),
              to_char(rc.expires_on,'YYYY-MM-DD'),
              (rc.sha256 IS NOT NULL AND rc.expires_on < (now() AT TIME ZONE 'Asia/Dubai')::date),
              ty.needs_proof
         FROM driver_ledger e
         LEFT JOIN ledger_type ty ON ty.code = e.type_code
         LEFT JOIN driver_ledger_receipt rc ON rc.sha256 = e.receipt_sha
        WHERE e.person_id = $4
          AND e.effective_on BETWEEN $1::date AND $2::date
        ORDER BY on_day, rank, at`,
      [from, to, ids, pid]);

    /* THE RUNNING BALANCES, carried in rather than restarted.
       Computed here and not in SQL because the carry is a separate read and
       the two must agree; a window function over the page alone would silently
       restart at the top of every page. */
    /* TWO CASH QUANTITIES, AND ONLY ONE OF THEM NEEDS AN OPENING.
       ─────────────────────────────────────────────────────────────────────
       This file shipped with one column, `running_cash`, which was null for
       everybody because it tried to answer "how much is in their pocket now" —
       and that needs a stated opening and recorded hand-ins, neither of which
       exists yet. The operator pointed out what that hid: the cash TAKEN is
       not an estimate, it is a measured fact on every cash trip we hold.

       Measured on production 2026-09-22 for person 202: 120 cash trips,
       AED 7,427.40 taken, from 2024-12-28 onward. A column rendering that as
       "—" because nobody has typed an opening balance is withholding a number
       the database is certain of.

       So they are separated:

         running_taken  what has gone INTO their hand, cumulative. Needs
                        nothing but the trips. Always a real number. It is also
                        the ceiling on what they could still be holding.
         running_cash   what they are STILL holding = opening + taken since
                        that opening - hand-ins recorded since. Absent with a
                        reason until an opening exists, which is honest,
                        because without it the figure would silently mean the
                        first thing while being labelled the second. */
    let taken = Number(carry.cash_trips_before);
    let cash = Number(carry.cash_trips_before) + Number(carry.cash_led_before);
    let owed = Number(carry.owed_before);
    const shaped = lines.map((r) => {
      const isLedger = r.kind === 'ledger';
      const verification = r.entry_source === 'verification';
      /* A verification row is shown and moves nothing — driver_ledger's own
         rule (sql/schema_v78.sql:245). */
      if (!verification) {
        if (r.kind === 'trip' && r.cash_amount != null) {
          taken += Number(r.cash_amount);
          cash += Number(r.cash_amount);
        }
        if (isLedger && r.book === 'cash') cash += Number(r.amount);
        if (isLedger && (r.book === 'advance' || r.book === 'deduction')) owed += Number(r.amount);
      }
      return {
        kind: r.kind,
        on: r.on_day,
        at: r.at,
        platform: r.platform,
        ref: r.ref,
        plate: r.plate,
        detail: r.detail,
        /* THE TRIP'S TWO FACTS, side by side and never added together. */
        fare: round2(r.fare),
        cash_in: r.kind === 'trip' ? round2(r.cash_amount) : null,
        cash_basis: r.cash_basis,
        payment_type: r.kind === 'trip' ? r.payment_type : null,
        outcome: r.outcome,
        amount: round2(r.amount),
        type_code: r.type_code,
        book: r.kind === 'trip' ? 'earning' : (r.book || null),
        ledger: isLedger,
        note: r.note,
        entered_by: r.entered_by,
        /* THE SAME FOUR STATES /api/ledger/entries reports, shaped identically.
           The page renders both through one proofCell, so a divergence here
           would mean the same entry described two ways on two panels. */
        receipt: !isLedger ? null
          : (r.receipt_sha
            ? (r.receipt_row
              ? (r.receipt_expired
                ? { sha256: r.receipt_sha, held: false, expired: true,
                  expires_on: r.receipt_expires_on,
                  absent_reason: `a photograph was held until ${r.receipt_expires_on}, which is `
                    + 'past its twelve-month retention, so this system no longer serves it. The '
                    + 'entry is permanent and still records that one was taken.' }
                : { sha256: r.receipt_sha, held: true, expired: false,
                  expires_on: r.receipt_expires_on, absent_reason: null })
              : { sha256: r.receipt_sha, held: false, expired: false, expires_on: null,
                absent_reason: 'this entry records a photograph by digest and no photograph is '
                  + 'stored under it. Nothing in this system deletes a receipt, so it was never '
                  + 'saved rather than removed.' })
            : { sha256: null, held: false, expired: false, expires_on: null,
              absent_reason: r.needs_proof === false
                ? 'this type carries no photograph — it records a decision or a period figure, '
                  + 'which has none to take'
                : 'no photograph is attached to this entry' }),
        receipt_sha: r.receipt_sha,
        entry_source: r.entry_source,
        verification,
        /* A card trip moved no balance and the row says so rather than
           leaving two empty cells to read as nought. */
        no_movement_reason: r.kind === 'trip' && r.cash_amount == null
          ? (r.outcome !== 'completed'
            ? 'this booking did not complete, so no fare was charged and nothing changed hands'
            : 'the rider paid the platform, so nothing changed hands with the driver on this '
              + 'trip. The fare is shown because it happened, not because it moved a balance.')
          : null,
        /* ALWAYS A NUMBER. Nothing about it is conditional on a human having
           typed anything — it is the sum of what the trips say was handed
           over. */
        running_taken: round2(taken),
        running_cash: cashOpen ? round2(cash) : null,
        running_owed: owedOpen ? round2(owed) : null,
      };
    });

    const page = shaped.slice(offset, offset + limit);

    /* TOTALS OVER THE WHOLE WINDOW, NOT OVER THE PAGE. #payouts shipped
       reading "AED 319,015 · 6 transfers" over a register of 217 transfers
       because a page added up what it was given. */
    const sum = (f) => round2(shaped.filter((l) => !l.verification)
      .reduce((a, l) => a + (Number(f(l)) || 0), 0));
    /* Counted as well as summed, for the reason the exposure route counts its
       advance and deduction rows: nothing recorded and a balance that nets to
       zero are different facts, and a bare sum reports both as 0. */
    const count = (f) => shaped.filter((l) => !l.verification && f(l)).length;

    /* ── CASH TAKEN, OVER THIS WINDOW, AS THE OPERATOR DEFINED IT ────────
       "cash taken should be cash trip amount + cash advance - cash deposited
       for the duration."

       Three measured terms, all bounded by the same window as every other
       total here:

         cash fares      what the trips put in their hand    (positive)
         cash advances   cash the company handed them        (positive)
         cash deposited  what they handed back               (ALREADY NEGATIVE)

       THE MINUS SIGN IS NOT WRITTEN, AND THAT IS THE POINT. driver_ledger's
       sign convention (sql/schema_v78.sql:30-41) is that a row's `direction`
       IS its sign, and cash_deposit is direction -1 — so its `amount` is
       stored negative and the subtraction is already in the data. Writing a
       literal minus here would ADD the deposits back and overstate what the
       driver is holding, which is the dangerous direction. api/ledger_routes.js
       does the same addition at its own cash term for the same reason.

       WHY type_code AND NOT book. `book = 'advance'` is a NET over seven
       types — salary_advance, charging_advance, opening_balance, repayment,
       writeoff, refund — and the operator asked for the CASH one. Summing the
       book would fold a charging advance and a debt write-off into a cash
       figure. The deposit half takes the whole cash book EXCEPT the opening,
       matching the exposure route's `handed` CTE, so a future settling type
       is picked up without another edit. */
    const cashFares = sum((l) => l.cash_in);
    const cashAdvance = sum((l) => (l.type_code === 'cash_advance' ? l.amount : 0));
    const cashDeposit = sum((l) => (l.book === 'cash' && l.type_code !== 'cash_opening'
      ? l.amount : 0));
    const cashAdvanceRows = count((l) => l.type_code === 'cash_advance');
    const cashDepositRows = count((l) => l.book === 'cash' && l.type_code !== 'cash_opening');
    const cashTripRows = count((l) => l.kind === 'trip' && l.cash_in != null);
    const takenWindow = round2(cashFares + cashAdvance + cashDeposit);

    return res.json({
      from, to,
      person_id: w.person_id, name: w.name, accounts: w.accounts,
      person_absent_reason: w.person_absent_reason || null,
      opening: {
        cash: cashOpen ? round2(opening.cash_amount) : null,
        cash_on: opening?.cash_on || null,
        cash_absent_reason: cashOpen ? null
          : 'no opening cash position has been stated for this person, so the cash column is a '
            + 'running change and not a balance. It is not zero: it is a figure nobody has '
            + 'counted. The accounts team states it and the date it is as of, and everything '
            + 'after that date is counted from here.',
        owed: owedOpen ? round2(opening.owed_amount) : null,
        taken_needs_no_opening: 'cash taken is measured on the trips themselves and is always a '
          + 'real figure. What it is NOT is what the driver still holds: that is this number '
          + 'less whatever they have handed back, and no hand-in is recorded until somebody '
          + 'records one. So it reads as a ceiling, not a balance.',
        owed_on: opening?.owed_on || null,
        owed_absent_reason: owedOpen ? null
          : 'no opening balance has been carried in for this person, so what they owed before '
            + 'this ledger started is unknown and the owed column runs from nothing recorded '
            + 'rather than from nought owed.',
      },
      carried_in: {
        taken: round2(Number(carry.cash_trips_before)),
        cash: cashOpen ? round2(Number(carry.cash_trips_before) + Number(carry.cash_led_before)) : null,
        owed: owedOpen ? round2(Number(carry.owed_before)) : null,
        why: 'what each balance stood at the day before this window opened. A window is a view '
          + 'onto a continuing account; summing only its own lines would restart both balances '
          + 'every time somebody changed the dates.',
      },
      /* WHAT THE WINDOW ITSELF SAYS — a FLOW, next to the positions the
         exposure route answers with. The two are different questions and the
         page must not print them under one heading: what a driver is holding
         today does not change because somebody moved the dates, and what they
         took during September does not change because today arrived. */
      over_window: {
        from, to,
        earned: income?.earned == null ? null : round2(Number(income.earned)),
        cash_earned: income?.cash_earned == null ? null : round2(Number(income.cash_earned)),
        earning_days: Number(income?.days) || 0,
        earning_accounts: Number(income?.accounts) || 0,
        earned_absent_reason: income?.earned != null ? null
          : (ids.length === 0
            ? 'this person has no platform account linked, so no statement of theirs can be '
              + 'found to add up. It is not nought earned: it is nobody to ask.'
            : 'none of this person\'s linked accounts reported earnings between these dates. '
              + 'That is a gap in what the platforms published for this window, not a '
              + 'statement that they earned nothing.'),
        /* Always a number: the trips measured it and nobody had to type
           anything. Its TERMS ride beside it because it is derived, and a
           derived figure that arrives without its parts is one a reader has
           to trust rather than check. */
        cash_taken: takenWindow,
        cash_taken_terms: {
          cash_fares: cashFares,
          cash_fare_trips: cashTripRows,
          cash_advance: cashAdvance,
          cash_advance_rows: cashAdvanceRows,
          cash_deposit: cashDeposit,
          cash_deposit_rows: cashDepositRows,
          /* The sign, said out loud, because the one way to get this
             arithmetic wrong is to subtract a number that is already
             negative. */
          deposit_is_already_negative: true,
        },
        cash_taken_means: cashAdvanceRows === 0 && cashDepositRows === 0
          ? 'cash fares over this window. No cash advance and no deposit is recorded between '
            + 'these dates, so there is nothing to add or take off — this is what the trips '
            + 'put in their hand, not a balance net of hand-ins nobody has entered.'
          : 'cash fares over this window, plus cash advanced to them, less what they handed '
            + 'back. A flow over these dates — not what they are holding today.',
      },
      totals: {
        fares: sum((l) => l.fare),
        cash_in: cashFares,
        fees: sum((l) => (l.book === 'fee' ? l.amount : 0)),
        ledger_advance: sum((l) => (l.book === 'advance' ? l.amount : 0)),
        ledger_deduction: sum((l) => (l.book === 'deduction' ? l.amount : 0)),
        ledger_cash: sum((l) => (l.book === 'cash' ? l.amount : 0)),
        ledger_pay: sum((l) => (l.book === 'pay' ? l.amount : 0)),
        over_the_window: true,
        excludes_verification: true,
        /* SAID IN WORDS, because three different figures on this product all
           answer to the name "earned" and none of them is this one. */
        fares_are_not_earnings: 'fares is what riders were charged on these trips. What the '
          + 'driver earned is the fare less the platform\'s commission, and what the platform '
          + 'reports on its statement is a third figure again. The three never agree and are '
          + 'never summed.',
      },
      shown: page.length,
      of: shaped.length,
      truncated: shaped.length > page.length,
      lines: page,
      absent_reason: null,
    });
  }));
}
