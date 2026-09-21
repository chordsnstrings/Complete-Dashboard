/* THE DRIVER'S CURRENT ACCOUNT: what they owe us, what we owe them.
   ─────────────────────────────────────────────────────────────────────────
   WHAT THIS IS FOR. Drivers take advances monthly — in cash, as a salary
   advance, and as charging credit — and repay them. They also hold cash they
   collected from fares, carry deductions (Salik, fines, damage), and are paid
   by this company rather than by any platform. All of that is one running
   position between one human being and this company, and none of it exists in
   this database today.

   ── the four things every row states, separately ──────────────────────────
   This is not double-entry. Double-entry would need the company's own cash and
   bank accounts modelled, and this product holds neither — inventing an
   account nobody can measure is precisely what the house principle forbids.
   What it borrows from double-entry is the discipline of not collapsing
   distinct facts into one column:

     book         which sub-ledger this moves: advance, cash, deduction, pay.
     type         what kind of thing it is, from an extensible registry.
     amount       signed, on ONE convention (below).
     settles_via  how the value physically moved — or that it did not.

   Collapse `type` and `settles_via` and you lose the ability to answer "how
   much physical cash left the office this month", which is the question a cash
   control actually asks. A charging advance's value goes to a third party and
   never touches the driver's hands; a salary advance recovered by payroll
   touches no cash at all; a repayment taken out of fares the driver is already
   holding is a transfer between two obligations. Three different facts about
   where this company's money is.

   ── ONE SIGN CONVENTION, AND IT IS THE DRIVER'S OBLIGATION ────────────────
   POSITIVE increases what the driver owes this company. NEGATIVE decreases it.
   That one sentence has to hold across all four books or no total is
   meaningful:

     cash_advance   +   we handed over money
     repayment      -   they gave it back
     salik          +   we paid a toll on their behalf
     deposit        -   they handed in cash they were holding
     salary         -   we owe them for the month
     pay_out        +   we paid them, discharging what we owed

   ── why the sign cannot be wrong ──────────────────────────────────────────
   A row entered the wrong way round is the worst defect this table can carry:
   it moves a balance by twice the amount, in the direction nobody checks. A
   CHECK constraint cannot reach another table to compare a type's direction,
   and a trigger would put the rule somewhere a reader of this file would not
   find it. So the direction is carried on the row AND tied to the type by a
   COMPOSITE foreign key — (type_code, direction) references the registry's own
   (code, direction). The database then refuses a row whose direction does not
   match its type, declaratively, and a plain CHECK ties the amount's sign to
   the direction. Neither can drift from the other.

   ── nothing is ever deleted or amended ────────────────────────────────────
   No UPDATE of an amount, no DELETE, ever. A mistake is corrected by a
   REVERSING entry that points at the row it undoes. That is what makes the
   register defensible six months later, and it is why `entry_source` exists:
   this repo's own acceptance ritual (CLAUDE.md, "every modal filled") would
   otherwise write permanent rows against real named humans every time somebody
   proved the feature works. A `verification` row can exist and can never be
   summed — the balance view excludes it by construction, not by a WHERE clause
   somebody has to remember.

   ── and it is NOT money_event ─────────────────────────────────────────────
   money_event (sql/schema_v42.sql) looks exactly like the right home and is
   the first place an implementer reaches for. src/rollup.js:491 DELETEs and
   rebuilds it whole on every pass, quarter-hourly, from five collector-derived
   sources at :338-425. A clerk-entered row placed there survives until the
   next pass and then vanishes, with the page still serving a cached balance
   that includes it. Nothing in src/rollup.js may read or write this table;
   where a balance must appear beside provider money, it joins at READ time. */

-- ---------------------------------------------------------------------------
-- The type registry: extensible without a migration, constrained by a key.
-- ---------------------------------------------------------------------------

/* The operator's instruction is that the advance FORMATS are cash, salary and
   charging today and that more must be addable later. A hard enum would need a
   schema file for each new one; a free-text column would let `salik`, `Salik`
   and `salk` become three deduction types nobody can total. So: a table, with
   every entry holding a foreign key into it.

   The cost of a registry is real and is stated here rather than discovered: a
   new type is a ROW, which means it does not pass through code review the way
   a new enum value would. `active` is how a type is retired — never DELETE,
   because entries reference it and their history must still read. */
