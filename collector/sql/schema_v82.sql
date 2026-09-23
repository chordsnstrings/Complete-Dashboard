-- ===========================================================================
-- Which saved value a credential observation was about.
-- ===========================================================================
-- THE DEFECT. On 2026-09-23 the operator saved a new UBER_WEB_COOKIE_EGARI on
-- the Settings page at 08:30:22Z. The collector's half-hourly run had started
-- at 08:30:00Z and loaded its settings then, 22 seconds before the save. At
-- 08:31:28Z that run asked Uber with the value it held, the OLD cookie, and
-- recorded "redirected to auth.uber.com — the session is no longer signed in".
-- The banner then showed the saved cookie as stopped. The saved cookie was
-- fine: at 08:40:51Z production's own paste check passed it, and at 08:41:07Z
-- a report request made with the stored value came back "accepted".
--
-- So "checked after the save" does not mean "checked the saved value". The
-- failing row was written a minute AFTER the save and was still about the
-- value before it. Comparing checked_at with app_setting.updated_at cannot
-- tell those apart. Only the observer knows which value it held.
--
-- value_version is that answer: the app_setting.updated_at of the value the
-- observing process had loaded, as whole microseconds since the epoch, so it
-- compares exactly and without a time zone. NULL means the value did not come
-- from the Settings page: an environment variable, a code default, or a row
-- written before this column existed.
--
-- src/auth_state.js noteCredential() writes a row only when the version it
-- used is the one stored now, so an observation about a replaced value is
-- dropped rather than painted over the verdict on the new one.
-- api/save_check.js tests a value when it is saved and stamps the rows with
-- the new version. api/auth_routes.js reads a row whose version is not the
-- stored one as describing an earlier value, never as the current state.
ALTER TABLE credential_state ADD COLUMN IF NOT EXISTS value_version BIGINT;

COMMENT ON COLUMN credential_state.value_version IS
  'The app_setting.updated_at, in whole microseconds since the epoch, of the '
  'value this row was observed with. NULL when the value came from the '
  'environment or a default, or the row predates schema_v82. A row whose '
  'version is not the stored one describes a value that has since been '
  'replaced.';
