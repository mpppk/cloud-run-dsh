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

Durable state: GitHub (canonical), Cloud SQL (metadata/sessions/checkpoints), GCS (checkpoint bundles).

### Documents

| Document | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | **Start here.** The architecture as measured on GCP: components and how they map to the diagram, the open-workspace sequence with per-step implementation status, network and security model, and the create-and-verify procedure. |
| [`docs/e2e-verification-report.md`](docs/e2e-verification-report.md) | **The 2026-09-05 end-to-end verification on GCP: the full sequence diagram ran, and the 13 production-only bugs found on the way.** |
| [`docs/bringup-report.md`](docs/bringup-report.md) | The 2026-09-03 bring-up: what was proven on GCP, what was not, and 11 gotchas with their evidence. |
| [`docs/deployment-runbook.md`](docs/deployment-runbook.md) | The full deployment runbook (canonical). |
| [`docs/cost.md`](docs/cost.md) | Cost breakdown and the minimal profile. |
| [`docs/local-development.md`](docs/local-development.md) | Local dev server and docker-compose. |
| [`docs/gcp-ai-agent-impersonation.md`](docs/gcp-ai-agent-impersonation.md) | The `ai-agent` operator identity and its escalation path. |
| `docs/システム仕様書 v1.0`, `docs/実装手順書 v1.0` | Original spec and implementation guide (Japanese). |

> **Status (2026-09-05):** the full open-workspace sequence has run end to end on GCP.
> A real agent turn completed there — the LLM called a harness tool, read a file from the
> cloned repository, and the events streamed back over SSE. Getting there took 13 fixes for
> bugs that only appear in production; see
> [`docs/e2e-verification-report.md`](docs/e2e-verification-report.md).
>
> Known gaps: `stop` does not delete the Instance and writes no workspace tarball
> ([#72](https://github.com/mpppk/cloud-run-dsh/issues/72)), and `terraform destroy` fails
> after migrations have run ([#73](https://github.com/mpppk/cloud-run-dsh/issues/73)).

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
