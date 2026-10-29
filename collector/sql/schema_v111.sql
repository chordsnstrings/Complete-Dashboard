-- v111: daily targets by vehicle class (api/revenue_target.js, the operator,
-- 2026-10-29: "Let me set targets vehicle wise. Make model year - per day
-- target, which will reflect everywhere").
--
-- One row per SAVE, never updated, the rule revenue_target keeps: what each
-- day was asked stays what it was asked. A save governs from its set_day (the
-- Dubai day it was made) and carries into every later month until the next
-- save; a month's own revenue_target saves still govern the days before it.
--
--   rates        [{make, model, year, rate}] — AED a car on an AVERAGE day for
--                each make + model + year the Owner gave a figure, the names
--                as the vehicle register spells them (coalesce(vehicle,
--                vehicle_plate), the same pair every vehicle page reads).
--   other_rate   AED a car on an average day for every other car: one whose
--                class has no figure here, or that has no make, model or year
--                on file (133 of the 273 plates on the register on the day
--                this was written; none of them had earned that week).
--   cars         [{make, model, year, cars}] — the cars each class counted at
--                the save (earned in the 7 days before it), for the history.
--   weights      the seven weekday weights (index 0 Sunday) learned at the
--                save from the 8 whole weeks before it (api/target_weights.js),
--                or NULL when too few were usable; weights_basis says which.
CREATE TABLE IF NOT EXISTS class_target (
  id            bigserial PRIMARY KEY,
  set_day       date NOT NULL,
  set_at        timestamptz NOT NULL DEFAULT now(),
  set_by        bigint,
  set_by_label  text NOT NULL DEFAULT '',
  rates         jsonb NOT NULL DEFAULT '[]'::jsonb,
  other_rate    numeric(12,2) NOT NULL CHECK (other_rate > 0),
  cars          jsonb NOT NULL DEFAULT '[]'::jsonb,
  weights       jsonb,
  weights_basis jsonb
);
CREATE INDEX IF NOT EXISTS class_target_day_idx ON class_target (set_day, set_at);
