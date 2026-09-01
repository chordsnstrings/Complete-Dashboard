-- When each insight rule last EVALUATED, as opposed to when it last found
-- something.
--
-- /api/insights serves the newest row per (code, entity) and src/insights.js
-- prunes the table to exactly that, so a finding that was true once and has
-- not been true since survives forever. The readers could infer "the rule ran"
-- only from the rows the rule wrote — which means a rule that ran and found
-- NOTHING left its entire previous set standing as live work.
--
-- Measured on production 2026-09-01: 35 vehicle_doc_expiring findings frozen
-- at 2026-08-25 while other rules wrote that same morning. Their titles are
-- written in relative time — "expires in 1 days" — so the action list was
-- telling an operator to chase a document that had lapsed six days earlier.
--
-- One row per CODE rather than per job, because that is the key both readers
-- already group by, and because one job can own several codes (the vehicle
-- document rule emits both the expiring and the expired form of its finding).
-- Written only when the job SUCCEEDS: a rule that threw has evaluated nothing,
-- and its findings must stand rather than vanish the moment it starts failing.
CREATE TABLE IF NOT EXISTS insight_run (
  code   TEXT PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL
);
