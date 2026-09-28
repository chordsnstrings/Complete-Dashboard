-- v87 — fleets named from the platforms (ULM-DESIGN §3).
-- ──────────────────────────────────────────────────────────────────────────
-- The fleet's name was typed: schema.sql seeds 'Ecosine Transports LLC' and
-- 'Egari Luxury', the front end hard-codes "Ecosine"/"Egari" in about forty
-- places, and neither was ever read from a platform. The operator's ruling
-- (2026-09-26): the name comes FROM the platforms, the brand is the common
-- part of what they call the fleet, nothing is hard-coded, everything is real.
--
-- So this records what each platform reports — its accounts, their real ids
-- and the names they give — and which fleet each account belongs to. The
-- brand is derived from those names (src/fleet_names.js) and written back to
-- fleet.name, which is what /api/auth/me already returns.
--
-- Additive only: new tables and new nullable columns. The two existing
-- fleets keep their ids ('ecosine', 'egari') so every stored row stays valid,
-- and nothing is seeded — an account exists here only once a platform (or our
-- own stored CABMAN snapshots) has reported it.

-- One row per account a platform reports: an Uber organisation, a Yango
-- park, a Bolt company, an FMS login, a CABMAN company behind an interface,
-- a hotel domain. `account_id` is the platform's own stable id, never one we
-- made up; for CABMAN it is "<InterfaceUniqueId>/<CompanyName>", because each
-- company behind the interface is its own account (§3.3.1) — the Ecosine
-- interface carries "Ecosine Transports LLC" and "Sahalat".
--
-- status:  new      reported, nobody has decided
--          linked   belongs to fleet_id; its names name that fleet
--          ignored  not ours (an Uber parent org, another operator's cars)
-- filed_fleet: where TODAY's configuration (src/config.js) files this
--   account's rows, whatever its status — the evidence of where its history
--   went, which is not the same thing as where it belongs.
-- link_basis: 'configuration' when the link records what src/config.js
--   already did (the account's id is the one configured for that fleet, so
--   the link moves nobody's rows), 'person' when an Owner confirmed it.
-- detail: counts and evidence only — names and ids, never a token.
CREATE TABLE IF NOT EXISTS platform_account (
  id             bigserial PRIMARY KEY,
  platform       text NOT NULL,
  account_id     text NOT NULL,
  fleet_id       text REFERENCES fleet(id),
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'linked', 'ignored')),
  reported_name  text,
  name_reason    text,
  reported_at    timestamptz,
  source_call    text,
  filed_fleet    text,
  link_basis     text CHECK (link_basis IS NULL OR link_basis IN ('configuration', 'person')),
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (platform, account_id),
  CHECK ((status = 'linked') = (fleet_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS platform_account_fleet ON platform_account (fleet_id) WHERE status = 'linked';

-- Every name an account has been reported under, one row per run of the same
-- name. A platform renaming the business shows here as a new row, and once on
-- the fleet's page as "renamed by Uber on <date>" (§3.2 rule 9).
CREATE TABLE IF NOT EXISTS platform_account_name (
  id              bigserial PRIMARY KEY,
  account_pk      bigint NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  name            text NOT NULL,
  source_call     text,
  first_reported  timestamptz NOT NULL DEFAULT now(),
  last_reported   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_account_name_acct ON platform_account_name (account_pk, first_reported DESC);

-- The vehicles an account reported, for the linking evidence: "how many
-- plates does this account share with each fleet" (§3.3.2) is counted from
-- these against our own rows. Filled for the platforms that name the account
-- PER VEHICLE (CABMAN's CompanyName, FMS's ClientName); for the others the
-- account's plates are its own filed trips.
CREATE TABLE IF NOT EXISTS platform_account_vehicle (
  account_pk    bigint NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  plate         text NOT NULL,
  first_seen    timestamptz,
  last_seen     timestamptz,
  observations  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_pk, plate)
);

-- The fleet's name is derived; the admin may CHOOSE another run of words
-- from the same names but never type one (§3.2 rule 6). `brand_choice` holds
-- that run, folded ("egari luxury"); NULL means the derived brand.
-- `name_basis` says how fleet.name was arrived at (brand | chosen | disagree |
-- unnamed) and `name_derived_at` when; NULL there means fleet.name is still
-- the value schema.sql seeded, which was typed and is not a platform's.
ALTER TABLE fleet ADD COLUMN IF NOT EXISTS brand_choice     text;
ALTER TABLE fleet ADD COLUMN IF NOT EXISTS name_basis       text;
ALTER TABLE fleet ADD COLUMN IF NOT EXISTS name_derived_at  timestamptz;
ALTER TABLE fleet ADD COLUMN IF NOT EXISTS created_at       timestamptz;
ALTER TABLE fleet ADD COLUMN IF NOT EXISTS created_from     bigint;

-- The legal names: what each platform registers a fleet under, from its
-- linked accounts only. Finance needs these beside the brand (§3.2 rule 5).
CREATE OR REPLACE VIEW fleet_legal_name AS
SELECT a.fleet_id, a.platform, a.account_id, a.reported_name AS name, a.reported_at, a.source_call
  FROM platform_account a
 WHERE a.status = 'linked' AND a.fleet_id IS NOT NULL AND a.reported_name IS NOT NULL;

-- Every change to an account's fleet, and every name chosen. Linking,
-- unlinking or moving an account changes which fleet's history it is, so who
-- can see its rows (§3.3.5): those wait here as `pending` until an Owner
-- other than the proposer approves. A name choice and ignoring a NEW account
-- move nobody's rows and are recorded as `applied` at once. `impact` is who
-- gains or loses visibility, computed when it was proposed and shown to the
-- approver; `basis` 'configuration' marks a link that records what
-- src/config.js already did.
CREATE TABLE IF NOT EXISTS fleet_change (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('link', 'unlink', 'ignore', 'unignore', 'new_fleet', 'name')),
  account_pk      bigint REFERENCES platform_account(id) ON DELETE SET NULL,
  fleet_id        text,
  from_fleet      text,
  words           text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'declined', 'withdrawn', 'superseded')),
  basis           text NOT NULL DEFAULT 'person' CHECK (basis IN ('person', 'configuration')),
  reason          text NOT NULL DEFAULT '',
  impact          jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_by     bigint,
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  approved_by     bigint,
  approved_at     timestamptz,
  decided_reason  text
);
CREATE INDEX IF NOT EXISTS fleet_change_pending ON fleet_change (proposed_at) WHERE status = 'pending';
-- At most one change waiting per account: two pending links for one account
-- would let the second approval silently undo the first.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_change_one_pending ON fleet_change (account_pk)
  WHERE status = 'pending' AND account_pk IS NOT NULL;
