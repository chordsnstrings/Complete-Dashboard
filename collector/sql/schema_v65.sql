-- ---------------------------------------------------------------------------
-- One person, two records: the link the roster already carries and nothing
-- joined on.
-- ---------------------------------------------------------------------------
-- Reported from the product on 2026-09-07: "Muhammad Khalifa Afzal Khalid has
-- uber trips, but it doesn't show that uber is there. it only shows bolt
-- trips." He does. The roster holds both records with the same phone number on
-- each — the hotel channel as MUHAMMAD KHALIFA AFZAL KHALID, Uber as "Muhammad
-- Khalid" — and the Uber account carries 4,461 trips over 302 days on eight
-- vehicles against the 822 the page shows.
--
-- personFold decides two records are one person from the NAME, and
-- api/identity_map.js argues at length, correctly, that it must never learn to
-- do more. The pattern here is that Bolt and the hotel channel file the full
-- legal name and Uber drops the middle one — Zubair Khan Shaukat Ali / Zubair
-- Khan Ali, Zia Ali Said Muhammad / Zia Ali Muhammad. A subsequence rule would
-- catch those and would also merge Muhammad Khalid with Muhammad Khalid Gul,
-- two men with 77 simultaneous trips on two plates, refused by hand in that
-- same file. The name cannot settle it.
--
-- Measured over the 289 roster rows: 217 distinct phones, none on more than
-- two rows, none twice within one channel, 72 shared across two channels, 61
-- of those carrying names no fold can reach, 58 still rendering as two
-- directory rows — 13,056 trips and AED 393,731 on the smaller row of each
-- pair.
--
-- ── why a TABLE and not another entry in the register ──────────────────────
-- api/identity_map.js is a list a human checked pair by pair, and it is right
-- that it is: a rule that generalises is a rule that will one day fire on two
-- names nobody has looked at. But a hand list cannot answer "how do we ensure
-- it automatically happens" — the fleet hires, and the next Muhammad Khalid
-- would wait for somebody to notice him.
--
-- So the discovery is automatic and the EVIDENCE is stored with it. Every row
-- here carries which phone tail joined the two records, both names, both
-- channels and when it was decided, so a link can be read, disputed and
-- overridden. Nothing merges silently.
--
-- ── and it is deliberately not person_key ─────────────────────────────────
-- person_key is a stored generated column (sql/schema_v53.sql) built from the
-- register, and moving it means recomputing 364,015 rows. This table is read
-- at the boundary, by the same alias layer api/driver_routes.js already
-- applies to the register's own merges, so a link takes effect on the pages
-- that show a person WITHOUT a migration. Promoting a link into the register —
-- which is what moves the stored column, and with it every rollup — stays a
-- human's decision, and `confirmed_at` is where that decision is recorded.
CREATE TABLE IF NOT EXISTS driver_identity_link (
  -- The record that gets folded INTO the other. Primary key, so a record can
  -- be an alias of at most one person: a chain would be an ambiguity, and this
  -- table's whole claim is that the phone produces none.
  alias_ext_id       TEXT PRIMARY KEY,
  alias_platform     TEXT NOT NULL,
  alias_name         TEXT,
  canonical_ext_id   TEXT NOT NULL,
  canonical_platform TEXT NOT NULL,
  canonical_name     TEXT,
  -- The folded name of the surviving record, which is the key every surface
  -- already groups by. Stored rather than derived so a reader of this table
  -- needs nothing else to apply it.
  canonical_key      TEXT NOT NULL,
  -- How it was decided. One value today, named rather than implied, because
  -- the next basis (a shared Emirates ID, say) must be distinguishable in the
  -- same table and must be able to carry different weight.
  basis              TEXT NOT NULL DEFAULT 'shared_phone',
  -- The sentence a page prints. Not a code: this is what makes the link
  -- arguable by somebody who was not here when it was made.
  evidence           TEXT NOT NULL,
  -- The last four digits and nothing more. Enough to check a link against a
  -- record by eye; not enough to be a contact detail leaving through a page
  -- that has no business carrying one.
  phone_tail         TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A human's verdict, either way. `rejected` wins over the rule and survives
  -- every recomputation, so an operator who says "those are two brothers" is
  -- not overruled by the next collector run.
  confirmed_at       TIMESTAMPTZ,
  confirmed_by       TEXT,
  rejected           BOOLEAN NOT NULL DEFAULT false,
  rejected_reason    TEXT
);
CREATE INDEX IF NOT EXISTS driver_identity_link_canon_idx
  ON driver_identity_link (canonical_key);
CREATE INDEX IF NOT EXISTS driver_identity_link_live_idx
  ON driver_identity_link (alias_ext_id) WHERE NOT rejected;

COMMENT ON TABLE driver_identity_link IS
  'Records the roster proves are one person, joined on a phone number both '
  'channels filed. Discovered by src/identity_link.js on every roster pull, '
  'applied at the API boundary rather than in person_key, and always with the '
  'evidence that decided it.';
COMMENT ON COLUMN driver_identity_link.rejected IS
  'A human said these are two people. Wins over the rule, and survives '
  'recomputation — the collector never clears it.';
