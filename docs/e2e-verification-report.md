# GCP 実機動作確認レポート — 2026-09-05

`docs/architecture.md` の「ワークスペースを開く流れ」を、実際の GCP プロジェクト
`cloud-run-dsh` の上で端から端まで通した記録。

**結論: シーケンス図の全経路が実機で動いた。** そこに至るまでに **13 件のバグ**を
新たに発見・修正した。そのすべてが「ローカルのテストは緑なのに本番だけ落ちる」型で、
原因はいずれも **テストダブルと実物の乖離、またはドキュメントと実装の乖離**だった。

検証後、GCP リソースはすべて削除済み（本文末尾に確認結果）。

---

## 1. 何が動いたか

### 1.1 ワークスペースを開く（シーケンス図 ステップ1-11）

```
POST /v1/workspaces                     → 201  ワークスペース作成
POST /v1/workspaces/:id/controller/acquire → 200  コントローラリース取得
POST /v1/workspaces/:id/open            → 200  {"state":"READY"}   （57秒）
```

Instance 内の agent-host が出した構造化ログ（Cloud Logging より）:

```json
{"event":"gcs.auth.token_source","source":"metadata-server","expires_in_s":1799}
{"event":"workspace.restore.completed","instanceName":"dsh-e7cabd5a-…"}
{"event":"lease.heartbeat.started","event_detail":"intervalMs=15000"}
{"event":"agent.host.listening","event_detail":"port=8080"}
```

これで以下が実機で確認された。

| ステップ | 内容 | 根拠 |
|---|---|---|
| 1-3 | IAP identity → メンバーシップ → コントローラリース | `acquire` 200、リース行が DB に生成 |
| 4-5 | control-plane が Cloud Run Instance を create → start | Instances API に実インスタンスが出現 |
| 6-7 | GitHub インストールトークン発行 → clone | `workspace.restore.completed`（clone 成功が前提） |
| 8 | GCS からチェックポイント取得 | `gcs.auth.token_source: metadata-server`（#27 の実装が本番で機能） |
| 9 | Harness を構成 | 同上（restore 完了に含まれる） |
| 10 | セッションとイベントを復元 | `turn.resume.empty`（新規なので空） |
| 11 | 201 応答 | `{"state":"READY"}` |

**#27 のメタデータサーバからのトークン取得が、本番の Cloud Run 上で実際に使われた**
（ローカルでは env フォールバックしか検証できていなかった経路）。

### 1.2 エージェントのターン（シーケンス図 ステップ12-16）

```
POST /v1/workspaces/:id/sessions        → 201
POST /v1/sessions/:id/messages          → 201  {"seq":0,"eventType":"user_message"}
GET  /v1/sessions/:id/events?seq=0      → SSE
```

SSE で観測されたイベント列（抜粋・実出力）:

```
id: 0   user_message          {"content":"Read README.md … describing this repository."}
id: 2   turn/start            {"turn":1}
id: 5   request/header        provider=deepseek-official model=deepseek/deepseek-v4-flash
id: 7…14 assistant/chunk      tool-call "read" を逐次ストリーム
        assistant/message     tool-call: read {"file_path": "README.md"}
        tool/call             read {"file_path": "README.md"}
        tool/result           <path>/workspace/README.md</path>  1: TODO app built with TanS…
        step/start            {"turn":1,"step":2}
        assistant/message     "This repository is a TODO app built with TanStack Start,
                               Drizzle, and Cloudflare D1."
        turn/end              {"turn":1,"reason":{"kind":"completed"}}
```

**LLM が実際にツールを呼び、clone 済みリポジトリの実ファイルを読み、答えた。**
`mpppk/todo-app2026` の README の内容と一致している。

確認できたこと:

- control-plane → agent-host への入力転送（#22）が本番で機能
- `@deepseek-ai/dsh-agent-loop` の実エージェントループが動作
- `dsh-llm-deepseek` アダプタを **OpenRouter** に向けて動作（自前アダプタ不要）
- ハーネスの `tool-fs` の `read` ツールが `/workspace` の実ファイルを読んだ
- イベントが連番付きで Cloud SQL に追記された
- control-plane の SSE が DB をポーリングして配信した（`seq` カーソル付き）

### 1.3 停止（シーケンス図 ステップ17）

```
POST /v1/workspaces/:id/checkpoints  → 200  {"checkpointed":true}
POST /v1/workspaces/:id/stop         → 200  {"state":"STOPPED"}
```

Instance は `INSTANCE_STOPPING` へ遷移。**ただし図との差が2点あり、#72 に記録した**
（Instance を delete しない / 停止時の tar.gz 保存が行われない）。

