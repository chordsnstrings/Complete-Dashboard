-- ── which process can actually see which credential ─────────────────────────
--
-- The API and the collector are separate components with separate environments,
-- and on this deployment they do not hold the same secrets. UBER_WEB_COOKIE and
-- YANGO_COOKIE are set on the collector worker and on nothing else — which is
-- correct, since only the collector calls those providers, and the web-facing
-- service has no business holding a session cookie it never uses.
--
-- But the Settings page is served BY the API, and it reported both as "unset".
-- An operator reading that page would conclude the Uber session had expired and
-- go and capture a new one, when the collector had a working one all along. The
-- page was not describing the fleet's credentials; it was describing the API's
-- environment, and saying nothing about the difference.
--
-- So the collector records what it can see. Names and presence only — never a
-- value, not even a masked one. This table is read by a web service; a secret
-- that reaches it has been copied somewhere it was deliberately kept out of.

CREATE TABLE IF NOT EXISTS credential_visibility (
  component   TEXT NOT NULL,          -- 'collector' | 'api'
  key         TEXT NOT NULL,
  configured  BOOLEAN NOT NULL,
  source      TEXT,                   -- 'environment' | 'settings' | 'unset'
  observed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (component, key)
);
