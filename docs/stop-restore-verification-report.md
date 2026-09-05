# GCP 実機動作確認レポート — stop → restart → 復元（2026-09-05）

[前回のレポート](./e2e-verification-report.md)は「ワークスペースを開く流れ」を実機で通した記録だった。
本レポートはその続きで、**仕様書 §1 の看板機能「Instance 停止・再起動を跨いだ Session /
workspace 復元」を実機で通した記録**である。

**結論: stop → restart → 復元が動いた。** 実装（[#87](https://github.com/mpppk/cloud-run-dsh/pull/87)、
[#72](https://github.com/mpppk/cloud-run-dsh/issues/72) と
[#75](https://github.com/mpppk/cloud-run-dsh/issues/75)）が正しいことを実機で確認し、
その過程で**新たに 5 件の問題**を発見した。

その後、**同じ日にもう 2 周**（環境の構築 → 確認 → 撤収）を回している。
2周目は §6、3周目は §7、3 周を通した総括は §9 にある。
**復元は 3 周とも成立した。**

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
| #115 のドレイン確認ゲート | **未検証。**手順書に入れたが、次の bring-up の撤収で実測すること |

---

## 8. 1周目レポート（open まで）との差分

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

## 9. 3 周を通しての総括

同じ日に環境を 3 回作って壊した。**周を追うごとに新しく見つかるバグが減っている。**

| | 1周目 | 2周目 | 3周目 |
|---|---|---|---|
| 新しく見つかったバグ | 5 件（#89 / #93 / #94 / #96 / #97 ほか） | 3 件（#107 / #109 / #110） | **1 件（#115）** |
| デプロイの revision | 00003（2 回失敗） | **00001** | **00001** |
| `terraform destroy` | 1 回（事前に `DROP OWNED BY`） | 1 回 | **2 回**（#115） |
| Terraform リソース | 50 | 52 | 52 |
| 復元 | 39 秒 | 58 秒 | 18 秒 |

**1周目のバグはローカルでは絶対に出ない種類だった。** `idleTimeout`、
シークレットの権限、Cloud SQL のソケット形式 — どれも「手元では緑」のまま
実機の直前で落ちるものである。

**2周目・3周目のバグは種類が変わった。**
#107 は「ローカルのどのコマンドも Dockerfile の COPY 列挙を実行しない」経路、
#109 は「1周目の回避策が原因を隠していた」もの、
#115 は「撤収という、成功したときは誰も見ない経路」である。
**周回を重ねると、検証されていない経路が奥から順に出てくる。**

前回のレポート（open まで）は「バグ 14 件のすべてがテストダブルかコメントと
実物の乖離だった」と結論した。3 周を通しても、この形は変わっていない。
**#109 だけが例外で、これは唯一「実装そのもの」のバグだった** —
上限のないプールという、コードを読めば分かるが実機で負荷をかけるまで
誰も困らない種類の欠陥である。
