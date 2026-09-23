-- ===========================================================================
-- The operator's HR roster export: one immutable snapshot per upload.
-- ===========================================================================
-- WHAT IT IS. The operator's HR system exports a workbook,
-- `active-drivers-YYYY-MM-DD.xlsx`, one sheet "Drivers", 44 columns. It is the
-- only source this product has for four government documents — passport,
-- Emirates ID, UAE driving licence, RTA permit card — and for the visa's
-- expiry. Measured on the 2026-09-23 export (143 rows): the database held NO
-- source at all for passport, Emirates ID, visa or RTA permit expiry, and its
-- only licence expiries came from Yango, 34 of whose 59 dates were about five
-- years older than HR's — renewals Yango never picked up. /api/compliance/
-- drivers was telling the operator that 88 people could not legally drive,
-- and for the 32 of them on this file HR says the licence is valid.
--
-- ── AN UPLOAD IS A SNAPSHOT, AND NOTHING IS EVER DELETED ──────────────────
-- Re-uploading a newer export is the normal case. A person missing from a
-- newer upload is "off the HR list since <that export's date>", derived by
-- comparing snapshots — never a DELETE — and a document whose expiry changes
-- between two exports is a renewal the page can show, which it could not if
-- the row were overwritten in place. So hr_roster_row is keyed on the upload
-- and every upload keeps every row it carried.
--
-- ── THE KEY IS (fleet, employee_id), NEVER employee_id ALONE ──────────────
-- HR's D-numbers are issued per company and are reused across the two
-- fleets, so an Employee ID on its own names two different people.
--
-- ── WHAT IS NOT STORED, BY THE OPERATOR'S DECISION ────────────────────────
-- Of the 44 columns, 20 are kept (listed in src/hr_roster.js as STORED). Not
-- kept: gender, nationality, date of birth, marital status, address,
-- emergency contact, first/last name (Full Name is kept), bank name, IBAN,
-- notes, Active, Vehicle Assigned, violations and complaints counts, contract
-- dates, joining date, Hired At, punctuality and safety scores, last test
-- result — and the VISA NUMBER, which on this export is the Emirates ID
-- typed a second time. The parser reads those columns only to check the
-- export's shape and then drops them; they never reach a query.
--
-- ── THE NUMBERS ARE HELD, AND WHERE THEY MAY LEAVE IS NARROW ──────────────
-- passport_no and rta_permit_no are stored and returned by NO route.
-- emirates_id and licence_no are returned by exactly one route,
-- /api/driver/profile, for the person the HR row matched — the operator's
-- decision of 2026-09-23 — and by no other. api/redact.js carries the column
-- list (HR_NUMBER_COLUMNS) and api/hr_roster.js selects these columns in
-- exactly one read. Every other read selects `(x IS NOT NULL) AS x_on_file`
-- instead, so the value never becomes a string in the process at all.

