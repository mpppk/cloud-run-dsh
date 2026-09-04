# Control Plane container (T9 Workspace API & Agent Gateway).
#
# Contents: bun (JS runtime), TLS root certificates, application code.
# Unlike the agent-host image, the control plane never spawns subprocesses,
# so git/bash/tar/gzip are NOT needed here.
#
# Build from the repository root:
#   docker build --platform linux/amd64 -f apps/control-plane/Dockerfile -t control-plane .
#
# `--platform linux/amd64` is REQUIRED for every image destined for GCP:
# Cloud Run executes linux/amd64 only, and a native build on Apple Silicon
# produces a linux/arm64 image that Cloud Run cannot run.
#
# Runtime configuration (injected via environment by Cloud Run — no secrets
# are baked into the image):
#   PORT                        — listen port (Cloud Run injects 8080; default below)
#   DATABASE_URL                — Postgres/Cloud SQL connection string (REQUIRED)
#   GCP_PROJECT_ID / GCP_REGION — where workspace Instances are created (REQUIRED)
#   AGENT_HOST_IMAGE            — agent-host image for created Instances (REQUIRED)
#   AGENT_HOST_SERVICE_ACCOUNT  — SA that created Instances run as (REQUIRED)
#   CHECKPOINT_BUCKET           — GCS checkpoint bucket (REQUIRED)
#   AGENT_HOST_DATABASE_URL     — DB URL injected into Instances, Cloud SQL
#                                 socket form (REQUIRED)
#   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_PEM — injected into Instances (REQUIRED)
# See apps/control-plane/README.md for the full contract.

# --- deps: install workspace dependencies -----------------------------------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/agent-host/package.json apps/agent-host/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages/cloud-run-instance-client/package.json packages/cloud-run-instance-client/package.json
COPY packages/cloud-run-sandbox/package.json packages/cloud-run-sandbox/package.json
COPY packages/controller-lease/package.json packages/controller-lease/package.json
COPY packages/dsh-subprocess-cloud-run/package.json packages/dsh-subprocess-cloud-run/package.json
COPY packages/github-credential-broker/package.json packages/github-credential-broker/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/session-persistence-postgres/package.json packages/session-persistence-postgres/package.json
COPY packages/workspace-checkpoint/package.json packages/workspace-checkpoint/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN bun install --frozen-lockfile

# --- build: assemble the workspace -------------------------------------------
#
# Typechecking deliberately does NOT run here. It runs in CI instead
# (.github/workflows/ci.yml) and locally via `bunx tsc --build`. Re-running it
# during packaging buys nothing and makes the image unbuildable on a
# cross-architecture host: under qemu
# (arm64 host -> linux/amd64 image) `bun run typecheck` dies immediately with
#   ASSERTION FAILED: MemoryExhaustion ... JSC::LocalAllocator::allocateSlowCase
#   panic(main thread): abort() called   (Bun v1.4.0, exit code 134)
# (apps/agent-host/Dockerfile got the same treatment for the same reason.)
# Cloud Run only runs linux/amd64, so every image destined for GCP must be
# built with `--platform linux/amd64`; keeping the typecheck here would force
# that build onto a native amd64 machine for no packaging benefit.
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# --- runtime -----------------------------------------------------------------
FROM oven/bun:1-slim AS runtime
# ca-certificates: TLS to Cloud SQL / GCP APIs. Run as non-root; the control
# plane needs no writable volume and no subprocess tooling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /usr/sbin/nologin --uid 10001 controlplane
WORKDIR /app
COPY --from=deps --chown=controlplane:controlplane /app/node_modules ./node_modules
COPY --from=build --chown=controlplane:controlplane /app/package.json /app/bun.lock ./
COPY --from=build --chown=controlplane:controlplane /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build --chown=controlplane:controlplane /app/apps/control-plane ./apps/control-plane
COPY --from=build --chown=controlplane:controlplane /app/packages ./packages
USER controlplane
# Cloud Run injects PORT=8080; the server listens on 0.0.0.0:$PORT
# (apps/control-plane/src/server.ts, 実装手順書 section 24).
EXPOSE 8080
ENTRYPOINT ["bun", "run", "apps/control-plane/src/main.ts"]
