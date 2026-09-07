-- 0003_auth_sessions.down.sql — Revert 0003_auth_sessions.sql
-- (Ignored by infra/migrations/runner.ts like every *.down.sql; manual use only.)
DROP TABLE IF EXISTS oauth_login_flows;
DROP TABLE IF EXISTS auth_sessions;
