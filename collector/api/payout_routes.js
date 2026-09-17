/* THE PAYOUT REGISTER — what each platform actually transferred, by date.
   ─────────────────────────────────────────────────────────────────────────
   Finance already has five pages and none of them holds a transfer. #reconcile
   compares a month's "bank payout" against what the statements say was owed,
   and its bank payout is driver_payout_day.earnings summed by month — Uber's
   weekly PER-DRIVER earnings, spread across the days they were earned. That is
   a real quantity and it is not a wire.

   ── THE "7.1% APART" THIS FILE USED TO PRINT WAS A WRONG-WEEK COMPARISON ──
   The retracted sentence, which stood at the top of this file and in the note
   on GET /api/finance/payouts and on the page that renders it: "On the one
   week both were measured (Ecosine, Mon 7 – Sun 13 Sep 2026) the dashboard
   says 110,962.09 and Uber's own books say the transfer was 103,567.54, 7.1%
   apart." The arithmetic is sound — 7,394.55 / 103,567.54 = 7.14% — and the
   two figures are not the same week, which is the whole of why they disagreed
   by that much.

   103,567.54 was wired on MONDAY 2026-09-07, and by the cadence below a Monday
   wire settles the Mon–Sun week that ENDED THE DAY BEFORE: 31 Aug – 6 Sep. The
   wire that settles 7–13 Sep is the one paid on Monday 2026-09-14, and it is
   111,179.66. Beside the right wire, measured on production 2026-09-17:

     ours, the seven daily bank_payout figures /api/reconcile prints for
     7–13 Sep (each sum(driver_payout_day.earnings) for that day):
       14,324.61 + 15,770.41 + 17,192.37 + 16,612.39
       + 17,532.04 + 15,726.00 + 13,804.27              = 110,962.09
     Uber's wire, Mon 2026-09-14                         = 111,179.66
     difference                                               217.57  (0.20%)

   So the two registers agree to a fifth of one percent. They still describe
   different events — a week of per-driver earnings is not a transfer — but
   "7.1% apart" was never a measurement of that difference, and a page that
   printed it was telling an operator their books were out by seven percent.

   This route answers the narrower question the operator actually asked: how
   much money reached the company's account, and on exactly which date. It
   answers it only where a provider publishes it, and where a provider does not
   it says which provider, and why, in the provider's own terms.

   THE THREE ANSWERS ARE DIFFERENT IN KIND, and the response keeps them apart:

     uber   the transfer, dated exactly. REPORT_TYPE_PAYMENTS_ORGANIZATION over
            a ONE-DAY window carries 'Payouts : Transferred To Bank Account',
            empty on a day with no transfer. Uber wires on Monday, settling the
            Mon–Sun week that ended the day before.
     bolt   the transfer, dated exactly. /fleetOwnerPortal/getPayouts, one row
            per payout with 'finished' as a unix second. 175 payouts over
            2024-12-23 .. 2026-09-07 across both fleets.
     yango  NOT PUBLISHED. The Fleet API's park ledger is a DRIVER-account
            ledger: the three categories that mention a bank are in a group
            Yango itself names "Payouts from account balance to contractors",
            which is the park paying its drivers. None of them carries a row.
            So Yango appears here with no payout total and a reason, and never
            with a zero.

   THREE ROUTES LIVE HERE.
     GET  /api/finance/payouts            the register, one row per transfer
     GET  /api/finance/payouts/reconcile  each wire against our own figure for
                                          the week it settles, read-only
     POST /api/finance/payouts/verify     ask Uber LIVE about named days */
import { oneDay, settlesWeek } from '../src/sources/uber_payout.js';
import { uberOrgs } from '../src/sources/uber.js';
import { loadSettings } from '../src/settings.js';
import { dubaiIso } from '../src/util.js';

/* ROUNDING, ONCE. Every figure on these two routes is money to two decimals or
   a percentage to two decimals, and a percentage computed from unrounded money
   and then rounded is not the same number as one computed from the rounded
   money. Rounded at the last step, consistently. */
const r2 = (n) => (n == null || !Number.isFinite(Number(n))
  ? null : Math.round(Number(n) * 100) / 100);

/* A DATE THAT IS NOT A DATE MUST NOT REACH THE PROVIDER.
   The shape check alone is not enough and api/server.js carries the same note
   over its own asDate(): '2026-13-45' matches ten digits and two dashes and is
   not a day. The round trip through Date is what separates a well-formed
   string from a real one. Duplicated here rather than imported because
   server.js does not export it, and the rule is four lines long. */
const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/* Today on the fleet's calendar, from src/util.js's dubaiIso() and not from a
   hand-rolled offset.
   ─────────────────────────────────────────────────────────────────────────
   This was `new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)`,
   which is arithmetic on a UTC instant rather than a calendar conversion, and
   test/timezone.test.mjs refused it by name: "is the UTC day of a clock — use
   dubaiIso/dubaiMonth from src/util.js". The guard is right and its reasoning
   is the one this repo has been bitten by more than once — every page that has
   ever bound on a UTC day has been four hours wrong, and an offset written out
   by hand is a second copy of a rule that already has an owner. */
const dubaiToday = () => dubaiIso();

/* HOW MANY DAYS THE SETTLED PERIOD COVERS, COUNTED RATHER THAN ASSUMED.
   The basis sentences used to say "N of 7 days carrying rows". Seven is right
   for Uber's Mon-Sun week and right only by accident — nothing in settlesWeek()
   promises seven — so the first cadence that settles over a fortnight would
   print a false denominator beside correct numbers, which is the shape of error
   this file exists to stop. Inclusive at both ends, matching the SQL's
   BETWEEN and the (period_end - period_start + 1) the reconcile query reads. */
