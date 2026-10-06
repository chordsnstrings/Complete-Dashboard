-- v100 — the target nudge texts (src/target_sms.js), 2026-10-06. Additive.
--
-- Two new kinds on sms_outbox: 'target_nudge', one row per driver texted (or
-- held) at 13:00 or 18:00 Dubai, and 'target_run', one row per run carrying
-- the counts of who was skipped and why. The CHECK is replaced rather than
-- edited in v88, which owns the table, because every schema file replays on
-- every boot and the ledger skips a file whose sha it has seen.
ALTER TABLE sms_outbox DROP CONSTRAINT IF EXISTS sms_outbox_kind_check;
ALTER TABLE sms_outbox ADD CONSTRAINT sms_outbox_kind_check
  CHECK (kind IN ('reset_code', 'phone_code', 'trip_register', 'cash_deposit', 'cash_run',
                  'target_nudge', 'target_run'));