CREATE TABLE IF NOT EXISTS ledger_type (
  code       TEXT PRIMARY KEY,
  /* Which sub-ledger this moves. A deposit settles CASH the driver is holding
     and must not reduce an ADVANCE balance; totalling them into one number is
     how a person who has handed in their takings reads as having repaid a
     loan. */
  book       TEXT NOT NULL,
  label      TEXT NOT NULL,
  /* +1 increases what the driver owes this company, -1 decreases it. Half of
     the composite key that stops a row being entered the wrong way round. */
  direction  SMALLINT NOT NULL,
  /* Whether a human entering this type must attach a photograph.
     THE RULE, so that a new type is classified rather than guessed: proof is
     required where money or goods PHYSICALLY CHANGED HANDS and somebody can
     photograph the evidence — a handover, a deposit, a fine, a reimbursement.
     It is not required where the entry records a DECISION or a PERIOD FIGURE,
     which has no photograph to take: an opening balance carried in from a
     spreadsheet, a month of tolls read off a statement, what payroll decided,
     a waiver, a write-off.
     A write-off is the most consequential row in this table — it is money
     ceasing to be owed — and it is exempt here because no photograph of it
     exists, NOT because it needs less control. Its control is an admin gate on
     the route and, when ULM arrives, an approver. */
  needs_proof BOOLEAN NOT NULL DEFAULT true,
  active     BOOLEAN NOT NULL DEFAULT true,
  sort       INT NOT NULL DEFAULT 100,
  /* What this type MEANS, in words, because a code is not self-explanatory to
     the person who has to decide which one they are looking at. */
  note       TEXT NOT NULL,
  CONSTRAINT ledger_type_book_ck CHECK (book IN ('advance', 'cash', 'deduction', 'pay')),
  CONSTRAINT ledger_type_dir_ck  CHECK (direction IN (-1, 1)),
  /* The target of the composite foreign key below. */
  CONSTRAINT ledger_type_code_dir_uq UNIQUE (code, direction)
);

INSERT INTO ledger_type (code, book, label, direction, needs_proof, sort, note) VALUES
  ('cash_advance',      'advance',   'Cash advance',            1, true,  10,
   'Cash handed to the driver. The company''s cash falls and the driver''s obligation rises on the same day.'),
  ('salary_advance',    'advance',   'Salary advance',          1, true,  20,
   'An advance against future pay. Recovered by a deduction from a pay run this system records but does not run.'),
  ('charging_advance',  'advance',   'Charging advance',        1, true,  30,
   'Charging paid for on the driver''s behalf. Always a human entry: a charger meters a VEHICLE, and api/unauthorized_sql.js:62-101 records that this building has no ground truth for who was in one.'),
  ('opening_balance',   'advance',   'Opening balance',         1, false, 40,
   'What was outstanding when this ledger started, carried in from a spreadsheet. The ONLY advance type with no receipt, because history has none.'),
  ('repayment',         'advance',   'Repayment',              -1, true,  50,
   'Money returned against an advance. How it arrived is settles_via, not a separate type.'),
  ('writeoff',          'advance',   'Written off',            -1, false, 60,
   'Bad debt: the company deciding a balance will not be recovered. Never summed with repayments into one "collected" figure — one is money that came back and one is money that did not. No photograph exists of a decision, so this type is exempt from proof and MUST be admin-gated on the route instead.'),
  ('refund',            'advance',   'Refund to driver',       -1, true,  70,
   'The company returning money to the driver — an overcharge corrected, or a cost they bore that was ours.'),

  ('cash_deposit',      'cash',      'Cash handed in',         -1, true,  110,
   'Fare cash returned to the company. Reduces what the driver is holding; it does NOT repay an advance.'),
  ('cash_opening',      'cash',      'Opening cash position',  -1, false, 120,
   'What a driver was holding when this ledger started. Without it, cash in hand reads as every cash fare since the person joined.'),

  ('salik',             'deduction', 'Salik / tolls',           1, false, 210,
   'Road tolls recovered from the driver, entered as a period figure. driver_statement_day.salik may already report some of it — check whether that figure is net of the fare before anything reads both.'),
  ('traffic_fine',      'deduction', 'Traffic fine',            1, true,  220,
   'A fine attributed to the driver. Carries the same vehicle-to-person attribution problem as charging.'),
  ('damage',            'deduction', 'Damage / excess',         1, true,  230,
   'Repair cost or insurance excess charged to the driver.'),
  ('deduction_waived',  'deduction', 'Deduction waived',       -1, false, 240,
   'A deduction cancelled. A reversal of a specific row is reverses_id; this is a decision not to pursue one.'),

  ('salary',            'pay',       'Salary',                 -1, false, 310,
   'What payroll decided for the period. RECORDED, never calculated — this system does not run payroll and must not appear to.'),
  ('commission',        'pay',       'Commission',             -1, false, 320,
   'A revenue share payroll decided. Recorded for the same reason.'),
  ('incentive',         'pay',       'Incentive / bonus',      -1, false, 330,
   'A target, rating or peak-period payment payroll decided.'),
  ('reimbursement',     'pay',       'Reimbursement',          -1, true,  340,
   'The driver spent their own money on the company''s behalf. Runs the opposite way to a charging advance and must never net against one silently.'),
  ('pay_out',           'pay',       'Paid to driver',          1, true,  350,
   'The company settling what it owed. Discharges the pay book; it is not a deduction.')
