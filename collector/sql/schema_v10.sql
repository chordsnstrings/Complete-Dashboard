-- The analyst layer: a model proposes, the database adjudicates.
--
-- An LLM asked "what is interesting about this fleet?" will always answer, and
-- the answer will always be fluent. That is the problem, not the feature. Every
-- row in this table therefore records four separate things:
--
--   claim         what was proposed
--   check_*       the specific, pre-declared measurement that would settle it
--   measured_*    what the database actually returned for that measurement
--   verdict       confirmed | refuted | immaterial | unsupported
--
-- `immaterial` is its own verdict and carries as much weight as `refuted`,
-- because a true statement about eleven trips is not a finding. A claim is only
-- shown to an operator when it is both TRUE and BIG ENOUGH, and the numbers
-- that decided it are stored beside it so the judgement can be checked.
--
-- The model never writes SQL. It picks a metric, a dimension and a segment from
-- fixed allowlists, and the measurement is composed from those by code.

CREATE TABLE IF NOT EXISTS analyst_finding (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL,             -- one generation pass
  window_start  DATE NOT NULL,
  window_end    DATE NOT NULL,
  fleet_id      TEXT,

  claim         TEXT NOT NULL,             -- the model's sentence
  why           TEXT,                      -- why it would matter if true
  action        TEXT,                      -- what an operator would do about it

  check_kind    TEXT NOT NULL,             -- rate_gap | mean_gap | share | trend
  metric        TEXT NOT NULL,             -- from the metric allowlist
  dimension     TEXT,                      -- from the dimension allowlist
  segment       TEXT,                      -- the value of that dimension
  direction     TEXT,                      -- higher | lower | rising | falling
  claimed_value NUMERIC,                   -- what the model said the number was

  measured_value    NUMERIC,               -- what the segment actually is
  baseline_value    NUMERIC,               -- what the rest of the fleet is
  segment_n         INT,
  baseline_n        INT,
  effect            NUMERIC,               -- measured - baseline, in metric units
  effect_pct        NUMERIC,               -- effect as a share of baseline
  p_value           NUMERIC,               -- where a test applies; NULL where none does
  verdict           TEXT NOT NULL,
  verdict_reason    TEXT NOT NULL,

  model         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analyst_run_idx     ON analyst_finding (run_id);
CREATE INDEX IF NOT EXISTS analyst_verdict_idx ON analyst_finding (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS analyst_window_idx  ON analyst_finding (window_start, window_end);

COMMENT ON COLUMN analyst_finding.verdict IS
  'confirmed = true and material. refuted = the measurement contradicts the claim. immaterial = true but too small or too rare to act on. unsupported = the measurement could not be made (a segment with no rows, or a metric the channel does not report).';
COMMENT ON COLUMN analyst_finding.p_value IS
  'Two-proportion z-test for rate claims, Welch t for mean claims, NULL for descriptive claims where no test applies. NULL here means "no test", never "passed".';

-- The hotel report returns one money figure per booking, named `cost`. The
-- collector was writing it to both `price` and `cost`, which made every margin
-- computed from those two columns exactly zero — across 1,254 bookings and six
-- properties over a full year, revenue and cost were the same number every
-- time. A margin of zero is a claim about the business; "this channel does not
-- report a cost" is a claim about the data, and only the second one is true.
--
-- The collector no longer writes it. This clears the rows that already carry it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_once WHERE name = 'v10_hotel_cost_is_not_a_cost') THEN
    UPDATE trip SET cost = NULL, margin = NULL
    WHERE platform = 'hotel' AND cost IS NOT NULL AND price IS NOT NULL AND cost = price;
    INSERT INTO schema_once (name) VALUES ('v10_hotel_cost_is_not_a_cost');
  END IF;
END $$;
