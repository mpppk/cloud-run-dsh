-- 0003_auth_sessions.sql — issue #150: opaque server-side auth sessions.
--
-- The browser holds only a high-entropy raw token in the
-- `__Host-dsh_session` cookie; the database stores SHA-256(token) only.
-- OAuth login flows (state hash + PKCE verifier) live here too, consumed
-- one-time by the #151 callback.
--
-- No `users` table: the stable internal id (`github:<numeric-id>`) is stored
-- directly, like the existing `workspaces.owner_id TEXT`.
--
-- Applied idempotently via infra/migrations/runner.ts (recorded in
-- schema_migrations). Rollback: 0003_auth_sessions.down.sql (manual use).

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  token_hash BYTEA NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  github_login TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_sessions_expires_at
  ON auth_sessions(expires_at);

CREATE TABLE oauth_login_flows (
  state_hash BYTEA PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  return_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
