# Agent Host container (実装手順書 section 7).
#
# Contents: bun (Node.js-compatible JS runtime), git, bash, tar, gzip,
# application code. The sandbox CLI is PROVIDED by Cloud Run (sandbox
# launcher) — it is deliberately NOT vendored here.
#
# Build from the repository root:
#   docker build -f apps/agent-host/Dockerfile -t agent-host .
#
# Bun version policy (issue #83): the image MUST pin an exact Bun release,
# never a floating tag like `oven/bun:1`. A floating tag silently pulled a
# newer Bun into the container and broke `POST /v1/workspaces/:id/open`
# with 503s on GCP (see docs/stop-restore-verification-report.md §3.1).
# The canonical version lives in `.bun-version` at the repository root
# (CI installs it via `bun-version-file`); the `BUN_VERSION` default below
# MUST match it. `tests/bun-version-consistency.test.ts` fails the suite
# if they drift. To upgrade Bun, see docs/local-development.md
# ("Upgrading Bun") and change `.bun-version` + both Dockerfiles together.

# --- deps: install workspace dependencies -----------------------------------
ARG BUN_VERSION=1.4.0
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/agent-host/package.json apps/agent-host/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages/cloud-run-instance-client/package.json packages/cloud-run-instance-client/package.json
COPY packages/cloud-run-sandbox/package.json packages/cloud-run-sandbox/package.json
COPY packages/controller-lease/package.json packages/controller-lease/package.json
COPY packages/dsh-subprocess-cloud-run/package.json packages/dsh-subprocess-cloud-run/package.json
COPY packages/gcp-token-provider/package.json packages/gcp-token-provider/package.json
COPY packages/github-credential-broker/package.json packages/github-credential-broker/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/session-persistence-postgres/package.json packages/session-persistence-postgres/package.json
COPY packages/workspace-checkpoint/package.json packages/workspace-checkpoint/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN bun install --frozen-lockfile

# --- build: assemble the workspace -------------------------------------------
#
# Typechecking deliberately does NOT run here. It runs in CI instead
# (.github/workflows/ci.yml, added together with this change because it was
# NOT already covered — the repository had no workflows at all). Re-running it
# during packaging buys nothing and makes the image unbuildable on a
# cross-architecture host: under qemu
# (arm64 host -> linux/amd64 image) `bun run typecheck` dies immediately with
#   ASSERTION FAILED: MemoryExhaustion ... JSC::LocalAllocator::allocateSlowCase
#   panic(main thread): abort() called   (Bun v1.4.0, exit code 134)
# Cloud Run only runs linux/amd64, so every image destined for GCP must be
# built with `--platform linux/amd64`; keeping the typecheck here would force
# that build onto a native amd64 machine for no packaging benefit.
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# --- runtime -----------------------------------------------------------------
# Pinned via $BUN_VERSION (see header comment); `-slim` keeps the runtime
# small while deps/build use the full image.
FROM oven/bun:${BUN_VERSION}-slim AS runtime
# git, bash, tar, gzip are required inside the container (実装手順書 section 7).
# Run as non-root; /workspace is the only mutable root (仕様書 section 6.1).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git bash tar gzip ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash --uid 10001 host \
  && mkdir -p /workspace \
  && chown host:host /workspace
WORKDIR /app
COPY --from=deps --chown=host:host /app/node_modules ./node_modules
COPY --from=build --chown=host:host /app/package.json /app/bun.lock ./
COPY --from=build --chown=host:host /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build --chown=host:host /app/apps/agent-host ./apps/agent-host
COPY --from=build --chown=host:host /app/packages ./packages
USER host
# No secrets baked in: configuration is injected via environment at runtime
# (WORKSPACE_ID, CHECKPOINT_BUCKET, DATABASE_URL, GITHUB_APP_*, ...) by Cloud Run.
EXPOSE 8080
ENTRYPOINT ["bun", "run", "apps/agent-host/src/index.ts"]
