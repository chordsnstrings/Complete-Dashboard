-- v121: passkeys (WebAuthn) and single sign-on (OIDC) — ULM-DESIGN §5.1,
-- §10.1, §14 decision 3. Both stay OFF until the Owner turns them on in
-- Set up → Access → Settings (access_config keys `passkeys`, `sso`,
-- `sso_provision`, `sso_domains`, defaulted in api/access/service.js); this
-- file only makes room for them. api/access/signin_methods.js is the code.
--
-- Additive only: two new tables and one nullable column. Nothing here needs
-- more than the CREATE and ownership every earlier access migration already
-- used (schema_v86.sql created access_session as this same role), so it
-- cannot fail at boot on a managed Postgres 16 for want of a privilege.
--
-- access_passkey — one row per registered credential.
--   credential_id  the authenticator's credential id, base64url — what the
--                  browser names when it signs in. UNIQUE: one credential
--                  belongs to one person.
--   public_key     the credential's public key as SubjectPublicKeyInfo (DER,
--                  base64), converted from COSE at registration so signing
--                  in is one node:crypto call. A public key, not a secret.
--   alg            COSE algorithm: -7 ES256, -257 RS256 (the two offered).
--   sign_count     the authenticator's signature counter as last seen. One
--                  that does not grow disables the credential (a copied
--                  authenticator), with the reason in disabled_reason.
--   transports     how the browser can reach it (internal, hybrid, usb…).
--   user_handle    the opaque WebAuthn user.id the credential was made for
--                  (32 random bytes, base64url — never the email or the row
--                  id, which an authenticator would keep and show). Signing
--                  in, the credential's own user handle must match it.
--   backup_eligible / backed_up   the BE/BS flags: a synced passkey.
-- access_sso_identity — which account at the company's sign-in provider is
--   which person here: (issuer, subject), the provider's stable id. Linked on
--   the first single sign-on by a verified address on an allowed domain;
--   from then on the SUBJECT decides, so an address the provider later gives
--   to somebody else does not open the old holder's account.
-- access_session.auth_method — how the session was opened: NULL for every
--   session before this file (password), 'password', 'passkey', 'sso'. The
--   identify step reads it: a session opened by a user-verified passkey, or
--   by a provider that asserted multi-factor, has already done two-step.
CREATE TABLE IF NOT EXISTS access_passkey (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES access_user(id) ON DELETE CASCADE,
  credential_id    text NOT NULL UNIQUE,
  public_key       text NOT NULL,
  alg              integer NOT NULL CHECK (alg IN (-7, -257)),
  sign_count       bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports       text[] NOT NULL DEFAULT '{}',
  user_handle      text NOT NULL,
  aaguid           text,
  backup_eligible  boolean NOT NULL DEFAULT false,
  backed_up        boolean NOT NULL DEFAULT false,
  name             text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  disabled_at      timestamptz,
  disabled_reason  text
);
CREATE INDEX IF NOT EXISTS access_passkey_user ON access_passkey (user_id);

CREATE TABLE IF NOT EXISTS access_sso_identity (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES access_user(id) ON DELETE CASCADE,
  issuer        text NOT NULL,
  subject       text NOT NULL,
  email         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  UNIQUE (issuer, subject),
  UNIQUE (user_id, issuer)
);

ALTER TABLE access_session ADD COLUMN IF NOT EXISTS auth_method text;
