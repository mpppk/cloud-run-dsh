# GCP 実機動作確認レポート — stop → restart → 復元（2026-09-05）

[前回のレポート](./e2e-verification-report.md)は「ワークスペースを開く流れ」を実機で通した記録だった。
本レポートはその続きで、**仕様書 §1 の看板機能「Instance 停止・再起動を跨いだ Session /
workspace 復元」を実機で通した記録**である。

**結論: stop → restart → 復元が動いた。** 実装（[#87](https://github.com/mpppk/cloud-run-dsh/pull/87)、
[#72](https://github.com/mpppk/cloud-run-dsh/issues/72) と
[#75](https://github.com/mpppk/cloud-run-dsh/issues/75)）が正しいことを実機で確認し、
その過程で**新たに 5 件の問題**を発見した。

その後、**さらに 5 周**（環境の構築 → 確認 → 撤収）を回している。
2周目は §6、3周目は §7、4周目は §8、5周目は §9、6周目は §10、6 周を通した総括は §12 にある。
6周目だけは目的が違い、**#135（`open` の非同期化 / workspace 一覧 / product UI）と #141 の
診断情報**を初めて実機に載せる周である。
**復元は 6 周とも成立した**（4周目だけは open を呼び直す必要があった — §8.3）。
**5周目は新しいバグが 1 件も出なかった** — その読み方は §12 末尾に書いた。

検証後、GCP リソースはすべて削除済み（各周の撤収節）。

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

> **この節は1周目の時点の記録である。** 下 4 行のうち 2 行は同じ日の2周目で決着した
> （§6 参照）。決着した行はその旨を追記し、行そのものは当時の記録として残す。
> 3 周を終えた時点で**まだ未確認のまま残っているもの**は §7.5 にまとめてある。

| 項目 | 状態 |
|---|---|
| `CHECKPOINT_FAILED` の保護の実機確認 | **未確認。** チェックポイントを失敗させる安全な方法が無かった。ローカルではテストで固定済み（#87） |
| 同時 stop のレース | ローカルで決定論的に再現済み（#88 → PR #92）。**実機では未確認** |
| `workspace_checkpoints` を書くか消すか | **決着。**「書く」を採用（#95 → PR #101）。2周目の実機で 3 行を確認（§6.1）。ただし全行が同じオブジェクトを指す点は [#110](https://github.com/mpppk/cloud-run-dsh/issues/110) |
| `/readyz` の DB 到達性 | **決着。**実プローブを入れた（#97 → PR #102）。2周目の実機で ready を確認（§6.1） |
| IAP フロントエンド | 未作成（ブランドは一度作ると削除できないため）。本検証は `--ingress=all` + `--no-allow-unauthenticated` + ID トークンで代替した。**IAP 経由の経路は依然未検証**。6周目でも利用者が明示的に見送りを決めており、[#128](https://github.com/mpppk/cloud-run-dsh/issues/128) はこの 1 条件だけ未達で開いたままである（§10） |

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

## 6. 2周目（同日）— 1周目の修正の実機検証

1周目で直した13本のうち、**実機でしか判定できないもの**を同じ日にもう一度環境を作って
確認した。あわせて新しい問題が3件見つかった。

### 6.1 1周目の修正の検証結果

| 対象 | 1周目 | 2周目 |
|---|---|---|
| デプロイ（#93 / #94） | revision **00003**（accessor 権限と TCP 形式で2回失敗） | ✅ **00001。一発成功** |
| `open` の初回（#96） | **503**（`idleTimeout`） | ✅ **200 READY、20 秒** |
| コンテナの Bun（#100） | qemu の制限で**確認不能** | ✅ 起動して `/livez` 200。**`idleTimeout` を受理** |
| `workspace_checkpoints`（#101） | **0 行** | ✅ **3 行** |
| `/readyz`（#102） | DB 不通でも ready | ✅ 実プローブ付きで ready |
| `POST /checkpoints` の `skipped`（#89） | 応答に無い | ✅ clean で `true`、dirty で `false` |
| ログ中のトークン（#76） | — | ✅ **0 件** |
| stop → 復元（#72 / #87） | 成立（39 秒） | ✅ 成立（58 秒） |
| 撤収（#73 / #103） | `DROP OWNED BY` が**必須** | ✅ **不要。52 destroyed が一発** |
| Terraform リソース数 | 50 | **52**（#93 でシークレット + IAM が Terraform 管理に移ったため） |

### 6.2 #85 の未確認事項が確定した — 停止中の Instance は quota を消費する

1周目は「停止中の Instance が region あたり 100 の quota を消費するか」を
**未確認のまま**残した（推測で断定しないという判断）。2周目で決着した。

`serviceruntime.googleapis.com/quota/allocation/usage`
（`quota_metric="run.googleapis.com/instances"`、asia-northeast1）:

```
11:40:50  0   ← Instance 作成前
11:41:18  1   ← 作成後
   （11:44 と 11:51 に stop。データ点なし = 割り当ては 1 のまま）
11:52:54  0   ← delete した瞬間に 0 へ
```

**このメトリクスは値が変わったときに点を打つ。** stop では点が出ず、delete で初めて
0 に落ちた。つまり **stop では quota が解放されず、delete でのみ解放される。**

したがって **101 個目の workspace で `open` が失敗する。**
[#104](https://github.com/mpppk/cloud-run-dsh/pull/104) で入れた GC
（30 日で reaper + `DELETE /v1/workspaces/:id`）は**必要だった**ことになる。

### 6.3 新しく見つかった 3 件

| # | 内容 | どこで落ちたか |
|---|---|---|
| [#107](https://github.com/mpppk/cloud-run-dsh/issues/107) | `packages/gcp-token-provider` が Dockerfile の COPY 列挙に無く、**両イメージがビルドできない** | bring-up の開始直後 |
| [#109](https://github.com/mpppk/cloud-run-dsh/issues/109) | control-plane 1 プロセスが Cloud SQL 接続を **23 本**保持し、`max_connections` 25 を枯渇させる | 検証の途中で DB に繋げなくなった |
| [#110](https://github.com/mpppk/cloud-run-dsh/issues/110) | `workspace_checkpoints` は「世代索引」と書かれているが、**3 行すべてが同じ `checkpoint.bin` を指す** | 行数の確認時 |

#### #107 — ローカルの緑が意味を持たない経路

`bunx tsc --build` も `bun test`（848 pass）もレビューも通っていた。
**Dockerfile の COPY 列挙はローカルのどのコマンドでも実行されない**ため、
実機の直前でしか落ちない。列挙は手で維持されており、
[PR #105](https://github.com/mpppk/cloud-run-dsh/pull/105) が新パッケージを足したときに
2 つの Dockerfile の更新が漏れた。

修正では COPY 行を足すだけでなく、**`packages/` 配下と両 Dockerfile の列挙が一致することを
テストで固定した**（`tests/dockerfile-workspace-copy.test.ts`）。行を足すだけでは、
次に誰かがパッケージを足したときに同じことが起きる。

#### #109 — 1 周目の「回避策」が原因を隠していた

1 周目の撤収で `DROP OWNED BY dsh_app` が
`remaining connection slots are reserved` で失敗し、`max: 1` で回避した。
そのときは「`db-f1-micro` は接続スロットが少ない」で片付けた。

**本当の原因は control-plane が上限なしで接続を食い潰していたことだった。**
2 周目で切り分けた:

- agent-host の Instance は**停止済み**（API で確認）→ 23 本は control-plane のもの
- Cloud Run のコンテナは **1 つだけ**（`listening` ログ 1 回、`instanceId` 1 種類）
  → オートスケールによる複数プールではない
- executor は起動時に **1 回だけ**生成され共有されている
  → リクエストごとに `new SQL` しているわけでもない

つまり **1 つの Bun.SQL プールが上限なしで育っている。**
コードのどこにも `max` の指定が無い。

**#73 のコメントに書いた「単一接続で繋ぐこと」は症状への対処であって、
原因の修正ではなかった。**

### 6.4 撤収

```
Cloud SQL: なし   Cloud Run: なし   バケット: なし   Secret: なし   Instances: 0
```

**52 destroyed、エラー 0 件、`DROP OWNED BY` 不要。** 削除順もログで確認した。

```
google_sql_database.dsh: Destruction complete after 0s
google_sql_user.app:     Destruction complete after 1s   ← database の後
```

1 周目に手動削除が必要だった `control-plane-database-url` も、
#93 で Terraform 管理に移ったため残らなかった。

---

## 7. 3周目（同日）— #109 の副作用を疑う

2周目の修正3件（#107 / #109 / #110）を実機で確認するために、もう一度環境を作った。

**3周目は目的が違う。** 1周目・2周目は「直したものが効いたか」を見てきた。
3周目の主目的は **#109 で入れた接続上限そのものを疑うこと**である。
プールに上限（agent-host 5 / control-plane 5）を入れたということは、
**枯渇の代わりに待ちが起きうる**ということでもある。詰まるとしたら
`/readyz` が最初に詰まる — `/readyz` は自前で `SELECT 1` を投げるので、
プールが埋まっていれば readiness ごと巻き添えになる。

### 7.1 負荷をかけた状態での測定（3周目の新しい実験）

SSE ストリームを張ったままターンを回し、**同時に** `/readyz` を 3 秒間隔で 20 回叩いた。

| 測定 | 2周目（上限なし） | 3周目（上限 5+5） |
|---|---|---|
| `num_backends` のピーク | **23**（`max_connections` 25 に対して） | ✅ **10**（5+5 のとおり） |
| `open` の初回 | 20 秒 | ✅ **18 秒**（遅くなっていない） |
| 復元 | 58 秒 | ✅ **18 秒** |
| 負荷中の `/readyz` | 未測定 | ✅ **20/20 が 200、0.10〜0.13 秒** |
| 負荷中の SSE | 未測定 | ✅ 切断なし。200 イベント、`turn/end` まで到達 |

> `open` と復元の所要時間・`/readyz` の応答時間は実行時の端末出力から取ったもので、
> ログファイルには残していない。
>
> **`num_backends` のピークだけは後から裏が取れた。** Cloud Monitoring は
> 時系列を数週間保持しているので、撤収済みのインスタンスの値を読み直せる
> （読み取り専用の GET のみ。GCP は変更しない）。
> `metric.type="cloudsql.googleapis.com/database/postgresql/num_backends"`、
> `resource.labels.database_id="cloud-run-dsh:dev-dsh-pg"`、
> `metric.labels.database="dsh"` で引くと、値が変わった点は次のとおり（UTC）:
>
> ```
> 11:51  22   ← 2周目のピーク（§6 の「23」に対応）
> 11:56   0   ← 2周目の撤収
> 12:33  10   ← 3周目の負荷確認のピーク
> 12:34   0
> 12:35   5
> 12:47   2
> 12:50   1
> 12:51   0
> ```
>
> **3周目のピークは 10 で、上の表と一致する。**

**上限を絞ったことによる待ちは観測されなかった。** `/readyz` の応答時間は
20 回すべて 0.13 秒以内に収まっており、プール待ちが起きていれば必ず伸びる値が
まったく伸びていない。#109 の修正は副作用を持たなかったと判断する。

### 7.2 2周目の修正3件の判定

| # | 何を確かめたか | 結果 |
|---|---|---|
| [#107](https://github.com/mpppk/cloud-run-dsh/issues/107) | Dockerfile の COPY 列挙 | ✅ 両イメージがビルド・push できた |
| [#109](https://github.com/mpppk/cloud-run-dsh/issues/109) | 接続上限が効くか / 詰まらないか | ✅ 上表のとおり |
| [#110](https://github.com/mpppk/cloud-run-dsh/issues/110) | `workspace_checkpoints` の説明と実態 | ✅ **3 行 / `gcs_object` は 1 種類**。「世代索引ではなく監査記録」という書き換えが実態と一致 |

### 7.3 復元は 3 回とも成立した

復元の確認は 3 周とも **新しいセッションで**行っている。エージェントに
思い出させるのではなく、**ディスクを読ませる**ためである。3周目は
`/workspace/CYCLE3_PROOF.txt` を置いてから stop し、再起動後の新セッションに読ませた。

```
tool-call  read  {"file_path": "/workspace/CYCLE3_PROOF.txt"}
assistant  The file `/workspace/CYCLE3_PROOF.txt` exists and contains exactly:
           cycle3-marker-20260905
```

デプロイは 3周目も **revision 00001 で一発成功**した（#93 / #94 の手順書修正が
2周連続で再現した）。

### 7.4 撤収 — ここで新しい失敗を引いた（#115）

**1 回目の `terraform destroy` が失敗した。**

```
Error: Error when reading or editing Database: googleapi: Error 400:
Invalid request: failed to delete database dsh.
Detail: pq: database "dsh" is being accessed by other users., invalid
```

失敗時点で **Cloud Run サービスも Instance も既に削除済み**だったにもかかわらず、
Cloud SQL 側の `num_backends` は 2 のまま残っていた。接続は即座には切れない。
1 回目は 33 destroyed で停止した。

**2 回目はそのまま成功した** — 19 destroyed、エラー 0 件。合計 52 で
1周目・2周目と同じ数に着地し、state は空、残留リソースはゼロ。

> デプロイの revision・Cloud Run の削除確認・state が空であることの確認は
> 実行時の端末出力によるもので、ログファイルには残していない。
>
> **`num_backends` の残存値は Monitoring の保持データで確認できた**（§7.1 の注記参照）。
> `destroy-c3.log`（失敗）が書かれたのは **12:49:44 UTC** で、そのときのゲージは **1〜2**。
> `destroy-c3b.log`（成功）が書かれたのは **12:54:25 UTC** で、ゲージは **0**。
> **「Cloud Run を消しても接続が残っていた」は実際の時系列で裏付けられる。**

```
google_sql_database.dsh:          Destruction complete after 0s
google_sql_user.app:              Destruction complete after 0s   ← database の後
google_sql_database_instance.main: Destruction complete after 2m22s
```

削除順（#103 の `depends_on`）は 3周目も正しく効いていた。

これは **[#73](https://github.com/mpppk/cloud-run-dsh/issues/73) とは別の失敗**である。
#73 は「`max_connections` が枯渇して繋げない」、#115 は
「destroy 時に接続が残っていて DROP DATABASE が弾かれる」。
症状は似ているが原因も対処も違う。
[#115](https://github.com/mpppk/cloud-run-dsh/issues/115) として起票した。

**「destroy の失敗 = 課金の継続」なので、これは手順書の警告に入れるべき失敗である。**
手順書の Appendix にはすでに 2 つの失敗モードが書かれていたが、この 3 つ目は
書かれていなかった。

```
Cloud SQL: なし   Cloud Run: なし   バケット: なし   Secret: なし   Instances: 0
```

ローカルの秘密（DB パスワード、LLM キー、DATABASE_URL）は 3 回上書きしてから削除した。

### 7.5 3周目で「依然未確認」のまま残したもの

3周目でも手を出さなかった。**手を出していないので、正直に未確認と書く。**

| 項目 | 状態 |
|---|---|
| `CHECKPOINT_FAILED` の保護の実機確認 | **1周目から未確認。**チェックポイントを安全に失敗させる方法が無い |
| 同時 stop のレース（#88） | ローカルで決定論的に再現済み。**実機では未確認** |
| IAP フロントエンド | 未作成（ブランドは一度作ると削除できない）。**IAP 経由の経路は依然未検証** |
| #115 のドレイン確認ゲート | **未検証どころか壊れていた。** レポート執筆中に Monitoring を読み直したところ、ゲートのフィルタが `database_id` を `project:instance` ではなくインスタンス名単体で指定しており、時系列が 1 本も返らない。ゲートを越えられず **destroy に到達できない**（[#118](https://github.com/mpppk/cloud-run-dsh/issues/118)）。ゲージ自体は上記のとおり正しい信号を出しているので、壊れているのはフィルタ 1 行。**4周目で修正版を実機検証し、destroy が 1 回で成功した（§8.1）** |

---

## 8. 4周目（2026-09-05〜06）— 撤収ゲートを実機で試す周

3周目で入れた撤収ゲート（#115 → PR #116、フィルタ修正 #118 → PR #119）は
**一度も実機で動いていなかった**。4周目の合格条件はただひとつ、
**手順書どおりに撤収して `terraform destroy` が 1 回で成功すること**である
（3周目は 2 回必要だった）。

### 8.1 結論から — ゲートは動いた。destroy は 1 回で終わった

```
num_backends sample 1: 2 (from 1 series)
num_backends sample 2: 2 (from 1 series)
num_backends sample 3: 1 (from 1 series)
num_backends sample 4: 1 (from 1 series)
num_backends sample 5: 1 (from 1 series)
num_backends sample 6: 1 (from 1 series)
num_backends sample 7: 1 (from 1 series)
num_backends sample 8: 0 (from 1 series)   ← ここで break
→ Destroy complete! Resources: 47 destroyed.   エラー 0 件
```

`(from 1 series)` が #118 の修正が効いている証拠である。
`database_id` を `project:instance` にしたので時系列が返っている。

削除順（#103 の `depends_on`）も 4周目も正しかった:

```
google_sql_database.dsh:           Destruction complete after 1s
google_sql_user.app:               Destruction complete after 0s   ← database の後
google_sql_database_instance.main: Destruction complete after 2m33s
```

残留リソースはゼロ。`tfstate` も削除済み。ローカルの秘密は 3 回上書きして破棄した。

### 8.2 ゲートが、別のバグを釣り上げた

ゲートは最初 `2` を返し続けた。**control-plane はもう消してあるのに接続が残る。**
理由は、撤収手順の**最初のステップ（Step 8.1）が動いていなかった**からである。

```
$ gcloud run instances list --location=asia-northeast1
ERROR: (gcloud.run) Invalid choice: 'instances'.
```

`gcloud run instances` は**現行の gcloud（SDK 582.0.0）に存在しない**。
Instance は Terraform state に入っていないので `terraform destroy` でも消えない。
手順書自身が「step 1 is the only thing that stops their billing」と書いている、
その step 1 が動かなかった。**Instance は生き残り、課金が続いていた。**

v2 REST で消したところ、接続はすぐ落ちた:

```
（Instance を DELETE）
num_backends sample 8: 0    ← 落ちた
```

**ゲートが無ければ、Instance が残ったまま「撤収完了」と判断していた。**
`terraform destroy` は成功しただろうし、Terraform 管理下のものは全部消えたので、
一見きれいに終わったように見えたはずである。
[#123](https://github.com/mpppk/cloud-run-dsh/issues/123) として起票し、
[PR #124](https://github.com/mpppk/cloud-run-dsh/pull/124) で v2 REST の
**列挙 → 全件削除 → 空になるまで確認**に置き換えた。

手順書は `dsh-ws-demo` という**固定名**を消そうとしていたことも分かった。
実際の名前は `dsh-<workspace-uuid>` なので、**固定名では最初から当たらない**。

### 8.3 stop の直後に open を呼ぶと必ず失敗する（#121）

4周目で初めて **stop と open を連続で実行した**（1〜3周目は間に他の確認を挟んでいて、
たまたま 60 秒以上空いていた）。結果:

```
POST /v1/workspaces/{id}/stop  → 200 {"state":"STOPPED"}   1.4 秒
POST /v1/workspaces/{id}/open  → 500 internal server error  63.6 秒
```

Instance のログを見ると理由がはっきりしている:

```
21:37:59  gateway.prepare_stop.prepared  state=STOPPING   ← stop はここで 200 を返す
21:38:07  "Shutting down user disabled instance"
   （10 秒おきに繰り返し）
21:39:07  "Shutting down user disabled instance"          ← 約 60 秒続く
21:39:47  "Started instance in 8.43s."                    ← ようやく起動
21:39:52  workspace.restore.completed / agent.host.listening
```

control-plane 側は 21:38:00 に open を始め、agent-host の `/readyz` を 30 回
ポーリングして 21:39:03 に諦めた。**その 44 秒後に Instance は普通に起動し、
復元も成功している。** つまり**実際には何も壊れていないのに失敗扱いになった。**

ポーリング中に返っていた `HTTP 500` は**アプリの応答ではなく
Google フロントエンドのエラーページ**だった。
「URL がまだ応答できる状態にない」ことと「agent-host が不健康」を、
**同じカウンタで数えていた**のが本質である。

### 8.4 そして状態が食い違ったまま固まった（#122）

失敗した後、workspace は**観測できる状態がすべて READY なのに、
ターンだけが拒否される**状態になった。

```
GET  /v1/workspaces/{id}          → 200 "runtimeState":"READY"
GET  agent-host /readyz           → 200 "status":"READY"
POST /v1/sessions/{sid}/messages  → 409 "agent input refused in state RESTORE_FAILED"
```

`RESTORE_FAILED` は**どの GET でも観測できない**ので、クライアントには
何が起きているのか分かりようがない。原因は
`assertAgentInputAllowed()` が**プロセス内キャッシュ**を読んでいて、
DB を読み直す `reloadState()` を呼ぶのが `open()` だけだったこと。

```
21:39:03  control-plane が RESTORE_FAILED を書く（open 失敗）
21:39:52  agent-host が DB を READY に更新（復元は成功している）
21:42:09  ターンを投げる → 409 RESTORE_FAILED
21:47:22  もう一度 POST /open → 0.7 秒で 200 READY
21:47:22  同じセッションにターン → 201 受理。ファイルも読めた
```

**`open` を呼び直せば直る。だがそれを知る手段が API に無い。**

### 8.5 データは無事だった

失敗したのは起動の手順であって、復元そのものではない。
再 open 後、**新しいセッション**から読ませたところ:

```
tool-call  read  {"file_path": "/workspace/CYCLE4_PROOF.txt"}
assistant  The exact contents of `/workspace/CYCLE4_PROOF.txt` are:
           cycle4-marker-20260906
```

### 8.6 ついでに測ったもの

| 項目 | 結果 |
|---|---|
| デプロイ | **revision 00001**（3周連続で一発） |
| `num_backends` ピーク | **10**（#109 の上限どおり。3周目に続き 2 周連続） |
| ログ中のトークン | **0 件** |
| Terraform | 52 適用 / 47 destroy（差の 5 件は Step 8.3 でバケットを先に消したため。バケット本体＋IAM バインド 4 件が destroy の対象外になった） |
| 手動チェックポイント | dirty なので `skipped: false`（期待どおり） |

> 数字の出どころ: §8.1 の 8 サンプル・`47 destroyed`・`Invalid choice` は
> `teardown-c4.log`、`stop` 1.4 秒・再 `open` の 500（63.6 秒）・409 は
> `c4-verify.log`、マーカーの読み取りは `c4-sse-restore3.txt` に残っている。
> §8.3〜§8.4 の時刻は `gcloud logging read` の値で、ファイルには残していない。
> 再 `open` の 0.7 秒と手動チェックポイントの応答も実行時の端末出力による
> （チェックポイント自体は Step 8.3 のバケット削除記録に
> `manual-checkpoints/2026-09-05T21-51-56-939Z.json` として残っている）。
> `num_backends` のピーク 10 は §7.1 と同じ手順で Monitoring の保持データから確認した。

### 8.7 4周目で見つかった 3 件

| # | 内容 | どこで落ちたか |
|---|---|---|
| [#121](https://github.com/mpppk/cloud-run-dsh/issues/121) | stop 直後の open が構造的に必ず失敗する | stop → open を初めて連続実行したとき |
| [#122](https://github.com/mpppk/cloud-run-dsh/issues/122) | 復旧後も in-memory 状態が RESTORE_FAILED のまま固まる | #121 の後始末をしようとしたとき |
| [#123](https://github.com/mpppk/cloud-run-dsh/issues/123) | 撤収 Step 8.1 の gcloud コマンドが存在しない | **撤収ゲートが接続の残存を検知したことで発覚** |

#121 と #122 は [PR #125](https://github.com/mpppk/cloud-run-dsh/pull/125)、
#123 は [PR #124](https://github.com/mpppk/cloud-run-dsh/pull/124) で修正した。

#125 のレビューでは、レビュアーが
**「5xx かつ本文に `server error`」という判定が、アプリ自身の catch-all 500
（`{"error":"internal server error"}`）にもマッチしてしまう**ことを見つけて直した。
判定を `<html` に絞ることで、本物の障害を shutdown 窓と誤認して
3 分待つ経路が消えた。

---

## 9. 5周目（2026-09-06）— 初めて新しいバグが 1 件も出なかった周

4周目で見つけた 3 件（#121 / #122 / #123）は、いずれも
**「次の bring-up で確認する」と PR に書いたまま**マージされていた。
5周目はその 3 件を実機で確かめる周である。

**結果: 3 件とも直っていた。そして新しいバグは 1 件も出なかった。**
1周目から数えて、**新規バグ 0 件は初めて**である。

### 9.1 #121 — stop の直後に open を呼ぶ

4周目に失敗したのと**まったく同じ操作**をした。stop が返ってから 1 秒後に open。

```
stop took 1.3s
=== #121 THE TEST: open 1 second after stop (cycle 4 failed here) ===
{"workspaceId":"13c585c7-...","state":"READY"}  [HTTP 200]
reopen-immediately took 36.9s
RESULT #121: PASS
```

| | 4周目（修正前） | 5周目（修正後） |
|---|---|---|
| stop → open の間隔 | 約 1 秒 | 約 1 秒 |
| 結果 | **HTTP 500、63.6 秒**、`RESTORE_FAILED` | ✅ **HTTP 200 READY、36.9 秒** |

**36.9 秒かかっているのは正常である。** shutdown 窓（約 60 秒）を待つのではなく、
その間に返る Google フロントエンドの HTML 500 を
**別予算で数えるようにした**ので、新世代が健康になった時点で通っている。
PR #125 の案B（フロントエンドの 500 と agent-host 自身の 503 を区別する）が
実機で意図どおりに働いた。

### 9.2 #122 — GET の状態とターンの可否が食い違わないか

4周目は `GET` が READY を返すのにターンが 409 `RESTORE_FAILED` で拒否された。
5周目は open が成功したのでその経路には落ちないが、
**両者が一致していること**は確認した。

```
GET /v1/workspaces/{id}  → "runtimeState":"READY"
POST .../messages        → 201 受理
RESULT restore: PASS — fresh session read the marker off disk
```

**注意: これは #122 の「異常系」を再現した検証ではない。**
#122 が起きるには先に open を失敗させる必要があり、#121 を直した今、
実機で意図的に失敗させる安全な手段が無い。
**異常系はリグレッションテスト（PR #125）で固定されているだけで、
実機では未確認のままである。** 正直に記録しておく。

### 9.3 #123 — 撤収 Step 8.1

4周目に `Invalid choice: 'instances'` で死んでいたステップが、
v2 REST の列挙 → 全件削除 → 空になるまでポーリングに置き換わっている。

```
###### Step 8.1 — delete EVERY Cloud Run Instance (v2 REST, issue #123) ######
found: [dsh-13c585c7-0b73-4014-b2d0-acefb7992c1c]
deleting instance: dsh-13c585c7-0b73-4014-b2d0-acefb7992c1c
instances remaining: 1 (check 1/30)
instances remaining: 1 (check 2/30)
instances remaining: 1 (check 3/30)
instances remaining: 0 (check 4/30)
```

**固定名ではなく実際の `dsh-<uuid>` を拾って消している。**
削除は非同期なので、空になるまで 4 回（約 90 秒）ポーリングしてから次に進んだ。

その結果、撤収ゲートも 4周目より速く抜けた:

```
num_backends sample 1: 2 (from 1 series)
num_backends sample 2: 2 (from 1 series)
num_backends sample 3: 0 (from 1 series)    ← 4周目は 8 サンプル必要だった
→ Destroy complete! Resources: 47 destroyed.   エラー 0 件
```

4周目は Instance が残っていて接続が落ちなかったので 8 サンプルかかった。
**5周目は 3 サンプル。Step 8.1 が正しく効いた分だけ速い。**

### 9.4 PR #125 が足した DB 往復は負荷に出なかった

#122 の修正は、入力ゲートの判定ごとに `runtime_state` を 1 行読む。
**#109 でプール上限を 5 に絞ってあるので、ここが詰まる可能性があった。**
3周目と同じ負荷（SSE を張ったままターンを回し、同時に `/readyz` を 20 回）をかけた。

| | 3周目（#125 前） | 5周目（#125 後） |
|---|---|---|
| `/readyz` 20 回 | 0.10〜0.13 秒 | ✅ **0.09〜0.12 秒** |
| `num_backends` ピーク | 10 | ✅ **10** |
| 負荷中の SSE | 切断なし | ✅ 切断なし（188 イベント） |

**劣化していない。** PR #125 のレビュアーが指摘したとおり、
本番で入力ゲートを通るのは 1 リクエストあたり 2 回（control-plane と agent-host で
1 回ずつ、別プロセス・別プール）で、`runToolInvocation` /
`runSubprocess` には**現時点で本番の呼び出し元が無い**。
将来 agent ループがツール毎に呼ぶようになったら、ここは再評価が要る。

### 9.5 5周目の測定値

| 項目 | 結果 |
|---|---|
| デプロイ | **revision 00001**（4周連続で一発） |
| `open` 初回 | 16.5 秒 |
| stop | 1.3 秒 |
| stop 直後の open | **36.9 秒で成功**（4周目は 63.6 秒で失敗） |
| 復元 | ✅ 新セッションが `cycle5-marker-20260906` を読み出した |
| `num_backends` ピーク | 10 |
| `terraform destroy` | **1 回、47 destroyed、エラー 0 件** |
| 残留リソース | **ゼロ**（SQL / Run / Instance / バケット / Secret / AR すべて 0） |
| ログ中のトークン | **0 件** |
| **新規バグ** | **0 件** |

ローカルの秘密（DB パスワード、LLM キー、DATABASE_URL）は 3 回上書きして破棄した。

> 数字の出どころ: `52 added` は `apply5.log`、revision 00001 は
> `deploy-c5.log`、stop 1.3 秒・再 `open` の 200（36.9 秒）・`RESULT` 2 件・
> `/readyz` 20 プローブ・188 イベントは `c5-verify.log`、
> マーカーの読み取りは `c5-sse-restore.txt`、
> Step 8.1 の 4 回・ゲートの 3 サンプル・`47 destroyed` は `teardown-c5.log`。
> `num_backends` のピーク 10 は §7.1 と同じ手順で Monitoring の保持データから確認した。

---

## 10. 6周目（2026-09-07）— product UI と `open` の非同期化を実機で通す周

**目的が今までと違う。** 1〜5周目は「stop → 復元」という同じ看板機能を繰り返し確かめる周だった。
6周目は **[#135](https://github.com/mpppk/cloud-run-dsh/issues/135) の実装（`open` の非同期化 /
workspace 一覧 / product UI）と [#141](https://github.com/mpppk/cloud-run-dsh/issues/141) の
診断情報**を、初めて実機に載せる周である。

`main` は `844b3a6`。**52 追加 → 検証 → 47 destroy、エラー 0 件、リソース 0 に復帰。**

**IAP ブランドは意図的に作っていない。** 一度作るとプロジェクトから削除できないため利用者が見送りを決めた。
`TF_VAR_iap_support_email` を未設定にすることで `google_iap_brand` / `google_iap_client` は
`count = 0` になり、plan にも現れないことを確認した（[#128](https://github.com/mpppk/cloud-run-dsh/issues/128)
の IAP 条件は未達のまま残る）。control-plane は IAP ではなく Cloud Run IAM
（`--no-allow-unauthenticated` + ID トークン）で保護し、IAP ヘッダは手で付けた。

### 10.1 計測値

| 確認項目 | 結果 |
|---|---|
| `POST /v1/workspaces/:id/open`（[#136](https://github.com/mpppk/cloud-run-dsh/issues/136)） | **HTTP 202 を 1.19 秒**で返した |
| `GET /v1/workspaces/:id` のポーリングで READY 到達 | **20 秒** |
| `stop` → 1 秒後に `open`（[#121](https://github.com/mpppk/cloud-run-dsh/issues/121)） | `stop` 200（1 秒）→ `open` **202 を 0.62 秒** → READY **30 秒**。`RESULT #121: PASS` |
| controller lease を 75 秒放置（[#143](https://github.com/mpppk/cloud-run-dsh/pull/143)） | `held:true` のまま。`expiresAt` が `21:03:45` → `21:05:03` に**前進**した |
| `GET /v1/workspaces`（[#137](https://github.com/mpppk/cloud-run-dsh/issues/137)） | `{"workspaces":[]}` → 1 件 → **別の IAP identity では 0 件** |
| IAP ヘッダ無しの `GET /v1/workspaces` | **401** |
| product UI（[#138](https://github.com/mpppk/cloud-run-dsh/issues/138)） | `/app` `/app/app.js` `/app/app.css` `/app/sse.js` が Cloud Run から 200 |
| `/app/<uuid>`（動的パス） | **404** — 完全一致 allowlist が本番でも効いている |
| product UI の語彙 | 配信された HTML に `controllerId` / `approvalId` / `lease` / `RESTORE_FAILED` は 0 件 |
| debug UI（`/`、`/ui/*`） | 200。共存が壊れていない |
| workspace DTO | `lastError` を**含まない**（[#141](https://github.com/mpppk/cloud-run-dsh/issues/141) の設計どおり） |

**`open` が 1.19 秒で返ったことが、この周の主結果である。** 同期実装では通常 60 秒、
#121 の shutdown 猶予が効くと約 3 分かかっていた（§9 の 36.9 秒はその「成功した方」の値である）。
製品 UI が「3 分回るボタン」を持たずに済むという #136 の前提が、実機で成立した。

### 10.2 今回のビルドで実機を通し直した 3 件

いずれも過去の周で実機に触れてはいる。**「初めて」なのは各項目に書いた差分だけである**ことを
先に断っておく。先行する実機確認は `docs/e2e-verification-report.md` の §1.2（実 LLM ターン）・
#25（実 Cloud SQL への実 runner）・ #26（実 GCS での保存・復元）、および本レポート §1 の
`checkpoint.bin` の記録である。

**(1) 追加マイグレーション `0002_last_error.sql` の初回適用。**
ランナー自体の実機走行は #25 で済んでいる。今回初めてなのは、#141 が足した
**このリポジトリで最初の追加マイグレーション**の適用であり、その初回適用がいきなり本番だったことである。
冪等性も同じ実行で確認している:

```
Applied 2 migration(s): 0001_init.sql, 0002_last_error.sql
--- second run must be a no-op (idempotence) ---
No pending migrations.
tables: controller_leases, schema_migrations, session_events, sessions, workspace_checkpoints, workspaces
workspaces.last_error: {"column_name":"last_error","is_nullable":"YES"}
schema_migrations: 0001_init.sql, 0002_last_error.sql
```

初回適用がいきなり本番だったからこそ、冪等性の同時確認に意味がある。

**(2) `edit` ツールによる既存ファイルの書き換え。**
実機での LLM ターン自体は 1〜5 周目も回っている（e2e レポート §1.2 の `read`、
2〜5周目のマーカー書き込みの `write` / `read` / `glob`）。
今回初めてなのは、clone 済みリポジトリの既存ファイルに対する `read` → `edit` の往復であり、
`tool/result` の成功（`isError: false`）まで確認している。
「README.md の先頭に挨拶を1行だけ足してください。」を送ったところ、1 ターンが最後まで回った:

```
turn/start → step 1: tool/call read  {"file_path": "/workspace/README.md"}
           → step 2: tool/call edit  {"old_string": "TODO app built with TanStack Start, ...",
                                      "new_string": "こんにちは！よろしくお願いします。\n\n..."}
           → assistant/chunk ×51 → assistant/message ×3
turn/end   {"reason":{"kind":"completed"}}
model: deepseek/deepseek-v4-flash（provider: deepseek-official）
usage: inputTokens 178 / outputTokens 64 / cacheReadTokens 4096（最終ステップの値。ターン累計 totalTokens は 4338）
```

**エージェントは実際に clone 済みリポジトリのファイルを読んで書き換えている。**
SSE は 41,213 バイト、`user_message` / `turn/*` / `step/*` / `tool/call` / `tool/result` /
`assistant/*` が揃っていた。

**(3) 現行ビルドのチェックポイントが実バケットに書かれることの再確認。**
実バケットへの書き込み自体は 1 周目から毎周起きている（§1 の `checkpoint.bin`、#26 の保存・復元）。
今回の記録は「#135 / #141 後のビルドでも書かれている」の再確認であり、撤収時に消す対象として現れた:

```
Removing gs://cloud-run-dsh-dev-checkpoints/workspaces/9491e741-.../checkpoint.bin#1788728724905170...
```

### 10.3 実機では新しいバグが 0 件だった。ただしそれは偶然ではない

**課金を始める前に、本番と同じ構成をローカルで先に踏んだ**。その段階で 2 件見つけている。

1. **bring-up スクリプトの env キーが 2 箇所間違っていた** — `SQL_CONNECTION_NAME`（正しくは
   `CLOUD_SQL_CONNECTION_NAME`）と、そもそも書き忘れていた `AGENT_HOST_DATABASE_URL`。
   本番イメージを実 Postgres につないで起動して初めて分かった（`MissingRequiredEnvError`）。
   気付かずに走らせていれば、Cloud SQL を作ってから control-plane が起動しない形で止まっていた
2. **`RESTORE_FAILED` なのに `last_error` が NULL のままだった** — 認証失敗のように
   **リクエスト内で `open` が投げる**経路（bring-up 直後に最も出やすい形）に理由が残らなかった。
   runbook は「`last_error` を読め」と書いているのに空振りする。
   [#145](https://github.com/mpppk/cloud-run-dsh/pull/145) で塞ぎ、同じ手順で
   `before: NULL` / `after: 理由あり` を確認してから本番に載せた

加えて、仕様書 §29 が「**毎回デプロイ前に確認せよ**」と定める Cloud Run Instances Preview API の
ドリフト確認も、課金前に読み取りだけで行った。`validateOnly=true` にクライアントが組み立てる
body をそのまま投げると `403`（サービスアカウント未作成）まで到達し、対照実験（未知フィールド →
`400 Cannot find field`、不正 enum → `400 Invalid value`）で「形は受理された」ことを確定させている。

**「実機で 0 件」は「バグが無い」ではなく、「実機に載せる前に踏んだ」である。**

### 10.4 撤収

[#123](https://github.com/mpppk/cloud-run-dsh/issues/123) の修正（v2 REST で列挙 → 削除 →
0 になるまでポーリング）が、5周目に続いて今回も効いた:

```
found: [dsh-9491e741-e427-438d-88fb-bf90c7a54ea5]
deleting instance: dsh-9491e741-e427-438d-88fb-bf90c7a54ea5
instances remaining: 1 (check 1/30) … 0 (check 4/30)
num_backends sample 1: 2 → sample 2: 3 → sample 3: 1 → sample 4: 0
Destroy complete! Resources: 47 destroyed.
```

エラー 0 件。[#73](https://github.com/mpppk/cloud-run-dsh/issues/73)（マイグレーション後に
`dsh_app` ロールを落とせない）は再発しなかった。撤収後に独立して数え直し、
Cloud Run サービス / Cloud SQL / シークレット / バケット / Artifact Registry /
Cloud Run Instance がすべて 0 であることを確認した（Step 8.7 の記録）。
サービスアカウントとネットワークは `terraform destroy`（47 件、エラーなし）の管理下で削除され、
IAP ブランドは `count = 0` で作られていない（ログに `google_iap_brand` /
`google_iap_client` の作成記録は無い）。
ローカルの秘密（DB パスワード、LLM キー、`DATABASE_URL`）と `terraform.tfstate` は削除した。

> 数字の出どころ: `52 added` とマイグレーションは `g1-bringup.log`、
> 202 の 1.19 秒 / READY 20 秒 / lease の `expiresAt` 前進 / `RESULT #121: PASS` /
> 静的配信の応答コードは `g1-verify.log`、ターンの中身は `g1-sse.txt`、
> Step 8.1 の 4 回・ゲートの 4 サンプル・`47 destroyed` は `g1-teardown.log`
> （いずれもコーディネータの scratchpad）。

---

## 11. 1周目レポート（open まで）との差分

| | 前回（open まで） | 今回（stop → 復元） |
|---|---|---|
| 発見したバグ | 14 件 | 5 件 |
| Terraform リソース | 48 | **50**（Artifact Registry の reader 2 件が増えた） |
| `terraform destroy` | 2 回目で成功 | **1 回で成功**（事前に `DROP OWNED BY`） |
| 確認した経路 | `open` → ターン | `stop` → チェックポイント → `restart` → 復元 |

前回のレポートは「バグ 14 件のすべてがテストダブルかコメントと実物の乖離だった」と
結論した。**今回の 5 件のうち 3 件（#93 / #94 / #97）も同じ型である** — 手順書と
コメントが、実物と違うことを書いていた。

---

## 12. 6 周を通しての総括

環境を 6 回作って壊した（1〜3周目は同じ日、4・5周目は翌日、6周目はその翌日）。
**6周目だけは目的が違う** — stop → 復元をもう一度なぞる周ではなく、
#135 と #141 の新しい実装を初めて実機に載せる周である（§10）。

| | 1周目 | 2周目 | 3周目 | 4周目 | 5周目 | 6周目 |
|---|---|---|---|---|---|---|
| 新しく見つかったバグ | 5 件（#93 / #94 / #95 / #96 / #97 ほか） | 3 件（#107 / #109 / #110） | 1 件（#115） | 3 件（#121 / #122 / #123） | **0 件** | **実機 0 件**（課金前のローカル検証で 2 件 — §10.3） |
| デプロイの revision | 00003（2 回失敗） | **00001** | **00001** | **00001** | **00001** | **00001** |
| `terraform destroy` | 1 回（事前に `DROP OWNED BY`） | 1 回 | 2 回（#115） | 1 回（ゲートが効いた） | **1 回** | **1 回** |
| Terraform リソース | 50 | 52 | 52 | 52 適用 / 47 destroy | 52 適用 / 47 destroy | 52 適用 / 47 destroy |
| `num_backends` ピーク | — | 23 | 10 | 10 | **10** | 3（ゲートの観測値） |
| 復元 | 39 秒 | 58 秒 | 18 秒 | 失敗 → 再 open で成功（#121） | **stop 直後の open が 36.9 秒で成功** | **stop 直後の open が 202 を 0.62 秒で返し、30 秒で READY** |
| `open` の応答 | 同期（完了まで待つ） | 同期 | 同期 | 同期（失敗時 63.6 秒） | 同期（36.9 秒） | **非同期 202 を 1.19 秒**（#136） |

**「周を追うごとにバグが減る」は 3周目までの話だった。** 4周目で 3 件に戻っている。
減っていたのではなく、**まだ触っていない経路が残っていただけ**である。
そして 5周目は **0 件**だった — ただしこれは「もう無い」ではなく、
**5周目が 4周目と同じ叩き方をした**ことの帰結でもある（§12 末尾）。

### 何が変わると新しいバグが出るか

4周目の 3 件は、いずれも**それまでの周と操作の順序や環境が違った**ことで出た。

- **#121**（stop 直後の open）は、**stop と open を連続で実行した**から出た。
  1〜3周目は間に確認作業を挟んでいて、たまたま 60 秒以上空いていた。
  **バグはコードにずっとあったが、叩き方が足りなかった。**
- **#122** は #121 の後始末をしようとして初めて見えた。
  **失敗した後の状態**は、成功し続けている限り誰も見ない。
- **#123**（`gcloud run instances` が無い）は、**手順書どおりに撤収したから**出た。
  1〜3周目の撤収は私が REST で Instance を消していて、手順書の Step 8.1 を
  そのまま実行していなかった。

**「手順書を読んで、書いてあるとおりに実行する」ことそれ自体が検証だった。**

### バグの型は 6 周を通して変わっていない

前回のレポート（open まで）は「バグ 14 件のすべてがテストダブルかコメントと
実物の乖離だった」と結論した。**6 周を通しても、この形が大半である。**

- 1周目: `idleTimeout`、シークレットの権限、Cloud SQL のソケット形式 —
  「手元では緑」のまま実機の直前で落ちるもの
- 2周目: #107（ローカルのどのコマンドも Dockerfile の COPY 列挙を実行しない）
- 3周目: #115（撤収という、成功したときは誰も見ない経路）
- 4周目: #123（手順書に書いてあるコマンドが存在しない）、
  #118（ゲートのフィルタが実物のラベル形式と違う）

**例外は 3 件で、いずれも「実装そのもの」のバグだった。**

- **#109** — 上限のないプール。コードを読めば分かるが、
  実機で負荷をかけるまで誰も困らない。
- **#121** — shutdown 窓より短いポーリング予算と、500 の一律カウント。
  コードの前提（500 = agent-host が不健康）が実物と違った。
- **#122** — in-memory キャッシュを読む入力ゲート。
  **正常系では絶対に踏まない**。異常系に落ちた後の回復経路にしかない。

### ゲートが別のバグを釣った

4周目で一番おもしろかったのは、**#115 のために入れた撤収ゲートが
#123 を釣り上げた**ことである。ゲートが「接続がまだ残っている」と言い続けたので
調べたら、消えていないはずの Instance が生きていた。

ゲートが無ければ `terraform destroy` は成功し、Terraform 管理下のものは全部消え、
**一見きれいに終わったように見えたはずである。**
「まだ終わっていないものを終わっていないと言う」仕組みには、
**それが直接狙ったバグ以外も捕まえる**価値がある。

### 5周目が 0 件だったことをどう読むか

**「バグがもう無い」ことの証明ではない。** 5周目がやったのは、
**4周目とほぼ同じ操作をもう一度なぞる**ことだった。
新しい叩き方をしていないのだから、新しい経路のバグが出ないのは当然である。

4周目の 3 件が「操作の順序や環境が違ったから出た」ことを踏まえると、
**次に新しいバグを出したいなら、また違う叩き方をするしかない。** 例えば:

- 同時に 2 つの workspace を open / stop する（#88 の同時 stop レースは
  ローカルでは固定済みだが**実機では未確認**のまま）
- チェックポイントを意図的に失敗させる（`CHECKPOINT_FAILED` の保護は
  **1周目からずっと未確認**）
- IAP フロントエンド経由で通す（**一度も通していない**）
- Instance を 100 個まで作って quota を踏む（#104 の GC が本当に要るか）
- **control-plane を再起動しながら**ターンを流す

**5周目の 0 件が意味するのは、「4周目までに見つけた経路については
直っている」ということだけである。**

### 6 周を通して残った未確認事項

| 項目 | 状態 |
|---|---|
| `CHECKPOINT_FAILED` の保護 | **1周目から未確認。**安全に失敗させる方法が無い |
| 同時 stop のレース（#88） | ローカルで決定論的に再現済み。**実機では未確認** |
| #122 の異常系 | **実機では未確認。**#121 を直した今、意図的に open を失敗させる安全な手段が無い。リグレッションテストで固定されているだけ |
| IAP フロントエンド | 未作成（ブランドは一度作ると削除できない）。**IAP 経由の経路は依然未検証** |
| ゲートごとの DB 往復（PR #125） | 5周目の負荷では劣化なし。ただし `runToolInvocation` / `runSubprocess` に**本番の呼び出し元が無い**ため、将来増えたら再評価が要る |
