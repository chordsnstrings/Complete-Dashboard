/* How many days the figure on this row was actually measured over.
   ─────────────────────────────────────────────────────────────────────────
   driver_statement_day is one row per driver per day, and its name says so —
   which is why every reader has treated its net, tips, salik and cash as a
   measurement of that day. For the uber_rest slice they are not. Uber files
   this fleet's earnings as WEEKLY breakdowns, and src/rollup.js expands each
   one across the days it covers with `p.net / p.days`. Seven days of a week
   therefore carry a seventh of it each, and the value is identical on all
   seven, because it is one number wearing seven hats.

   Discovered by shipping it: the driver page grew a per-day Money column and
   production answered 309.88 for seven consecutive days, then 446.84 for the
   next seven. Real money, correctly totalled over any whole week — and a
   figure nobody measured on any single one of those days. This product has a
   standing rule that a number must come from a specific API call, and the
   whole reason /api/money/sources reports the GRAIN a provider answered at is
   that a weekly statement shown as seven daily figures is indistinguishable
   from seven measurements.

   So the grain travels with the money. period_days is what the provider's own
   report window was: 1 where a channel filed a day, 7 where it filed a week,
   NULL where the row predates this column or came from an operator import
   whose window is not recorded. A page can then say "a seventh of a week"
   instead of stating an allocation as a fact.

   Not a fix to the allocation itself — spreading is the right thing to do with
   a weekly total that has to join to days, and the alternative (attributing a
   week to one arbitrary day) is worse. The fix is that it stops being silent. */
ALTER TABLE driver_statement_day
  ADD COLUMN IF NOT EXISTS period_days INT;

COMMENT ON COLUMN driver_statement_day.period_days IS
  'The provider report window this row was expanded from, in days: 1 = the channel filed this day, 7 = a seventh of a week, NULL = unknown. A row with period_days > 1 is an allocation and must not be presented as a measurement of its day.';

/* And the same fact on the day record, so a reader of driver_day never has to
   join back to find out whether the money on the row was measured or spread.
   The MAX across a person's platforms: a day reached by one channel's daily
   figure and another's week is a mixed day, and the coarsest grain on it is
   the one that limits what can be claimed. */
ALTER TABLE driver_day
  ADD COLUMN IF NOT EXISTS money_period_days INT;

COMMENT ON COLUMN driver_day.money_period_days IS
  'The coarsest provider report window behind driver_day.money, in days. 1 means every channel on this day reported it as a day; anything larger means part of the figure is a longer period divided across its days, and the number is an allocation at this grain. NULL where nothing reported money.';
