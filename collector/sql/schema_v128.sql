-- v128: the fares a driver collects on, per account per Dubai day (FIX-STATUS
-- CARD-3; filled by src/card_fares.js after each card-payments read).
--
-- WHY A TABLE. Card payments are measured against the fares a driver collects
-- on — cash trips (trip_cash) and the hotel channel's pos-driver fares, paid
-- on the driver's own card machine (CARD-2b). Read live, those come through
-- trip_cash → trip_ext → trip_norm, which runs a LATERAL per trip: the whole
-- year of card payments took 19 s on production (2026-11-23), and phase 3
-- needs that whole span on every page that shows cash in notes. So the
-- collector sums the trips once per account and day, and every read is a
-- small join.
--
-- Keyed by ACCOUNT, not person: who an account belongs to (the person spine)
-- and who a card payment belongs to (card_id_person) are both decided at read
-- time, so a fold or a link applies at once, with no rebuild.
--
--   cash, cash_trips  trip_cash: completed trips the driver holds cash for,
--                     valued by Uber's own cash_collected where its payments
--                     report has it, else the fare (the cash text's figure)
--   cash_unvalued     of those, trips with no fare on record (cash_amount NULL):
--                     counted, never valued as AED 0 — the cash is then a floor
--   pos, pos_trips    trip_ext: completed hotel fares filed 'pos-driver'
--                     (pos-supervisor / cash-supervisor are not the driver's)
--
-- Rebuilt for the last 14 days on every hourly read, and in full (month by
-- month, from the day before the first card payment) once a day.

CREATE TABLE IF NOT EXISTS card_fare_day (
  platform       TEXT NOT NULL,
  driver_ext_id  TEXT NOT NULL,
  day            DATE NOT NULL,
  cash           NUMERIC(12,2) NOT NULL DEFAULT 0,
  cash_trips     INT NOT NULL DEFAULT 0,
  cash_unvalued  INT NOT NULL DEFAULT 0,
  pos            NUMERIC(12,2) NOT NULL DEFAULT 0,
  pos_trips      INT NOT NULL DEFAULT 0,
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, day)
);
CREATE INDEX IF NOT EXISTS card_fare_day_ext_idx ON card_fare_day (driver_ext_id, day);
