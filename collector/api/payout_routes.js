/* THE PAYOUT REGISTER — what each platform actually transferred, by date.
   ─────────────────────────────────────────────────────────────────────────
   Finance already has five pages and none of them holds a transfer. #reconcile
   compares a month's "bank payout" against what the statements say was owed,
   and its bank payout is driver_payout_day.earnings summed by month — Uber's
   weekly PER-DRIVER earnings, spread across the days they were earned. That is
   a real quantity and it is not a wire. On the one week both were measured
   (Ecosine, Mon 7 – Sun 13 Sep 2026) the dashboard says 110,962.09 and Uber's
   own books say the transfer was 103,567.54, 7.1% apart, describing different
   events.

   This route answers the narrower question the operator actually asked: how
   much money reached the company's account, and on exactly which date. It
   answers it only where a provider publishes it, and where a provider does not
   it says which provider, and why, in the provider's own terms.

   THE THREE ANSWERS ARE DIFFERENT IN KIND, and the response keeps them apart:

     uber   the transfer, dated exactly. REPORT_TYPE_PAYMENTS_ORGANIZATION over
            a ONE-DAY window carries `Payouts : Transferred To Bank Account`,
            empty on a day with no transfer. Uber wires on Monday, settling the
            Mon–Sun week that ended the day before.
     bolt   the transfer, dated exactly. /fleetOwnerPortal/getPayouts, one row
            per payout with `finished` as a unix second. 89 payouts over 89
            distinct days for Ecosine back to 2024-12-30.
     yango  NOT PUBLISHED. The Fleet API's park ledger is a DRIVER-account
            ledger: the three categories that mention a bank are in a group
            Yango itself names "Payouts from account balance to contractors",
            which is the park paying its drivers. None of them carries a row.
            So Yango appears here with no payout total and a reason, and never
            with a zero. */
export function payoutRoutes(app, { q, wrap, range }) {
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
      cadence: 'Uber wires on a Monday, settling the Monday-to-Sunday week that ended the day '
        + 'before — proven over two consecutive weeks: the transfer equals the previous '
        + 'week’s closing balance to the fils.' },
    { platform: 'bolt', publishes: true,
      how: 'Bolt’s fleet portal lists every payout with the second it completed, so each '
        + 'row is already a date.',
      cadence: 'One payout per date, with no fixed weekday.' },
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
       2024-12-30" instead of implying the provider started last month. */
    const span = await q(
      `SELECT platform, fleet_id, min(paid_on) AS earliest, max(paid_on) AS latest,
              count(*)::int AS transfers
         FROM platform_payout
        WHERE ($1::text IS NULL OR platform = $1)
          AND ($2::text IS NULL OR fleet_id = $2)
        GROUP BY 1, 2`, [platform, fleet]);

    /* The provider's own daily movement, which is what makes a transfer
       checkable rather than merely stated: a wire of 103,567.54 means nothing
       alone and means everything when it is the closing balance of the week
       before it. basis says whether the provider published the row (statement)
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
    const held = new Map(totals.map((t) => [`${t.platform}:${t.fleet_id}`, t]));
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
         has both open needs to be told so by the API rather than discovering
         it from a 7% discrepancy. */
      note: 'A row here is a transfer that reached the company’s bank on the date beside '
        + 'it, taken from the provider’s own books. It is NOT the same figure as the "bank '
        + 'payout" on Bank reconciliation, which is the sum of what drivers earned in a month '
        + '— measured 7.1% higher on the one week both were checked, because it counts a '
        + 'different event.',
    });
  }));
}
