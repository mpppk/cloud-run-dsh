# 立ち上げ作業報告（2026-09-03 → 09-04）

Cloud Run DSH の**土台とサンドボックス**を GCP 上で実際に動かし、コストゼロの状態に戻すまでの記録。
PR 5本、レビュー9回、そして**実際に `terraform apply` を打たなければ見つからなかった欠陥が4件**。
エージェント本体はまだ存在しない。

| | |
|---|---|
| PR マージ | 5 |
| レビュー実施 | 9 |
| 差し戻し | 4 |
| テスト通過 | 514 |
| 稼働コスト | $0 |

最終的な構成は [アーキテクチャ](./architecture.md) を参照。本書は経緯とハマりポイントを扱う。

---

## 作ったもの

| PR | 変更 | なぜ必要だったか |
|---|---|---|
| #16 | Instances クライアントと runbook を実物の **v2** API に整合。`validateOnly` ドライランと読み取り専用の preflight を追加。 | runbook は存在しない v1 のパスを使っていた。このままなら全ての instance 呼び出しが失敗する。 |
| #19 | fake の Harness を実物の `@deepseek-ai/dsh-*` に置換（`0.1.2-rc.1` に厳密ピン）。 | サンドボックスは代用品に対してしか証明されていなかった。今は公開パッケージが実際に拒否している。 |
| #20 | apply して判明したインフラ欠陥4件の修正と、このリポジトリ初の CI workflow。 | これが無いと `terraform apply` が完走せず、Cloud Run 用のイメージも作れない。 |
| #17 | control-plane の Dockerfile と本番エントリ。未結線のランタイムレジストリは正直に fail-fast するプレースホルダに。 | control-plane にはイメージが存在せず、そもそもデプロイできなかった。 |
| #18 | 最小コストプロファイル、`--yes` ガード付きのバケット撤収スクリプト、根拠付きコスト表。 | バージョニング有効なバケットで撤収が失敗しうる。撤収が失敗するとは、課金が止まらないということ。 |

---

## GCP 上で確認できたこと

本番一式を実プロジェクトに構築し、動かし、削除した。以下はすべて実測であって、期待値ではない。

```
自前 agent-host イメージの Instance      Started instance in 14.14s · uid 10001 · x86_64
実物の Harness サンドボックス            /etc /var/tmp /home /app とパストラバーサルを全て拒否
観測ポリシ                               未観測ファイルの上書き 拒否 · read してから write 許可
                                         裏で変更された後の write 拒否
tool-fs-search (ripgrep/koffi)           OK -> ["ok.txt"]
Instance から Cloud SQL                  PostgreSQL 16.14 · db dsh · user dsh_app
                                         INSERT + SELECT, id=2（id=1 は削除済み Instance が書いた行）
Secret Manager                           secretKeyRef 経由で注入、spec には現れない
Artifact Registry                        push + pull, sha256:b6d8e966…
Invoker IAM                              未認証 403 · ID トークンで 200
ライフサイクル一巡                        apply 52 リソース · destroy 49 · 課金対象の残存なし
```

行 id は覚えておく価値がある。`id=1` は、その時点で既に削除されていた Instance が書いたものだ。
計算資源は使い捨てだが、状態はそうではない。

### 確認していないこと

**プローブは Dockerfile の `ENTRYPOINT` を上書きしている。** Cloud Run の `containers[].command` に
`bash -lc` を指定したため、`apps/agent-host/src/index.ts` は GCP 上で一度も実行されていない。
上の表で本番コードを直接動かしたのは `createHarnessComposition()` だけで、DB 接続も
`session-persistence-postgres` ではなく生の Bun SQL を使っている。ゲートウェイ、clone・復元、リース、
チェックポイントは実装済みだが GCP では動かしていない。control-plane に至っては本番デプロイ自体をしていない。

さらに、**エージェントのターンと、2つのサービスを繋ぐ経路はそもそも実装されていない。**
リポジトリ内に LLM クライアントは1つも無く、control-plane の `postMessage` は DB にイベントを書いて
201 を返すだけ、agent-host の `agentInput` は活動を記録して 202 を返すだけで、互いを呼ばない。
マイグレーションも実 runner を通しておらず、GitHub App も未登録、IAP ブランドは削除不能なので見送った。
これらが動くとは主張していない。

