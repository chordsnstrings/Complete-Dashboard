/* The fleet is part of a money event's identity, and the key had forgotten it.
   ─────────────────────────────────────────────────────────────────────────
   money_event is rebuilt from eight sources on every rollup, and one of them —
   the imported daily ledger statements — has been failing on every pass since
   the table was created:

     WARN [rollup] money_event import failed
       {"err":"duplicate key value violates unique constraint money_event_pkey"}

   Measured on production 2026-08-31: /api/money/sources over all time returns
   seven sources. statement_import is not among them. Every ledger statement
   figure is missing from the one table whose whole purpose is to say where a
   number came from — and #reconcile's expected-payout side is built from
   exactly those statements.

   The cause is a key that is narrower than the row it identifies.
   driver_statement_day is keyed (platform, fleet_id, name_key, day, source);
   money_event was keyed on every one of those but the fleet. So one person,
   working one day, appearing in BOTH businesses — which is the ordinary case
   here, since Ecosine and Egari share drivers — produced two source rows that
   collapsed onto one money_event key, and the whole INSERT died. Not the
   colliding row: the statement, for every driver, on every day.

   The refresh catches the error per source deliberately, so that one provider's
   broken table cannot cost the other seven their rows. That is the right rule
   and it is also why this was invisible: a hole that logs a warning and
   returns success is a hole nobody reads.

   Two fleets' money is not the same money, so fleet_id belongs in the key.
   Empty string rather than NULL, following the rule the table already states
   for its other key parts: a key cannot be written over expressions, and ''
   means "the provider gave none", which is comparable where NULL is not.

   Safe to change in place: refreshMoneyEvents DELETEs the whole table before
   it inserts, so there is no history here to migrate — only the shape of the
   next rebuild. */

UPDATE money_event SET fleet_id = '' WHERE fleet_id IS NULL;
ALTER TABLE money_event ALTER COLUMN fleet_id SET DEFAULT '';
ALTER TABLE money_event ALTER COLUMN fleet_id SET NOT NULL;

ALTER TABLE money_event DROP CONSTRAINT IF EXISTS money_event_pkey;
ALTER TABLE money_event ADD PRIMARY KEY
  (source, platform, fleet_id, kind, category, driver_ext_id,
   period_start, period_end, external_ref);

COMMENT ON COLUMN money_event.fleet_id IS
  'Part of the key. Ecosine and Egari share drivers, so one person on one day is two money events, and a key without the fleet collapsed them and failed the whole statement import.';
