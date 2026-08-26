-- What every credential is actually doing, checked rather than assumed.
-- ─────────────────────────────────────────────────────────────────────────
-- An expired Uber web session did not look like a failure. Measured on
-- 2026-08-26 against the live endpoint: with the `sid` cookie removed, the
-- supplier GraphQL request follows a redirect to auth.uber.com and comes back
-- 404 "Not Found", so the JSON parse fails, `data.errors` is undefined, the
-- row list is undefined, and src/sources/uber.js returns { err: null, rows: []
-- } — the exact shape of a week in which nobody drove. The run then records
-- status 'ok'. So the single most perishable credential in this deployment
-- could stop working and every page would go on saying every source was
-- healthy while the money quietly stopped arriving.
--
-- Two things follow, and this table is the second.
--
-- The first is detection, in src/auth_state.js: a response that redirected off
-- the host it was sent to, a 401 or 403, or a body that is not the JSON the
-- caller asked for, is an authentication failure and not an empty window.
--
-- The second is a place to record what was observed, so that a page can say
-- WHICH credential stopped and WHEN it last worked. collection_run already
-- carries a per-run verdict, but it is keyed by source and mode and answers
-- "did this pass succeed"; a credential outlives any one run, is shared by
-- several surfaces, and is what a person actually has to go and replace.
--
-- One row per credential per fleet. `state` is the observation, never a guess:
--   ok       the credential authenticated on the last attempt
--   expired  it was refused, or redirected to a login page
--   missing  the surface is configured for this fleet and has no credential
-- `last_ok_at` is what makes a red banner actionable — "Uber stopped
-- authenticating for Egari at 14:20, it last worked at 09:54" is a work item;
-- "Uber is broken" is a mood.
CREATE TABLE IF NOT EXISTS credential_state (
  provider    TEXT NOT NULL,          -- uber | uber_fleet | fms | cabman | yango | bolt | hotel
  fleet_id    TEXT NOT NULL,          -- '*' where the credential is not per fleet
  credential  TEXT NOT NULL,          -- the env key a person would replace
  state       TEXT NOT NULL,          -- ok | expired | missing
  detail      TEXT,                   -- the provider's own words, trimmed
  surface     TEXT,                   -- which request observed it
  last_ok_at  TIMESTAMPTZ,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, fleet_id, credential)
);

COMMENT ON TABLE credential_state IS
  'Observed authentication state per credential per fleet. Written by the '
  'collector whenever a surface authenticates or is refused; read by '
  '/api/auth to raise the banner every page carries.';

COMMENT ON COLUMN credential_state.last_ok_at IS
  'The last time this credential authenticated. Never cleared by a failure — '
  'it is what turns "Uber is broken" into "Uber stopped at 14:20 and last '
  'worked at 09:54".';
