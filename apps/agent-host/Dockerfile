# Agent Host container (実装手順書 section 7).
#
# Contents: bun (Node.js-compatible JS runtime), git, bash, tar, gzip,
# application code. The sandbox CLI is PROVIDED by Cloud Run (sandbox
# launcher) — it is deliberately NOT vendored here.
#
# Build from the repository root:
#   docker build -f apps/agent-host/Dockerfile -t agent-host .

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

# --- build: typecheck the workspace ------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun run typecheck

# --- runtime -----------------------------------------------------------------
FROM oven/bun:1-slim AS runtime
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