残作業は [#31](https://github.com/mpppk/cloud-run-dsh/issues/31) に集約している。

---

## ハマりポイント

いずれも実際に時間を使ったもの。同じ作業を繰り返す人にとっての被害が大きい順に並べている。

### G1. Cloud Run Instances に VPC 接続手段は無い — スキーマは嘘をつく

`vpcAccess.networkInterfaces` は v2 の discovery document に公開されている。API はこのフィールドを
受け取り、捨て、そのうえで自分自身のリクエストを拒否する。コネクタは明示的に拒絶される。

```
Annotation 'run.googleapis.com/vpc-access-connector' is not supported
on resources of kind 'instance'. Supported kinds are: revision, null
```

スキーマを読むだけでは足りない。文書化された2つの経路のどちらかは通るはずだという前提で、
Serverless VPC Access コネクタと Auth Proxy サイドカーを組むのに1時間を溶かした。

### G2. だがネイティブの `/cloudsql` ボリュームは動き、しかもほぼ何も要らない

`cloudSqlInstance` 型のボリュームを `/cloudsql` にマウントする方式は、実行サービスアカウントの
`roles/cloudsql.client` だけで Instance から動く。サイドカーも、コネクタも、サブネットも不要。

これが分かったのは、ユーザーから「実行サービスアカウントに Cloud SQL の権限を付けるだけでは
ダメでしたっけ」と問われたためである。その通りで、私が過剰に組んでいた。コネクタを外したことで、
何もしないまま常時課金されていた `e2-micro` 2台も消えた。

### G3. その経路は Cloud SQL に公開 IPv4 を強制する

ネイティブ統合は公開アドレスにダイヤルする。`ipv4_enabled = false` だと同じ Instance が
`SFEClient is nil` / `refresh failed: context deadline exceeded` で失敗する。両方向とも実測した。

`authorized_networks` は**空のまま**にすること。Instance は Google の共有プールから出ていくので、
そこを通せる許可リストは実質 `0.0.0.0/0` になる。認可は IAM と短命クライアント証明書が担い、
許可リストに載っていないホストからは素の TCP すら開かない。

### G4. Instances API は v2 にしか無い — v1 は HTML の 404 を返す

v1 の discovery にも `projects.locations.instances` はあるが、IAM 系メソッドしか無い。
v1 の CRUD URL は JSON の API エラーではなく HTML のエラーページを返すので、
「このパスは存在しない」ではなく「許可リストに入っていない」と誤読しやすい。

v2 で押さえるべき点が2つ。`instanceId` は*クエリパラメータ*であり（create ではボディの `name` は
無視される）、サーバは `launchStage: GA` を返す — 入るべき Preview 許可リストなど存在しない。

### G5. `validateOnly=true` は本当に無料のドライラン

v2 の `create` は `validateOnly` を受け付け、デフォルト補完済みの Instance を 200 で返し、何も作らない。
前後の list で確認済み。今回の全ての create は、金を払う前にこれで検証した。

### G6. `apply` でしか見つからなかった Terraform 欠陥が3件

- **`compute.googleapis.com` 欠落** — VPC に必要で、初回 apply は45個中39個を作ったところで停止した。
- **`edition` 未指定** — API が `ENTERPRISE_PLUS` を既定に選び、`db-custom-*` tier を拒否する。
- **サブネットが1つも無い** — `auto_create_subnetworks = false` なのにサブネットを作るリソースが無く、
  スタックは立ち上がるが自分のデータベースに到達できなかった。

3件とも `terraform validate` は緑だった。この種の欠陥は、実プロジェクトへの実 apply でしか表に出ない。

### G7. Cloud Run は linux/amd64 のみ、しかも bun は qemu 下でクロスビルドできない

Apple Silicon 上の素の `docker build` は `linux/arm64` を作り、Cloud Run では動かない。
`--platform linux/amd64` を足すと、今度は別の形で失敗する。

```
ASSERTION FAILED: MemoryExhaustion
  JSC::LocalAllocator::allocateSlowCase
panic(main thread): abort() called      (Bun 1.4.0, exit 134)
```

`tsc` が起動した瞬間に bun が死ぬ。対処は、パッケージング中の型検査をやめ、
型検査とネイティブ amd64 のイメージビルドを CI に移すことだった。

### G8. Harness は `/tmp` への書き込みを許す — 仕様書は許さないと書いている

`workspace-write` モードでは `/tmp` ちょうど（`/var/tmp` は不可）が書ける。これは upstream の挙動だが、
仕様書もアダプタのコメントも「ワークスペースルート外への書き込みは拒否される」と書いている。
閉じ込め自体は本物で、公開パッケージが強制している。

これが見えたのは fake を実物に置き換えた後である。*自分が信じている通りに*振る舞う代用品は、
その信念を気持ちよく追認してくれる。

### G9. コメントに一致して通っていたテスト

`expect(c).toMatch(/ipv4_enabled\s*=\s*false/)` は、設定が変数化された後も通り続けた。
近くの*コメント*にその文字列が含まれていたためである。アサーションは設定の検査をやめており、
出力からはそれが分からなかった。

以降に追加したアサーションは全て代入行にアンカーし、**意図的に設定を壊して落ちることを確認**してから
採用している。一度も落ちるところを見ていないテストは、証拠ではない。

### G10. destroy がサービスアカウントも消した — import してあったため

3つのサービスアカウントは既存で、`apply` が衝突しないように state へ import してあった。結果、
`destroy` がそれらも一緒に削除し、`gcloud config auth/impersonate_service_account` が存在しない ID を
指す状態になって、設定を解除するまで全ての gcloud 呼び出しが失敗した。

もう1つ。Secret Manager の*バージョン*はシークレットごと消えるので、作り直すたびに DB パスワードを
入れ直す必要がある。

### G11. 環境まわりの小さな罠

- `docker` がデフォルトの PATH に無い。`~/.docker/bin` にある。
- bun はワークスペースのパッケージを*パッケージ単位で*リンクする。リポジトリ直下のスクリプトからは
  `@cloud-run-dsh/*` を import できない。
- Harness のパッケージは `@deepseek-ai/dsh-*` として公開されており、npm の `latest` タグが古い。
  `npm view … version` は `0.0.1-rc.1` を返すが、実際の最新は `0.1.2-rc.1`。`versions` 配列を全部読むこと。
- Terraform は ADC 無しで動かせた。`gcloud auth print-access-token` の値を
  `GOOGLE_OAUTH_ACCESS_TOKEN` に入れるだけでよい。
- `observability` の redactor が20文字以上の技術的な識別子を黙って潰す。クラス名を
  `RuntimeNotWired` にせざるを得なかったのはこのため（[#29](https://github.com/mpppk/cloud-run-dsh/issues/29)）。

---

## 進め方

オーケストレーター1つ、使い捨ての worker、そして PR ごとに独立した reviewer。
worker も reviewer も `opencode` の `glm-5.3-flash`。GCP の認証情報を持ち、課金を伴う判断を下すのは
オーケストレーターだけとした。

### 効いたルール

reviewer には「worker の『テストが通りました』を信用するな。ブランチを checkout して自分で叩き直し、
自前の probe を書け」と指示した。9回のレビューのうち4回が差し戻しで、指摘は些末なものではなかった。

| レビュー | 指摘 |
|---|---|
| R18 | `db-f1-micro` は ENTERPRISE 専用 tier なので、最小プロファイルはオーケストレーターが既に踏んだのと同じ 400 で失敗する。公式ドキュメントだけでなく provider のソースまで読んで確認していた。 |
| R20 | baseline のテストが赤で、しかも「CI が型検査を強制している」は虚偽。`.github/workflows/` は存在しなかった。どちらも私の記述。 |
| R18b | 立ち上げ用プロファイルが、必須と自ら書いている公開 IP を一度も有効化していない。runbook 通りに進めてもデータベースに到達できない。 |
| R17 | `--platform` の記載がどこにも無い。qemu のクラッシュを2種類の builder で独立に再現。 |

> このうち3件は同じ種類である。**テストは緑で、それでも動かない。**
> ローカルのテストスイートでは捕まえられず、diff を読むだけの reviewer にも捕まえられない。

### 私が間違えたこと

- PR 本文に「25 pass, 0 fail」という古い数値を貼った。説明対象の変更を入れる*前*に測った値だった。
  reviewer が実行し直して 24 / 1 を得た。
- 「型検査は既に CI で強制されている」と、確認せずに書いた。CI は存在しておらず、Dockerfile の
  ステップを外したことで自動ゲートがゼロになっていた。
- 公開 IP をローカルの tfvars で検証し、出荷されるプロファイルに反映しなかった。私の検証は通ったが、
  成果物では通らない。
- API の失敗を1つ広く解釈しすぎて、データベース経路を過剰に組んだ（コネクタ + サイドカー）。
  ユーザーの一言でボリューム宣言1つに縮んだ。
- シーケンス図に、実装されていない経路を実装済みであるかのように描いた。
  ユーザーの指摘で気づき、実装状況の表を足した。

共通しているのは、**直前に実行したコマンドの結果ではなく、思い込みから断定したこと**である。
それはまさに、私が reviewer に対して「worker の主張を疑え」と指示していた当のものであり、
私自身にも当てはまっていた。

---

## 現在の状態

- **main** は `f57e29a`、テスト 514 通過、オープンな PR なし。
- **GCP** に課金対象は残っていない。Cloud SQL、バケット、レジストリ、VPC、Instance、Service いずれもゼロ。
  API は有効なままだが、それ自体は無料。
- **CI** が全ての PR で、型検査・テスト・Terraform 検証・両イメージのネイティブ amd64 ビルドを実行する。
- **次の作業** は [#31](https://github.com/mpppk/cloud-run-dsh/issues/31) に集約。
  順序は `#23 RuntimeRegistry 結線` → `#22 入力の転送経路` → `#21 エージェントのターン`。
