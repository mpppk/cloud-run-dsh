# Cost Profiles — bring-up verification vs. production baseline

> 対象リージョンは **asia-northeast1 (Tokyo)**、通貨は USD。
> 「月額」はインスタンスを **24 時間 365 日稼働させ続けた場合の概算** (730 時間/月)。
> 価格は 2026-09 時点の公式価格ページ (`https://cloud.google.com/sql/pricing`,
> `https://cloud.google.com/storage/pricing`) に掲載の値。変更の可能性があるため、
> 承認前に再確認すること。推測値は書かず、根拠がない項目は「不明」とした。

## プロファイル比較

Terraform の本番向け既定値は変更していない。検証時だけ
`infra/terraform/profiles/minimal.tfvars` を `--var-file` で渡す:

```bash
terraform -chdir=infra/terraform plan  -var-file=profiles/minimal.tfvars
terraform -chdir=infra/terraform apply -var-file=profiles/minimal.tfvars
```

| 設定 | standard (既定値) | minimal (`profiles/minimal.tfvars`) |
|---|---|---|
| `db_tier` | `db-custom-1-3840` (vCPU 1 / 3.75 GiB 専有) | `db-f1-micro` (共有 1 vCPU / 0.6 GiB) |
| `db_disk_type` | `PD_SSD` | `PD_HDD` (Enterprise edition のみ選択可) |
| 自動バックアップ | 有効 | **無効** |
| PITR | 有効 (WAL 7 日) | **無効** |
| transaction log retention | 7 日 | 1 日 (バックアップ無効時は送信しない) |
| Query Insights | 有効 | **無効** |
| availability_type | `ZONAL` | `ZONAL` (既に安い方のため変更なし) |

### 最小 tier の選定根拠 (推測ではなく公式ドキュメントで確認済み)

- Cloud SQL for PostgreSQL **Enterprise edition** は「general purpose shared core」
  マシンシリーズとして `db-f1-micro` (0.6 GB) と `db-g1-small` (1.7 GB) を
  PostgreSQL で利用できる: https://cloud.google.com/sql/docs/postgres/machine-series-overview
- `db-f1-micro` / `db-g1-small` は **Cloud SQL SLA の対象外**で、
  「low-cost test and development instances only」と公式に明記されている:
  https://cloud.google.com/sql/docs/postgres/instance-settings
- 注意: 0.6 GiB RAM ではワークスペース実負荷は持たない想定。立ち上げ確認
  (apply, マイグレーション, /livez) 専用。OOM した場合は `db-g1-small`
  (約 3 倍の単価) に上げて再確認すること。
- 注意 (2026-09-05 実測): `db-f1-micro` では**接続スロットが枯渇しやすい**。
  control-plane のコネクションプールだけで枠が埋まり、`psql` が繋がらなく
  なった。検証中に素の `psql` で直接確認したい場合は、control-plane を止めた
  状態で行うか、一時的に上位 tier への上げを検討すること。

## 月額概算 (asia-northeast1)

### minimal プロファイル (検証用)

