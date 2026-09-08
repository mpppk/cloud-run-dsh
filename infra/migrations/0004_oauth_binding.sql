-- 0004_oauth_binding.sql — A6 browser binding + A1 expiry-cleanup index.
--
-- Upgrades databases that already applied 0003_auth_sessions.sql (which the
-- runner records by filename, so it can never re-apply) AND fresh databases
-- (0003 then 0004 apply in order). Every statement is IF (NOT) EXISTS, so
-- re-running is safe.
--
-- binding_hash is NULLABLE on purpose: flows created before this upgrade
-- have no binding. consumeLoginFlow maps NULL to "" and bindingMatches("")
-- denies, so pre-upgrade flows fail closed exactly once (they live <=5 min
-- anyway) instead of breaking the upgrade.
--
-- Applied idempotently via infra/migrations/runner.ts (recorded in
-- schema_migrations). Rollback: 0004_oauth_binding.down.sql (manual use).

-- A6: SHA-256 of the `__Host-dsh_oauth` nonce issued with the flow. The
-- callback must present the raw nonce from the same browser; the flow is
-- consumed one-time and the binding is compared constant-time. Raw nonces
-- are never stored.
ALTER TABLE oauth_login_flows
  ADD COLUMN IF NOT EXISTS binding_hash BYTEA;

-- A1: supports bounded expiry cleanup
-- (`DELETE ... WHERE expires_at < now() ... LIMIT n`) on login flows.
CREATE INDEX IF NOT EXISTS oauth_login_flows_expires_at
  ON oauth_login_flows(expires_at);
