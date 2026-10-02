-- v98 — the monthly revenue target (api/revenue_target.js), 2026-10-02. Additive.
--
-- The operator, 2026-10-02: "Every month, the admin will set a specific
-- revenue target. the first page will show how much every day we need to earn
-- and yesterday were we over or under." One gross target for both fleets,
-- shared over the cars that earned in the last 7 days.
--
-- ONE ROW PER SAVE, never updated. The page reads, for each day of the month,
-- the latest save made on or before that day — so a save never rewrites what
-- an earlier day was asked for, and the history of who set what, when, at how
-- many cars, is the table itself. `rate` is fixed at the save: AED a car a day
-- from that day on, computed so the month target reads exactly `gross_target`
-- at the moment it is saved (past_plan is what the days already gone had been
-- planned at, kept so the arithmetic can be checked from the row alone).
CREATE TABLE IF NOT EXISTS revenue_target (
  id            bigserial PRIMARY KEY,
  month         date NOT NULL,             -- the first day of the month (Dubai)
  gross_target  numeric(14,2) NOT NULL CHECK (gross_target > 0),
  cars          integer NOT NULL CHECK (cars > 0),        -- cars that earned in the 7 days before the save
  rate          numeric(16,6) NOT NULL CHECK (rate > 0),  -- AED a car a day, from set_day on
  past_plan     numeric(14,2) NOT NULL DEFAULT 0,         -- the month's days before set_day, as planned
  set_day       date NOT NULL,             -- the Dubai day of the save
  set_at        timestamptz NOT NULL DEFAULT now(),
  set_by        bigint,                    -- access_user.id; NULL for the deploy seed
  set_by_label  text NOT NULL DEFAULT ''   -- who, in words: an email, or 'system:seed'
);
CREATE INDEX IF NOT EXISTS revenue_target_month_idx ON revenue_target (month, set_at, id);
