-- A pass that produced nothing left no trace at all.
-- ─────────────────────────────────────────────────────────────────────────
-- runAnalyst writes one analyst_finding row per PROPOSAL. When the model
-- proposes nothing — because it is unreachable, rate-limited, misconfigured,
-- or genuinely had nothing to say — it writes no row, so the Action list
-- cannot tell "the analyst has never run" from "it ran and found nothing".
--
-- Measured on production 2026-08-26: runs 0, last_run null, model null, and
-- the page reporting the analyst as merely quiet. The collector log had the
-- answer all along — a 429 from the model endpoint, then a 120s abort on the
-- retry — and analystPass caught the error, logged it, and returned null. Not
-- one page in the product could say so, and nothing in collection_run either,
-- because the analyst does not go through runWindow.
--
-- One row per pass, written whether or not anything came of it. `outcome` is
-- what the page needs to choose its sentence:
--   ok        the model answered and its proposals were measured
--   empty     the model answered and proposed nothing worth checking
--   no_model  no key is configured for the component that runs the analyst
--   failed    the model call itself failed — `error` carries the provider's words
CREATE TABLE IF NOT EXISTS analyst_run (
  run_id       TEXT PRIMARY KEY,
  window_start DATE,
  window_end   DATE,
  fleet_id     TEXT,
  outcome      TEXT NOT NULL,
  proposed     INT  NOT NULL DEFAULT 0,
  dropped      INT  NOT NULL DEFAULT 0,
  confirmed    INT  NOT NULL DEFAULT 0,
  model        TEXT,
  error        TEXT,
  duration_ms  INT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyst_run_at_idx ON analyst_run (finished_at DESC);

COMMENT ON TABLE analyst_run IS
  'One row per analyst pass, written even when it produced no finding — so an '
  'empty Action list can say whether the analyst is quiet, unconfigured, or '
  'broken. Before this the three were indistinguishable.';
