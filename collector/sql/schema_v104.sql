-- v104 — the month target shared by weekday, from the fleet's own weeks.
--
-- The operator (2026-10-11): "I think the target distribution makes more
-- sense hourly and daily based on previous performance. A historically bad
-- day on a Sunday can't be expected to perform the same way as weekday."
-- This replaces the EQUAL split chosen on 2026-10-02.
--
-- Measured on production that morning, over the 8 complete weeks to
-- 4 October, each day against its own week's average day: fares Mon 0.94,
-- Tue 1.03, Wed 1.04, Thu 1.13, Fri 1.13, Sat 0.95, Sun 0.78 (completed trips
-- the same within 0.02). Held all year: Sep 2025–Feb 2026 read Sun 0.77,
-- Thu 1.14. Back-tested, a day's share of its week was missed by 10.5–11.2%
-- under the equal split and 5.8–6.8% under weights learned from the 4 to 26
-- weeks before it (api/target_weights.js; docs/COVERAGE.md).
--
-- revenue_target.weights: the seven weights a SAVE shared its month by
-- (index 0 = Sunday, as JavaScript's getUTCDay), mean 1 over the week; NULL
-- for a save made before this, which stays the equal split it was — a day is
-- always judged against what it was asked. weights_basis says where they came
-- from (the weeks used and any skipped, with why).
ALTER TABLE revenue_target ADD COLUMN IF NOT EXISTS weights jsonb;
ALTER TABLE revenue_target ADD COLUMN IF NOT EXISTS weights_basis jsonb;

-- target_weights: the trips minimum's weekday weights, one row a month,
-- frozen the first time the month is read on or after the day they start
-- (from_day) — so a Sunday's minimum never moves under a driver once the
-- month has begun. Learned from the 8 complete weeks before from_day.
-- `trips` is NULL when too few weeks were usable: the minimum is then the
-- same every day, and basis.why says why.
CREATE TABLE IF NOT EXISTS target_weights (
  month       date PRIMARY KEY,             -- the first day of the month (Dubai)
  from_day    date NOT NULL,                -- the first day the weights apply to
  trips       jsonb,                        -- [Sun..Sat], mean 1, or NULL
  fares       jsonb,                        -- [Sun..Sat], for reference beside it
  basis       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
