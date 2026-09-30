-- v97 — the monthly report email (src/monthly_report.js), 2026-09-30. Additive.
--
-- The operator, 2026-09-30: a monthly performance email — the month against
-- the month before and the same month last year, by company, vehicle and
-- driver, with GLM 5.2's summary — to the addresses on the Settings page
-- (MONTHLY_REPORT_RECIPIENTS). One row per month per address: what Resend
-- said, and the report as composed (figures and summary) at the month's first
-- scheduled send, so every address gets the same email and a retry does not
-- ask the model again.
CREATE TABLE IF NOT EXISTS monthly_report_send (
  month         date NOT NULL,           -- the first day of the month reported
  recipient     text NOT NULL,
  status        text NOT NULL,            -- sent | failed
  provider_id   text,
  error         text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts      int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, recipient)
);
