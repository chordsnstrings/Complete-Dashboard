-- v110: the ntfy watcher's memory (api/alerts.js), one row per CREDENTIAL —
-- provider|fleet_id|credential, the key credential_state itself upserts on
-- (schema_v33). Not the surface: noteCredential overwrites `surface` on every
-- write, and a healthy Bolt run ends on getPayouts while an expired token is
-- written on orderHistory, so a surface-keyed memory never saw the recovery
-- and stayed silent on the next expiry.
--
-- Two verdicts per row:
--   severity/state/notified_at          what the operator was last TOLD. Written
--                                       only once ntfy accepted the push, so a
--                                       restart re-announces nothing and a failed
--                                       push is retried on the next pass. NULL
--                                       severity = never told (a new row).
--   seen_severity/seen_state/seen_since what the banner has said, unchanged,
--                                       since when. A change is sent only once it
--                                       has held for two passes: a refusal fixed
--                                       by the next run is never a buzz.
CREATE TABLE IF NOT EXISTS alert_state (
  key            TEXT PRIMARY KEY,
  severity       TEXT,
  state          TEXT,
  label          TEXT,
  notified_at    TIMESTAMPTZ,
  seen_severity  TEXT NOT NULL,
  seen_state     TEXT,
  seen_since     TIMESTAMPTZ NOT NULL DEFAULT now()
);
