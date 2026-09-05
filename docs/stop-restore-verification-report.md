# GCP 実機動作確認レポート — stop → restart → 復元（2026-09-05）

[前回のレポート](./e2e-verification-report.md)は「ワークスペースを開く流れ」を実機で通した記録だった。
本レポートはその続きで、**仕様書 §1 の看板機能「Instance 停止・再起動を跨いだ Session /
workspace 復元」を実機で通した記録**である。

**結論: stop → restart → 復元が動いた。** 実装（[#87](https://github.com/mpppk/cloud-run-dsh/pull/87)、
[#72](https://github.com/mpppk/cloud-run-dsh/issues/72) と
[#75](https://github.com/mpppk/cloud-run-dsh/issues/75)）が正しいことを実機で確認し、
その過程で**新たに 5 件の問題**を発見した。

検証後、GCP リソースはすべて削除済み（本文末尾）。

---

## 0. なぜこの検証が必要だったか

前回の検証で確認できたのは `open` → エージェントのターン成功までだった。
**stop → restart → 復元は一度も試していなかった。**

そして調査の結果、そもそも成立しえないことが分かった。`WorkspaceRuntime` の実装が
2つあり、`stop` で片方が呼ばれていなかった。

- **agent-host 側**（`packages/workspace-runtime/src/runtime.ts`）の `stop()` は正しい順序を
  全部踏む: `STOPPING` 遷移 → 進行中ターンのドレイン → ライフサイクルチェックポイント →
  セッション flush → sandbox 破棄 → Cloud Run stop。チェックポイント失敗時は
  `CHECKPOINT_FAILED` にして **Cloud Run の stop を呼ばない**保護まである
- **control-plane 側**（`apps/control-plane/src/runtime-factory.ts`）の `stop()` は
  `client.stop()` **1行だけ**だった

つまり `POST /v1/workspaces/:id/stop` は **agent-host に何も伝えず外から Instance を
止めていた。** 公式ドキュメントは停止で in-memory ファイルが消えると明記している
（"Stopping an instance terminates the active container runtime, **deleting all in-memory
files and unpersisted system state**"）ので、これは不整合ではなく **作業消失**だった。

#87 はこの経路を繋いだ。本レポートはその実機確認である。

---

## 1. 何が動いたか

### 1.1 準備

| 段階 | 結果 |
|---|---|
| `terraform apply`（minimal プロファイル） | **50 added**、exit 0 |
| シークレット3件（DB / OpenRouter / GitHub App） | Secret Manager に格納 |
| マイグレーション | `0001_init` 適用、**6 テーブル**作成 |
| イメージ2つ（agent-host / control-plane） | `linux/amd64` でビルドし Artifact Registry へ push |
| control-plane デプロイ | `/livez` `/readyz` ともに 200 |

### 1.2 ワークスペースを開いてファイルを書く

```
POST /v1/workspaces                → 201
POST /v1/workspaces/:id/open       → 200 {"state":"READY"}   Instance 起動 9.56s
POST /v1/workspaces/:id/sessions   → 201
POST /v1/sessions/:id/messages     → 201
```

**復元を検証するにはワークスペースを dirty にする必要がある。** ワークツリーが clean だと
チェックポイントは正しくスキップされる（`packages/workspace-checkpoint/src/scheduler.ts` の
dirty ゲート）ので、「チェックポイントが 0 件」でも壊れていることにならず、検証にならない。
そこでエージェントにファイルを書かせた。

SSE で受信したターン（抜粋）:

```
turn/start   {"turn":1}
request/context {"provider":"deepseek-official","model":"deepseek/deepseek-v4-flash"}
tool/call    glob  {"pattern":"*"}
tool/call    write {"file_path":"/workspace/RESTORE_PROOF.txt",
                    "content":"stop-restore-marker-20260905"}
tool/call    read  {"file_path":"/workspace/RESTORE_PROOF.txt"}
assistant    "The file `RESTORE_PROOF.txt` has been created … with the exact content"
turn/end     {"turn":1,"reason":{"kind":"completed"}}
```

### 1.3 停止 — ここが #72 の本体

```
POST /v1/workspaces/:id/stop → 200 {"state":"STOPPED"}
```

**GCS は stop 前は空だった。stop 直後にチェックポイントが出現した。**

```
gs://cloud-run-dsh-dev-checkpoints/workspaces/<ws>/checkpoint.bin
  2974 bytes  2026-09-05T08:00:30Z
```

中身を落として展開した結果:

```json
manifest: {"version":1,
           "baseCommit":"2c6fe42d68f1638b2d4059f0fa8c9901df9effb8",
           "createdAt":"2026-09-05T08:00:30.857Z",
           "patch":"patch.diff","untracked":"untracked.tar"}
untrackedFiles: ["RESTORE_PROOF.txt"]
patchDiff: (空。追跡ファイルへの変更は無いため)
untrackedTar: 2048 bytes の POSIX tar
```

```
$ tar xzf untracked.tgz -O RESTORE_PROOF.txt
stop-restore-marker-20260905      ← エージェントが書いた内容そのもの
```

Instance は **delete されず `INSTANCE_STOPPING` で残った**。これは
[#85](https://github.com/mpppk/cloud-run-dsh/issues/85) で確定した設計どおり
（停止中の Instance は課金されないため残す）。

### 1.4 再起動と復元

```
POST /v1/workspaces/:id/open → 200 {"state":"READY"}   39 秒
```

**確認方法として、あえて新しいセッションを作った。** 復元されたセッションを使うと、
エージェントが会話の記憶から答えられてしまい、ファイルシステムが復元されたことの
証明にならない（偽陽性になる）。記憶を持たないセッションにディスクを読ませた。

```
POST /v1/workspaces/:id/sessions → 201   （新規セッション）
POST /v1/sessions/:id/messages   → 201   "Read RESTORE_PROOF.txt … If the file does
                                          not exist, say NOT_FOUND."
```

SSE:

```
tool/call   read {"file_path":"/workspace/RESTORE_PROOF.txt"}
tool/result <path>/workspace/RESTORE_PROOF.txt</path>
            <content>
            1: stop-restore-marker-20260905
            (End of file - total 1 lines)
            </content>
assistant   "The file `RESTORE_PROOF.txt` exists at the repository root with the
             following exact contents: stop-restore-marker-20260905"
turn/end    completed
```

**停止で消えたはずのファイルが、チェックポイント経由で戻ってきた。**

### 1.5 手動チェックポイント（#75）

以前はマーカー JSON を置くだけで `checkpointed: true` を返していた（API の嘘）。

```
POST /v1/workspaces/:id/checkpoints → 200 {"checkpointed":true}
```

```
checkpoint.bin  08:00:30Z → 08:05:46Z    ← タイムスタンプ更新＝実スナップショットを書き直した
manual-checkpoints/2026-09-05T08-05-46-407Z.json:
  {"kind":"manual-checkpoint-request",…,"checkpointSkipped":false}
```

マーカーは監査記録として残しつつ、**中身は本当に取り直されている。**

### 1.6 セッション永続化

再起動を跨いで `session_events` が残っていた。

```
workspaces               1
sessions                 2
session_events         129   （再起動前のセッションに 88、再起動後の新セッションに 41）
controller_leases        1
workspace_checkpoints    0   ← 後述（#95）
```

---

## 2. 発見した問題 5 件

| # | 内容 | 種別 |
|---|---|---|
| [PR #96](https://github.com/mpppk/cloud-run-dsh/pull/96) | `Bun.serve` の `idleTimeout` 未設定で 10 秒超のリクエストが全滅 | **本番バグ** |
| [#93](https://github.com/mpppk/cloud-run-dsh/issues/93) | runbook どおりだとデプロイが必ず失敗（シークレットの accessor 権限が抜けている） | 手順書 |
| [#94](https://github.com/mpppk/cloud-run-dsh/issues/94) | runbook の DB 接続が TCP 形式で、`authorized_networks` が空なので繋がらない | 手順書 |
| [#95](https://github.com/mpppk/cloud-run-dsh/issues/95) | チェックポイントを GCS に 2 回書いたのに `workspace_checkpoints` が 0 行 | 実装の穴 |
| [#97](https://github.com/mpppk/cloud-run-dsh/issues/97) | `/readyz` が DB 不通でも ready を返した | 実装の穴 |

あわせて [#91](https://github.com/mpppk/cloud-run-dsh/issues/91)（runbook の `docker build` に
`--platform linux/amd64` が無い）をビルド時に起票した。

---

## 3. 特筆すべき発見

### 3.1 浮動タグのリスクが現実になった

`POST /open` が **503（プレーンテキスト）** で落ちた。ログの決定的な一行:

```
warn: Bun.serve() timed out a request after 10 seconds. Pass `idleTimeout` to configure.
ERROR The request failed because either the HTTP response was malformed or
      connection to the instance had an error
```

`Bun.serve` の `idleTimeout` は既定 10 秒。`open` は Instance の create + start +
readiness ポーリングで 60 秒前後かかるので、応答の途中で接続が切られ、Cloud Run が
それを 503 に変換していた。

**コードは変わっていない。変わったのはコンテナの Bun のバージョンである。**
前回の検証では同じ経路が 57 秒で 200 を返していた。Dockerfile が `oven/bun:1` という
浮動タグを使っているため、それ以降の変更を拾った。

これは [#83](https://github.com/mpppk/cloud-run-dsh/issues/83) で
「浮動タグと `.bun-version` が乖離している」とリスクとして起票していたものが、
**実際に壊れた形**である。起票した時点では「いつか壊れる」でしかなかった。

agent-host 側も同時に直した。`prepare-stop` はライブターンをドレインしてバンドルを
書いてから応答するので 10 秒は普通に超える。**今回検証しようとしていた経路そのものが、
同じ理由で死ぬところだった。**

さらに [PR #96](https://github.com/mpppk/cloud-run-dsh/pull/96) のレビューで、
**この修正が SSE も黙って直していた**ことが分かった。control-plane の `sse.ts` と
agent-host の `gateway.ts` はどちらも **15 秒間隔**で heartbeat を流している。
旧既定の 10 秒では **heartbeat 間隔のほうが長い**ため、イベントが流れていない区間で
SSE の接続も切られていたはずである。今回の検証では、ターン中はイベントが連続して
流れていたため踏まなかった。**気づかずに直っていた不具合**であり、記録しておく。

### 3.2 手順書どおりにやると必ず失敗する箇所が 2 つあった

**#93 と #94 は、どちらも「runbook を素直に実行すると 100% 失敗する」。**

- #93: Step 6 が `control-plane-database-url` を `gcloud secrets create` で作らせるが、
  **accessor 権限を付ける手順が無い。** Terraform 管理の3つには付いているのに、
  4つ目だけが管理外にあるという非対称が原因。runbook のコメント自体は
  「control-plane SA は db-password / github-app-private-key / llm-api-key の accessor を
  持っている」と3つを正しく列挙しているが、**4つ目の存在に気づいていない**
- #94: Step 6 の `DATABASE_URL` が TCP 形式だが、`authorized_networks` が空である以上
  Cloud Run の service も共有プールから egress するので TCP は開かない
  （`Connection timeout after 30s` を実測）。**同じ runbook の Step 4 が自分でその理由を
  説明している**のに、Step 6 が「services reach Cloud SQL over TCP」という誤った前提を
  書いていた

前回の検証でも同じ壁に当たり、手で回避したまま記録し忘れたと思われる。
**今回それが再現し、ようやく記録された。**

なお #93 は撤収側でも顔を出した。`terraform destroy` 後に
`control-plane-database-url` だけが残り、手で削除する必要があった。

### 3.3 チェックポイントの形式はドキュメントの記述と違う

`docs/architecture.md` のシーケンス図は「ワークスペースを **tar.gz** で保存」と書き、
#72 の本文も「tar.gz のチェックポイント」と書いていた。**実際の形式は違う。**

```
checkpoint.bin = JSON {
  manifest: { version, baseCommit, createdAt, patch, untracked },
  patchDiff:      追跡ファイルへの変更（git patch のテキスト）,
  untrackedFiles: 未追跡ファイルのパス一覧,
  untrackedTar:   未追跡ファイルの tar（base64）
}
```

ベースコミット + 差分 + 未追跡ファイルという構成で、**丸ごと tar.gz より賢い**
（リポジトリ本体は clone で復元し、差分だけ運ぶ）。実害は無いが、記述が実態と違う。
本レポートに合わせて図と表を修正した。

### 3.4 実装もテストもあるのに本番で一度も使われないテーブル（#95）

チェックポイントを GCS に 2 回書いたのに、`workspace_checkpoints` は **0 行**のままだった。

INSERT の実装は `apps/agent-host/src/adapters.ts:798` にあり、スキーマにもテーブルがあり、
ユニットテストも INSERT の形を検証している。だが INSERT が走るのは状態遷移に渡される
`persist` コールバック経由だけで、チェックポイント作成経路がそこを通っていない。

復元は GCS のキー規約（`workspaces/<id>/checkpoint.bin`）を直接引いているため
**動いてはいる**。つまりこのテーブルは現状 dead weight である。

**これは前回のレポートで整理した「本番だけで出るバグ」の型そのもの**である
（[production-only bug pattern](./e2e-verification-report.md)）。
テストダブルは INSERT を検証しているが、本番の呼び出し経路がそこに来ない。

### 3.5 #73 の回避手順が実機で正しいと確認できた

[#73](https://github.com/mpppk/cloud-run-dsh/issues/73) は
「マイグレーション後は `terraform destroy` が必ず失敗する」という問題である。

今回は destroy の前に `DROP OWNED BY dsh_app CASCADE` を流した。
**結果、`terraform destroy` は一発で通った（50 destroyed、exit 0）。**
[PR #79](https://github.com/mpppk/cloud-run-dsh/pull/79) で 4 巡かけて確定させた手順が、
実機で正しいことが証明された。

ただし**追加の落とし穴**が1つ見つかった。`DROP OWNED BY` が最初に失敗した:

```
PostgresError: remaining connection slots are reserved for roles with privileges of
the "pg_use_reserved_connections" role
```

`db-f1-micro` は接続スロットが極端に少なく、**Bun.SQL の既定プールが食い潰す。**
`new SQL({ url, max: 1 })` で単一接続にすれば通る。#73 の手順に追記が必要。

---

## 4. 未解決の項目

| 項目 | 状態 |
|---|---|
| `CHECKPOINT_FAILED` の保護の実機確認 | **未確認。** チェックポイントを失敗させる安全な方法が無かった。ローカルではテストで固定済み（#87） |
| 同時 stop のレース | ローカルで決定論的に再現済み（#88 → PR #92）。**実機では未確認** |
| `workspace_checkpoints` を書くか消すか | #95 で判断待ち |
| `/readyz` の DB 到達性 | #97 で判断待ち |
| IAP フロントエンド | 未作成（ブランドは一度作ると削除できないため）。本検証は `--ingress=all` + `--no-allow-unauthenticated` + ID トークンで代替した。**IAP 経由の経路は依然未検証** |

---

## 5. 撤収

```
Cloud SQL:   なし
Cloud Run:   なし
バケット:     なし
Secret:      なし
Instances:   0
```

`terraform destroy` は **50 destroyed で一発成功**（前掲 3.5）。
Terraform 管理外の `control-plane-database-url` のみ残ったため手動削除した（#93）。

ローカルの秘密（GitHub App の PEM、DB パスワード、LLM キー、ダウンロードした
チェックポイント）は 3 回上書きしてから削除済み。

---

## 6. 前回レポートとの差分

| | 前回（open まで） | 今回（stop → 復元） |
|---|---|---|
| 発見したバグ | 14 件 | 5 件 |
| Terraform リソース | 48 | **50**（Artifact Registry の reader 2 件が増えた） |
| `terraform destroy` | 2 回目で成功 | **1 回で成功**（事前に `DROP OWNED BY`） |
| 確認した経路 | `open` → ターン | `stop` → チェックポイント → `restart` → 復元 |

前回のレポートは「バグ 14 件のすべてがテストダブルかコメントと実物の乖離だった」と
結論した。**今回の 5 件のうち 3 件（#93 / #94 / #97）も同じ型である** — 手順書と
コメントが、実物と違うことを書いていた。
