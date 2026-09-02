# Cloud Run Instances + Cloud Run Sandboxes + DeepSeek Harness
# 実装手順書 v1.0

---

# 1. Repository

推奨monorepo構成:

```text
apps/
  control-plane/
  agent-host/

packages/
  cloud-run-instance-client/
  cloud-run-sandbox/
  dsh-subprocess-cloud-run/
  workspace-runtime/
  workspace-checkpoint/
  session-persistence-postgres/
  github-credential-broker/
  controller-lease/
  observability/

infra/
  terraform/
  migrations/

tests/
  integration/
  security/
  load/
```

DeepSeek HarnessはversionまたはGit commit SHAを固定する。

---

# 2. Google Cloud基盤

有効化:

```text
Cloud Run API
Cloud SQL Admin API
Secret Manager API
Artifact Registry API
Cloud Storage API
IAP API
Cloud Logging / Monitoring
```

作成:

```text
Artifact Registry
Cloud SQL PostgreSQL
GCS checkpoint bucket
Host service account
Control Plane service account
```

Regionは可能な限り統一する。

---

# 3. Cloud SQL Schema

```sql
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
```

---

# 4. Workspace State Machine

application serviceを作成する。

```ts
type WorkspaceRuntimeState =
  | "STOPPED"
  | "STARTING"
  | "RESTORING"
  | "READY"
  | "BUSY"
  | "CHECKPOINTING"
  | "STOPPING"
  | "ERROR"
  | "RESTORE_FAILED"
  | "CHECKPOINT_FAILED";
```

state transitionをDB transactionで管理する。

---

# 5. Cloud Run Instance Adapter

interface:

```ts
interface InstanceRuntime {
  create(workspace: Workspace): Promise<InstanceInfo>;
  start(instanceName: string): Promise<void>;
  stop(instanceName: string): Promise<void>;
  get(instanceName: string): Promise<InstanceInfo>;
  delete(instanceName: string): Promise<void>;
}
```

Google Cloud SDK / REST API依存はこのpackage内だけに置く。

Cloud Run Instanceは個別にcreate/start/stop/delete可能である。citeturn667424search5

---

# 6. Instance Configuration

baseline:

```yaml
cpu: 4
memory: 8Gi
restartPolicy: on-failure
sandboxLauncher: true
port: 8080
```

Sandbox launcherはCloud Run Instanceのcontainer設定で有効にする。citeturn667424search0

---

# 7. Agent Host Container

Containerへ含める。

```text
Node.js
DeepSeek Harness
git
bash
tar
gzip
sandbox CLIはCloud Run側提供
application code
```

Host process:

```text
Agent Gateway
Harness runtime
SandboxManager
CheckpointManager
IdleManager
GitHubCredentialBroker
```

---

# 8. Sandbox Manager

interface:

```ts
interface SandboxManager {
  ensureRunning(): Promise<void>;

  exec(
    request: SandboxExecRequest,
  ): SubprocessHandle;

  reset(): Promise<void>;

  dispose(): Promise<void>;
}
```

sandbox id:

```ts
`dsh-${workspaceId}`
```

---

# 9. Sandbox Creation

概念:

```bash
/usr/local/gcp/bin/sandbox run \
  dsh-WORKSPACE_ID \
  --detach \
  --allow-egress \
  --write \
  --mount type=bind,source=/workspace,destination=/workspace \
  --workdir /workspace \
  -- /bin/sh -c 'while true; do sleep 3600; done'
```

named Sandboxを一度作り、その後 `sandbox exec` を再利用する。citeturn989520search1turn989520search3

CLIのPreview変更に備え、command generationもAdapter内へ閉じ込める。

---

# 10. Harness Filesystem

compositionへ:

```text
fs-sandbox
fs-observation-policy
tool-fs
tool-fs-search
```

を組み込む。

policy:

```text
workspace-write
workspaceRoot=/workspace
```

Harnessのfilesystem provider / policy / model-facing toolsは独立したseamとして設計されている。citeturn517072search4turn517072search10

---

# 11. `dsh-subprocess-cloud-run`

新package:

```text
packages/dsh-subprocess-cloud-run/
  src/
    runtime.ts
    process.ts
    argv.ts
    environment.ts
    errors.ts
    plugin.ts
```

Harnessの `ctx.subprocess` providerを実装する。

E2B providerをreference implementationとして利用する。citeturn517072search7turn517072search8

---

# 12. resolveExecutable

Sandbox内で:

