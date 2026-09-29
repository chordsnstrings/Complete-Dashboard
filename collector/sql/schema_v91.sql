-- v91 — the 07:00 daily report email (src/daily_report.js), 2026-09-29.
-- Additive.

-- Who gets it. Added and removed by the Owner and Access admins on the Access
-- page; seeded once from REPORT_RECIPIENTS (the environment, never the repo).
-- A removal is kept as a row, so an emptied list is never mistaken for one
-- that was never seeded.
CREATE TABLE IF NOT EXISTS report_recipient (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  added_by    text NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_by  text,
  removed_at  timestamptz
);
-- One live row per address; a removed address can be added again.
CREATE UNIQUE INDEX IF NOT EXISTS report_recipient_live
  ON report_recipient (lower(email)) WHERE removed_at IS NULL;

-- One row per day: the figures and the commentary as composed, so a retry at
-- 07:15 sends what 07:00 composed rather than a second, different email.
CREATE TABLE IF NOT EXISTS report_run (
  business_day  date PRIMARY KEY,
  status        text NOT NULL,            -- composed | sent | partial | failed
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per day per address: what Resend said.
CREATE TABLE IF NOT EXISTS report_send (
  business_day  date NOT NULL,
  recipient     text NOT NULL,
  status        text NOT NULL,            -- sent | failed
  provider_id   text,
  error         text,
  attempts      int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_day, recipient)
);
