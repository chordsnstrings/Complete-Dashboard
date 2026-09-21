/* `cash_opening` WAS SEEDED THE WRONG WAY ROUND.
   ─────────────────────────────────────────────────────────────────────────
   sql/schema_v78.sql states one sign convention and repeats it on every type:
   POSITIVE increases what the driver owes this company. Against that rule the
   registry it seeds is correct on seventeen of eighteen types and wrong on one.

     cash_deposit   -1   the driver hands cash in, so they hold less     ✓
     cash_opening   -1   ...                                             ✗

   An opening cash position is the cash a driver was ALREADY HOLDING when this
   ledger started. They have it; the company does not; they owe it. That is a
   POSITIVE obligation, and seeded at -1 it would have subtracted the whole
   opening position from the very exposure figure the 35% policy is enforced
   with — every driver starting the ledger looking safer than they are by twice
   whatever they were carrying.

   It was found while working out the numerator of that ratio, not by a test,
   because the constraint that makes a wrong sign impossible works off the
   registry: the composite key (type_code, direction) guarantees an ENTRY
   agrees with its TYPE, and can say nothing about whether the type itself is
   right. A rule stated in prose and applied eighteen times by hand is a rule
   that will be wrong once.

   ── why this is an UPDATE and not a new code ─────────────────────────────
   sql/schema_v78.sql says, in as many words, that changing what a type MEANS
   is a new code rather than an edit, because `book` and `direction` are copied
   onto every entry at write time and an edit would leave the register holding
   two meanings for one code. That reasoning is about types with entries
   against them. This one has none — the write path shipped after it and no
   opening position has been recorded anywhere — so there is no history to
   contradict, and a `cash_opening_v2` would leave a permanently confusing
   wrong-signed code in the registry for no benefit.

   The guard below is what keeps that honest: the update applies only while the
   type is unused. If any entry exists against it, the file does nothing and
   says so, and the correction becomes a new code as v78 requires. */
DO $$
DECLARE used INT;
BEGIN
  SELECT count(*) INTO used FROM driver_ledger WHERE type_code = 'cash_opening';
  IF used > 0 THEN
    RAISE NOTICE 'cash_opening has % entries against it — direction NOT changed. '
      'Correcting it now would leave two meanings for one code; add a new type instead.', used;
  ELSE
    /* The composite unique (code, direction) is the target of driver_ledger's
       foreign key. Nothing references this pair, so moving it is safe. */
    UPDATE ledger_type
       SET direction = 1,
           note = 'What a driver was already holding when this ledger started. POSITIVE: '
                  'they have the company''s cash, so they owe it. The only cash type with no '
                  'receipt, because a position carried in from a spreadsheet has none.'
     WHERE code = 'cash_opening' AND direction = -1;
  END IF;
END $$;

/* And the guard that stops the whole registry drifting from the rule again.
   Every type's direction is asserted here, by name, against the one sentence
   in sql/schema_v78.sql that governs them: positive increases what the driver
   owes. A type whose direction does not match this list fails the boot loudly
   rather than quietly mis-signing a balance — which is the failure mode that
   produced this file. */
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(code || ' is ' || direction, ', ') INTO bad
    FROM ledger_type
   WHERE (code IN ('cash_advance','salary_advance','charging_advance','opening_balance',
                   'cash_opening','salik','traffic_fine','damage','pay_out')
          AND direction <> 1)
      OR (code IN ('repayment','writeoff','refund','cash_deposit','deduction_waived',
                   'salary','commission','incentive','reimbursement')
          AND direction <> -1);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ledger_type directions disagree with the sign convention: %', bad;
  END IF;
END $$;
