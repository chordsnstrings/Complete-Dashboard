-- ---------------------------------------------------------------------------
-- money_event — every figure any provider has told us, in one shape
-- ---------------------------------------------------------------------------
-- The money in this product arrives through nine different API surfaces and
-- lands in five tables with five vocabularies. Uber's trip export carries no
-- price at all; its GraphQL breakdown carries a weekly net and a tree of named
-- components; its OAuth REST endpoint carries the same thing under different
-- words for one fleet only; Yango prices every trip AND publishes a weekly
-- driver summary AND a park ledger; the hotel channel prices every booking;
-- the ledger import carries months the APIs no longer serve.
--
-- Reading a fleet total therefore meant knowing which of five tables to trust
-- for which channel over which window — and the answer was encoded in one
-- function (api/income_sql.js chooseBasis) that picks a winner per platform
-- and DISCARDS the rest. That is the right rule for a total, and the wrong
-- place for it to be the only record: a figure nobody can trace back to the
-- call that produced it is a figure nobody can check.
--
-- So every provider figure is appended here, once, keeping:
--   * WHICH API said it            (source)
--   * WHAT the provider called it  (kind, category)
--   * WHAT GRAIN it was reported at (period_start..period_end)
--   * and the day, ONLY where the provider reported a single day
--
-- That last one is the discipline this table exists to enforce. A weekly
-- statement is not seven daily figures, and the moment it is stored as though
-- it were, a number nobody measured is indistinguishable from one somebody
-- did. `day` is NULL for a weekly row. Anything that needs a daily figure out
-- of a weekly one has to spread it deliberately, in the open, and say so.
--
-- Append-only from the tables the collectors already write: this adds no API
-- call and invents no value. It is the same numbers, in one shape, with their
-- provenance still attached.

CREATE TABLE IF NOT EXISTS money_event (
  -- The API surface, not the platform: Uber has three that carry money and
  -- they disagree, so "uber" is not an answer to "where did this come from".
  source        TEXT NOT NULL,
  platform      TEXT NOT NULL,
  fleet_id      TEXT,
  -- fare      what a rider paid for one trip
  -- payout    what the platform says it paid us for a period
  -- component a named line inside a payout, in the provider's own words
  -- ledger    a park/company transaction, neither a fare nor a payout
  kind          TEXT NOT NULL,
  -- Empty string rather than NULL on the three key parts: they are part of the
  -- primary key, and a key cannot be written over expressions. '' means "the
  -- provider gave none", which is the same thing NULL meant and is comparable.
  category      TEXT NOT NULL DEFAULT '',
  driver_ext_id TEXT NOT NULL DEFAULT '',
  driver_name   TEXT,
  -- The same fold every other table keys people by, so a person's money and
  -- a person's work can be counted together. See sql/schema_v20.sql.
  person_key    TEXT GENERATED ALWAYS AS (regexp_replace(
                  btrim(regexp_replace(lower(driver_name), '\s+', ' ', 'g')),
                  '(\m\w+)( \1)+', '\1', 'g')) STORED,
  plate         TEXT,
  -- The grain the PROVIDER reported at. Equal for a single day.
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  -- Set only where period_start = period_end. Never a spread, never inferred.
  day           DATE,
  amount        NUMERIC(14,2) NOT NULL,
  currency      TEXT DEFAULT 'AED',
  -- The provider's own id for the row where it has one — a trip id, a ledger
  -- transaction id — so a figure can be taken back to the record it came from.
  external_ref  TEXT NOT NULL DEFAULT '',
  ingested_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (source, platform, kind, category, driver_ext_id,
               period_start, period_end, external_ref)
);

-- The window predicate every reader uses: rows whose reported period overlaps
-- the window at all. An index on both ends, because a weekly row inside a
-- month is found by period_start and a monthly row containing a day is found
-- by period_end.
CREATE INDEX IF NOT EXISTS money_event_period_idx ON money_event (period_start, period_end);
CREATE INDEX IF NOT EXISTS money_event_day_idx ON money_event (day) WHERE day IS NOT NULL;
CREATE INDEX IF NOT EXISTS money_event_person_idx ON money_event (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';
CREATE INDEX IF NOT EXISTS money_event_source_idx ON money_event (source, platform);