| 項目 | 単価 (公式) | 概算月額 | 根拠 |
|---|---|---|---|
| Cloud SQL `db-f1-micro` | $0.014/hour | **$10.22** | [Cloud SQL pricing](https://cloud.google.com/sql/pricing) — Tokyo shared-core 表 |
| Cloud SQL ストレージ PD_HDD 10 GiB | $0.117/GiB/月 | $1.17 | 同上 — Tokyo storage 表 |
| バックアップ / PITR | 無効化 | $0 | (standard ではバックアップ $0.104/GiB/月 が掛かる) |
| GCS チェックポイントバケット (Standard, <1 GiB 想定) | $0.026/GiB/月 | ≈$0.03 未満 | [GCS pricing](https://cloud.google.com/storage/pricing) |
| Secret Manager (シークレット 3 件 × 1 バージョン) | $0.06/バージョン/月 | $0.18 | [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing) |
| Artifact Registry (1 イメージ ≈ 0.5 GiB 以下想定) | $0.10/GiB/月 (0.5 GiB 無料枠) | $0〜僅少 | [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing) |
| Cloud Run (コントロールプレーン) | リクエスト時のみ課金 | ほぼ $0 (アイドル時) | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Cloud Run Instance (Pre-GA) | CPU $0.00000027/vCPU秒 + メモリ $0.00000193/GiB秒 (Tokyo) | **稼働時間のみ**。1 vCPU / 1 GiB を 30 日連続で $5.70。**停止中は $0** | Cloud Billing Catalog API の実 SKU (下記)。pricing ページには記載が無い |
| ネットワーク egress | 使用量依存 | **不明** | [Network pricing](https://cloud.google.com/vpc/network-pricing) |
| VPC peering / Private Service Access range | ピアリング自体は無課金 | $0 (内部 IP 保有料の扱いは**不明**) | https://cloud.google.com/vpc/network-pricing |

**合計 (DB 稼働 24h/日): 約 $11〜12/月** (Cloud Run Instance の稼働分と egress は別途)。

#### Cloud Run Instance の単価の根拠 (2026-09-05 実測)

pricing ページに Instances の記載が無いため、Cloud Billing Catalog API から
Cloud Run (`services/152E-C115-5142`) の SKU を全件取得して確認した。
**description が `Instances` で始まる SKU は2つしか存在しない。**

```
asia-northeast1
  Instances CPU      0.00000027 USD / second          (category: Compute)
  Instances Memory   0.00000193 USD / gibibyte second (category: Compute)
```

**storage / disk の SKU は無い** (ディスク系は `Ephemeral Storage` = category
`EphemeralDisk` のみで、これは停止で消える)。2つとも稼働時間の計測なので、
**停止した Instance は課金されない。**

> description に `Instance` を含む SKU は他に
> `Services CPU / Memory (Instance-based billing)` の2件があるが、これは Cloud Run
> **Services** の課金モードであって Instances 製品のものではない。いずれも時間課金の
> メーターなので、停止中ゼロという結論は変わらない。

裏取り: `1 vCPU × 30日 = 2,592,000秒 × 0.00000027 = $0.70`、
`1 GiB × 30日 = 2,592,000秒 × 0.00000193 = $5.00`、合計 **$5.70** は
[Introducing Cloud Run instances](https://cloud.google.com/blog/products/serverless/introducing-cloud-run-instances)
の公表額と一致する。全額が CPU とメモリだけで説明できるため、隠れた保有料は無い。

この結果、**停止した Instance は delete せず残す**方針とした
([#85](https://github.com/mpppk/cloud-run-dsh/issues/85))。

⚠️ **ただし「残す＝速く再開できる」ではない。**
[公式ドキュメント](https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances)は
"Stopping an instance terminates the active container runtime, **deleting all in-memory
files and unpersisted system state.**" と明記しており、**停止した時点でワークスペースの
中身は消えている。** 残す利点は `create` 1回を省けることだけで、状態は結局 GCS の
チェックポイントから戻すしかない。
課金はゼロだが Instance オブジェクトは溜まり続け、
[quota](https://docs.cloud.google.com/run/quotas) は region あたり 100。
停止中がこの 100 を消費するかは**未確認**。

さらに、検証合間は `gcloud sql instances patch <name> --activation-policy=NEVER`
でインスタンスを停止できる。停止中はインスタンス料金が掛からずストレージのみ
(≈$1.2/月)。

### standard プロファイル (現行既定値)

| 項目 | 単価 (公式) | 概算月額 | 根拠 |
|---|---|---|---|
| Cloud SQL `db-custom-1-3840` | vCPU $0.0537/hour + メモリ $0.0091/GiB/hour | **$64.11** (= $39.201 + 3.75 × $6.643) | [Cloud SQL pricing](https://cloud.google.com/sql/pricing) — Tokyo Enterprise edition 表 |
| Cloud SQL ストレージ PD_SSD 10 GiB | $0.221/GiB/月 | $2.21 | 同上 |
| 自動バックアップ + PITR (WAL) | バックアップ保存 $0.104/GiB/月 | $1 前後 (DB サイズ依存、WAL 分は**不明**) | 同上 — "Backups (used)" |
| その他 (GCS / Secret / AR / Cloud Run) | minimal と同様 | $1 未満 | 各価格ページ |

**合計: 約 $67〜68/月** (DB 稼働 24h/日)。Cloud SQL は接続が無くても
インスタンスが存在するだけで課金が続く点に注意。

> 数字の取り方: Cloud SQL のリージョン別単価は pricing ページの Tokyo 表
> (vCPU $0.0537/hour, Memory $0.0091/GiB/hour, db-f1-micro $0.014/hour,
> SSD $0.221/GiB/月, HDD $0.117/GiB/月, Backups $0.104/GiB/月) から計算した。
> 分からない項目 (Cloud Run Instance, egress, PITR の WAL 実サイズ) は推測で
> 埋めず「不明」としている。

## バックアップ無効化の是非 (minimal プロファイル)

**無効にした** (判断と根拠):

- 検証用プロファイルは「一度動くことの確認」が目的で、データの永続価値がない。
- 自動バックアップ + PITR はバックアップ保存料 ($0.104/GiB/月) と WAL 保持を
  発生させ、destroy し忘れた場合の放置コストを増やす。
- 副作用: インスタンス障害時のデータ復旧は **不可能**。検証データは失われて
  もよいという前提でのみ使うこと。本番へ移行する際は必ず既定値
  (`db_backup_enabled = true`) に戻す。
- なお `terraform destroy` 自体はバックアップ無効でも動作に影響しない。

## Teardown

<!-- The heading text is exactly "Teardown" so its GitHub auto-slug is
     `#teardown`, matching the links from profiles/minimal.tfvars and
     scripts/lib/bucket-teardown.ts (docs/cost.md#teardown). A raw
     <a id="teardown"> anchor is NOT used: GitHub's sanitizer prefixes every
     id with `user-content-`, so a plain-HTML anchor only resolves through
     frontend JS, not by the id itself. Auto-heading slugs go through the
     same user-content- prefix but are the standard, proven GitHub
     deep-link path (the same one deployment-runbook.md#step-8--teardown-stop-paying
     relies on). -->

課金を止めるまでの手順:

> **🚨 `terraform destroy` が失敗したまま放置すると課金は止まらない。**
> 特にチェックポイントバケットは versioning 有効のため、オブジェクト
> (live + 全バージョン) が 1 つでも残っていると destroy が失敗し、
> バケットと Cloud SQL の両方が課金され続ける。

手順の全体像は [deployment-runbook.md Step 8](deployment-runbook.md#step-8--teardown-stop-paying)。
バケット空化は専用スクリプト (`--yes` 無しでは実行不可) で行う:

```bash
# 破壊的操作: 全チェックポイント (live + 全バージョン) を完全削除する
bun run teardown:empty-bucket -- --bucket "$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)" --yes

terraform -chdir=infra/terraform destroy
```

- スクリプトは `--yes` がないと実行を拒否する (unit test で検証済み)。
- 実装: `scripts/empty-checkpoint-bucket.ts` (+ `scripts/lib/bucket-teardown.ts`)。
  GCS JSON API で全バージョンを列挙→削除し、バケットが空になったことを確認してから終了する。

### destroy 失敗時の課金リスク一覧

| リソース | destroy 挙動 | 課金が止まる条件 |
|---|---|---|
| Cloud SQL (最大コスト) | 削除される (`deletion_protection = false`) | destroy 成功時 |
| Cloud SQL ユーザー `dsh_app` | マイグレーション後は**削除失敗する** (テーブル＋残存権限がロールを参照。テーブルだけ落としても `DROP ROLE` が権限依存で失敗する。オープンな issue [#73](https://github.com/mpppk/cloud-run-dsh/issues/73)。2026-09-05 の撤収で実測、`DROP ROLE` までの全経路を PostgreSQL 16.9 で再実証) | `dsh_app` で `DROP OWNED` 後に `postgres` で `REVOKE` 3件、それから destroy 再実行 (破壊的操作・撤収時のみ。詳細は [deployment-runbook.md Step 8](deployment-runbook.md#step-8--teardown-stop-paying)) |
| GCS チェックポイントバケット | **空でないと削除失敗** | 上記スクリプト実行後 |
| Service Networking peering | `deletion_policy = "ABANDON"` で**残る** | runbook Step 8.5 の手動削除 |
| Cloud Run Instance (Pre-GA) | Terraform 管理外 | 停止すれば課金は止まる (上記 SKU 参照)。ただし撤収時はオブジェクトも残さないよう手動 delete (Step 8.1) |

### ABANDON された peering が次回 apply に与える影響

`google_service_networking_connection.private_vpc_connection` は destroy 後も
peering を残す。次回 `terraform apply` で同リソースを再作成する際、同じ
VPC (または同名 VPC) に `servicenetworking.googleapis.com` の peering が
既に存在すると API がエラーを返して apply が失敗する可能性がある。
対処:

1. `gcloud compute networks peerings list --network=<vpc>` で残存を確認
2. 残っていれば runbook Step 8.5 の `gcloud services vpc-peerings delete` で
   削除してから apply する
