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
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

/* THE PERSON, AND THE ACCOUNTS THEY WERE FOLDED FROM.
   Read-only: opening somebody's register must never mint their ledger record,
   for the reason api/public/driverledger.js:20-25 gives — a fleet browsed end
   to end would create four hundred people who have never had a dirham
   recorded, and every money figure would then be counted over a population
   that looking created. */
async function who(q, req) {
  const asked = personParam(req);
  if (Number.isNaN(asked)) {
    return { person_id: null, accounts: [],
      absent_reason: 'the person asked for is not a person id. This register takes ?person=p412 '
        + 'or ?person=412 for a person, or ?ext_id= for one of their platform accounts.' };
  }
  const extId = String(req.query.ext_id || req.query.id || '').trim();
  if (asked == null && !extId) {
    return { person_id: null, accounts: [],
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
      return { person_id: null, accounts: [],
        absent_reason: 'no person on the register holds that platform account. The account may '
          + 'exist and simply not have been reviewed onto a person yet — the same-person queue '
          + 'is where that happens.' };
    }
    personId = Number(row.driver_id);
  }

  const accounts = await q(
    `SELECT platform, external_id, display_name, basis
       FROM driver_platform_id WHERE driver_id = $1 AND detached_at IS NULL
      ORDER BY platform, external_id`, [personId]);
  const [person] = await q(`SELECT id, full_name FROM driver WHERE id = $1`, [personId]);
  if (!person) {
    return { person_id: null, accounts: [],
      absent_reason: 'no person on the register carries that id.' };
  }
  return { person_id: personId, name: person.full_name, accounts, absent_reason: null };
}

export function registerRoutes(app, { q, wrap, winDays }) {
  app.get('/api/driver/register', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    const w = await who(q, req);

    if (w.absent_reason) {
      return res.json({
        from, to, person_id: null, name: null, accounts: [],
        opening: null, carried_in: null, lines: [], totals: null,
        shown: 0, of: 0, truncated: false, absent_reason: w.absent_reason,
      });
    }

    const ids = w.accounts.map((a) => a.external_id);
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
        WHERE person_id = $1 AND entry_source <> 'verification'`, [w.person_id]);

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
      [w.person_id, from, ids]);

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
          WHERE te.driver_ext_id = ANY($3::text[])
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
      [from, to, ids, w.person_id]);

    /* THE RUNNING BALANCES, carried in rather than restarted.
       Computed here and not in SQL because the carry is a separate read and
       the two must agree; a window function over the page alone would silently
       restart at the top of every page. */
    let cash = Number(carry.cash_trips_before) + Number(carry.cash_led_before);
    let owed = Number(carry.owed_before);
    const shaped = lines.map((r) => {
      const isLedger = r.kind === 'ledger';
      const verification = r.entry_source === 'verification';
      /* A verification row is shown and moves nothing — driver_ledger's own
         rule (sql/schema_v78.sql:245). */
      if (!verification) {
        if (r.kind === 'trip' && r.cash_amount != null) cash += Number(r.cash_amount);
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

    return res.json({
      from, to,
      person_id: w.person_id, name: w.name, accounts: w.accounts,
      opening: {
        cash: cashOpen ? round2(opening.cash_amount) : null,
        cash_on: opening?.cash_on || null,
        cash_absent_reason: cashOpen ? null
          : 'no opening cash position has been stated for this person, so the cash column is a '
            + 'running change and not a balance. It is not zero: it is a figure nobody has '
            + 'counted. The accounts team states it and the date it is as of, and everything '
            + 'after that date is counted from here.',
        owed: owedOpen ? round2(opening.owed_amount) : null,
        owed_on: opening?.owed_on || null,
        owed_absent_reason: owedOpen ? null
          : 'no opening balance has been carried in for this person, so what they owed before '
            + 'this ledger started is unknown and the owed column runs from nothing recorded '
            + 'rather than from nought owed.',
      },
      carried_in: {
        cash: cashOpen ? round2(Number(carry.cash_trips_before) + Number(carry.cash_led_before)) : null,
        owed: owedOpen ? round2(Number(carry.owed_before)) : null,
        why: 'what each balance stood at the day before this window opened. A window is a view '
          + 'onto a continuing account; summing only its own lines would restart both balances '
          + 'every time somebody changed the dates.',
      },
      totals: {
        fares: sum((l) => l.fare),
        cash_in: sum((l) => l.cash_in),
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
