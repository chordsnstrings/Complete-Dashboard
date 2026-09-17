/* THE TRANSACTION LEDGER'S VERDICT ON THE WIRE REGISTER.
   ─────────────────────────────────────────────────────────────────────────
   WHAT THIS IS FOR. The register is built from REPORT_TYPE_PAYMENTS_ORGANIZATION,
   which is ONE AGGREGATE ROW PER REQUEST and carries no date column — so it can
   only be asked one day at a time, and the walk therefore asks the days most
   likely to carry a wire first. Measured 2026-09-17: every one of the twenty
   payout dates found across seventeen months, 2025-04-07 to 2026-09-14, is a
   MONDAY.

   That makes "Uber wires on a Monday" very likely and not checked. The walk
   asks Mondays first precisely because they are where wires are, which means a
   wire on a Thursday would be found LAST, or — for any period the walk has not
   finished — not at all. An operator reading a complete-looking register has no
   way to tell those apart.

   REPORT_TYPE_PAYMENTS_ORDER settles it, and it is a different kind of report.
   Probed on production 2026-09-17: it is PER TRANSACTION (399+ rows for one
   day), the wire is one of those rows (Description = 'so.payout', carrying
   'Paid to you:Trip balance:Payouts:Transferred To Bank Account' — exactly
   -111,179.66 on 2026-09-14, the figure the operator confirmed against their
   bank), and every row is DATED by a column called 'vs reporting' (399 of 399
   values date-like; asked for 2026-09-14 alone its range is that day, asked for
   2026-09-07..14 the sampled rows are 2026-09-07).

   So ONE report over a window names every wire in that window, with its date,
   whatever weekday it fell on. That is the audit: not a faster way to build the
   register — generation cost scales with the transactions in the window, so
   asking a year of ORDER is dearer than asking a year of Mondays — but the only
   way to show the register is COMPLETE rather than merely plausible.

   TWO TABLES' WORTH OF FACT, ONE OF THEM PER WIRE.

   payout_audit records which WINDOWS have been put to the ledger. A page that
   says "no wire was missed" must be able to say over which period it is saying
   it, and a period nobody audited is not a period with no missed wires.

   platform_payout gains what the ledger said about EACH wire. Deliberately NOT
   an overwrite of `amount`: two Uber reports disagreeing about one transfer is
   a finding this product exists to surface, not a conflict to resolve silently
   by preferring whichever was written last. Where they agree, audit_amount is
   the confirmation; where they differ, the row carries both and the page says
   so; where the audit found a wire the register did not hold, the row is
   inserted with its source naming the ORDER report. */
CREATE TABLE IF NOT EXISTS payout_audit (
  platform     TEXT NOT NULL,
  fleet_id     TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  /* audited — the report generated and was read.
     refused — the limiter shut, it timed out, or the shape was not the one the
               parser reads. Nothing was learned, and the window must be asked
               again rather than counted as clean. */
  outcome      TEXT NOT NULL,
  wires_found  INT,
  wires_new    INT,
  detail       TEXT,
  audited_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, fleet_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS payout_audit_window_idx
  ON payout_audit (platform, fleet_id, period_start)
  WHERE outcome = 'audited';

ALTER TABLE platform_payout ADD COLUMN IF NOT EXISTS audit_amount NUMERIC(14,2);
ALTER TABLE platform_payout ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ;

COMMENT ON COLUMN platform_payout.audit_amount IS
  'What REPORT_TYPE_PAYMENTS_ORDER''s so.payout row says this transfer was, where that ledger has been asked. NULL means the wire has not been audited — not that it disagrees. Never overwrites amount: two provider reports disagreeing about one wire is a finding, not a conflict to resolve by writing order.';
