/* WHAT EACH PLATFORM ACTUALLY PAID THE COMPANY, AND ON WHICH DATE.
   ─────────────────────────────────────────────────────────────────────────
   The dashboard has carried a figure called "bank payout" since reconciliation
   was built, and it has never been one. api/reconcile_routes.js:303 sums
   driver_payout_day.earnings by month and names the total bank_payout — that
   is Uber's weekly PER-DRIVER earnings spread across the days they were
   earned. It is a real quantity. It is not a transfer, and the two do not
   agree: measured on the closed week Mon 7 – Sun 13 Sep 2026 for Ecosine, the
   dashboard says 110,962.09 and Uber's own books say the wire was 103,567.54.
   7.1% apart, describing different events.

   Three providers were asked what they publish about the transfer itself, and
   the three answers are different in kind. That is why there are two tables
   here rather than one: a wire and a day's account movement are different
   facts, and a schema that stores them in one place would have to invent one
   of them for the providers that only give the other.

   UBER — the exact wire, on the exact date, PROVEN.
     REPORT_TYPE_PAYMENTS_ORGANIZATION carries `Payouts : Transferred To Bank
     Account`, and — this is the part that was not known until 2026-09-16 — a
     ONE-DAY window works. The column is EMPTY on a day with no transfer and
     carries the whole transfer on the day it happened. Measured, Ecosine:

       Mon 2026-09-07  earnings 15,985.57  cash -2,816.65  BANK -103,567.54
       Tue 2026-09-08  earnings 18,127.27  cash -2,902.50  BANK (none)
       Wed 2026-09-09  earnings 19,426.04  cash -3,229.91  BANK (none)
       Thu 2026-09-10  earnings 18,713.33  cash -3,460.75  BANK (none)
       Fri 2026-09-11  earnings 21,066.24  cash -4,135.73  BANK (none)

     and the daily balances chain to the fils across all five:
       103,567.54 -> 14,199.06 -> 30,531.51 -> 47,693.72 -> 64,029.20 -> 82,086.09.
     So Uber wires on MONDAY, and it wires the closing balance of the week that
     just ended — 103,567.54 was both the Monday transfer and the Sunday
     closing balance of 31 Aug – 6 Sep. A week's report gives the amount; only
     a day's report gives the date, and the date is what was asked for.

   BOLT — the exact wire, on the exact date, PROVEN.
     /fleetOwnerPortal/getPayouts, a path the collector has never called,
     returns one row per transfer with `finished` as a unix second. Measured
     2026-09-16: Ecosine 89 payouts over 89 distinct days back to 2024-12-30
     totalling AED 282,522.60; Egari 86 over 86 days back to 2024-12-23
     totalling AED 108,343.76. One row per day, already dated, nothing to
     divide and nothing to infer.

   YANGO — NOT PUBLISHED, and now for a measured reason rather than a guess.
     /v2/parks/transactions/list answers off the API key (the collector has
     been asking /v1, which 404s because Yango publishes no v1 under
     Transactions at all). It is a full dated ledger — 1,325 rows over the 90
     days to 2026-09-16, complete. But it is the DRIVER-ACCOUNT ledger: the 89
     published categories include a group called "Payouts from account balance
     to contractors" (bank_payment, partner_service_transfer,
     partner_service_financial_statement) and that is the park paying its
     drivers, not Yango paying the park. None of those three carries a single
     row here. There is no category anywhere in the vocabulary for a transfer
     from Yango to the company.

     So Yango's wire is ABSENT, and platform_payout will hold no Yango row.
     That is the true reason and it is the one the page must print. What the
     ledger DOES give is worth having and goes in the second table.

   ─────────────────────────────────────────────────────────────────────────
   platform_payout — one row per transfer that actually reached the company.
   Nothing derived, nothing apportioned, nothing averaged. A provider that does
   not publish a transfer contributes no rows, and the page says so by name. */
