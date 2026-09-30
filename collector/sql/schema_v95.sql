-- v95 — the 08:00 cash email (src/cash_sms_email.js), 2026-09-30. Additive.
--
-- The operator, 2026-09-30: every morning at 8, email the cash desk every
-- driver who was texted to deposit yesterday's cash — name, mobile, the
-- amount, and which platform it came from. The drivers, amounts and
-- platforms are read from sms_outbox (the 05:00 cash_deposit rows), so this
-- table only records what Resend said, one row per day per address: a send
-- that failed is retried on the next quarter hour and an address is never
-- sent a day's list twice.
CREATE TABLE IF NOT EXISTS cash_email_send (
  business_day  date NOT NULL,           -- the day the cash was taken
  recipient     text NOT NULL,
  status        text NOT NULL,            -- sent | failed
  provider_id   text,
  error         text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts      int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_day, recipient)
);