```text
command -v <command>
```

相当を実行する。

結果をexecution-world pathとして返す。

Host側のPATHで解決しない。

---

# 13. spawn

入力:

```ts
SubprocessSpawnSpec
```

を、

```text
sandbox exec
sandbox-id
--workdir
cwd
--env
...
--
argv...
```

へ変換する。

重要:

```text
argv.join(" ")
```

は禁止する。

commandとargsを独立したargvとして渡す。

---

# 14. Environment Allowlist

```ts
const ALLOWED_ENV = new Set([
  "CI",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TERM",
]);
```

Harness内部で必要な安全な`DSH_*`については個別精査して追加する。

Host parent environmentを丸ごと渡さない。

---

# 15. stdout / stderr

Sandbox CLIのstdout/stderrをSubprocessHandleへstreamする。

Cloud Run Sandbox CLIはSandbox commandのstdout / stderrをcallerへ転送する。citeturn989520search1

以下を対応する。

```text
stream output
collected output
exit code
duration
truncation
redaction
```

---

# 16. Subprocess Lock

workspaceごとにMutex:

```ts
await workspaceProcessMutex.runExclusive(async () => {
  return runtime.spawn(...);
});
```

1つのcommandが完了するまで次を開始しない。

---

# 17. Timeout

timeout時:

```text
Abort caller
 ↓
sandbox delete
 ↓
sandbox run
 ↓
mark command TIMEOUT
```

workspaceはHost bind mountなので保持される。

---

# 18. GitHub App

HostにGitHub App credential providerを実装する。

```ts
interface GitHubCredentialBroker {
  getInstallationToken(
    repository: Repository,
  ): Promise<TemporaryToken>;
}
```

token expirationより十分短いapplication cacheを設定する。

Sandboxへ必要なoperationの間だけtokenを渡す。

Git remote URL等へのtoken永続埋め込みは禁止する。

---

# 19. Workspace Bootstrap

起動時:

```text
mkdir /workspace
 ↓
GitHub installation token
 ↓
git clone
 ↓
base SHA checkout
 ↓
checkpoint restore
```

checkout完了後tokenを破棄する。

---

# 20. Checkpoint Generation

dirty判定:

```text
git status --porcelain
```

diff:

```bash
git diff --binary HEAD > patch.diff
```

untracked:

```bash
git ls-files --others --exclude-standard
```

対象filesをtarへまとめる。

manifest:

```json
{
  "version": 1,
  "baseCommit": "...",
  "createdAt": "...",
  "patch": "patch.diff",
  "untracked": "untracked.tar"
}
```

bundleをGCSへuploadする。

---

# 21. Checkpoint Scheduler

trigger:

```text
Agent turn complete
dirty for 2m
before stop
before update
manual
```

同時checkpoint禁止。

checkpoint中に新規mutationがあれば、

```text
dirty = true
```

を維持し次checkpointへ回す。

---

# 22. Restore

```text
clone repository
checkout base commit
download checkpoint
git apply --binary
extract untracked tar
validate git status
```

restore後のgit statusがcheckpoint manifestと整合しない場合はREADYにしない。

---

# 23. Harness Session Persistence

`ctx.sessionPersistence` 用のPostgreSQL providerを作成する。

interface semanticsはHarness標準providerに合わせる。

特に、

```text
append-only
contiguous seq
durable append
immutable persisted event
```

を保証する。citeturn517072search3

appendはtransactionで実装する。

---

# 24. Agent Gateway

listen:

```text
0.0.0.0:$PORT
```

責務:

```text
auth identity
workspace authorization
request validation
controller check
session API
SSE
approval
cancel
health
```

Harness内部HTTP Serverを直接Internetへ公開しない。

---

# 25. IAP

Cloud Runアクセスの前段でIAPを利用する。

ApplicationではIAP identityだけを信用せず、

```text
authenticated identity
+
workspace membership
```

をauthorizationに使用する。

---

# 26. Controller Lease

heartbeat:

```text
15 seconds
```

expiration:

```text
45 seconds
```

Acquire:

```sql
INSERT ...
ON CONFLICT ...
```

をtransaction + expiry conditionで実装する。

Takeover:

```text
new controller
 ↓
atomic lease replacement
 ↓
old controller becomes observer
```

---

# 27. Instance Start

`POST /workspaces/:id/open`

処理:

```text
authorize
 ↓
state STOPPED?
 ↓ yes
STARTING
 ↓
Cloud Run start
 ↓
wait for health
 ↓
RESTORING
 ↓
restore
 ↓
READY
```

