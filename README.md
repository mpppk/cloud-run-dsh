# cloud-run-dsh

Cloud Run Instances + Cloud Run Sandboxes + DeepSeek Harness — AI Coding Agent execution platform.

1 workspace = 1 Cloud Run Instance = 1 named Sandbox (`dsh-${workspaceId}`) with `/workspace` bind mount.

## Architecture (spec v1.0)

- **Control Plane** (`apps/control-plane`): Workspace API, Instance controller, IAP auth, membership checks.
- **Agent Host** (`apps/agent-host`): Runs inside Cloud Run Instance — Agent Gateway, Harness runtime, SandboxManager, CheckpointManager, IdleManager, GitHubCredentialBroker.
- **Execution Plane**: Cloud Run Sandbox (isolated via `sandbox run --allow-egress --write --mount type=bind,source=/workspace`).
- **Packages**:
  - `cloud-run-instance-client` — Cloud Run Instance adapter (`InstanceRuntime` interface), GCP dependency isolation.
  - `cloud-run-sandbox` — Sandbox lifecycle (`SandboxManager`, named sandbox `dsh-${workspaceId}`).
  - `dsh-subprocess-cloud-run` — Harness `ctx.subprocess` provider (argv/env/stdio/timeout, queue per workspace).
  - `workspace-runtime` — `WorkspaceRuntimeState` state machine (`STOPPED` → `STARTING` → `RESTORING` → `READY` ↔ `BUSY`/`CHECKPOINTING` → `STOPPING` → `STOPPED` + error states).
  - `workspace-checkpoint` — dirty detection, `git diff --binary`, untracked tar, GCS upload/restore.
  - `session-persistence-postgres` — Cloud SQL append-only `session_events` provider.
  - `github-credential-broker` — GitHub App short-lived installation token, no persistent embedding.
  - `controller-lease` — single-writer lease (15s heartbeat / 45s expiry, atomic takeover).
  - `observability` — structured logging & metrics (`workspace.*`, `sandbox.*`, `subprocess.*`).

Durable state: GitHub (canonical), Cloud SQL (metadata/sessions/checkpoints), GCS (checkpoint bundles). Local filesystem is ephemeral.

See `docs/` — System Spec v1.0 & Implementation Guide v1.0 (Japanese).

## Monorepo

- **Runner**: `bun` (workspaces `apps/*`, `packages/*`)
- **Language**: TypeScript (strict, ESNext, `moduleResolution: bundler`, `isolatedModules`, `noUncheckedIndexedAccess`)
- **Test**: `bun test` (built-in runner)

```
apps/control-plane
apps/agent-host
packages/cloud-run-instance-client
packages/cloud-run-sandbox
packages/dsh-subprocess-cloud-run
packages/workspace-runtime
packages/workspace-checkpoint
packages/session-persistence-postgres
packages/github-credential-broker
packages/controller-lease
packages/observability
infra/terraform
infra/migrations
tests/integration
tests/security
tests/load
```

## Getting Started

```bash
bun install
bun run typecheck   # tsc --build (project references)
bun test            # bun built-in test runner, all workspaces
bun run build       # tsc --build
bun run lint        # tsc --noEmit
```

No business logic / GCP calls in T1 — skeleton only (placeholder exports + smoke tests).

## Infra

Terraform baseline lives in `infra/terraform` (preferred per AGENTS.md). Apply via `terraform` in that directory.

GCPのAIエージェント用サービスアカウントと `gcloud` Impersonationの設定は、[docs/gcp-ai-agent-impersonation.md](docs/gcp-ai-agent-impersonation.md) に記録しています。