CREATE TABLE IF NOT EXISTS platform_payout (
  platform       TEXT NOT NULL,             -- uber | bolt
  fleet_id       TEXT NOT NULL,             -- ecosine | egari
  /* The provider's own id where it has one (Bolt's payout id), and otherwise
     a stable synthetic key built from the platform, fleet and date — never a
     row number, which would renumber the history the first time a backfill
     ran in a different order. */
  payout_ext_id  TEXT NOT NULL,
  /* THE DAY THE MONEY MOVED, on the fleet's calendar. Dubai is UTC+4 all year
     and Bolt stamps `finished` as a unix second, so a payout finishing at
     02:00 local is 22:00 the previous day in UTC — this column is Dubai's day
     and the collector is the only place that conversion happens. */
  paid_on        DATE NOT NULL,
  amount         NUMERIC(14,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'AED',
  /* What the transfer settles, where the provider says. Uber's Monday wire
     settles the Mon–Sun week that ended the day before, which is knowable and
     so is recorded; Bolt does not say, and NULL means "not stated" rather
     than "same day". */
  period_start   DATE,
  period_end     DATE,
  method         TEXT NOT NULL DEFAULT 'bank',
  /* WHICH CALL PROVED IT. A figure whose provenance is not stored is a figure
     that cannot be re-derived when a provider changes shape, and this product
     has a whole page (#provenance) built on the principle. */
  source         TEXT,
  raw            JSONB,
  collected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, fleet_id, payout_ext_id)
);
CREATE INDEX IF NOT EXISTS platform_payout_day_idx ON platform_payout (paid_on DESC);
CREATE INDEX IF NOT EXISTS platform_payout_fleet_idx ON platform_payout (fleet_id, paid_on DESC);

/* platform_account_day — the provider's own books, one row per day.
   ─────────────────────────────────────────────────────────────────────────
   The wire is one line of a statement, and a statement is what makes the wire
   checkable: a transfer of 103,567.54 means nothing on its own and means
   everything when it is the closing balance of the week before it. This table
   holds the movement, per platform per fleet per DAY, from whichever surface
   the provider publishes:

     uber   REPORT_TYPE_PAYMENTS_ORGANIZATION over a one-day window, which is
            the provider's own statement — basis 'statement'
     yango  /v2/parks/transactions/list summed per Dubai day per category,
            which is the provider's own dated rows — basis 'ledger'
     bolt   nothing yet: getFleetBalanceDetails answers DATE_RANGE_TOO_BIG on
            90 days and has not been measured on a window it accepts

   Every money column is NULLABLE and NULL means NOT PUBLISHED. It does not
   mean zero. Uber leaves the bank column empty on a day with no transfer and
   that is a real zero, so the collector writes 0 there and NULL only where the
   provider published no such column at all — the distinction this product
   exists to keep. */
CREATE TABLE IF NOT EXISTS platform_account_day (
  platform          TEXT NOT NULL,
  fleet_id          TEXT NOT NULL,
  day               DATE NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'AED',
  /* Where this row came from, because the two are not equally strong. A
     'statement' row is the provider's own opening and closing balance and can
     be checked against itself; a 'ledger' row is summed by us from dated rows
     and has no balance to check against. A reader must be able to tell them
     apart, and a page that presents them identically is lying by omission. */
  basis             TEXT NOT NULL,          -- statement | ledger
  opening_balance   NUMERIC(14,2),
  closing_balance   NUMERIC(14,2),
  earnings          NUMERIC(14,2),
  refunds_expenses  NUMERIC(14,2),
  /* Signed as the provider signs them: Uber writes payouts negative, because
     from the account's point of view a payout leaves it. Kept as sent rather
     than flipped, so a reader comparing this against a downloaded report sees
     the same characters. */
  cash_collected    NUMERIC(14,2),
  bank_transferred  NUMERIC(14,2),
  /* THE COMMISSION, which src/sources/yango.js says in as many words cannot be
     measured: "an order carries no commission field, and Yango's commission is
     about 24% of the gross". It is in the ledger. Measured over the 90 days to
     2026-09-16 for the Ecosine park: platform_ride_fee -2,710.84 over 238
     rows, platform_ride_vat -135.54, platform_reposition_fee -266.30,
     platform_mandatory_fee -530.00 — 3,642.68 against a gross of 13,413.40
     (card 8,659.40 + cash 4,214.00 + tolls 540.00), which is 27.2%. So the
     ~24% estimate was the right order and the exact figure is now a
     measurement rather than a remark in a comment. */
  commission        NUMERIC(14,2),
  tips              NUMERIC(14,2),
  taxes             NUMERIC(14,2),
  /* The per-category totals behind a 'ledger' row, so the page can show what
     made up a day without a second table and without storing a transaction. */
  components        JSONB,
  raw               JSONB,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, fleet_id, day)
);
CREATE INDEX IF NOT EXISTS platform_account_day_day_idx ON platform_account_day (day DESC);
