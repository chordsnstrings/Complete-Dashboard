-- What each provider actually sends, recorded rather than remembered.
--
-- Every collector maps a chosen subset of a response into columns. The rest is
-- discarded at the door, and six months later nobody can answer "does Uber tell
-- us whether a trip was corporate?" without reading the collector and guessing.
-- For rows we keep, /api/schema/raw-fields answers it from the stored payload.
-- For surfaces we call but do not persist — a driver roster, a ledger page, a
-- vehicle list — there is nothing to inspect at all.
--
-- This table is that inspection: one row per provider surface per probe, with
-- the field names, how often each is filled, and the distinct values for fields
-- narrow enough to be a dimension. It stores SHAPE, never records: a field with
-- more than a handful of distinct values has its contents suppressed, because
-- the question being answered is "what is available", not "what did it say".
CREATE TABLE IF NOT EXISTS provider_probe (
  provider     TEXT NOT NULL,
  surface      TEXT NOT NULL,
  ok           BOOLEAN NOT NULL,
  http_status  INT,
  record_count INT,
  top_keys     TEXT[],
  fields       JSONB,        -- [{key, type, fill_pct, distinct_seen, values|null}]
  unmapped     TEXT[],       -- fields with no matching column on the table we load into
  error        TEXT,
  note         TEXT,
  probed_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (provider, surface)
);

CREATE INDEX IF NOT EXISTS provider_probe_at_idx ON provider_probe (probed_at DESC);

COMMENT ON TABLE provider_probe IS
  'Shape of each provider surface the collectors call: field names, fill rates, and values only for fields narrow enough to be a dimension. Never records.';
COMMENT ON COLUMN provider_probe.unmapped IS
  'Fields the provider sends that no column on our side holds. This is the list that answers "what else could we be collecting".';

-- The counterparty, as the provider describes it.
--
-- The corporate channel's property list carries `tripApprovalRequired`,
-- `tripPurposeRequired`, `active`, an address and a phone number, and the
-- collector was keeping only the name. Without the approval flag, the leakage
-- report "charged with no authorisation on file" fired on 1,095 of 1,254
-- bookings — 87% — because most properties do not use the approval workflow at
-- all. A finding that fires on seven bookings in eight is not a finding, and
-- this one names people.
CREATE TABLE IF NOT EXISTS partner (
  platform          TEXT NOT NULL,
  partner_id        TEXT NOT NULL,
  name              TEXT,
  active            BOOLEAN,
  address           TEXT,
  phone             TEXT,
  approval_required BOOLEAN,   -- does a booking here need an authorisation?
  purpose_required  BOOLEAN,   -- must the traveller state why?
  editable_amount   BOOLEAN,
  raw               JSONB,
  updated_at        TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, partner_id)
);
CREATE INDEX IF NOT EXISTS partner_name_idx ON partner (name);

COMMENT ON COLUMN partner.approval_required IS
  'Whether this counterparty''s own booking workflow requires an authorisation. A missing authorisation is only evidence of anything where this is true.';
