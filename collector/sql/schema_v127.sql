-- v127: card-machine payments — Network International (FIX-STATUS CARD-1;
-- src/sources/network_cards.js reads them, api/card_routes.js serves them).
-- The operator, 2026-11-23: drivers now take real cash AND card payments on
-- card machines; this sheet "shows how much was in card machine. The rest is
-- real cash still left in the driver."
--
-- What the source is (measured on the sheet, 2026-11-23): one running list,
-- 8,034 payments from 2025-12-13 to 2026-11-22, AED 542,744.80, each row
-- carrying ONLY an Emirates ID (or the words "Not Found" / "N/A" where no
-- driver was mapped to the terminal that day), a day, the fleet, the
-- terminal id and the amount. No time, no transaction reference, no card
-- type. The Emirates ID is the sheet keeper's mapping of terminal to driver —
-- Network International knows terminals, not drivers — and terminals move
-- between drivers (the operator: "they aren't fixed, terminals change"; 57 of
-- 113 mapped terminals passed between drivers, never two on one day).
--
--   card_payment  one row per payment as the sheet has it. A negative amount
--                 is a CHARGEBACK (the operator: "the negative amounts are
--                 chargebacks", and "fare isn't lost. it usually comes back"),
--                 kept signed. The terminal id stays on every row so any
--                 figure traces back to the device (the operator: "in
--                 driver's history, the terminal ID should be there so that
--                 we can trace back"). Identical rows are separate payments,
--                 as the sheet's own total counts them: there is no reference
--                 to tell a repeat AED 50 fare from a double entry.
--   card_import   one row per read of the sheet: what it held, what was kept
--                 and why anything was not, and whether it was written or
--                 held back.
--   card_id_link  a person's decision that an Emirates ID the HR export does
--                 not carry belongs to a driver. No foreign key, as with
--                 charging_link: a fold that removes the person strands the
--                 decision, and the view says so rather than the fold failing.
--   card_id_person  the view every reader joins: Emirates ID -> person, by a
--                 person's link first, then by the HR export (the newest
--                 upload that carries the ID, through its matched platform
--                 accounts and the person spine). An ID the export ties to
--                 two driver records places on neither, and says so. An HR
--                 row matched to no live account is NOT in it — so "not in
--                 the view" never means "not on the HR export"; readers ask
--                 hr_roster_row for that (api/card_routes.js).
--
-- Corrected in place before it was ever applied (the review of 2026-11-23,
-- on the branch, never deployed): an account row with no person, and a
-- stranded link hiding a valid HR placement.
--
-- A read REPLACES the stored payments of the days it covers (the sheet has no
-- reference to append by); see src/sources/network_cards.js for the guard
-- that holds back a read that would remove a large share of them.

CREATE TABLE IF NOT EXISTS card_import (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'network_sheet',
  read_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sheet_range  TEXT,
  rows_read    INT NOT NULL DEFAULT 0,
  rows_kept    INT NOT NULL DEFAULT 0,
  rows_skipped INT NOT NULL DEFAULT 0,
  skipped      JSONB NOT NULL DEFAULT '{}'::jsonb,
  day_from     DATE,
  day_to       DATE,
  total        NUMERIC(14,2),
  replaced     INT,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'held', 'error')),
  why          TEXT
);
CREATE INDEX IF NOT EXISTS card_import_read_idx ON card_import (read_at DESC);

CREATE TABLE IF NOT EXISTS card_payment (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'network_sheet',
  import_id    BIGINT NOT NULL REFERENCES card_import(id),
  row_no       INT NOT NULL,
  txn_day      DATE NOT NULL,
  fleet_id     TEXT,
  terminal_id  TEXT NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  emirates_id  TEXT CHECK (emirates_id IS NULL OR emirates_id ~ '^784[0-9]{12}$'),
  id_label     TEXT
);
CREATE INDEX IF NOT EXISTS card_payment_day_idx ON card_payment (source, txn_day);
CREATE INDEX IF NOT EXISTS card_payment_eid_idx ON card_payment (emirates_id, txn_day);
CREATE INDEX IF NOT EXISTS card_payment_terminal_idx ON card_payment (terminal_id, txn_day);

CREATE TABLE IF NOT EXISTS card_id_link (
  emirates_id  TEXT PRIMARY KEY CHECK (emirates_id ~ '^784[0-9]{12}$'),
  person_id    BIGINT NOT NULL,
  decided_by   TEXT,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT
);

CREATE OR REPLACE VIEW card_id_person AS
WITH hr AS (
  SELECT r.emirates_id AS eid, u.id AS upload_id, u.export_date, d.driver_id
    FROM hr_roster_row r
    JOIN hr_roster_upload u ON u.id = r.upload_id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.matched_accounts, '[]'::jsonb)) a
    JOIN driver_platform_id d ON d.platform = a ->> 'platform' AND d.external_id = a ->> 'ext_id'
                             AND d.detached_at IS NULL AND d.driver_id IS NOT NULL
   WHERE r.emirates_id ~ '^784[0-9]{12}$'
), newest AS (
  SELECT DISTINCT ON (eid) eid, upload_id FROM hr ORDER BY eid, export_date DESC, upload_id DESC
), hr_people AS (
  SELECT h.eid, array_agg(DISTINCT h.driver_id ORDER BY h.driver_id) AS people
    FROM hr h JOIN newest n ON n.eid = h.eid AND n.upload_id = h.upload_id
   GROUP BY h.eid
)
SELECT coalesce(l.emirates_id, p.eid) AS emirates_id,
       CASE WHEN l.emirates_id IS NOT NULL AND EXISTS (SELECT 1 FROM driver x WHERE x.id = l.person_id) THEN l.person_id
            WHEN cardinality(p.people) = 1 THEN p.people[1] END AS person_id,
       /* A link to a person since removed falls back to the HR export's own
          placement when it has one (the review of 2026-11-23): a stranded
          decision must not hide a valid one-person match. */
       CASE WHEN l.emirates_id IS NOT NULL AND EXISTS (SELECT 1 FROM driver x WHERE x.id = l.person_id) THEN 'linked'
            WHEN cardinality(p.people) = 1 THEN 'hr'
            WHEN l.emirates_id IS NOT NULL THEN 'link_stranded'
            ELSE 'hr_ambiguous' END AS basis,
       coalesce(cardinality(p.people), 0) AS hr_people
  FROM hr_people p
  FULL JOIN card_id_link l ON l.emirates_id = p.eid;
