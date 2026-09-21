/* THE PERSON A DEBT BELONGS TO, AS A ROW WITH AN ID OF ITS OWN.
   ─────────────────────────────────────────────────────────────────────────
   WHAT THIS IS FOR. The driver advance ledger (sql/schema_v78.sql) records
   money the company lends a human being and money that human being pays back.
   Every other fact in this database is keyed on a PROVIDER's idea of who
   somebody is — (platform, driver_ext_id) — and that is not good enough to
   hang a debt on. This file gives a person an id this building owns.

   ── why not key the ledger on the platform account ────────────────────────
   The obvious design keys an entry on the account the operator clicked and
   resolves the person at read time, the way api/driver_routes.js:809-816
   already resolves a driver page. Three measurements say that is wrong, and
   each of them on its own would be enough.

   (1) FOR A LARGE PART OF THE ROSTER THERE IS NO ACCOUNT ID. The hotel channel
   files trips with a blank driver_ext_id, so api/driver_routes.js:286 builds
   the page key as

       coalesce(nullif(btrim(driver_ext_id),''), 'name:' || CANON(driver_name))

   — a LOWERCASED NAME. That file's own comment at :102-108 spells out the
   hazard it is living with: "a feed that starts spelling somebody 'Khan Khan'
   silently renames their id." A directory row may be renamed and re-found; a
   balance may not. One re-spelling upstream orphans the debt on a page nobody
   can reach, and two people whose names fold identically pool theirs.

   (2) THE READ-TIME LAYER MOVES ON ITS OWN, AND FASTER THAN person_key DOES.
   Moving person_key takes an edit to api/identity_map.js, a regeneration of
   sql/schema_v53.sql, a passing test and a deploy — four deliberate human acts.
   The boundary layer needs none:
     · src/identity_link.js:605-610 DELETEs every unconfirmed, unrejected link
       whose evidence no longer holds, on EVERY collector run. One person
       becomes two between passes, silently.
     · api/identity_links.js:73 lets shared_phone and shared_email links apply
       with no human involved at all.
     · POST /api/same-person/decide (api/sameperson_routes.js:128) is wrapped
       in wrap() and NOTHING ELSE — no requireAdmin, while the settings write
       at api/server.js:3564 carries one. Anybody who can reach the URL can
       fold two people's balances into one, or split one person's into two, by
       posting an alias id and a verdict with a free-text name.
   A debt that can be moved between two humans by an anonymous POST is not a
   debt this product may record.

   (3) A BALANCE COMPUTED THAT WAY CANNOT BE REPRODUCED. The resolution is
   recomputed per request from a table the collector rewrites, behind the
   30-second cache at api/identity_links.js:41. Finance reads an exposure
   figure, acts on it, and the same report over the same window answers
   differently a month later with no diff to point at. On a surface whose whole
   claim is provenance that is disqualifying.

   So the person is resolved ONCE, AT WRITE TIME, into a stored id, and the row
   records which resolver produced it. A later identity change becomes an
   explicit, logged re-attribution — never a recompute.

   ── why these two tables and not new ones ────────────────────────────────
   sql/schema.sql:28-43 already declares exactly this shape:

       driver             (id BIGSERIAL PRIMARY KEY, fleet_id, full_name, …)
       driver_platform_id (platform, external_id) -> driver_id

   and a grep over src/, api/ and test/ finds ZERO readers and ZERO writers of
   driver_platform_id anywhere in this codebase. The canonical person entity
   was designed at the start of this project and never wired up. Adopting it is
   better than adding a parallel one beside it: a second person table would
   become a sixth way to answer "who is this", and this product already has
   five (the register, the link table, person_key, the CANON name key, and the
   raw driver_name fold that api/analytics_routes.js:432-437 groups
   receivables on).

   Nothing in this file changes how any EXISTING page resolves a driver. The
   directory, the driver pages and every rollup keep the precedence they have.
   This is the key the LEDGER hangs on, and the ledger alone.

   ── a person may exist before any platform account does ──────────────────
   A new hire, or somebody paid only a salary, exists nowhere in this database:
   every person here is a by-product of a provider record (driver_compliance is
   PK (platform, driver_ext_id), so is driver_platform_state), and
   api/driver_routes.js:176 returns null for an id that seeds no row. A salary
   advance to somebody in their first week would have had no row to key on.
   driver.id is a BIGSERIAL that owes nothing to a provider, so a person can be
   minted by the advance entry itself and acquire accounts later. */

-- ---------------------------------------------------------------------------
-- The person.
-- ---------------------------------------------------------------------------

/* Where this row came from. A person minted by a finance clerk recording an
   advance is a different kind of record from one adopted off the roster, and a
   reader of the ledger a year from now must be able to tell them apart. */
ALTER TABLE driver ADD COLUMN IF NOT EXISTS created_by   TEXT;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE driver ADD COLUMN IF NOT EXISTS created_note TEXT;

