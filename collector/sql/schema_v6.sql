-- Fields the Uber trip report carries that were being discarded.
--
-- `Service type` is Uber's own personal-vs-business split. Across a full year
-- of this fleet's 30,296 trips it holds exactly one value, personal_transport
-- — there is no Uber for Business work in the record. Storing it means a
-- business trip shows up the day one arrives, rather than staying invisible
-- until somebody thinks to read the raw JSON again.
--
-- `Vehicle UUID` is Uber's own id for the car. The plate already joins the
-- sources, but a plate is a string a human typed somewhere; the UUID joins a
-- trip to vehicle_profile and vehicle_document exactly.
ALTER TABLE trip ADD COLUMN IF NOT EXISTS service_type    TEXT;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS vehicle_ext_id  TEXT;

CREATE INDEX IF NOT EXISTS trip_service_type_idx ON trip (service_type) WHERE service_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_vehicle_ext_idx  ON trip (vehicle_ext_id) WHERE vehicle_ext_id IS NOT NULL;

-- Payment types arrive in mixed case from Uber ("CASH" beside "cash",
-- "OFFLINE" beside "offline"), which split one category into two everywhere it
-- was grouped. Normalise what is stored; the collector lower-cases new rows on
-- the way in.
UPDATE trip SET payment_type = lower(trim(payment_type))
WHERE payment_type IS NOT NULL AND payment_type <> lower(trim(payment_type));
