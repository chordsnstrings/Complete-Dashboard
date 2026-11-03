-- v112: the token-expiry warnings the ntfy watcher has sent (api/alerts.js
-- expiryTick; the operator, 2026-11-03: "for the any token refresh lets have a
-- notification about 24 hours before expiry").
--
-- One row per TOKEN warned about: the setting it is stored under and the
-- instant it expires, which is the token's own identity here — a fresh paste
-- carries a new expiry, so it is warned about again when its own last day
-- comes, and a restart or a deploy never repeats a warning already sent.
-- Written only once ntfy has accepted the push, so a failed one is retried on
-- the next pass. Never holds the token: only its key and its expiry.
CREATE TABLE IF NOT EXISTS expiry_notice (
  setting_key  text NOT NULL,
  expires_at   timestamptz NOT NULL,
  notified_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (setting_key, expires_at)
);
