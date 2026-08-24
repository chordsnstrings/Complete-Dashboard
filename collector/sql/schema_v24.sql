-- A report window longer than a billing cycle is a smear, not a statement.
--
-- Two collectors stamped their RUN's window onto rows that describe something
-- much shorter. The Bolt roster wrote a driver's snapshot under the backfill's
-- whole year; Yango's summary endpoint aggregates whatever range it is asked,
-- so a year-long ask produced one 366-day totals row per driver — ten of them
-- smearing AED 17,000 at a flat forty-six dirhams a day across every month of
-- the record, including months before Yango had carried a single trip.
--
-- Both collectors are fixed (Bolt clamps to the gateway's 31-day maximum;
-- Yango asks in Monday-anchored calendar weeks), but their upsert key is the
-- window, so the fixed collectors write NEW rows beside the old smears rather
-- than over them — and the day-level resolution keeps giving the smear every
-- day no honest row covers, which is most of the year.
--
-- No provider on this fleet issues a statement longer than a calendar month:
-- Uber pays weekly, Yango summarises what it is asked (now weekly), Bolt's
-- gateway refuses anything over 31 days. Sixty-two days is double the longest
-- legitimate window; anything past it is one of these run-stamps. The next
-- rollup pass rebuilds driver_payout_day without them, and the next collection
-- re-fetches the same money under honest windows.
DELETE FROM driver_performance
WHERE period_end - period_start > 62;

-- And the same rows out of the materialised day table (sql/schema_v23.sql):
-- the refresher rebuilds it after every collection, but "after every
-- collection" is up to a quarter hour away, and a migration that half-purges —
-- source rows gone, their expansion still being served — leaves every money
-- page wrong in a way nothing on the page can explain. The day rows carry
-- their period bounds precisely so a correction like this can reach them.
DELETE FROM driver_payout_day
WHERE period_end - period_start > 62;