/* DO UPDATE, not DO NOTHING, for the DESCRIPTIVE fields: a corrected label or
   a clearer note is worthless if it only reaches databases that have never run
   this file, and src/db.js replays a file whose sha has changed.

   `book` and `direction` are deliberately NOT updated. Both are copied onto
   every entry at write time, so changing a type's direction here would not
   restate the rows already written — it would leave the register holding two
   different meanings for one code, which is the silent version of the defect
   this table's composite key exists to prevent. Changing what a type MEANS is
   a new code, not an edit. */
ON CONFLICT (code) DO UPDATE SET
  label       = EXCLUDED.label,
  needs_proof = EXCLUDED.needs_proof,
  sort        = EXCLUDED.sort,
  note        = EXCLUDED.note;

-- ---------------------------------------------------------------------------
-- The entries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_ledger (
  id           BIGSERIAL PRIMARY KEY,

  /* THE PERSON, RESOLVED ONCE AT WRITE TIME. sql/schema_v77.sql argues this at
     length: the read-time fold moves on its own (src/identity_link.js:605-610
     withdraws links on every collector run) and POST /api/same-person/decide
     carries no auth, so a debt resolved per-request could be moved between two
     humans by an anonymous POST. */
  person_id    BIGINT NOT NULL REFERENCES driver(id),
  /* The name the person entering this SAW, frozen. An upstream rename must not
     make a year-old entry unrecognisable to the person defending it. */
  person_name  TEXT NOT NULL,
  /* Which resolver decided: register:<key> | link:<alias>@<basis> |
     human:<name> | account. This is what lets a balance state "as resolved on
     2026-09-21" and reproduce it after the register has moved. */
  resolved_from TEXT NOT NULL,
  /* The account the operator clicked, as EVIDENCE and never as the key. For
     the hotel channel this is the synthesised 'name:…' string from
     api/driver_routes.js:286, which is exactly why it cannot be the key. */
  acct_platform TEXT,
  acct_ext_id   TEXT,

  type_code    TEXT     NOT NULL,
  direction    SMALLINT NOT NULL,
  book         TEXT     NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'AED',

  /* How the value moved. `none` is a real answer: a salary advance recovered
     by payroll and cash reclassified against pay both move no cash at all. */
  settles_via  TEXT,

  /* THE DAY THE MONEY MOVED, as a Dubai calendar date — this repo's calendar
     everywhere (api/window.js, and `AT TIME ZONE 'Asia/Dubai'` throughout the
     SQL). Distinct from entered_at, which is the UTC instant somebody typed
     it: a charging statement arrives weeks after the month it covers, and a
     balance "as of 30 September" computed in October and again in November
     will legitimately differ. Both columns exist so the page can say so. */
  effective_on DATE NOT NULL,
  /* A salary or a month of tolls covers a span, not a day. Null for an event. */
  period_start DATE,
  period_end   DATE,

  entered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* One of the four supervisor codes until ULM exists. A fixed list rather
     than free text because `requested_by` in this codebase already proved what
     free text does to an audit column: one person becomes three spellings. */
  entered_by   TEXT NOT NULL,
  /* Attribution, not authentication — anybody who can reach the URL can write
     here until ULM lands. NOTE: Express reports the proxy's address unless
     `trust proxy` is set, and it is set NOWHERE in this app today; a route
     writing this column before that is fixed records the same useless address
     on every row. */
  entered_ip   INET,
  /* Reserved so ULM slots in without a migration or a backfill. */
  actor_id     BIGINT,

  /* The sentence a page prints. Same role as driver_identity_link.evidence:
     it is what makes the entry arguable by somebody who was not there. */
  note         TEXT NOT NULL,
  /* A charging statement line, a bank reference, a payroll run, a fine number. */
  source_ref   TEXT,

  /* manual       — a human entered it and it counts.
     import       — came from a spreadsheet, and it counts.
     verification — written to prove the feature works. EXCLUDED FROM EVERY
                    BALANCE BY CONSTRUCTION, because this repo's acceptance
                    ritual would otherwise leave permanent debt against real
                    people every time somebody filled the modal. */
  entry_source TEXT NOT NULL DEFAULT 'manual',
  import_batch TEXT,

  /* The row this one undoes. Never a DELETE and never an UPDATE of an amount. */
  reverses_id  BIGINT REFERENCES driver_ledger(id),

  /* The receipt, by digest. Deliberately NOT a unique reference: if the same
     photograph is attached to two entries that must be VISIBLE — a dedupe that
     silently reuses a receipt turns "100% of entries carry proof" into a claim
     about bytes rather than about events. */
  receipt_sha  TEXT,

  /* Sign must agree with direction, and direction must agree with the type.
     The second is the composite FK below — a CHECK cannot reach another table,
     and a trigger would hide the rule from a reader of this file. */
  CONSTRAINT driver_ledger_sign_ck   CHECK (sign(amount)::smallint = direction),
  CONSTRAINT driver_ledger_nonzero_ck CHECK (amount <> 0),
  CONSTRAINT driver_ledger_source_ck CHECK (entry_source IN ('manual', 'import', 'verification')),
  CONSTRAINT driver_ledger_period_ck CHECK (
    (period_start IS NULL) = (period_end IS NULL)
    AND (period_start IS NULL OR period_start <= period_end)),
  CONSTRAINT driver_ledger_settles_ck CHECK (settles_via IS NULL OR settles_via IN
    ('cash', 'bank', 'payout_deduction', 'cash_in_hand', 'netted_against_pay',
     'third_party', 'none')),
  /* A row may not reverse itself. */
  CONSTRAINT driver_ledger_self_ck   CHECK (reverses_id IS NULL OR reverses_id <> id),
  /* THE ONE THAT MATTERS: a type's direction is the type's, not the writer's. */
  CONSTRAINT driver_ledger_type_fk FOREIGN KEY (type_code, direction)
    REFERENCES ledger_type (code, direction)
);

