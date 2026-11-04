-- login schema: credentials and refresh tokens.
CREATE TABLE credentials (
  user_id         uuid PRIMARY KEY,
  email           text        NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash   text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('adopter', 'staff', 'admin')),
  shelter_id      uuid,
  failed_attempts integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'staff' OR shelter_id IS NOT NULL)
);

CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY,            -- sha256 of the token; the token itself is never stored
  user_id    uuid        NOT NULL REFERENCES credentials (user_id) ON DELETE CASCADE,
  family_id  uuid        NOT NULL,        -- all tokens descended from one login
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry ON refresh_tokens (expires_at);
