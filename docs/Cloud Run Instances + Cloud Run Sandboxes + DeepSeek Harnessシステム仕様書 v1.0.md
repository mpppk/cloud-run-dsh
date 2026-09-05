# Cloud Run Instances + Cloud Run Sandboxes + DeepSeek Harness
# システム仕様書 v1.0

**策定日:** 2026-09-02  
**ステータス:** Approved Baseline  
**対象:** AI Coding Agent実行基盤

---

## 1. 目的

DeepSeek HarnessをAgent RuntimeとしてCloud Run Instance上で稼働させ、AI Agentが要求するShellコマンド、Git操作、ビルド、テスト、生成コード実行等をCloud Run Sandboxへ隔離する。

本システムでは以下を実現する。

- 1 workspace = 1 Cloud Run Instance
- workspaceごとの独立したAgent Runtime
- DeepSeek Harnessの継続Session
- AI生成コードのHostからの隔離
- GitHub repositoryとの連携
- Instance停止・再起動を跨いだSession / workspace復元
- idle workspaceの自動停止
- 複数ブラウザからの閲覧
- workspace単位のsingle-writer制御
- Cloud Run Instanceの明示的なstart / stopによるコスト制御

Cloud Run Instanceは通常のCloud Run Serviceとは異なり、個別にaddress可能なsingleton containerであり、create / start / stop / deleteを明示的に管理できるため、本システムのAgent Hostとして採用する。citeturn667424search5

---

## 2. 確定済み設計値

| 項目 | v1.0 |
|---|---|
| Runtime単位 | 1 workspace = 1 Cloud Run Instance |
| Agent Runtime | DeepSeek Harness |
| Execution isolation | Cloud Run Sandbox |
| Session DB | Cloud SQL for PostgreSQL |
| Workspace checkpoint | Cloud Storage |
| Git provider | GitHub |
| Git認証 | GitHub App + short-lived installation token |
| Harness filesystem policy | `workspace-write` |
| MVP Sandbox egress | Enabled |
| Production Sandbox egress | Network / Execution sandbox分離 |
| User authentication | IAP |
| CPU | 4 vCPU |
| Memory | 8 GiB |
| Instance start | workspaceを開いた時 |
| Idle timeout | 30分 |
| Instance stop | idle timeout後 |
| Checkpoint | Agent turn完了 + dirty最大2分 + lifecycle前 |
| Browser connection | 複数可 |
| Controller | workspaceにつき1接続 |
| Active subprocess | workspaceにつき1つ |
| PTY | MVP対象外 |
| LSP | MVP対象外 |
| Interactive terminal | MVP対象外 |
| Restart policy | `on-failure` |

Cloud Run SandboxはHostとCPU / memory allocationを共有するため、4 vCPU / 8 GiBはHarnessとSandboxを合わせたallocationである。Cloud Run Instancesは最大8 vCPU / 32 GiBまで設定でき、4 vCPUでは2–16 GiBを構成できる。citeturn667424search0turn644489search2turn644489search7

---

# 3. 全体アーキテクチャ

```text
                         Browser
                            │
                            │ IAP
                            ▼
                ┌─────────────────────┐
                │ Control Plane       │
                │                     │
                │ Workspace API       │
                │ Instance Controller │
                └──────────┬──────────┘
                           │
                  workspace → instance
                           │
                           ▼
┌────────────────────────────────────────────────┐
│ Cloud Run Instance                             │
│ 1 instance = 1 workspace                       │
│                                                │
│ ┌────────────────────────────────────────────┐ │
│ │ Agent Gateway                              │ │
│ │                                            │ │
│ │ API / SSE                                  │ │
│ │ controller lease                           │ │
│ │ auth context                               │ │
│ └──────────────────┬─────────────────────────┘ │
│                    │                           │
│ ┌──────────────────▼─────────────────────────┐ │
│ │ DeepSeek Harness                           │ │
│ │                                            │ │
│ │ Agent Loop                                 │ │
│ │ Session                                    │ │
│ │ Approval                                   │ │
│ │ fs-sandbox                                 │ │
│ │ fs-observation-policy                      │ │
│ │ subprocess-cloud-run                       │ │
│ └───────────────┬────────────────────────────┘ │
│                 │                              │
│              /workspace                       │
│                 │                              │
│                 │ bind mount                   │
│                 ▼                              │
│ ┌────────────────────────────────────────────┐ │
│ │ Cloud Run Sandbox                          │ │
│ │                                            │ │
│ │ bash                                       │ │
│ │ git                                        │ │
│ │ node / npm                                 │ │
│ │ python                                     │ │
│ │ compiler                                   │ │
│ │ tests                                      │ │
│ │ generated code                             │ │
│ └────────────────────────────────────────────┘ │
└───────────────────┬────────────────────────────┘
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
    Cloud SQL      GCS         GitHub
    sessions    checkpoints   repository
```