並行open requestは同じstart operationへcoalesceする。

---

# 28. Idle Manager

workspaceごとに:

```text
lastMeaningfulActivityAt
```

を管理する。

30分経過時:

```text
if (
  !agentRunning &&
  !subprocessRunning &&
  !checkpointRunning
) {
  beginStop();
}
```

SSE heartbeatやbrowser connectionをactivityに含めない。

---

# 29. Graceful Stop

```text
READY
 ↓
STOPPING
 ↓
reject new agent turns
 ↓
wait running operation
 ↓
checkpoint
 ↓
flush session persistence
 ↓
delete sandbox
 ↓
Cloud Run Instance stop API
 ↓
STOPPED
```

checkpoint failure:

```text
CHECKPOINT_FAILED
```

としてCloud Run stopを呼ばない。

---

# 30. Restart Recovery

Host startup時:

```text
read WORKSPACE_ID
 ↓
DB metadata
 ↓
restore workspace
 ↓
restore session metadata
 ↓
create sandbox
 ↓
health READY
```

Cloud Run Instance stop/restartでlocal stateが失われるためこのpathを通常系として扱う。citeturn667424search5

---

# 31. Structured Logging

example:

```json
{
  "severity": "INFO",
  "event": "sandbox.exec.completed",
  "workspaceId": "...",
  "sessionId": "...",
  "sandboxId": "...",
  "toolCallId": "...",
  "argv0": "npm",
  "durationMs": 4212,
  "exitCode": 0
}
```

command全体やenvを無条件でlogしない。

---

# 32. Metrics

最低限:

```text
workspace.start.duration
workspace.restore.duration
workspace.checkpoint.duration

sandbox.create.duration
sandbox.exec.duration
sandbox.reset.count

agent.turn.duration
subprocess.timeout.count

instance.active_minutes

cpu.utilization
memory.utilization
```

---

# 33. Unit Tests

```text
Instance adapter
Sandbox argv builder
env allowlist
cwd validation
workspace path validation
controller lease
checkpoint scheduler
idle calculation
state transition
exit status mapping
timeout mapping
SessionPersistence append
```

---

# 34. Integration Tests

Cloud Run上で:

```text
echo
pwd
git status
git diff
npm install
npm test
TypeScript build
large stdout
large stderr
non-zero exit
timeout
Sandbox recreate
```

を検証する。

---

# 35. Security Tests

必須negative test:

```text
write /etc/test
read Host process env
access metadata server
obtain GitHub App private key
write workspace外
parallel controller acquisition
parallel subprocess
network access when egress-disabled
```

---

# 36. Restart Recovery Test

1. Agent sessionを作成。
2. tracked fileを変更。
3. untracked fileを作成。
4. checkpoint。
5. Instanceをrestart。
6. Session historyを検証。
7. tracked diffを検証。
8. untracked fileを検証。
9. Agent conversationを継続。

---

# 37. Load Test

4 vCPU / 8 GiB Instanceで、

```text
Harness active
+
Sandbox
+
dependency installation
+
10分以上のtest/build
```

を実行する。

測定:

```text
CPU
burst balance影響
memory peak
OOM
build duration
Harness latency
```

CPU burst枯渇後に許容できない性能となる場合はLarge profileへの変更またはruntime選定を再評価する。Cloud Run Instancesはbaseline + burst CPU allocationを採用している。citeturn644489search2

---

# 38. Deployment Stages

## Stage 1 — Technical PoC

```text
single workspace
Cloud Run Instance
Sandbox
/workspace bind mount
npm test
```

## Stage 2 — Agent PoC

```text
Harness
fs-sandbox
subprocess-cloud-run
Agent Loop
```

## Stage 3 — MVP

```text
Cloud SQL
GCS checkpoint
GitHub App
IAP
Controller lease
Idle stop
Restart recovery
```

## Stage 4 — Production hardening

```text
2 Sandbox network model
advanced secret handling
quota
billing
rate limit
security audit
```

## Stage 5 — Advanced Harness

```text
PID / PGID
background jobs
PTY
LSP
terminal
```

---

# 39. Release Gate

MVPリリースには仕様書v1.0のAcceptance Criteriaをすべて満たすこと。

加えてCloud Run Instances / SandboxesがPreviewである間、deploy前にGoogle Cloud Known IssuesとAPI差分を確認する。citeturn667424search6