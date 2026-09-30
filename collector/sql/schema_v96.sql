-- v96 — the 08:00 low-trips email (src/low_trips_email.js), 2026-09-30. Additive.
--
-- The operator, 2026-09-30: at 8 every morning, email every active driver who
-- completed fewer than the minimum trips yesterday (10; the Owner sets it on
-- the Access page, access_config low_trips_min). One row per day per address:
-- what Resend said, and the list as composed at the day's first send, so a
-- retry and a later address get the same list.
CREATE TABLE IF NOT EXISTS low_trips_email_send (
  business_day  date NOT NULL,           -- the day the trips were counted for
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