const weekDays = (w) => {
  const a = Date.parse(`${w?.period_start}T12:00:00Z`);
  const b = Date.parse(`${w?.period_end}T12:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.round((b - a) / 864e5) + 1
    : null;
};

const FLEETS = ['ecosine', 'egari'];
const MAX_DAYS = 5;
/* THE PLATFORM CLOSES A REQUEST BEFORE FIVE DAYS CAN FINISH, SO THE LOOP STOPS
   ITSELF FIRST.
   ─────────────────────────────────────────────────────────────────────────
   MEASURED ON PRODUCTION 2026-09-17, on the first real use of this route: a
   five-day ask for ecosine was cut by DigitalOcean's load balancer at
   300.46 s with no response at all — curl reported http=000. The work had NOT
   failed. Three of the five days were asked, answered and STORED; the operator
   simply received nothing, and had no way to know which three. That is the
   worst shape a money page can take: the register moved and the page said
   nothing moved.

   MAX_DAYS is a bound on the ASK. This is a bound on the REQUEST, and the two
   are different limits: one Uber report takes between ten and forty seconds
   and the limiter can add minutes, so five days fits inside 300 s on a good
   run and does not on an ordinary one. The loop now checks the clock before
   each day and stops while there is still time to answer, reporting every day
   it did not reach as refused WITH THE TRUE REASON — not as a failure, and not
   as a day with no transfer.

   240 s leaves a minute for the response to be assembled and sent, which is
   generous on a route whose remaining work after the loop is arithmetic. */
const requestBudgetMs = () => Number(process.env.PAYOUT_VERIFY_BUDGET_MS || 240000);

/* THE LIVE ASK, AND WHY IT IS AN INJECTION POINT.
   ─────────────────────────────────────────────────────────────────────────
   api/probe.js already calls Uber from this process — it imports
   uberWebHeaders and uberOrgs and calls loadSettings() — so reaching the
   provider from the API service is established rather than new. The ask itself
   is src/sources/uber_payout.js oneDay(), imported rather than reimplemented:
   the mapper's central claim is that an EMPTY bank cell (a day with no
   transfer, mapped to 0) and an ABSENT bank column (a provider change, mapped
   to null) are different facts, and a second copy that got that one line wrong
   would write a wire of zero on four days in five.

   It is reachable through deps so a test can mount these routes with a stub in
   place of the provider. A test that called Uber would be a test of Uber's
   limiter, would need a credential in the checkout, and would be red whenever
   the network was. api/server.js passes no `uber` key, so production always
   gets the real one. */
const LIVE_UBER = {
  async orgFor(fleet) {
    /* Credentials live in the settings table, not only in the environment, and
       the API process does not load them at boot. Every probe route in
       api/probe.js opens with exactly this call for the same reason. */
    await loadSettings();
    return uberOrgs(fleet)[0] || null;
  },
  oneDay,
};

/* ONE LIVE ASK AT A TIME, ACROSS THE WHOLE PROCESS.
   ─────────────────────────────────────────────────────────────────────────
   Uber's payment-report generator has a cap of its own, tighter than the
   three-in-flight cap on the rest of the report pipeline: three one-day
   payment reports fired together came back "Payment report generation limit
   reached", and the limiter then stayed shut for several minutes, refusing
   even a single request. It is not hypothetical — it cut the collector's run
   on the night of 2026-09-16 to 4 of the 8 days it asked for, which is why
   Monday 2026-09-14's wire was still uncollected a day later.

   So the walk inside one request is strictly sequential (await in a for loop,
   never Promise.all), and this flag stops two REQUESTS doing concurrently what
   one request refuses to do. The second caller is told an ask is running; it
   is not queued behind the first, because a queued caller holds a socket open
   for minutes and then gets an answer about a moment that has passed.

   Module-level on purpose: the guard has to be per PROCESS, since the limiter
   is per Uber org and both fleets share the same generator. It is released in
   a finally, so a throw inside the walk cannot leave the route wedged shut —
   that failure mode is worse than the one the flag prevents, because nothing
   recovers it but a restart. */
let inFlight = null;

export function payoutRoutes(app, { q, wrap, range, uber = LIVE_UBER }) {
  /* Every provider this page is entitled to speak about, and what each one
     publishes. Written down rather than derived from the rows, because "we
     have no Yango payouts" and "Yango does not publish payouts" are different
     sentences and only the table can tell them apart — an empty result set
     looks identical either way, which is exactly how a collection failure gets
     rendered as a zero. */
  const PROVIDERS = [
    { platform: 'uber', publishes: true,
      how: 'Uber’s organisation payment statement, asked one day at a time. The transfer '
        + 'column is empty on a day with no transfer, so the date is the provider’s and '
        + 'not ours.',
      /* THE CADENCE IS PROVEN. THE "TO THE FILS" PART WAS NOT, AND THIS
         SENTENCE USED TO CLAIM IT WAS.
         ──────────────────────────────────────────────────────────────────
         What stood here: "proven over two consecutive weeks: the transfer
         equals the previous week's closing balance to the fils." Three
         Ecosine Mondays are now measurable and they do not support it:

           2026-08-17  opening 57,791.73   wire 57,810.41   wire 18.68 ABOVE
           2026-09-07  opening 103,567.54  wire 103,567.54  exact
           2026-09-14  opening 111,279.92  wire 111,179.66  wire 100.26 BELOW

         One of three. The WEEK a Monday wire settles is a different claim and
         it still holds on all three; only the equality was overstated, and it
         was overstated from a sample of two that happened to include the one
         Monday where it was true. */
      cadence: 'Uber wires on a Monday, settling the Monday-to-Sunday week that ended the day '
        + 'before. The amount is close to that Monday’s opening balance and is not reliably '
        + 'equal to it: over the three Ecosine Mondays measured so far the wire was 18.68 '
        + 'above the opening balance, exactly equal to it, and 100.26 below it.' },
    { platform: 'bolt', publishes: true,
      how: 'Bolt’s fleet portal lists every payout with the second it completed, so each '
        + 'row is already a date.',
      cadence: 'One payout per date, with no fixed weekday. Bolt does not say which period a '
        + 'payout settles, so nothing here claims one.' },
    { platform: 'yango', publishes: false,
      how: null,
      why_absent: 'Yango does not publish a transfer to the company at all. Its park ledger is a '
        + 'driver-account ledger: the only categories that mention a bank sit in a group Yango '
        + 'names "Payouts from account balance to contractors" — the park paying its own '
        + 'drivers — and none of them has ever carried a row for this park. What Yango does '
        + 'give, dated to the second, is what it collected and what it charged; that is on the '
        + 'daily movement below, and it is not a transfer.' },
  ];

  /* ── every transfer, one row each ──────────────────────────────────────── */
  app.get('/api/finance/payouts', wrap(async (req, res) => {
    const [from, to, platform, fleet] = range(req);
    const p = [from, to, platform, fleet];

    const payouts = await q(
      `SELECT platform, fleet_id, paid_on, amount, currency,
              period_start, period_end, method, source, payout_ext_id
         FROM platform_payout
        WHERE paid_on BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR platform = $3)
          AND ($4::text IS NULL OR fleet_id = $4)
        ORDER BY paid_on DESC, platform, fleet_id`, p);

    /* Per platform and fleet, so a page can say "Uber paid Ecosine this much
       on these dates" without summing across two businesses that keep separate
       bank accounts. */
    const totals = await q(
      `SELECT platform, fleet_id, currency,
              count(*)::int AS transfers,
              count(DISTINCT paid_on)::int AS dates,
              round(sum(amount)::numeric, 2) AS total,
              min(paid_on) AS earliest,
              max(paid_on) AS latest
         FROM platform_payout
        WHERE paid_on BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR platform = $3)
          AND ($4::text IS NULL OR fleet_id = $4)
        GROUP BY 1, 2, 3
        ORDER BY 1, 2`, p);

    /* THE WHOLE HISTORY, not the window. A page whose window is the last thirty
       days shows two Uber transfers, and "two transfers" is a fact about the
       window rather than about the provider — so the span the record actually
       covers travels beside it, and the page can say "the record runs from
       2024-12-23" instead of implying the provider started last month. */
    const span = await q(
      `SELECT platform, fleet_id, min(paid_on) AS earliest, max(paid_on) AS latest,
              count(*)::int AS transfers
         FROM platform_payout
        WHERE ($1::text IS NULL OR platform = $1)
          AND ($2::text IS NULL OR fleet_id = $2)
        GROUP BY 1, 2`, [platform, fleet]);

    /* The provider's own daily movement, which is what makes a transfer
       checkable rather than merely stated: a wire of 111,179.66 means nothing
       alone and means a great deal beside the opening balance of the day it
       left on. basis says whether the provider published the row (statement)
       or we summed it from that provider's dated rows (ledger) — a distinction
       the page must keep, because only the first can be checked against
       itself. */
    const days = await q(
      `SELECT platform, fleet_id, day, basis, currency,
              opening_balance, closing_balance, earnings, refunds_expenses,
              cash_collected, bank_transferred, commission, tips, taxes
         FROM platform_account_day
        WHERE day BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR platform = $3)
          AND ($4::text IS NULL OR fleet_id = $4)
        ORDER BY day DESC, platform, fleet_id`, p);

    /* WHAT WE HOLD PER PROVIDER, next to what the provider publishes.
       ────────────────────────────────────────────────────────────────────
       The combination is the whole point. A provider that publishes transfers
       and has none stored is a COLLECTION problem; a provider that publishes
       none and has none stored is a fact about the provider; and rendering the
       two the same way — an empty row, or worse a zero — is how this product
       would start lying. Each gets its own sentence below. */
    const anyFor = (plat) => totals.some((t) => t.platform === plat)
      || span.some((s) => s.platform === plat);
    const coverage = PROVIDERS
      .filter((prov) => !platform || prov.platform === platform)
      .map((prov) => ({
        platform: prov.platform,
        publishes_payouts: prov.publishes,
        how: prov.how,
        cadence: prov.cadence || null,
        in_window: totals.filter((t) => t.platform === prov.platform),
        record_span: span.filter((s) => s.platform === prov.platform),
        /* The sentence the page prints where a figure would go. Never "0" and
           never "no data": both of those are answers, and the honest answer
           here is a reason. */
        absent: prov.publishes
          ? (anyFor(prov.platform)
            ? null
            : 'No transfer has been collected from this provider yet. It does publish them, so '
              + 'this is a gap in collection rather than a fact about the provider — check '
              + 'the credential for this platform on the Sources page.')
          : prov.why_absent,
      }));

    res.json({
      window: [from, to],
      filters: { platform, fleet },
      payouts,
      totals,
      days,
      coverage,
      /* Said in the response rather than left to the page to remember. The
         figure #reconcile calls "bank payout" is not this, and a reader who
         has both open needs to be told so by the API.

         THE OLD NOTE ENDED "measured 7.1% higher on the one week both were
         checked", AND THAT WAS A WRONG-WEEK COMPARISON. See the retraction at
         the top of this file: 110,962.09 is the week 7–13 Sep and 103,567.54
         is the wire paid on 7 Sep, which settles 31 Aug – 6 Sep. The wire that
         settles 7–13 Sep is 111,179.66, paid on 14 Sep, and the difference is
         217.57 — 0.20%, not 7.1%. */
      note: 'A row here is a transfer that reached the company’s bank on the date beside '
        + 'it, taken from the provider’s own books. It is NOT the same figure as the "bank '
        + 'payout" on Bank reconciliation, which is the sum of what drivers earned over a '
        + 'period. The two are close where both are known: Uber’s Monday wire settles the '
        + 'Monday-to-Sunday week that ended the day before, and for the week 7–13 Sep 2026 '
        + 'our figure of AED 110,962.09 sits against the wire of AED 111,179.66 paid on '
        + 'Monday 14 Sep — a difference of AED 217.57, which is 0.20%. The 7.1% this note '
        + 'used to quote was a mistake of a different kind: it compared that week’s earnings '
        + 'against the wire paid on 7 Sep, which by the same cadence settles the PREVIOUS '
        + 'week, 31 Aug – 6 Sep.',
    });
  }));

  /* ═══════════════════════════════════════════════════════════════════════
     GET /api/finance/payouts/reconcile — each wire against our own figure.
     ═══════════════════════════════════════════════════════════════════════
     Read-only and fast. No live ask, no correlated read over `trip`: the
     comparison figure is sum(driver_payout_day.earnings) over the week the
     transfer settles, which is one lateral aggregate per payout row over a
     table indexed on (day).

     WHAT calculated IS AND IS NOT. It is the same quantity #reconcile calls
     bank_payout — what the drivers of this platform and fleet earned over
     those days, as the provider's own per-driver payout report states it. It
     is not a transfer and nobody should expect it to equal one to the fils;
     the interest is in the SIZE of the gap, and on the one week where both
     sides are known that gap is 217.57 on 111,179.66, which is 0.20%.

     WHERE THERE IS NO PERIOD THERE IS NO COMPARISON. Bolt publishes 175
     transfers and never says what any of them settles, so its rows carry
     calculated = null, delta = null, delta_pct = null and a
     calculated_basis that says which provider declined to state a period.
     That is absent with a reason. A zero there would read as "Bolt's drivers
     earned nothing that week", which is false, and it would then be summed. */
  app.get('/api/finance/payouts/reconcile', wrap(async (req, res) => {
    const [from, to, platform, fleet] = range(req);
    const p = [from, to, platform, fleet];

    const rows = await q(
      `SELECT p.platform, p.fleet_id,
              to_char(p.paid_on, 'YYYY-MM-DD')      AS paid_on,
              p.amount                              AS wire,
              to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(p.period_end, 'YYYY-MM-DD')   AS period_end,
              p.source,
              a.opening_balance,
              a.checked_at,
              p.audit_amount,
              p.audited_at,
              c.calculated,
              c.driver_days,
              c.days_with_rows,
              /* THE LENGTH OF THE PERIOD, READ RATHER THAN ASSUMED.
                 The basis sentence below used to say "N of 7 days carrying
                 rows". Seven is right for Uber's Mon-Sun week and is right by
                 accident: nothing in this query or in settlesWeek() promises a
                 seven-day period, and the first provider or cadence that
                 settles over a fortnight would make the sentence state a false
                 denominator while every number beside it stayed correct. */
              (p.period_end - p.period_start + 1)     AS period_days
         FROM platform_payout p
         /* The provider's own statement for the day the money left, where we
            hold one. LEFT, not INNER: a transfer we have and a statement we
            have not asked for is the ordinary state of the backfill — 4
            statement days stored for uber/ecosine on 2026-09-17 — and an inner
            join would silently DROP the wire rather than report it with an
            opening balance nobody has measured.

            The basis predicate cannot change the answer today, and it is here
            anyway: platform_account_day is keyed (platform, fleet_id, day), so
            at most one row can match and this cannot multiply a money row. It
            says which KIND of row may fill opening_balance. A 'ledger' row is
            a sum WE built from the provider's dated rows and has no provider
            balance in it; only a 'statement' row can be put beside a wire. If
            that key is ever relaxed, or a ledger row ever carries a balance,
            this line is the difference between a measured opening balance and
            one of our own sums presented as the provider's. */
         LEFT JOIN platform_account_day a
           ON a.platform = p.platform AND a.fleet_id = p.fleet_id
          AND a.day = p.paid_on AND a.basis = 'statement'
         /* Our own figure for the week this transfer settles. Guarded on
            period_start inside the lateral so a row with no period does no
            work at all — and so that a NULL coming back means one of two
            things, which the caller separates on period_start rather than
            guessing: no period was stated, or the period was stated and we
            hold no driver-day rows for it. */
         LEFT JOIN LATERAL (
           SELECT round(sum(d.earnings)::numeric, 2) AS calculated,
                  count(*)::int                      AS driver_days,
                  count(DISTINCT d.day)::int         AS days_with_rows
             FROM driver_payout_day d
            WHERE p.period_start IS NOT NULL
              AND d.platform = p.platform
              AND d.fleet_id = p.fleet_id
              AND d.day BETWEEN p.period_start AND p.period_end
         ) c ON TRUE
        WHERE p.paid_on BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR p.platform = $3)
          AND ($4::text IS NULL OR p.fleet_id = $4)
        ORDER BY p.paid_on DESC, p.platform, p.fleet_id`, p);

    const out = rows.map((row) => {
      const wire = r2(row.wire);
      const stated = row.period_start != null && row.period_end != null;
      const calculated = stated ? r2(row.calculated) : null;

      /* The reason, in plain English, in every one of the three states. The
         house rule is that a figure which cannot be measured renders absent
         WITH A REASON, and "no period" and "a period with nothing in it" are
         not the same reason. */
      let basis;
      if (!stated && row.platform !== 'uber') {
        basis = `${row.platform} does not state which period a transfer settles, so there is `
          + 'no window to sum our own figure over. Nothing is compared here, and that is not '
          + 'a difference of zero.';
      } else if (!stated) {
        /* UBER DOES STATE ITS PERIOD, SO THIS SENTENCE MUST NOT BE THE BOLT ONE.
           ───────────────────────────────────────────────────────────────────
           THE DEFECT, WHICH THIS FILE'S NEIGHBOUR ALREADY RECORDS. Uber's
           period is not published by Uber at all — it is DERIVED, by
           settlesWeek(), from the Monday cadence. So a stored Uber payout row
           can carry a NULL period for two reasons that have nothing to do with
           the provider being silent: the transfer was not on a Monday, or the
           row was written before settlesWeek()'s getUTCDay() bug was fixed,
           when EVERY Monday payout was stamped NULL
           (src/sources/uber_payout.js records that bug and its measurement).
           Nothing re-stamps those rows: missingDays() only asks days with no
           statement row, so a day already stored is never revisited.

           Printing Bolt's sentence over them would reproduce, word for word,
           the defect that comment calls "a sentence that is false for Uber and
           true for nobody". */
        basis = 'this Uber transfer carries no settled period. Uber does not publish one — it '
          + 'is derived from the Monday cadence — so either the transfer was not on a Monday, '
          + 'or the row predates the fix to that derivation and was stored without one. '
          + 'Nothing is compared here, and that is not a difference of zero.';
      } else if (calculated == null) {
        basis = `no driver_payout_day rows are stored for ${row.platform}/${row.fleet_id} `
          + `between ${row.period_start} and ${row.period_end}, so our own figure for the week `
          + 'this transfer settles has not been collected. The transfer is real; the thing to '
          + 'compare it against is missing.';
      } else {
        basis = `sum of driver_payout_day.earnings for ${row.platform}/${row.fleet_id} over `
          + `${row.period_start} to ${row.period_end} — ${row.days_with_rows} of `
          + `${row.period_days} days `
          + `carrying rows, ${row.driver_days} driver-days. This is the same quantity Bank `
          + 'reconciliation calls "bank payout"; it is what the drivers earned, not a transfer.';
      }

      /* delta is the WIRE MINUS OUR FIGURE, so a positive number means more
         money arrived than our register accounts for. Measured on the one week
         both sides are known: 111,179.66 - 110,962.09 = +217.57, 0.20%. */
      const delta = calculated == null ? null : r2(wire - calculated);
      const openingBalance = r2(row.opening_balance);
      return {
        platform: row.platform,
        fleet_id: row.fleet_id,
        paid_on: row.paid_on,
        wire,
        period_start: row.period_start,
        period_end: row.period_end,
        calculated,
        calculated_basis: basis,
        delta,
        delta_pct: (delta == null || !wire) ? null : r2((delta / wire) * 100),
        opening_balance: openingBalance,
        /* The wire against the opening balance of the day it left on, WITHOUT
           the claim that they should match. Three measured Ecosine Mondays:
           +18.68, 0.00, -100.26. Null where no statement has been collected
           for that day — which is a day nobody asked about, not a balance of
           zero. */
        balance_delta: openingBalance == null ? null : r2(wire - openingBalance),
        /* NULL means nobody has ever asked the provider live about this day.
           sql/schema_v74.sql declares the column with no default for exactly
           that reason: a default would quietly assert that the nightly
           backfill is a human check. */
        checked_at: row.checked_at ?? null,
        source: row.source,
      };
    });

    /* TOTALS OVER TWO DIFFERENT POPULATIONS, SAID OUT LOUD.
       wire totals every transfer in the window. calculated and delta can only
       cover the rows that name a period, so they are summed over those rows
       alone and the wire for THOSE rows is carried beside them — otherwise a
       reader subtracts calculated from the wire total and gets the Bolt
       transfers as a phantom discrepancy. */
    const comparable = out.filter((x) => x.calculated != null);
    const sum = (xs, k) => r2(xs.reduce((a, x) => a + Number(x[k] || 0), 0));
    const totals = {
      wire: sum(out, 'wire'),
      calculated: comparable.length ? sum(comparable, 'calculated') : null,
      delta: comparable.length ? sum(comparable, 'delta') : null,
      wire_comparable: comparable.length ? sum(comparable, 'wire') : null,
      rows: out.length,
      comparable_rows: comparable.length,
      basis: comparable.length === out.length
        ? 'Every transfer in this window names the period it settles, so the wire total and '
          + 'the calculated total cover the same rows.'
        : `wire totals all ${out.length} transfers in this window. calculated and delta cover `
          + `only the ${comparable.length} that name a period AND have driver-day rows stored `
          + 'for it; wire_comparable is the wire over those same rows, and it is the figure to '
          + 'subtract calculated from. Subtracting calculated from wire would compare two '
          + 'different populations.',
    };

    /* THE DAYS NOBODY HAS ASKED ABOUT.
       ────────────────────────────────────────────────────────────────────
       This is the half of the answer that stops the register being read as
       exhaustive. Uber's statement is a per-day document and the backfill is
       bounded at 24 days per fleet per run, so on any given day most of the
       history has simply not been requested yet — 4 statement days stored for
       uber/ecosine on 2026-09-17, against a record that should run to
       hundreds. A day with no statement row is a day with NO MEASUREMENT, and
       rendering it as a day with no transfer would manufacture the absence of
       a wire out of the absence of a request.

       Uber only: it is the one provider here that publishes a per-day
       statement. Bolt publishes transfers and no daily account, and Yango
       publishes no transfer at all — neither of those is a day somebody failed
       to ask about, and listing them here would turn a fact about the provider
       into a backlog.

       Bounded at yesterday, on the fleet's calendar: today is still in
       progress, Uber would answer with a partial statement, and
       src/sources/uber_payout.js missingDays() excludes it for the same
       reason. */
    const gaps = await q(
      `WITH pairs AS (
         SELECT 'uber'::text AS platform, f.id AS fleet_id
           FROM fleet f
          WHERE ($3::text IS NULL OR $3 = 'uber')
            AND ($4::text IS NULL OR f.id = $4)
       ), asked AS (
         SELECT generate_series(
                  $1::date,
                  LEAST($2::date, (now() AT TIME ZONE 'Asia/Dubai')::date - 1),
                  interval '1 day')::date AS d
       )
       /* AND WHICH KIND OF ABSENCE EACH ONE IS.
          ────────────────────────────────────────────────────────────────────
          Until sql/schema_v75.sql there was no way to tell a day nobody had
          asked about from a day Uber had been asked about and has nothing for,
          so this panel had to say "either nobody asked, or the ask was
          refused" about every one of them. True, and blunt: an operator
          looking at 390 days cannot act on it, because most of them may be
          days before the fleet existed.

          payout_ask records what came back. 'empty' means Uber answered and
          holds no statement for that date — settled, and STILL not a day with
          no transfer. 'refused' means nothing was learned and the day is
          genuinely outstanding. A day with no ask row at all has never been
          put to Uber. */
       SELECT pr.platform, pr.fleet_id, to_char(a.d, 'YYYY-MM-DD') AS day,
              k.outcome AS ask_outcome
         FROM pairs pr
        CROSS JOIN asked a
         LEFT JOIN platform_account_day s
           ON s.platform = pr.platform AND s.fleet_id = pr.fleet_id
          AND s.day = a.d AND s.basis = 'statement'
         LEFT JOIN payout_ask k
           ON k.platform = pr.platform AND k.fleet_id = pr.fleet_id AND k.day = a.d
        WHERE s.day IS NULL
        ORDER BY pr.platform, pr.fleet_id, a.d`, p);

    const byPair = new Map();
    for (const g of gaps) {
      const k = `${g.platform}:${g.fleet_id}`;
      if (!byPair.has(k)) {
        byPair.set(k, { platform: g.platform, fleet_id: g.fleet_id, days: [], empty_days: [] });
      }
      /* A day Uber has answered about and has nothing for is NOT outstanding
         work. It is kept, separately and counted, because it is still a day
         with no statement and must never be read as a day with no transfer —
         but it does not belong in the list an operator is asked to act on. */
      if (g.ask_outcome === 'empty') byPair.get(k).empty_days.push(g.day);
      else byPair.get(k).days.push(g.day);
    }
    const unchecked = [...byPair.values()].map((u) => ({
      ...u,
      count: u.days.length,
      /* Counted and named, not silently folded into the number above. A fleet
         whose 390 "unasked" days turn out to be 12 outstanding and 378 that
         Uber has already said it holds nothing for is a fleet in a completely
         different state, and the operator cannot see that from one total. */
      empty_count: u.empty_days.length,
      empty_why: u.empty_days.length
        ? `Uber has been asked about ${u.empty_days.length} further days in this window and `
          + 'answered that it holds no statement for them — days before this fleet was earning '
          + 'on Uber, or gaps in the provider\u2019s own record. They are settled and are not '
          + 'asked again. They are still days with no statement, so they are still not days '
          + 'with no transfer.'
        : null,
      /* "NOBODY HAS ASKED" WAS NOT THE TRUE REASON, AND THIS CHANGE'S OWN
         MEASUREMENT DISPROVES IT.
         ──────────────────────────────────────────────────────────────────────
         This sentence used to end "so nobody has asked". A day that WAS asked
         and came back throttled or empty also leaves no row, and that is not a
         hypothetical: on the night of 2026-09-16 the walk asked eight days for
         ecosine and stored four, because Uber's report limiter shut. Those four
         refused days would have been reported to an operator as days nobody
         asked about. The house rule is not "give a reason", it is never give a
         reason that is not the true one — so the sentence now names both ways a
         day ends up here and claims neither. */
      why: `Uber publishes a one-day organisation statement for ${u.fleet_id} and we hold no `
        + `statement for these ${u.days.length} days — either nobody asked, or the ask was `
        + 'refused (Uber\u2019s report limiter shuts for minutes at a time and cut the walk of '
        + '2026-09-16 to four of the eight days it asked for). Either way it is a day with no '
        + 'measurement, and a day with no measurement cannot be reported as a day with no '
        + 'transfer. The nightly walk fills them Mondays first and oldest first behind them, '
        + 'bounded per run; POST /api/finance/payouts/verify asks for up to five named days '
        + 'now. Today is excluded because the Dubai day is still in progress.',
    }));

    /* WHAT THE TRANSACTION REPORT HAS CHECKED, AND OVER WHICH MONTHS.
       ────────────────────────────────────────────────────────────────────
       The register is built by asking Mondays first, so it cannot prove a wire
       never landed on a Thursday — every one of the twenty payout dates found
       across seventeen months IS a Monday, which makes the cadence very likely
       and not checked. sql/schema_v76.sql records which windows
       REPORT_TYPE_PAYMENTS_ORDER has been read over; that report is per
       transaction and dated row by row, so a window it has read is a window
       where no wire can have been missed whatever weekday it fell on.

       A period with no audit row is NOT a period with no missed wires, and the
       page must be able to say which of the two it is looking at. */
    const audit = await q(
      `SELECT platform, fleet_id,
              to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end, 'YYYY-MM-DD')   AS period_end,
              wires_found, wires_new, detail, audited_at
         FROM payout_audit
        WHERE outcome = 'audited'
          AND period_end >= $1::date AND period_start <= $2::date
          AND ($3::text IS NULL OR $3 = 'uber')
          AND ($4::text IS NULL OR fleet_id = $4)
        ORDER BY period_start DESC`, p);

    /* The wires the two Uber reports disagree about — the one thing here
       nobody should have to go looking for. NOT resolved: the row carries both
       figures, because deciding by writing order would destroy the only
       evidence that they differ. */
    const disagree = out.filter((r) => r.audit_amount != null
      && Math.abs(Number(r.audit_amount) - Number(r.wire)) >= 0.01)
      .map((r) => ({ platform: r.platform, fleet_id: r.fleet_id, paid_on: r.paid_on,
        register: r.wire, transaction_report: Number(r.audit_amount),
        difference: Math.round((Number(r.audit_amount) - Number(r.wire)) * 100) / 100 }));

    const auditedDays = audit.reduce((a, w) => a
      + Math.round((Date.parse(`${w.period_end}T12:00:00Z`)
        - Date.parse(`${w.period_start}T12:00:00Z`)) / 864e5) + 1, 0);

    res.json({
      window: [from, to],
      /* THE APPLIED FILTER TRAVELS WITH THE ANSWER, AND IT IS NOT DECORATION.
         ────────────────────────────────────────────────────────────────────
         THE DEFECT. `unchecked` is Uber-only by construction — Uber is the one
         provider with a per-day statement to be missing. The page sends the
         global platform chip on every call, so with the chip on Bolt or Yango
         this array came back EMPTY, and the panel read "Every day in this
         window has an Uber statement stored against it, so there is no day here
         that nobody asked about." On production that sentence is false for
         about twenty-six days per fleet. It is the exact inversion the panel
         exists to prevent, produced by a filter the page could not see it had
         applied. Now it can. */
      filters: { platform, fleet },
      rows: out,
      totals,
      unchecked,
      audit: {
        windows: audit,
        audited_days: auditedDays,
        wires_the_audit_added: audit.reduce((a, w) => a + (w.wires_new || 0), 0),
        disagreements: disagree,
        means: audit.length
          ? 'Each window here has been read from Uber’s per-transaction payments report, '
            + 'where every row carries its own date — so within these dates no transfer can '
            + 'have been missed, on any weekday. Outside them the register was built by '
            + 'asking the days most likely to carry a wire, and that is a strong expectation '
            + 'rather than a check.'
          : 'No window has been checked against the per-transaction report yet, so every '
            + 'transfer here rests on the register having asked the right days. Every payout '
            + 'date found so far is a Monday, which is why the walk asks Mondays first — and '
            + 'why the walk cannot itself be the thing that proves a Thursday was clear.',
      },
      note: 'Each row is one transfer that reached the bank, beside our own figure for the '
        + 'week that transfer settles — sum(driver_payout_day.earnings), which is what Bank '
        + 'reconciliation calls "bank payout". delta is the wire MINUS our figure, so a '
        + 'positive delta means more money arrived than our register accounts for. On the one '
        + 'week where both sides are known, Ecosine 7–13 Sep 2026: ours 110,962.09, wire '
        + '111,179.66 paid on Monday 14 Sep, delta +217.57 — 0.20%. balance_delta puts the '
        + 'wire against the opening balance of the day it left on; over three measured Ecosine '
        + 'Mondays that was +18.68, 0.00 and -100.26, so it is a difference to look at and not '
        + 'a check that should come out at zero. Where a provider states no period there is no '
        + 'comparison and the row says so instead of showing a zero. unchecked names the days '
        + 'nobody has asked Uber about, which are not days without a transfer.',
    });
  }));

  /* ═══════════════════════════════════════════════════════════════════════
     POST /api/finance/payouts/verify — ask Uber LIVE, one named day at a time.
     ═══════════════════════════════════════════════════════════════════════
     body: { fleet: "ecosine"|"egari", days: ["YYYY-MM-DD", ...] }   1..5 days

     WHY THIS EXISTS. The register is filled by a nightly walk that is bounded
     at 24 days per fleet per run and was cut to 4 by Uber's limiter on the
     night of 2026-09-16. Monday 2026-09-14 — the wire of 111,179.66 that
     settles the week the Payouts page is asked about most — was the 25th
     missing day in ecosine's queue, one past the budget, so neither that run
     nor the next could have reached it. An operator who needs that one day
     should not have to wait for a backfill to walk to it.

     WHAT IT COSTS, AND WHY THE CAP IS FIVE. One report is 10–40 seconds when
     the limiter is open. Five is about three minutes of walking, which fits
     inside a request and inside a person's patience, and it is well under the
     three concurrent reports that shut the limiter for minutes.

     EVERY REFUSAL IS BY NAME, WITH THE TRUE REASON. More than five days
     refuses the whole request rather than asking the first five, because
     answering about five of six days under a request that named six reads as
     "we checked everything". A malformed date is refused here and never sent
     to the provider: Uber answers a bad date with a report for some other day
     or an error that reads like a refusal, and neither is a fact about the day
     that was asked for.

     NEVER CACHED. api/cache.js only ever caches GET, so a POST cannot be
     served from it. The answer is also self-sufficient on purpose — it carries
     the wire, our figure, the delta and the balance check for every day it
     asked about — so a page has no reason to immediately re-read
     /api/finance/payouts/reconcile, which IS cached against a data version
     that a verify does not move. */
  app.post('/api/finance/payouts/verify', wrap(async (req, res) => {
    /* Belt and braces against an intermediary. The process cache never touches
       a POST; a proxy or a browser might. */
    res.set('Cache-Control', 'no-store');

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const fleet = String(body.fleet || '').trim();
    const asked = Array.isArray(body.days) ? body.days.map((d) => String(d).trim()) : null;
    const askedAt = new Date().toISOString();
    /* One shape for every answer this route gives, refusals included, so a
       page renders a refusal with the same code that renders a result. */
    const envelope = (extra) => ({
      platform: 'uber', fleet: fleet || null, asked_at: askedAt,
      days: [], refused: [], ...extra,
    });

    if (!FLEETS.includes(fleet)) {
      return res.status(400).json(envelope({
        error: `"${fleet || '(none)'}" is not a fleet this dashboard holds. The fleets are `
          + `${FLEETS.join(' and ')}, and this route will not answer about one fleet under `
          + 'the name of another.',
      }));
    }
    if (!asked || !asked.length) {
      return res.status(400).json(envelope({
        error: 'no days were named. This route asks Uber about days somebody chose; it does '
          + 'not pick them, because a day picked here would be asked against a limiter that '
          + 'the nightly backfill is already spending.',
      }));
    }
    if (asked.length > MAX_DAYS) {
      /* Refused ENTIRELY and named day by day. Truncating to five would answer
         a question nobody asked and look like the question they did. */
      return res.status(400).json(envelope({
        error: `this named ${asked.length} days and the cap is ${MAX_DAYS}. The request is `
          + 'refused rather than truncated: answering about the first five under a request '
          + 'that named more reads as "we checked everything". Ask again with at most '
          + `${MAX_DAYS} days.`,
        refused: asked.map((day) => ({
          day,
          why: `not asked — the request named ${asked.length} days and one request may ask `
            + `for ${MAX_DAYS}. Uber's payment-report limiter shuts for minutes after about `
            + 'three reports in flight, so this route walks one day at a time and bounds how '
            + 'long one request may hold that queue.',
        })),
      }));
    }

    /* Per-day refusals. These do not refuse the request: the well-formed days
       in it are still asked, and each bad one is named beside them. */
    const refused = [];
    const todo = [];
    const seen = new Set();
    const today = dubaiToday();
    for (const day of asked) {
      if (!isDay(day)) {
        refused.push({ day, why: 'not a date in YYYY-MM-DD form, so it was not sent to Uber. '
          + 'A malformed date does not come back as a refusal — it comes back as a report for '
          + 'some other day, or as an error that reads like one, and neither is a fact about '
          + 'the day that was meant.' });
      } else if (seen.has(day)) {
        refused.push({ day, why: 'named twice in one request. It is asked once — a second '
          + 'report for the same day would spend the limiter to return the same row.' });
      } else if (day >= today) {
        refused.push({ day, why: `the Dubai day ${day} is not finished (today is ${today}). `
          + 'Uber would answer with a partial statement, and storing a partial as a final one '
          + 'would make the nightly walk skip this day for ever, because it only asks for days '
          + 'with no statement row at all.' });
      } else {
        seen.add(day);
        todo.push(day);
      }
    }

    if (!todo.length) {
      return res.json(envelope({
        refused,
        note: 'Nothing was asked of Uber: every day in this request was refused, for the '
          + 'reason beside it. No figure here is zero — there is no figure.',
      }));
    }

    const org = await uber.orgFor(fleet);
    if (!org) {
      return res.status(400).json(envelope({
        refused: todo.map((day) => ({
          day, why: `no Uber organisation is configured for the ${fleet} fleet, so there is `
            + 'no credential to ask with. This route will not fall back to the other fleet: an '
            + 'answer about Ecosine under a request naming Egari is worse than no answer.',
        })).concat(refused),
        error: `no Uber organisation is configured for the ${fleet} fleet — it has no org uuid `
          + 'and web session pair. Set it on the Sources page; nothing was asked of Uber.',
      }));
    }

    if (inFlight) {
      return res.status(409).json(envelope({
        refused: todo.map((day) => ({ day, why: 'not asked — another live ask was already '
          + 'running.' })).concat(refused),
        error: `a live ask is already running (${inFlight}). Uber's payment-report limiter `
          + 'shuts for minutes once about three reports are in flight, so this process runs '
          + 'one ask at a time. Nothing was asked of Uber. Try again when it finishes. '
          + 'NOTE, because a guard that overstates its reach is worse than none: this flag '
          + 'covers THIS API process only. The nightly collector walks up to 24 one-day '
          + 'reports per fleet at 21:00 UTC against the same limiter and neither side can see '
          + 'the other — an ask pressed during that window competes with it, which is what '
          + 'cut the walk of 2026-09-16 to four of eight days.',
      }));
    }
    inFlight = `${fleet}: ${todo.join(', ')} since ${askedAt}`;

    const out = [];
    try {
      /* STRICTLY SEQUENTIAL. A for..of with an await inside, never
         Promise.all: three of these fired together is the exact shape that
         came back "Payment report generation limit reached" and then refused
         even a single request for several minutes. */
      const startedAt = Date.now();
      for (const day of todo) {
        /* THE CLOCK, CHECKED BEFORE THE ASK AND NOT AFTER IT. Asking and then
           discovering there is no time to answer spends a report slot for
           nothing; the days not reached are reported as not reached. */
        /* >= AND NOT >, WHICH IS THE DIFFERENCE BETWEEN A RULE AND A RULE
           WITH ONE EXCEPTION. With `>` the first day is always asked before
           the clock is ever consulted, because elapsed is 0 at that point —
           harmless in production, where the budget is 240 s and the first day
           obviously fits, and fatal to the only test that can drive this
           without waiting four minutes: a zero budget still spent a report
           slot. `>=` makes the sentence "if the time spent has reached the
           budget, stop" true without an exception, and production behaviour is
           unchanged: 0 >= 240000 is false, so the first day is still asked. */
        if (Date.now() - startedAt >= requestBudgetMs()) {
          const left = todo.slice(todo.indexOf(day));
          for (const d of left) {
            refused.push({ day: d,
              why: `not asked — this request had used ${Math.round((Date.now() - startedAt) / 1000)}s `
                + `of its ${Math.round(requestBudgetMs() / 1000)}s budget and the platform closes `
                + 'a request at 300s. Nothing was asked of Uber for this day and nothing was '
                + 'stored for it, so it is still an unasked day. Ask again and it will be '
                + 'picked up; the days above this one are already stored.' });
          }
          break;
        }
        /* Read BEFORE the ask. stored_before is what the register held at the
           moment the operator pressed the button, and it is the only way the
           answer can say "this day was already stored and Uber now says
           something different" rather than silently overwriting. */
        const [before] = await q(
          `SELECT round(sum(pp.amount)::numeric, 2) AS wire,
                  EXISTS (SELECT 1 FROM platform_account_day s
                           WHERE s.platform = 'uber' AND s.fleet_id = $1
                             AND s.day = $2::date AND s.basis = 'statement') AS had_statement
             FROM platform_payout pp
            WHERE pp.platform = 'uber' AND pp.fleet_id = $1 AND pp.paid_on = $2::date`,
          [fleet, day]);
        const storedBefore = {
          wire: r2(before?.wire),
          had_statement: Boolean(before?.had_statement),
        };

        /* live: true is what makes oneDay() stamp platform_account_day
           .checked_at. The nightly walk omits the column entirely, so a day a
           person verified keeps its verification when a later backfill
           re-stores the row — see sql/schema_v74.sql. */
        let r;
        try {
          r = await uber.oneDay(org, day, { live: true });
        } catch (e) {
          /* A throw here is a network or parse failure, not a provider
             refusal, and it must not abandon the other four days. The reason
             is the one that actually happened. */
          r = { why: `the ask failed before Uber answered: ${String(e).slice(0, 200)}` };
        }

        const base = {
          day,
          asked: true,
          uber: null,
          wire: null,
          settles: null,
          stored_before: storedBefore,
          calculated: null,
          delta: null,
          balance_check: null,
          stored: false,
          why: null,
        };

        if (!r || !r.row) {
          /* THE FAILURE PATH. Every number stays null and `why` carries the
             true reason, which is not interchangeable: "the limiter is shut"
             is a fact about this minute and "Uber has no statement for this
             day" is a fact about the day, and only one of them can be true at
             a time. A zero here would be a wire that never happened. */
          out.push({ ...base,
            why: r?.throttled
              ? 'Uber’s payment-report limiter is shut — it refuses new reports for several '
                + 'minutes once about three are in flight. This is a fact about right now and '
                + `not about ${day}; nothing was learned and nothing was stored. Uber said: `
                + `${String(r.why || '').slice(0, 180)}`
              : String(r?.why || 'the ask returned no row and gave no reason, which is itself '
                + 'the finding — nothing about this day was learned').slice(0, 400) });
          continue;
        }

        const row = r.row;
        const bank = row.bank_transferred;
        /* wire is the ABSOLUTE value of bank_transferred. Uber signs it
           negative because from the account's point of view the money leaves.
           A MEASURED ZERO IS KEPT AS ZERO: Uber leaves the cell blank on a day
           it did not wire and the mapper maps a blank cell to 0, which is a
           measurement. null here means the column was absent from the report
           altogether, which is not. */
        const wire = bank == null ? null : Math.abs(r2(bank));
        const isTransfer = wire != null && wire > 0.005;

        /* The week this wire settles, from the same pure function the
           collector stamps onto the stored payout row — so the page and the
           table cannot disagree about it. Only Monday is proven; any other
           weekday gets a stated absence rather than an invented span. */
        const week = settlesWeek(day);
        let settles = null;
        if (isTransfer) {
          settles = week.period_start ? {
            period_start: week.period_start,
            period_end: week.period_end,
            /* TWO CLAIMS, AND ONLY ONE OF THEM IS MEASURED. This sentence used
               to attribute BOTH the weekday and the settled week to the five
               one-day reports. Those reports show which weekday the bank column
               is populated on; they say nothing about which week the money
               covers. The only evidence ever offered for the PERIOD was the
               identity wire(N) = closing balance(N-1), and this same change
               retracts that as holding on one Monday in three. So the weekday
               is stated as measured, the period as derived and unconfirmed, and
               the reader is told which is which. */
            basis: 'Uber wires on a MONDAY — measured, over five consecutive one-day reports '
              + 'whose bank column was populated on the Monday and empty on every other day. '
              + 'That the wire settles the Monday-to-Sunday week which ended the day before is '
              + 'DERIVED from that cadence and is not separately measured: the identity that '
              + 'would confirm it, the wire equalling the previous week\u2019s closing balance, '
              + 'holds on one of the three Mondays checked (18.68 above, exact, 100.26 below). '
              + 'Treat the period as this product\u2019s inference, not as Uber\u2019s statement.',
          } : {
            period_start: null,
            period_end: null,
            basis: `Uber transferred on ${day}, which is not a Monday. The Monday cadence is `
              + 'the only one measured here, so the week this settles is left unstated rather '
              + 'than invented.',
          };
        }

        let calculated = null;
        let delta = null;
        /* A TRANSFER WITH NO DERIVED PERIOD STILL OWES THE READER A REASON.
           ──────────────────────────────────────────────────────────────────
           THE DEFECT. This read `if (isTransfer && week.period_start)` and
           nothing else, so a real wire on a non-Monday came back with a wire of
           real money beside calculated: null carrying NO basis — and the page,
           finding no reason, fell through to its own default and printed "no
           transfer left on this day" in the row's Our-figure cell, next to a
           wire cell showing the money. Two cells of one row contradicting each
           other, and the printed reason the opposite of the truth. The reason
           already exists one block above, on settles.basis; it just was not
           carried across. */
        if (isTransfer && !week.period_start) {
          calculated = { value: null, driver_days: null, basis: settles.basis };
        }
        if (isTransfer && week.period_start) {
          const [c] = await q(
            `SELECT round(sum(d.earnings)::numeric, 2) AS value,
                    count(*)::int              AS driver_days,
                    count(DISTINCT d.day)::int AS days_with_rows
               FROM driver_payout_day d
              WHERE d.platform = 'uber' AND d.fleet_id = $1
                AND d.day BETWEEN $2::date AND $3::date`,
            [fleet, week.period_start, week.period_end]);
          const value = r2(c?.value);
          calculated = value == null ? {
            value: null,
            basis: `no driver_payout_day rows are stored for uber/${fleet} between `
              + `${week.period_start} and ${week.period_end}, so there is nothing to compare `
              + 'this wire against yet. The transfer is real; our side of it is missing.',
            driver_days: null,
          } : {
            value,
            basis: `sum of driver_payout_day.earnings for uber/${fleet} over `
              + `${week.period_start} to ${week.period_end} — ${c.days_with_rows} of `
              + `${weekDays(week)} days `
              + `carrying rows, ${c.driver_days} driver-days. The same quantity Bank `
              + 'reconciliation calls "bank payout": what the drivers earned, not a transfer.',
            driver_days: c.driver_days,
          };
          if (value != null) {
            const d = r2(wire - value);
            delta = { value: d, pct: wire ? r2((d / wire) * 100) : null };
          }
        }

        /* THE BALANCE CHECK REPORTS A DIFFERENCE. IT DOES NOT ASSERT AN
           EQUALITY. The claim this replaces — "the transfer equals the
           previous week's closing balance to the fils, proven over two
           consecutive weeks" — holds on one of the three Ecosine Mondays that
           are now measurable. */
        const opening = r2(row.opening_balance);
        const balanceCheck = (isTransfer && opening != null) ? {
          opening_balance: opening,
          wire,
          difference: r2(wire - opening),
          note: 'The wire against the opening balance of the day it left on, as a difference '
            + 'and not as a check. Measured on three Ecosine Mondays: 2026-08-17 the wire was '
            + '18.68 ABOVE the opening balance, 2026-09-07 the two were identical, 2026-09-14 '
            + 'the wire was 100.26 BELOW it. A non-zero difference here is normal.',
        } : null;

        out.push({ ...base,
          uber: {
            opening_balance: r2(row.opening_balance),
            closing_balance: r2(row.closing_balance),
            earnings: r2(row.earnings),
            refunds_expenses: r2(row.refunds_expenses),
            cash_collected: r2(row.cash_collected),
            bank_transferred: r2(row.bank_transferred),
            tips: r2(row.tips),
            taxes: r2(row.taxes),
          },
          wire,
          settles,
          calculated,
          delta,
          balance_check: balanceCheck,
          stored: Boolean(r.stored),
          /* A successful ask that could not be written is not a success, and
             the row says which of the two happened. */
          why: r.stored ? null
            /* The DATABASE's own words where there are any. src/sources/uber_payout.js
               now catches its write errors and returns writeWhy rather than
               throwing, precisely so this row can say which half failed: the
               ask reached Uber, a report slot was spent, and the figures above
               are real — it is the register that did not take them. The most
               likely cause is the ordinary deploy order, an API that writes
               checked_at restarting a moment before sql/schema_v74.sql has
               replayed, which is exactly when somebody presses this button. */
            : (r.writeWhy
              || 'Uber answered and the statement row was not written — the figures above are '
                + 'what Uber said and they are not in the register.'),
        });
      }
    } finally {
      /* Released whatever happened. A flag left set by a throw would wedge
         this route shut until the process restarted, which is a worse failure
         than the concurrent ask it exists to prevent. */
      inFlight = null;
    }

    res.json({
      platform: 'uber',
      fleet,
      asked_at: askedAt,
      days: out,
      refused,
      note: 'Each row here is Uber’s own organisation payment statement for one named day, '
        + 'asked live just now, one day at a time — Uber’s report limiter shuts for minutes '
        + 'once about three reports are in flight. wire is the absolute value of Uber’s '
        + '"Payouts : Transferred To Bank Account", which Uber signs NEGATIVE because from '
        + 'the account’s point of view the money leaves; a wire of 0 means Uber left the cell '
        + 'blank, which is a measured day with no transfer, while null means the column was '
        + 'not in the report at all. calculated is OUR figure for the week the wire settles — '
        + 'sum(driver_payout_day.earnings), what Bank reconciliation calls "bank payout" — and '
        + 'delta is the wire minus it, positive when more money arrived than our register '
        + 'accounts for. It is not a balancing figure: these are different events, and the '
        + 'only week where both sides are known differs by 0.20%. balance_check is a '
        + 'difference, not an equality test. A day that could not be asked carries its reason '
        + 'and no numbers at all.',
    });
  }));
}
