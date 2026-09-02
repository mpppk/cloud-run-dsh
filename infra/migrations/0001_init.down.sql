-- 0001_init.down.sql — Revert 0001_init.sql
DROP TABLE IF EXISTS controller_leases;
DROP TABLE IF EXISTS workspace_checkpoints;
DROP TABLE IF EXISTS session_events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS workspaces;
