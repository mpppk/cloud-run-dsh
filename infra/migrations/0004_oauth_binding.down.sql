-- 0004_oauth_binding.down.sql — Revert 0004_oauth_binding.sql
-- (Ignored by infra/migrations/runner.ts like every *.down.sql; manual use only.)
DROP INDEX IF EXISTS oauth_login_flows_expires_at;
ALTER TABLE oauth_login_flows DROP COLUMN IF EXISTS binding_hash;