### 1.4 単体で検証した項目

| Issue | 内容 | 結果 |
|---|---|---|
| #25 | 実 Cloud SQL に実 runner でマイグレーション | 6テーブル生成、2回目は `No pending migrations.` |
| #26 | 実 GCS でチェックポイントの保存・復元 | パッチと未追跡ファイルが新規クローンに復元 |

`terraform apply` は **48 リソース**（前回 52 から、VPC コネクタ廃止で減）。
サービスアカウントキーはゼロ。

---

## 2. 発見したバグ 13 件

**すべて「ローカルのテストは緑、本番だけ落ちる」型だった。**

| # | 内容 | 根本原因 |
|---|---|---|
| [#41](https://github.com/mpppk/cloud-run-dsh/issues/41) | control-plane が Instance に LLM のキーを渡していない | 継ぎ目の未接続 |
| [#42](https://github.com/mpppk/cloud-run-dsh/issues/42) | `Bun.SQL` が Cloud SQL の Unix ソケット DSN を拒否。**失敗時に DB パスワードを Cloud Logging に出した** | 実 DB に投げていなかった |
| [#45](https://github.com/mpppk/cloud-run-dsh/issues/45) | `Bun.SQL` がオプションを渡しても `process.env.DATABASE_URL` を読む | テストが env を設定していなかった |
| [#47](https://github.com/mpppk/cloud-run-dsh/issues/47) | Instances API に相対 URL を渡していた | フェイクが URL を解決しない |
| [#48](https://github.com/mpppk/cloud-run-dsh/issues/48) | 500 を返すときサーバ側に何もログを残さない | 観測性の欠落 |
| [#51](https://github.com/mpppk/cloud-run-dsh/issues/51) | redactor が UUID を伏せ、§25 の相関キーが全部消えていた | #29 の積み残し |
| [#53](https://github.com/mpppk/cloud-run-dsh/issues/53) | `launchStage` 未送信で Instance 作成が必ず400。**API のエラー本文も捨てていた** | フェイクが body を検証しない |
| [#56](https://github.com/mpppk/cloud-run-dsh/issues/56) | `cloudSqlInstance` ボリュームを送っていない | 設計と実装の乖離 |
| [#58](https://github.com/mpppk/cloud-run-dsh/issues/58) | Artifact Registry の読み取り権限が誰にも無い | `terraform validate` は IAM の過不足を見ない |
| [#60](https://github.com/mpppk/cloud-run-dsh/issues/60) | control-plane と agent-host がリースと状態機械を取り合う | 同じ DB 行を共有する状況をテストが作っていない |
| [#62](https://github.com/mpppk/cloud-run-dsh/issues/62) | git のトークンを `Bearer` で渡していた（GitHub は `Basic x-access-token` を要求） | **テストが誤った形を「正しい」と固定していた** |
| [#64](https://github.com/mpppk/cloud-run-dsh/issues/64) | control-plane SA にも AR 権限が必要だった | 「API を呼ばないから不要」という推論が誤り |
| [#68](https://github.com/mpppk/cloud-run-dsh/issues/68) | **Cloud Run が完全一致の `/healthz` を握る** | プラットフォームの挙動。コードからは分からない |
| [#70](https://github.com/mpppk/cloud-run-dsh/issues/70) | `SELECT max(seq) … FOR UPDATE` が実 PostgreSQL で拒否される | **フェイクが「ここは無視する」と自ら書いていた** |

加えて撤収時に [#73](https://github.com/mpppk/cloud-run-dsh/issues/73)（`terraform destroy` が
マイグレーション後に失敗する）を発見した。

---

## 3. 特筆すべき発見

### 3.1 Cloud Run は完全一致の `/healthz` をコンテナにルーティングしない

同一サービス・同一トークンでパスだけ変えた実測:

```
/readyz    → 200 application/json   （コンテナに到達）
/healthz   → 404 text/html          ← Google の HTML エラーページ
/healthz/  → 401 application/json   （コンテナに到達）
/Healthz   → 401 application/json   （コンテナに到達）
/healthzz  → 401 application/json   （コンテナに到達）
/nope-xyz  → 401 application/json   （コンテナに到達）
```

**完全一致の `/healthz` だけが届かない。** agent-host も control-plane も
ヘルスをそこで提供していたため、control-plane の health ポーリングは
**原理的に成功しなかった**。`/readyz` に改名して解決（#68）。

**コードをいくら読んでも分からない種類の問題**であり、実機で端から端まで
動かしたからこそ出た。

### 3.2 フェイクが「ここは無視する」と自ら書いていた

`packages/session-persistence-postgres/src/fakeExecutor.ts:370`:

```ts
// For SELECT max(seq) FOR UPDATE, we treat as normal select (serialization already via txQueue)
```

このコメントのとおり、フェイクは SQL を解釈せずロック意味論を読み飛ばしていた。
そのため `SELECT max(seq) … FOR UPDATE`（PostgreSQL が拒否する形）が
**実 DB に一度も投げられないまま**残っていた（#70）。

修正では、**同じテストスイートを無変更でフェイクと実 PostgreSQL の両方に回す**
仕組みを入れ、フェイクには未対応構文を検出したら fail-fast するガードを付けた。
CI にも postgres サービスを配線した。

### 3.3 テストが誤った挙動を「正しい」と固定していた

`packages/github-credential-broker/src/index.test.ts:269`:

```ts
expect(args.join(" ")).toContain("Authorization: Bearer ghs_headerToken1234567890");
```

GitHub の git-over-HTTPS はインストールトークンに `Bearer` を受け付けない
（`Basic base64("x-access-token:<token>")` を要求する）。実トークンでの比較:

```
Authorization: Bearer <token>  → remote: invalid credentials  【失敗】
Authorization: Basic  <b64>    → 【成功】
```

`Bearer` は REST API では通るため混同されていた。テストは文字列を照合するだけで
実際の GitHub に投げていなかったので、誤りが固定されていた（#62）。

### 3.4 「API を呼ばないから権限は不要」という推論は成り立たない

#58 で「control-plane は Artifact Registry の API を呼ばないから権限は不要」と
判断し、レビュアーもコードと grep で裏付けて承認した。**実機で反証された**（#64）。

**Cloud Run は Instance の create 時点で、呼び出し元の権限でイメージへの
アクセスを検証する。** コードが AR を呼ぶかどうかは関係ない。

### 3.5 秘密がログに漏れた（実害）

`Bun.SQL` が投げる `Invalid URL` 例外が、パスワード入り DSN を素のまま出力し、
**Cloud Logging に永続化された**（#42）。redactor を通らない経路だった。

```
TypeError: Invalid URL
 input: "postgresql://dsh_app:<PASSWORD>@/dsh?host=/cloudsql/…"
```

修正後は `[REDACTED]` になることを実機で確認済み。当該 DB は破棄したのでこの
パスワード自体は無価値だが、**「redactor があるから安全」は成り立たない**ことが
実証された。修正では「そもそも秘密を含む値を例外に載せない」方針を採った。

### 3.6 500 にログが無いと本番の障害は追えない

最初の `open` 失敗時、**Cloud Logging に例外のログが1行も出なかった**。
`toErrorResponse` がクライアントに内部情報を返さないのは正しかったが、
**サーバ側にも記録していなかった**（#48）。

原因特定のために、トランスポートを自作で包んで実 API のエラーを取る必要があった。
#48 を直したあとは、**その後の障害（#58 の403、#60 のリース衝突、#70 の SQL エラー）が
すべて `errorId` から一発で特定できた**。本検証で最も効いた修正のひとつ。

---

## 4. 未解決の項目

| Issue | 内容 |
|---|---|
| [#72](https://github.com/mpppk/cloud-run-dsh/issues/72) | stop が Instance を delete せず、停止時の tar.gz チェックポイントも保存しない（図との差） |
| [#73](https://github.com/mpppk/cloud-run-dsh/issues/73) | マイグレーション後に `terraform destroy` が失敗する |

`POST /checkpoints` が返す `{"checkpointed":true}` は、実際にはマーカーの JSON を
置くだけでワークスペースの中身を含まない。コードのコメントは正直だが、
**API の応答は利用者から見て誤解を招く**（#72 に記録）。

また今回の検証では **cancel と approval の実機動作を確認していない**
（PR #40 でローカルの実キー検証は済んでいる）。

---

## 5. 撤収

**GCP リソースはゼロ。**

```
Cloud SQL          : 0 items
Cloud Run services : 0 items
Cloud Run Instances: {}
GCS buckets        : (なし)
Artifact Registry  : 0 items
Secrets            : 0 items
Service accounts   : 313948038748-compute@… のみ（プロジェクト既定）
VPC                : default のみ（プロジェクト既定）
```

`terraform destroy` は #73 の罠で一度失敗し、2回目で成功（18 resources destroyed）。
検証に使った OpenRouter の API キー、GitHub App の PEM、DB パスワードは
すべてローカルから削除済み。
