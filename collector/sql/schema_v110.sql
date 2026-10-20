-- v110: what the ntfy watcher last TOLD the operator about each banner row
-- (api/alerts.js). One row per credential surface, keyed the way the banner
-- keys them: provider|fleet_id|credential|surface.
--
-- It holds the last NOTIFIED verdict, not the last observed one, so a restart
-- or a deploy does not re-announce a fault already announced, and a verdict
-- that flips and flips back inside the quiet gap is never sent at all. A row
-- is written only after ntfy accepts the push: a push that failed is retried
-- on the next pass because nothing here says it was sent.
CREATE TABLE IF NOT EXISTS alert_state (
  key          TEXT PRIMARY KEY,
  severity     TEXT NOT NULL,
  state        TEXT,
  label        TEXT,
  notified_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
