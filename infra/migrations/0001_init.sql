-- 0001_init.sql — Cloud SQL PostgreSQL schema (実装手順書 section 3)
-- Applied idempotently via infra/migrations/runner.ts which records versions in schema_migrations.

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,

  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,

  instance_name TEXT UNIQUE,
  instance_url TEXT,

  runtime_state TEXT NOT NULL DEFAULT 'STOPPED',

  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_events (
  session_id UUID NOT NULL REFERENCES sessions(id),
  seq BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  event_time BIGINT NOT NULL,
  data JSONB NOT NULL,
  source_event_seqs JSONB,
  surface_op JSONB,

  PRIMARY KEY(session_id, seq)
);

CREATE TABLE workspace_checkpoints (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),

  base_commit_sha TEXT NOT NULL,
  gcs_object TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX workspace_checkpoints_workspace_created
ON workspace_checkpoints(workspace_id, created_at DESC);

CREATE TABLE controller_leases (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id),
  controller_id UUID NOT NULL,
  user_id TEXT NOT NULL,

  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