/* HOW THIS PERSON SETTLES THE CASH THEY COLLECT, per person, because the
   operator states it varies between them.

     deposit_all      — every dirham collected is handed in, and the person is
                        paid their entitlement separately. Undeposited cash is
                        a live liability until a deposit records otherwise.
     net_against_pay  — the person keeps the cash and it is deducted from what
                        they are owed. The obligation is discharged by the pay
                        settlement, not by a handover.

   This is not decoration. Counting undeposited cash as exposure AND deducting
   the same cash from a person's pay charges them twice for one sum of money,
   and which of the two is correct depends entirely on this column. NULL means
   nobody has said, and a figure that depends on it must render ABSENT WITH A
   REASON rather than assume either. */
ALTER TABLE driver ADD COLUMN IF NOT EXISTS cash_rule TEXT;
ALTER TABLE driver DROP CONSTRAINT IF EXISTS driver_cash_rule_ck;
ALTER TABLE driver ADD CONSTRAINT driver_cash_rule_ck
  CHECK (cash_rule IS NULL OR cash_rule IN ('deposit_all', 'net_against_pay'));

/* WHAT THIS PERSON IS PAID ON — AND IT IS DOCUMENTATION, NOT A FORMULA.
   ─────────────────────────────────────────────────────────────────────────
   The operator's instruction is that this system RECORDS what payroll decided
   and never calculates it. Drivers are variously on a fixed salary, on
   commission, on a salary with incentives, and it differs person to person, so
   a reader of a recorded pay figure needs to know which arrangement produced
   it. That is all this column is for.

   No rate is stored, deliberately. A stored "30%" beside a revenue figure
   invites a reader to multiply, and when the recorded pay does not match —
   because deductions applied, or because payroll decided otherwise — the page
   would be contradicting itself in front of somebody whose wages are the
   subject. The basis is a label; nothing computes from it. */
ALTER TABLE driver ADD COLUMN IF NOT EXISTS pay_basis      TEXT;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS pay_basis_note TEXT;
ALTER TABLE driver DROP CONSTRAINT IF EXISTS driver_pay_basis_ck;
ALTER TABLE driver ADD CONSTRAINT driver_pay_basis_ck
  CHECK (pay_basis IS NULL OR pay_basis IN
    ('fixed_salary', 'commission', 'salary_plus_incentive', 'other'));

/* The name as the ledger knows it. driver.full_name exists already and is
   NULL on every row because nothing has ever written one; it is the column
   this file populates. Kept beside, and never instead of, the frozen name on
   each entry — a person may be renamed, an entry may not. */
CREATE INDEX IF NOT EXISTS driver_full_name_idx
  ON driver (lower(btrim(full_name)));

-- ---------------------------------------------------------------------------
-- The accounts that belong to that person.
-- ---------------------------------------------------------------------------

/* HOW THIS ACCOUNT CAME TO BE ATTACHED, recorded so a balance can state the
   resolution that produced it and reproduce it later.

     register:<key>        — api/identity_map.js named the pair.
     link:<alias>@<basis>  — driver_identity_link, with the basis it was
                             discovered on (shared_phone, shared_email, …).
     human:<name>          — somebody chose it on the entry screen, which is
                             the only basis that outranks the other two.
     account               — the operator clicked this account and no fold was
                             involved; it is its own person.

   The point of storing it is that api/identity_links.js:74-83 catches its own
   query failure and returns an EMPTY map — honest for a directory, a silent
   un-merge for money — and src/identity_link.js withdraws links on every run.
   A stored basis survives both. */
ALTER TABLE driver_platform_id ADD COLUMN IF NOT EXISTS basis      TEXT;
ALTER TABLE driver_platform_id ADD COLUMN IF NOT EXISTS linked_by  TEXT;
ALTER TABLE driver_platform_id ADD COLUMN IF NOT EXISTS linked_at  TIMESTAMPTZ NOT NULL DEFAULT now();
/* An account detached from a person is not deleted — it is closed, with a
   reason, because the entries that resolved through it must still read. */
ALTER TABLE driver_platform_id ADD COLUMN IF NOT EXISTS detached_at     TIMESTAMPTZ;
ALTER TABLE driver_platform_id ADD COLUMN IF NOT EXISTS detached_reason TEXT;

/* The lookup the write path makes on every entry: given the account somebody
   clicked, which person is that? Partial on live rows, because a detached
   account must not resolve. */
CREATE INDEX IF NOT EXISTS driver_platform_id_person_idx
  ON driver_platform_id (driver_id) WHERE detached_at IS NULL;

/* And the scan the ledger makes: every account of one person, including the
   synthesised name: keys the hotel channel produces, which are stored here as
   external_id values exactly as api/driver_routes.js:286 builds them. Storing
   them is what lets a hotel-only person be addressed at all; resolving THROUGH
   them at read time is what this file refuses to do. */
CREATE INDEX IF NOT EXISTS driver_platform_id_ext_idx
  ON driver_platform_id (external_id);

COMMENT ON TABLE driver IS
  'The canonical person, declared in sql/schema.sql at the start of this '
  'project and first written by the advance ledger (sql/schema_v78.sql). '
  'A person may exist here with no platform account at all. This id is what '
  'money is keyed on; it is NOT what the driver pages, the directory or any '
  'rollup resolve a driver by, and it deliberately does not change how they do.';

COMMENT ON TABLE driver_platform_id IS
  'Which provider accounts belong to one person, resolved once at write time '
  'and stored with the basis that decided it, so a balance can be reproduced '
  'after the identity register or the link table has moved.';
