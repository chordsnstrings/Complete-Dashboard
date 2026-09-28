-- SMS (2026-09-28): the outbox, a staff member's own mobile, one-time codes,
-- and the moment the unregistered-trip message went live.
--
-- Additive. Nothing existing changes.

-- ── the outbox ─────────────────────────────────────────────────────────────
-- One row per message the product decided about: sent, waiting (a trip
-- message held until 07:00), failed at the gateway, or held back with the
-- reason it was not sent. A held row is the answer to "why did this driver
-- not get a message" and is kept on purpose.
--
-- dedupe_key is what makes every job safe to run twice: a cash message is
-- `cash:<person>:<day>`, a trip message `trip:<plate>:<start>`, a code
-- `code:<user>:<id>`. A second run of the same job inserts nothing.
--
-- destination is a mobile number: class CT. message_text is the words sent to
-- a driver (an amount of cash, a route); it is NULL for a code, because a
-- code is never stored anywhere but as a hash in access_code.
-- provider_message_id is text: SMSala's ids are 19 digits, above 2^53.
CREATE TABLE IF NOT EXISTS sms_outbox (
  id                   bigserial PRIMARY KEY,
  kind                 text NOT NULL
                       CHECK (kind IN ('reset_code', 'phone_code', 'trip_register', 'cash_deposit', 'cash_run')),
  dedupe_key           text NOT NULL UNIQUE,
  person_id            bigint,         -- driver.id, for a driver message
  user_id              bigint,         -- access_user.id, for a staff code
  fleet_id             text,
  destination          text,
  sender               text,
  message_text         text,
  status               text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'held')),
  hold_reason          text,
  not_before           timestamptz,    -- a queued message waits until then
  provider_message_id  text,
  provider_status      text,           -- the gateway's word: Delivered, Undeliverable, …
  cost                 numeric,
  error                text,
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,
  plate                text,           -- a trip message: the car and the journey,
  trip_start           timestamptz,    -- so a later record of the SAME journey
  trip_end             timestamptz,    -- (FMS's final after its provisional) matches by overlap
  business_day         date,           -- a cash message: the Dubai day it is about
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  dlr_checked_at       timestamptz
);
CREATE INDEX IF NOT EXISTS sms_outbox_kind_at ON sms_outbox (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_outbox_queued ON sms_outbox (not_before) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS sms_outbox_trip ON sms_outbox (plate, trip_start) WHERE kind = 'trip_register';
CREATE INDEX IF NOT EXISTS sms_outbox_person_day ON sms_outbox (person_id, created_at DESC);

-- ── a staff member's own mobile, for a reset code ──────────────────────────
-- Set by the person themselves, and only counted once they have typed back a
-- code sent to it (phone_verified_at). A reset code goes nowhere else.
ALTER TABLE access_user ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE access_user ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

-- ── one-time codes ─────────────────────────────────────────────────────────
-- A reset code, or the code that confirms a mobile. Only an HMAC of the code
-- is stored. Three tries, then the code is dead; ten minutes, then it is
-- dead; one code per person per five minutes (the operator's rule,
-- 2026-09-28).
CREATE TABLE IF NOT EXISTS access_code (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES access_user(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('reset', 'phone')),
  code_hash   text NOT NULL,
  phone       text,                   -- the number being confirmed (purpose 'phone')
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          text
);
CREATE INDEX IF NOT EXISTS access_code_user ON access_code (user_id, purpose, created_at DESC);

-- ── when the trip message went live ────────────────────────────────────────
-- The unregistered-trip job only looks at journeys that ENDED after this.
-- 1,221 unauthorized journeys were already in occupancy_segment on the day it
-- shipped, and the weekly backfill re-judges a year of them: without this line
-- the first run would text drivers about trips from August.
CREATE TABLE IF NOT EXISTS sms_state (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sms_state (key, value) VALUES ('trip_since', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  ON CONFLICT (key) DO NOTHING;
