-- schema_v132 — Network International's emailed card-machine reports (FIX-STATUS NIR, 2026-11-26)
-- ---------------------------------------------------------------------------
-- Network International emails each merchant account a "MERCHANT TRANSACTION
-- ACTIVITY" PDF every morning for the day before (around 09:20 Dubai): one
-- row per card payment with the terminal, a masked card number, the acquirer
-- reference (unique per transaction), the auth code, the amount, the bank's
-- fee and VAT on it, and the net paid. The operator: amounts from this report,
-- the driver from the team's sheet (src/sources/ni_reports.js,
-- src/sources/network_cards.js mergeBank). Measured on 25 Nov 2026: both
-- merchants' reports (48 payments, AED 3,099.97) matched the sheet's day one
-- for one by terminal and amount.

-- One row per emailed report. A report re-sent for the same merchant and days
-- replaces the earlier one — unless it is unusable and the earlier one is
-- usable, which is kept (the review of 2026-11-26). status 'ok' only when every transaction row was
-- read and they add up to the report's own grand totals; anything else is
-- stored with its reason and never used for an amount.
CREATE TABLE IF NOT EXISTS ni_report (
  id             BIGSERIAL PRIMARY KEY,
  merchant_no    TEXT NOT NULL,
  merchant_name  TEXT,
  fleet_id       TEXT,
  day_from       DATE NOT NULL,
  day_to         DATE NOT NULL,
  report_date    DATE,
  message_id     TEXT,
  mail_uid       BIGINT,
  mail_uidvalidity BIGINT,
  received_at    TIMESTAMPTZ,
  attachment     TEXT,
  txns           INT NOT NULL,
  gross          NUMERIC(12,2) NOT NULL,
  fees           NUMERIC(12,2),
  vat            NUMERIC(12,2),
  net            NUMERIC(12,2),
  stated_txns    INT,
  stated_gross   NUMERIC(12,2),
  stated_net     NUMERIC(12,2),
  status         TEXT NOT NULL,
  why            TEXT,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_no, day_from, day_to)
);
CREATE INDEX IF NOT EXISTS ni_report_mail_idx ON ni_report (mail_uidvalidity, mail_uid);

-- One row per bank transaction OF ONE REPORT. bank_ref is the acquirer
-- reference number, unique per transaction; keyed with the report, so a
-- broken report re-sent later can never take over a usable report's rows (the
-- review of 2026-11-26); bankForMerge reads usable reports only, newest first.
-- report_day is the day the report covers (the sheet files a payment under
-- it), txn_day the bank's own date for the payment.
CREATE TABLE IF NOT EXISTS ni_card_txn (
  merchant_no  TEXT NOT NULL,
  bank_ref     TEXT NOT NULL,
  report_id    BIGINT NOT NULL REFERENCES ni_report(id) ON DELETE CASCADE,
  report_day   DATE NOT NULL,
  txn_day      DATE NOT NULL,
  terminal_id  TEXT NOT NULL,
  card_last4   TEXT,
  txn_type     TEXT NOT NULL,
  auth_code    TEXT,
  amount       NUMERIC(12,2) NOT NULL,
  msf          NUMERIC(12,2),
  vat          NUMERIC(12,2),
  net          NUMERIC(12,2),
  card_class   TEXT,
  PRIMARY KEY (report_id, bank_ref)
);
CREATE INDEX IF NOT EXISTS ni_card_txn_ref_idx ON ni_card_txn (merchant_no, bank_ref);
CREATE INDEX IF NOT EXISTS ni_card_txn_report_idx ON ni_card_txn (report_id);
CREATE INDEX IF NOT EXISTS ni_card_txn_day_idx ON ni_card_txn (report_day, terminal_id);

-- Every message the reader fetched, once, with what came of it: 'ok' (its
-- report(s) stored), 'no_report' (no report PDF in it), 'rejected' (not from
-- an allowed sender, or the receiving server did not pass its DMARC/SPF),
-- 'unreadable' (a PDF with no merchant or span), 'error' (retried up to three
-- times). A message is fetched again only while it is 'error' under three
-- attempts: one bad message cannot block the ones after it, and two versions
-- of one report cannot take turns (the review of 2026-11-26).
CREATE TABLE IF NOT EXISTS ni_mail_message (
  mail_uidvalidity BIGINT NOT NULL,
  mail_uid       BIGINT NOT NULL,
  message_id     TEXT,
  sender         TEXT,
  subject        TEXT,
  received_at    TIMESTAMPTZ,
  status         TEXT NOT NULL,
  why            TEXT,
  attempts       INT NOT NULL DEFAULT 1,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mail_uidvalidity, mail_uid)
);

-- card_payment says where each row's amount and driver came from. bank_ref is
-- set on rows whose amount is the bank's (source 'network_report'); id_basis
-- says how the driver was found: 'sheet' (a sheet row), 'sheet_same_payment'
-- (the sheet's row for the same terminal, day and amount), 'sheet_same_terminal_day'
-- (an unmatched sheet row on that terminal that day, nearest in amount),
-- 'sheet_terminal_driver' (every sheet row there already matched; the
-- terminal's one driver that day), or 'none' (the sheet maps nobody to that terminal that day, or several and the
-- payment cannot be told between them). Never a guess: a bank amount is used
-- only on a fleet-day the sheet itself has.
ALTER TABLE card_payment ADD COLUMN IF NOT EXISTS bank_ref TEXT;
ALTER TABLE card_payment ADD COLUMN IF NOT EXISTS id_basis TEXT;