/* The balance query: one person, one book, in date order. */
CREATE INDEX IF NOT EXISTS driver_ledger_person_idx
  ON driver_ledger (person_id, book, effective_on);
/* The register page: everything in a window, newest first. */
CREATE INDEX IF NOT EXISTS driver_ledger_when_idx
  ON driver_ledger (effective_on DESC);
/* "Which entries has this reversal undone", and the guard against reversing
   one row twice. */
CREATE UNIQUE INDEX IF NOT EXISTS driver_ledger_reverses_uq
  ON driver_ledger (reverses_id) WHERE reverses_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The proof.
-- ---------------------------------------------------------------------------

/* Bytes in Postgres, keyed by digest — the same shape driver_photo
   (sql/schema_v63.sql:33) already proved on this deployment, and for the same
   reason: both application services run on ephemeral disk, so nothing written
   to a filesystem survives. The database is db-s-2vcpu-4gb with 60 GB; at a
   compressed ~150 KB a receipt and a few hundred entries a month this is
   ~450 MB a year, which is immaterial against that.

   Compression happens in the BROWSER before the POST. A basic-xxs instance is
   512 MB and also serves every page in this product; decoding a 12-megapixel
   photograph there to resize it is how that container dies. */
CREATE TABLE IF NOT EXISTS driver_ledger_receipt (
  sha256       TEXT PRIMARY KEY,
  bytes        BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  byte_len     INTEGER NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by  TEXT,
  uploaded_ip  INET,
  /* Retention is twelve months by the operator's instruction. THE ENTRY
     OUTLIVES ITS PROOF: the ledger row is permanent and the image is not, so
     an expired receipt must render "held until <date>, since expired" rather
     than looking like an entry that never had one. */
  expires_on   DATE NOT NULL,
  CONSTRAINT driver_ledger_receipt_type_ck
    CHECK (content_type IN ('image/jpeg', 'image/webp', 'image/png')),
  CONSTRAINT driver_ledger_receipt_len_ck CHECK (byte_len > 0)
);
CREATE INDEX IF NOT EXISTS driver_ledger_receipt_expiry_idx
  ON driver_ledger_receipt (expires_on);