---

# 4. Control Plane / Execution Plane

## 4.1 Control Plane

Cloud Run Instance上で動作する以下をControl Planeとする。

- Agent Gateway
- DeepSeek Harness
- Agent Loop
- Session管理
- Approval
- workspace metadata
- credentials broker
- checkpoint coordinator
- Sandbox Manager

LLM API key、Google Cloud credential、GitHub App private key等の長寿命credentialはControl Planeだけが保持する。

## 4.2 Execution Plane

Cloud Run SandboxをExecution Planeとする。

以下はSandbox内でのみ実行する。

- bash
- git command
- npm / pnpm
- compiler
- test runner
- Python
- repository由来script
- AI生成コード

Cloud Run Sandboxはデフォルトで親workloadのenvironment variables、Secrets、Google Cloud metadata serverへアクセスできず、sandbox同士も隔離される。citeturn989520search1

---

# 5. Harness Integration

Harness本体はforkしない。

HarnessのCapability Seamを利用する。
（以下の素の名称は能力名の略称であり、npm パッケージは `@deepseek-ai/` スコープ付き
`@deepseek-ai/dsh-*`（例: `@deepseek-ai/dsh-fs-sandbox`）を指す）

```text
ctx.fs
    ↓
fs-sandbox
    ↓
Host /workspace

ctx.subprocess
    ↓
dsh-subprocess-cloud-run
    ↓
sandbox CLI
    ↓
Cloud Run Sandbox
```

Harnessではfilesystem / subprocessが交換可能なexecution-world capabilityとして設計され、E2B実装でも同方式が採用されている。citeturn517072search0turn517072search7turn517072search9

---

# 6. Filesystem

## 6.1 Workspace root

```text
/workspace
```

を唯一のmutable workspace rootとする。

## 6.2 Harness filesystem

以下を利用する。

```text
fs-sandbox
+
fs-observation-policy
```

permission mode:

```text
workspace-write
```

これによりmodel-facing `write` / `edit` は、ワークスペースルートおよびプラットフォームの
一時領域（`/tmp`）を除くワークスペース外への**永続的な**変更を拒否する。
`/tmp` ちょうど（`/var/tmp` は不可）への書き込みは upstream の `workspace-write` の
定義として許可される。2026-09-03 に GCP 上の Instance で実測済み
（`/etc`・`/var/tmp`・`/home`・`/app`・パストラバーサルは全て拒否、`/tmp` のみ許可。
詳細は `docs/bringup-report.md` の G8 を参照）。

