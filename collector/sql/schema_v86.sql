-- v86 — who may sign in, and what each person may see and do (ULM).
-- collector/docs/ULM-DESIGN.md is the design. Additive only: new tables, no
-- change to any existing one, so a deploy that is rolled back leaves every
-- existing page exactly as it was.

-- People who sign in. `email_norm` is the identity; the typed email is kept
-- as entered for display.
CREATE TABLE IF NOT EXISTS access_user (
  id                    bigserial PRIMARY KEY,
  email                 text NOT NULL,
  email_norm            text NOT NULL UNIQUE,
  name                  text NOT NULL DEFAULT '',
  password_hash         text,
  status                text NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited', 'active', 'suspended', 'offboarded')),
  must_change_password  boolean NOT NULL DEFAULT false,
  totp_secret           text,          -- sealed (api/access/crypto.js seal)
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_last_step        bigint,        -- a code is accepted once
  recovery_codes        text[] NOT NULL DEFAULT '{}',   -- sha-256 of each unused code
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz,
  last_login_at         timestamptz,
  last_seen_at          timestamptz,
  prefs                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  suspended_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            bigint,
  offboarded_at         timestamptz
);

-- A session is a random token held in an HttpOnly cookie; only its sha-256 is
-- stored. `stepup_at` is the last time the person re-confirmed who they are.
-- `view_as` is an Owner previewing a role: read-only, audited.
CREATE TABLE IF NOT EXISTS access_session (
  id              text PRIMARY KEY,
  user_id         bigint REFERENCES access_user(id) ON DELETE CASCADE,
  device_id       bigint,
  kind            text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'device')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  idle_minutes    integer NOT NULL DEFAULT 720,
  stepup_at       timestamptz,
  mfa_ok          boolean NOT NULL DEFAULT false,
  view_as         text,
  ip              text,
  ua              text,
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX IF NOT EXISTS access_session_user ON access_session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS access_team (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  name_norm     text NOT NULL UNIQUE,
  description   text NOT NULL DEFAULT '',
  lead_user_id  bigint REFERENCES access_user(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint,
  archived_at   timestamptz
);
CREATE TABLE IF NOT EXISTS access_team_member (
  team_id   bigint NOT NULL REFERENCES access_team(id) ON DELETE CASCADE,
  user_id   bigint NOT NULL REFERENCES access_user(id) ON DELETE CASCADE,
  added_at  timestamptz NOT NULL DEFAULT now(),
  added_by  bigint,
  PRIMARY KEY (team_id, user_id)
);

-- Roles the company made by copying a built-in one. Built-in roles live in
-- api/public/access_model.js and are never stored.
CREATE TABLE IF NOT EXISTS access_role (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  based_on    text,
  levels      jsonb NOT NULL DEFAULT '{}'::jsonb,
  caps        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  archived_at timestamptz
);

-- A grant is a role, to a person or a team, over some fleets (NULL = every
-- fleet), with an optional end. `status` 'pending' is a sensitive grant
-- waiting for a second Owner; it confers nothing until approved.
CREATE TABLE IF NOT EXISTS access_grant (
  id           bigserial PRIMARY KEY,
  user_id      bigint REFERENCES access_user(id) ON DELETE CASCADE,
  team_id      bigint REFERENCES access_team(id) ON DELETE CASCADE,
  role_code    text NOT NULL,
  fleets       text[],
  expires_at   timestamptz,
  effective_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked', 'declined')),
  reason       text NOT NULL DEFAULT '',
  granted_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  bigint,
  approved_at  timestamptz,
  revoked_by   bigint,
  revoked_at   timestamptz,
  CHECK ((user_id IS NULL) <> (team_id IS NULL))
);
CREATE INDEX IF NOT EXISTS access_grant_user ON access_grant (user_id) WHERE status IN ('active', 'pending');
CREATE INDEX IF NOT EXISTS access_grant_team ON access_grant (team_id) WHERE status IN ('active', 'pending');

-- One-time links: an invitation to set a first password, or a reset. Only the
-- token's sha-256 is stored; the link is shown once to the admin who made it.
CREATE TABLE IF NOT EXISTS access_link (
  token_hash  text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES access_user(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_request (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES access_user(id) ON DELETE CASCADE,
  view            text NOT NULL DEFAULT '',
  class_code      text,
  role_code       text,
  reason          text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined', 'withdrawn')),
  decided_by      bigint,
  decided_at      timestamptz,
  decision_reason text,
  grant_id        bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Screens that sign in with a device token (the wall display).
CREATE TABLE IF NOT EXISTS access_device (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  role_code     text NOT NULL DEFAULT 'WALL',
  fleets        text[],
  token_hash    text NOT NULL UNIQUE,
  created_by    bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

-- Four-eyes: a change prepared by one person and committed by another. The
-- payload is stored and hashed; the commit takes the id only.
CREATE TABLE IF NOT EXISTS access_proposal (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  payload       jsonb NOT NULL,
  payload_hash  text NOT NULL,
  prepared_by   bigint NOT NULL,
  prepared_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'declined', 'failed', 'expired')),
  decided_by    bigint,
  decided_at    timestamptz,
  result        jsonb
);

-- Quarterly attestation, per team.
CREATE TABLE IF NOT EXISTS access_review (
  id          bigserial PRIMARY KEY,
  team_id     bigint REFERENCES access_team(id) ON DELETE CASCADE,
  period      text NOT NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL,
  closed_at   timestamptz,
  attested_by bigint,
  decisions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (team_id, period)
);

-- Company-wide access settings: the sign-in mode, the two-step policy, the
-- cash threshold for re-confirmation.
CREATE TABLE IF NOT EXISTS access_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained. Each row's hash covers the previous row's hash,
-- so a deleted or edited row breaks the chain from that point on.
CREATE TABLE IF NOT EXISTS access_audit (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     bigint,
  actor_label  text NOT NULL DEFAULT '',
  action       text NOT NULL,
  subject_type text,
  subject_id   text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  ua           text,
  prev_hash    text,
  hash         text NOT NULL
);
CREATE INDEX IF NOT EXISTS access_audit_at ON access_audit (at DESC);
CREATE INDEX IF NOT EXISTS access_audit_subject ON access_audit (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS access_audit_actor ON access_audit (actor_id, at DESC);