/* Why an entry has no receipt, when it has none — never a silent absence.
   Same relationship driver_photo_miss (sql/schema_v64.sql:28) has to
   driver_photo, and for the same house reason. */
CREATE TABLE IF NOT EXISTS driver_ledger_receipt_miss (
  entry_id BIGINT PRIMARY KEY REFERENCES driver_ledger(id),
  reason   TEXT NOT NULL,
  noted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The policy, and its own history.
-- ---------------------------------------------------------------------------

/* The operator keeps total exposure within 35% of the revenue a driver
   generates, and says the figure will change and will later belong to a user
   group. So it is stored, not compiled in — and it is APPEND-ONLY with an
   effective date, because a driver refused an advance at 35% and approved at
   45% a fortnight later is a decision somebody will have to explain. A page
   showing a ratio must be able to name the threshold that was in force, not
   only today's.

   NOT app_setting (sql/schema.sql:206): that is the AES-encrypted credential
   store, it is admin-gated, and src/settings.js:358 deletes a key outright
   with no history. A policy threshold is not a secret and its history is the
   point. */
CREATE TABLE IF NOT EXISTS ledger_policy (
  id             BIGSERIAL PRIMARY KEY,
  /* 'global' today. Reserved for the user group that will own it. */
  scope          TEXT NOT NULL DEFAULT 'global',
  pct            NUMERIC(5,2) NOT NULL,
  effective_from DATE NOT NULL,
  set_by         TEXT NOT NULL,
  set_ip         INET,
  set_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  note           TEXT,
  CONSTRAINT ledger_policy_pct_ck CHECK (pct > 0 AND pct <= 1000)
);
CREATE INDEX IF NOT EXISTS ledger_policy_scope_idx
  ON ledger_policy (scope, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Every attempt, not every success.
-- ---------------------------------------------------------------------------

/* An append-only entry table records only the writes that SUCCEEDED. The
   refused ones, the duplicates and the mis-aimed ones are the half a forensic
   question is actually about — "who tried to put AED 20,000 against the wrong
   person on the 3rd" has no answer without this table. */
CREATE TABLE IF NOT EXISTS driver_ledger_audit (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor    TEXT,
  ip       INET,
  action   TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  /* In words. A refusal that says only 'invalid' teaches nobody anything. */
  why      TEXT,
  entry_id BIGINT REFERENCES driver_ledger(id),
  person_id BIGINT REFERENCES driver(id),
  /* What was attempted, as sent. Bytes of an image are never stored here. */
  payload  JSONB,
  CONSTRAINT driver_ledger_audit_outcome_ck CHECK (outcome IN ('accepted', 'refused'))
);
CREATE INDEX IF NOT EXISTS driver_ledger_audit_when_idx ON driver_ledger_audit (at DESC);
CREATE INDEX IF NOT EXISTS driver_ledger_audit_person_idx ON driver_ledger_audit (person_id, at DESC);

COMMENT ON TABLE driver_ledger IS
  'The driver current account: advances, repayments, cash deposits, deductions '
  'and recorded pay, one signed row per event, append-only. Positive increases '
  'what the driver owes this company. Never written by src/rollup.js.';
