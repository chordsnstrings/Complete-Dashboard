-- v122 — ULM Phase 4 (docs/ULM-DESIGN.md §13): access reviews as a CYCLE,
-- dormant suspension that can be explained and undone, and an owner and a
-- state for each finding on #insights. Additive only: new tables and new
-- nullable columns, nothing dropped or rewritten, so a rolled-back deploy
-- leaves every existing page exactly as it was. Nothing here needs a
-- privilege beyond owning the tables the app already created in v86.
--
-- WHY A CYCLE AND NOT THE v86 TABLE. access_review (v86) held one row per
-- team per quarter and a jsonb of keep/remove ticks, so it could say nothing
-- about a DIRECT grant (most grants are direct: an invitation carries its
-- roles), nothing about who still had to decide, and nothing about what
-- happens to access nobody looked at. §11.3 asks for exactly those three:
--   · every quarter each team lead attests their team's access, person by
--     person — and an Access admin or the Owner attests what no lead covers;
--   · access nobody attested expires 14 days after the review closes;
--   · holders of the sensitive classes (DOC at F, CASH, CRED, ACCUSE, AUDIT,
--     RAW) are reviewed every month.
-- access_review is left in place, unread, so nothing recorded in it is lost.

-- One review: opened on the schedule (opened_by NULL) or by an Access admin.
-- `kind` quarterly covers every grant and every membership of a team that
-- holds a grant; monthly covers only those conferring a sensitive class;
-- adhoc is an admin's extra review of everything.
CREATE TABLE IF NOT EXISTS access_review_cycle (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('quarterly', 'monthly', 'adhoc')),
  period      text NOT NULL,            -- 2026-Q4 | 2026-11 | 2026-11-12 14:05 (Dubai)
  opened_at   timestamptz NOT NULL DEFAULT now(),
  opened_by   bigint,                   -- NULL: opened by the schedule
  due_at      timestamptz NOT NULL,
  closed_at   timestamptz,
  closed_by   bigint,                   -- NULL with closed_at set: closed by the schedule at due_at
  expires_at  timestamptz,              -- set at close: when access nobody attested ends
  items       integer NOT NULL DEFAULT 0
);
-- One quarterly and one monthly review per period; an admin's adhoc review
-- has a period of its own minute and is never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS access_review_cycle_period
  ON access_review_cycle (kind, period) WHERE kind <> 'adhoc';

-- One line of a review: one person's access, to keep or revoke.
--   kind 'grant'       a role given to the person directly (grant_id)
--   kind 'membership'  the person's place in a team that holds roles (team_id);
--                      removing it takes the team's roles away from them only
-- `reviewer_id` is the line's OWNER: the team's lead for a membership, NULL
-- for "any Access admin or Owner". `owner_only`: an Owner's access, which only
-- another Owner may decide. `state`:
--   pending     nobody has decided yet
--   kept        attested (decided_by NULL: kept by the rule that the last
--               Owner cannot be removed, §11.2)
--   revoked     taken away by the reviewer
--   unattested  the review closed with nobody deciding; ends at expires_at
--               unless someone attests it first
--   expired     ended because nobody attested it
--   gone        the access had already ended before anyone decided
CREATE TABLE IF NOT EXISTS access_review_item (
  id                bigserial PRIMARY KEY,
  cycle_id          bigint NOT NULL REFERENCES access_review_cycle(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('grant', 'membership')),
  grant_id          bigint,
  team_id           bigint,
  user_id           bigint NOT NULL,
  roles             text[] NOT NULL DEFAULT '{}',   -- what is attested, as it stood at opening
  fleets            text[],                         -- a grant's fleets; NULL = every fleet
  reviewer_id       bigint,
  owner_only        boolean NOT NULL DEFAULT false,
  state             text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'kept', 'revoked', 'unattested', 'expired', 'gone')),
  decided_by        bigint,
  decided_at        timestamptz,
  reason            text NOT NULL DEFAULT '',
  -- unattested: when this access ends. The grant itself is NOT shortened:
  -- the hourly sweep ends it at this moment, after checking that it is not
  -- the last Owner's (§11.2), so a late "keep" has nothing to undo.
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'grant') = (grant_id IS NOT NULL)),
  CHECK ((kind = 'membership') = (team_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS access_review_item_cycle ON access_review_item (cycle_id, state);
CREATE INDEX IF NOT EXISTS access_review_item_due ON access_review_item (expires_at) WHERE state = 'unattested';
CREATE INDEX IF NOT EXISTS access_review_item_reviewer ON access_review_item (reviewer_id) WHERE state IN ('pending', 'unattested');

-- DORMANT SUSPENSION (§11.2: no sign-in for 60 days → suspended
-- automatically; suspended → reinstated by an admin).
--   reinstated_at  the dormancy clock restarts here: without it the hourly
--                  sweep found a reinstated person's last sign-in still 60
--                  days old and suspended them again within the hour.
--   dormant_since  set when the SWEEP suspended the account, cleared on
--                  reinstatement — so sign-in can say why the account is
--                  closed and how to get back, which it could not tell from
--                  an admin's suspension.
-- The one statement here that needs more than CREATE: altering a table
-- needs its OWNER. The app's own user created access_user in v86, so it
-- owns it — but this file runs as ONE query (src/db.js migrate), so one
-- refused statement would roll back every table above and leave the review
-- and finding routes without theirs, retried and refused at every boot. A
-- missing privilege is therefore reported and passed, never raised. Without
-- the columns the dormancy sweep fails (logged; the rest of the housekeeping
-- still runs) and sign-in says the plain "This account is suspended".
DO $$
BEGIN
  ALTER TABLE access_user ADD COLUMN IF NOT EXISTS reinstated_at timestamptz;
  ALTER TABLE access_user ADD COLUMN IF NOT EXISTS dormant_since timestamptz;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'v122: access_user.reinstated_at/dormant_since not added: %', SQLERRM;
END $$;

-- FINDING OWNERSHIP (§8 act:finding.own: take, assign and close a finding on
-- #insights; records who acted). A finding is the insight table's own key —
-- the rule, and what it is about — so it survives every recomputation of the
-- rule; NULL parts of that key are stored as ''. No row means nobody has
-- taken it. Every change is also in the hash-chained access_audit.
CREATE TABLE IF NOT EXISTS finding_owner (
  code         text NOT NULL,
  entity_type  text NOT NULL DEFAULT '',
  entity_id    text NOT NULL DEFAULT '',
  fleet_id     text,                   -- the finding's fleet when last acted on (a one-fleet reader's filter)
  state        text NOT NULL CHECK (state IN ('open', 'taken', 'closed')),
  owner_id     bigint,                 -- the person on it (access_user.id)
  assigned_by  bigint,                 -- NULL when the owner took it themselves
  taken_at     timestamptz,
  closed_at    timestamptz,
  closed_by    bigint,
  outcome      text CHECK (outcome IS NULL OR outcome IN ('acted', 'no_action', 'wrong')),
  note         text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint,
  PRIMARY KEY (code, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS finding_owner_owner ON finding_owner (owner_id) WHERE state = 'taken';