`/tmp` を許すのは Harness のバグではなく仕様であり、封じ込めは次の理由で成立している
（[#30](https://github.com/mpppk/cloud-run-dsh/issues/30) での判断: 許容する）。
ワークスペース外の永続的な書き込みは拒否されるため、`/tmp` に書かれたものが
ホストや他ワークスペースの永続状態を汚すことはない。加えて Instance は短命であり、
プロセス終了時に `/tmp` ごと消える。チェックポイントの対象は `/workspace` のみで、
`/tmp` の内容が GCS や Cloud SQL に残ることもない。

`fs-observation-policy` によりread-before-write/editおよびstale-write保護を維持する。citeturn517072search4turn517072search10

## 6.3 Sandbox filesystem

Host:

```text
/workspace
```

をSandbox:

```text
/workspace
```

へbind mountする。

Cloud Run SandboxはHost directoryのbind mountをサポートしている。citeturn989520search1turn989520search5

---

# 7. Workspace Durability

Cloud Run Instanceのlocal filesystemをdurable storageとして扱わない。

Instanceをstopするとactive runtimeおよび未永続filesystem stateが失われる。citeturn667424search5

永続状態を次のように分離する。

```text
GitHub
    canonical repository history

Cloud SQL
    workspace metadata
    session event log
    checkpoint metadata

Cloud Storage
    uncommitted workspace checkpoint
```

checkpoint内容:

```text
base_commit_sha
git diff --binary
untracked_files.tar
metadata.json
```

除外:

```text
node_modules/
.next/
dist/
build/
coverage/
.cache/
.git/
```

---

# 8. Workspace Restore

Instance起動時:

```text
STARTING
  ↓
Git clone
  ↓
base commit checkout
  ↓
checkpoint download
  ↓
git diff apply
  ↓
untracked files restore
  ↓
Sandbox create
  ↓
Harness restore
  ↓
READY
```

復元失敗時:

```text
RESTORE_FAILED
```

としAgent入力を受け付けない。

> 補足（2026-09-05 [#60](https://github.com/mpppk/cloud-run-dsh/issues/60) /
> [#61](https://github.com/mpppk/cloud-run-dsh/issues/61) での確定事項）。
> 上の復元ステップの駆動主体は分割する。control-plane が `openInstance()`
>（`STOPPED → STARTING` + Instance 起動 + ヘルス観測。`STARTING` で停止）と、
> agent-host が `completeRestore()`（`STARTING → RESTORING → READY`）を担い、
> 単一プロセス利用向けの `open()` は両者の合成として残す。
> agent-host が `open()` を呼ぶと共有行が既に `STARTING` のため失敗するので、
> `completeRestore()` を呼ぶこと。

---

# 9. Workspace State Machine

```text
STOPPED
   │ open workspace
   ▼
STARTING
   ▼
RESTORING
   ▼
READY
   │
   ├───────────────┐
   │               │
   ▼               ▼
BUSY             CHECKPOINTING
   │               │
   └───────┬───────┘
           ▼
         READY
           │
        idle 30m
           ▼
       STOPPING
           │
      checkpoint
           ▼
        STOPPED
```

error state:

```text
ERROR
RESTORE_FAILED
CHECKPOINT_FAILED
```

---

# 10. Instance Start Policy

Instanceはworkspace詳細画面を開いた時点でstartする。

以下ではstartしない。

```text
workspace list表示
dashboard表示
background polling
```

目的は、ユーザーがpromptを入力している間にcold start / restoreを進めることである。

---

# 11. Idle Policy

idle timeout:

```text
30 minutes
```

Meaningful Activityは以下。

```text
user message
approval operation
agent turn
tool invocation
subprocess
filesystem mutation
checkpoint
explicit workspace operation
```

以下はactivityとして扱わない。

```text
health check
SSE heartbeat
browser connection維持
status polling
metrics collection
```

30分経過時に、

```text
agent running = false
subprocess running = false
checkpoint running = false
```

なら停止処理へ入る。

ブラウザが開いているだけではInstanceを維持しない。

---

# 12. Checkpoint Policy

checkpoint trigger:

### A. Agent turn完了

```text
agent turn completed
AND dirty
→ checkpoint
```

### B. Periodic

```text
dirty
AND last checkpoint >= 2 minutes
AND workspace mutationが安全な状態
→ checkpoint
```

### C. Lifecycle

以下の前には必須。

```text
Instance stop
Instance update
graceful shutdown
manual stop
```

lifecycle checkpoint失敗時はstopを中止する。

---

# 13. Cloud Run Sandbox Lifecycle

原則:

```text
1 workspace
=
1 Cloud Run Instance
=
1 named Sandbox
```

Sandbox名:

```text
dsh-${workspaceId}
```

Instance restore時に作成し、Instance停止時にdeleteする。

named Sandboxをdetachで維持し、繰り返し `sandbox exec` する。

これはCloud Run Sandboxesが公式に想定する再利用パターンである。citeturn989520search1turn989520search3

---

# 14. Sandbox Networking

## MVP

```text
egress = enabled
```

理由:

- git clone
- git fetch
- GitHub API
- npm install
- pnpm
- pip install

Cloud Run Sandboxのegressはデフォルトdenyであり、必要な場合はsandbox生成時に明示的に許可する。citeturn989520search1turn989520search3

## Production

2 Sandboxへ分離する。

```text
Network Sandbox
    egress = enabled
    git
    dependency download

Execution Sandbox
    egress = disabled
    tests
    build
    generated code
```

両者は同じ `/workspace` を利用する。

---

# 15. Subprocess Model

MVPでは、

```text
active subprocess / workspace = 1
```

とする。

commandはqueueで直列化する。

対応:

```text
resolveExecutable
spawn
cwd
env
stdin
stdout
stderr
exit code
AbortSignal
timeout
```

MVP非対応:

```text
PTY
terminal resize
persistent interactive shell
LSP
multiple concurrent commands
arbitrary background jobs
```

Harness subprocess seamはPTY、LSP、process-tree managementまで扱えるが、MVPはそのsubsetのみ実装する。citeturn517072search8

---

# 16. Timeout / Cancellation

MVPではprocess groupの完全管理を実装しない。

timeoutまたはcancel時:

```text
1. sandbox exec callerをcancel
2. named sandbox delete
3. named sandbox recreate
4. /workspace bind mount reconnect
5. subprocess result = cancelled / timeout
```

subprocessを1つに制限するため、Sandbox単位のresetで安全なtermination boundaryを確保する。

Phase 2でPID / PGID管理へ変更可能とする。

---

# 17. Environment Variables

SandboxはHost environmentを自動継承しない。citeturn989520search1

明示的なallowlistのみ渡す。

例:

```text
CI
NODE_ENV
LANG
LC_ALL
TERM
```

以下は禁止。

```text
LLM_API_KEY
DATABASE_URL
GCP credential
GitHub App private key
Secret Manager payload
```

Host credentialをfilesystem上へ配置しない。

---

# 18. GitHub Authentication

GitHub App private keyはHostだけが保持する。

git operation時:

```text
Agent
 ↓
Git operation request
 ↓
Host GitHub Credential Broker
 ↓
short-lived installation token
 ↓
Sandbox commandへ限定注入
 ↓
git fetch/push
 ↓
discard token
```

Sandboxへprivate keyまたはlong-lived PATを渡さない。

---

# 19. Session Persistence

Cloud SQL PostgreSQLを使用する。

Harness Session Logはmodel historyのsource of truthであり、append-only persistence seamとして設計されている。citeturn517072search2turn517072search3

主要table:

```text
workspaces
workspace_checkpoints
sessions
session_events
controller_leases
```

`session_events`:

```text
PRIMARY KEY(session_id, seq)
```

event sequenceを連続かつimmutableに保つ。

---

# 20. Browser Concurrency

同一workspaceへの複数browser connectionを許可する。

ただし、

```text
controllersPerWorkspace = 1
```

とする。

Controller:

```text
message send
approval
cancel
manual checkpoint
```

Observer:

```text
session stream
status
diff
logs
```

Controller lease initial implementation:

```text
heartbeat: 15 seconds
lease expiry: 45 seconds
```

takeover時は旧controllerをobserverへ降格する。

> 補足（2026-09-05 実機検証 [#60](https://github.com/mpppk/cloud-run-dsh/issues/60) /
> [#61](https://github.com/mpppk/cloud-run-dsh/issues/61) での確定事項）。
> 本節のリース（どのユーザが入力を送れるか）と §26-8 のリース
> （どのホストプロセスが workspace を所有するか）は**実装では1つのリースで表現する**
>（`controller_leases` の世代ごと UUID）。
> `POST /v1/workspaces/:id/open` がリースを確立し、その `controllerId` を
> Instance 環境変数 `CONTROLLER_ID` に注入する。agent-host は自力で新規取得せず、
> その ID を引き継ぐ（無ければ取得・同一 ID なら heartbeat・別 ID なら
> `LeaseAlreadyHeldError` で拒否し、2つ目のホストの起動を拒否する）。
> 既知の制限: リースが handover された後に古い `CONTROLLER_ID` のままの Instance が
> 再起動すると、新ホストは自分を拒否するため Instance の作り直しが必要。
> 根本解決（ホスト fencing とユーザ controller の分離）は将来課題とする。

---

# 21. Authentication

ユーザー認証はIAPを基本とする。

Application側では認証済identityから内部user IDを解決し、

```text
user
→ workspace membership
→ authorization
```

を必ず検証する。

IAPはinternal user向けCloud Run authenticationの推奨方式である。citeturn644489search8

---

# 22. Instance Resources

default:

```yaml
cpu: 4
memory: 8Gi
restartPolicy: on-failure
sandboxLauncher: true
```

CPUはburst / throttlingモデルであり、長時間のCPU-intensive buildではburst budget枯渇後のperformanceを実測する。citeturn644489search2

将来profile:

```text
Small
2 vCPU / 4 GiB

Standard
4 vCPU / 8 GiB

Large
8 vCPU / 16 GiB
```

v1ではStandardのみ。

---

# 23. Restart Policy

`on-failure` を採用する。

理由:

- abnormal process exit → restart
- planned idle stop → Cloud Run Instance Stop API
- graceful stopとcrashを区別可能

Cloud Runのrestart policyは `on-failure` / `always` / `never` を提供する。citeturn667424search2

またPreview時点で `always` に既知問題があるため採用しない。citeturn667424search6

---

# 24. Control Plane API

```text
POST /v1/workspaces
GET  /v1/workspaces/:id
POST /v1/workspaces/:id/open
POST /v1/workspaces/:id/stop

GET  /v1/workspaces/:id/sessions
POST /v1/workspaces/:id/sessions

POST /v1/sessions/:id/messages
GET  /v1/sessions/:id/events

POST /v1/sessions/:id/approvals/:approvalId
POST /v1/sessions/:id/cancel

POST /v1/workspaces/:id/checkpoints

POST /v1/workspaces/:id/controller/acquire
POST /v1/workspaces/:id/controller/heartbeat
POST /v1/workspaces/:id/controller/release
```

Agent streamingはSSEを採用する。

PTY導入時にWebSocketを追加検討する。

> 補足（2026-09-05 [#22](https://github.com/mpppk/cloud-run-dsh/issues/22) /
> [#68](https://github.com/mpppk/cloud-run-dsh/issues/68) での確定事項）。
> `POST /v1/sessions/:id/messages` は control-plane が共有 DB へ `user_message` を
> 追記した後（single-writer は control-plane のみ）、workspace の Instance URL へ
> 転送する（ID トークン認証。§3 の control-plane → Instance の矢印がこの経路）。
> agent-host は `user_message` を再追記しない。URL が無い停止中 Instance への送信は
> 409、追記成功後の転送失敗は 502 とする。
> ヘルス観測と readiness は `/readyz` で行う。完全一致の `/healthz` は Cloud Run の
> frontend が予約しておりコンテナにルーティングされないため使用しない
>（control-plane の `/livez` / `/readyz` 分割も同理由）。

---

# 25. Observability

structured log:

```text
workspace_id
instance_name
session_id
sandbox_id
tool_call_id
user_id
controller_id
process_id
event
duration_ms
exit_code
```

主要metrics:

```text
workspace_start_duration
workspace_restore_duration
workspace_checkpoint_duration

agent_turn_duration

sandbox_create_duration
sandbox_exec_duration
sandbox_reset_count

subprocess_timeout_count

instance_active_minutes
instance_idle_stop_count

cpu_utilization
memory_utilization

llm_tokens
llm_cost
```

Sandbox lifecycleはCloud Loggingにも記録される。citeturn989520search1

---

# 26. Security Requirements

必須:

1. AI生成commandをHost上で直接実行しない。
2. `/workspace` 外へのmodel-driven writeを禁止する。ただしプラットフォームの一時領域
   （`/tmp`。`/var/tmp` は不可）への書き込みは upstream の `workspace-write` の定義として
   許す（§6.2）。`/tmp` は Instance の破棄とともに消え、チェックポイントにも含まれない。
3. Host credentialをSandboxへ継承しない。
4. GitHub App private keyをSandboxへ渡さない。
5. SecretをHost filesystemへ書かない。
6. Sandbox environment variableをallowlist化する。
7. workspace所有権を全APIで検証する。
8. Controller leaseをworkspace単位で管理する。
9. lifecycle stop前にcheckpointする。
10. Cloud Run Preview APIへの依存をAdapterへ限定する。
11. command argvはshell文字列連結せずstructured argvで渡す。
12. stdout / stderrへsecret redactionを適用する。

> 補足（2026-09-05 [#42](https://github.com/mpppk/cloud-run-dsh/issues/42) の教訓）。
> redaction はアプリケーションが出すログに適用される。Bun ランタイム内部が投げる
> 例外など redactor を通らない経路があるため、secret を含みうる値自体を
> ランタイム API に渡さないこと（例: パスワード入り DSN 文字列を `Bun.SQL` に
> 渡さず、username / password / database を分けた options オブジェクトで接続し、
> 失敗時のメッセージに DSN を含めない）。

---

# 27. MVP Scope

含む:

```text
Cloud Run Instance lifecycle
Cloud Run Sandbox
DeepSeek Harness
read/write/edit
bash
git
npm/pnpm
tests/build
session persistence
checkpoint/restore
GitHub App
IAP
SSE
approval
controller lease
idle stop
observability
```

含まない:

```text
PTY
interactive shell
LSP
multiple concurrent subprocesses
persistent background jobs
multiple Sandbox execution policies
branch-level Sandbox fork
danger-full-access
```

---

# 28. MVP Acceptance Criteria

すべて満たすこと。

```text
✓ workspace openでInstanceが起動する
✓ 1 workspaceに1 Instanceだけ存在する
✓ Sandboxがnamed Sandboxとして作成される
✓ Harnessからnpm testをSandboxで実行できる
✓ stdout / stderr / exit codeがHarnessへ返る
✓ Harness file editがSandboxから即時参照できる
✓ workspace外へのfile editが拒否される（`/tmp` の一時書き込みを除く。§6.2）
✓ SandboxからHost credentialを取得できない
✓ GitHub App tokenでclone/fetch/pushできる
✓ Agent sessionがCloud SQLへ永続化される
✓ dirty workspaceがGCSへcheckpointされる
✓ Instance restart後Sessionが復元される
✓ Instance restart後uncommitted changesが復元される
✓ timeout commandをSandbox resetで停止できる
✓ meaningful activityなし30分後にInstanceがstopする
✓ browser connectionのみではidle timerが延長されない
✓ 複数browserが同一sessionを閲覧できる
✓ controllerは常に最大1つ
✓ controller takeoverが成功する
✓ 4 vCPU / 8 GiBで10分以上のbuild/test負荷試験を通過する
```

---

# 29. Production移行条件

MVP稼働データを基に以下を判断する。

- CPU profile
- memory profile
- idle timeout
- checkpoint interval
- Sandbox egress separation
- process-tree management
- background jobs
- PTY / LSP

Cloud Run Instances / SandboxesがPre-GAである間はbreaking change確認を各release前に実施する。citeturn667424search0turn667424search5