# Top-performer trip analysis — Sep 2025 → Aug 2026

Ad-hoc analysis assets. **Nothing here is imported by the collector or the API.**
Adding, editing or deleting these files cannot affect the running dashboard.

| File | What it is |
|---|---|
| `top-performer-analysis.md` | The analysis pack: 34 numbered PostgreSQL queries in 5 modules, plus how to read each result and what to do about it. |
| `dubai-season-calendar.md` | Dubai demand-seasonality calendar for the window, with a confidence register separating confirmed dates from estimates. |
| `season_calendar.sql` | The calendar as a day-grain table (361 rows) to join onto daily trip counts. |

## Before you run anything

**The queries are read-only** (`SELECT` / `WITH` only) with one exception:
`season_calendar.sql` begins `DROP TABLE IF EXISTS season_calendar; CREATE TABLE ... AS`.
Run that one in a scratch schema (`SET search_path = scratch;`) or against a read
replica you don't mind writing to — or paste its body in as a CTE instead.

**Run the three coverage audits first** — §5 "Run order", step 0, then `B1` and `C1`.
They decide whether the numbers below them mean anything. The three constraints
that make this necessary:

- `hours_online` is NULL for 232 of 241 drivers, so any average over it silently
  reports the handful of Yango drivers as if it were the fleet.
- `trip.price` is NULL on every Uber row, and Uber is most of this fleet's work.
  Money bases differ per platform and must not be summed.
- FMS writes GPS-inferred twins of trips the ride platforms already reported.
  Every demand query filters `trip_norm.is_booking`.

Days are Dubai days throughout (`trip_norm.local_day`). Drivers are identified by
`trip.person_key`, not by plate.

## Provenance

The seasonality calendar's war-period figures (airspace restrictions, DXB traffic,
hotel occupancy) came from live web research, not from the fleet database. Confirm
them against your own sources before quoting them. The analysis itself does not
depend on those dates: `E5` detects shocks statistically from `metric_break`.