CREATE TABLE IF NOT EXISTS hr_roster_upload (
  id               BIGSERIAL PRIMARY KEY,
  /* The same bytes twice are refused: an upload is a snapshot of the HR
     system on one day, and the same snapshot twice is not a second fact. */
  sha256           TEXT NOT NULL UNIQUE,
  /* The day HR exported it — from the filename when it says so, otherwise
     entered on the page — and which of the two it was. Ordering between
     snapshots is by this date, not by when the upload happened: an older
     export uploaded late is history, not the current list. */
  export_date      DATE NOT NULL,
  export_date_from TEXT NOT NULL CHECK (export_date_from IN ('filename', 'entered')),
  filename         TEXT,
  byte_len         INT NOT NULL,
  rows_read        INT NOT NULL,
  uploaded_by      TEXT NOT NULL,
  uploaded_ip      TEXT,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* The preview's figures at the moment of commit — counts, account ids and
     employee ids only, never a document number. JSONB, and bound as a STRING:
     docs/COVERAGE.md "A JS ARRAY bound to a JSONB column passes on PGlite and
     fails on production". */
  summary          JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_roster_row (
  upload_id            BIGINT NOT NULL REFERENCES hr_roster_upload(id),
  fleet_id             TEXT NOT NULL,
  employee_id          TEXT NOT NULL,
  full_name            TEXT,
  phone                TEXT,
  email                TEXT,
  /* HR's own word, verbatim, and shown as HR's. It is not this product's
     verdict and the page never presents it as one. */
  hr_compliance_status TEXT,
  passport_no          TEXT,
  passport_expires     DATE,
  /* Digits only: fifteen, starting 784, on 142 of 143 rows of the first
     export. Kept as HR typed it (digits) where it is not fifteen long, and
     the preview counts those rather than guessing a correction. */
  emirates_id          TEXT,
  emirates_id_expires  DATE,
  licence_no           TEXT,
  licence_expires      DATE,
  visa_expires         DATE,
  rta_permit_no        TEXT,
  rta_permit_expires   DATE,
  /* Every platform id HR files, whether or not this product holds the
     account: an Ecosine Bolt UUID cannot be matched today (Bolt refuses that
     fleet's roster, the one source that files Bolt's user UUID) and must not
     be lost for the day it can. YAY is a channel this fleet uses a little and
     nothing collects. */
  uber_id              TEXT,
  careem_id            TEXT,
  bolt_id              TEXT,
  yango_id             TEXT,
  yay_id               TEXT,
  /* How this row was tied to platform accounts AT IMPORT: by a platform id
     HR filed, else by phone, never by name. */
  match_basis          TEXT NOT NULL CHECK (match_basis IN ('platform_id', 'phone', 'none')),
  /* [{platform, ext_id, via, fleet_id, name}] — the accounts it matched.
     This is the (fleet, employee_id) <-> account bridge a later payroll
     import joins on; hr_employee_account below explodes it. */
  matched_accounts     JSONB NOT NULL,
  PRIMARY KEY (upload_id, fleet_id, employee_id)
);
CREATE INDEX IF NOT EXISTS hr_roster_row_emp_idx ON hr_roster_row (fleet_id, employee_id);

/* HR grouped these platform accounts under one employee. A PROPOSAL, never a
   merge: nothing reads this table to fold anybody. It is deliberately NOT
   driver_identity_link — src/identity_link.js DELETEs every unconfirmed row
   in that table whose rule no longer produces it, on every collector run, so
   a proposal written there would vanish within half an hour. A human's
   verdict is recorded here and here only. */
CREATE TABLE IF NOT EXISTS hr_roster_proposal (
  id                 BIGSERIAL PRIMARY KEY,
  fleet_id           TEXT NOT NULL,
  employee_id        TEXT NOT NULL,
  alias_platform     TEXT NOT NULL,
  alias_ext_id       TEXT NOT NULL,
  canonical_platform TEXT NOT NULL,
  canonical_ext_id   TEXT NOT NULL,
  evidence           TEXT NOT NULL,
  first_upload_id    BIGINT NOT NULL REFERENCES hr_roster_upload(id),
  last_upload_id     BIGINT NOT NULL REFERENCES hr_roster_upload(id),
  verdict            TEXT CHECK (verdict IN ('same', 'different')),
  decided_by         TEXT,
  decided_at         TIMESTAMPTZ,
  decided_note       TEXT,
  UNIQUE (fleet_id, employee_id, alias_ext_id, canonical_ext_id)
);

/* The bridge, as rows: which platform accounts each employee on the LATEST
   export was matched to. For the payroll import that is still to be built —
   it joins on (fleet_id, employee_id) and needs nothing else from here. No
   document number is in it. */
CREATE OR REPLACE VIEW hr_employee_account AS
  SELECT r.fleet_id, r.employee_id, a ->> 'platform' AS platform, a ->> 'ext_id' AS ext_id,
         a ->> 'via' AS via, u.id AS upload_id, u.export_date
    FROM hr_roster_row r
    JOIN hr_roster_upload u ON u.id = r.upload_id
    CROSS JOIN LATERAL jsonb_array_elements(r.matched_accounts) a
   WHERE u.id = (SELECT id FROM hr_roster_upload ORDER BY export_date DESC, id DESC LIMIT 1);

COMMENT ON TABLE hr_roster_row IS
  'One row per employee per HR roster upload, keyed (upload, fleet, employee_id). Immutable: a newer upload adds rows and never edits these. passport_no and rta_permit_no are never returned by any route; emirates_id and licence_no only by /api/driver/profile.';
COMMENT ON TABLE hr_roster_proposal IS
  'Accounts HR filed under one employee, proposed as one person on #same-person with basis hr_roster. Never applied by anything: a verdict here is recorded, not folded.';
