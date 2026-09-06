-- 0002_last_error.sql — issue #141: operator-visible restore failure reason.
--
-- Additive and NULLABLE: existing rows read NULL ("no recorded failure") and
-- need no backfill; rolling back to a 0001-only tree leaves a column the old
-- code ignores (SELECT * keeps working, rowToWorkspace never requires it).
-- New writers MUST pass reasons through summarizeRestoreError() — never
-- tokens, passwords, PEM, or internal URLs (see
-- packages/session-persistence-postgres/src/restore-error.ts).
--
-- Applied idempotently via infra/migrations/runner.ts (recorded in
-- schema_migrations). Never edit 0001_init.sql for this — it is already
-- applied in production.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_error TEXT;
