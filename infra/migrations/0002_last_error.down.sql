-- 0002_last_error.down.sql — Revert 0002_last_error.sql
-- (Ignored by infra/migrations/runner.ts like every *.down.sql; manual use only.)
ALTER TABLE workspaces DROP COLUMN IF EXISTS last_error;
