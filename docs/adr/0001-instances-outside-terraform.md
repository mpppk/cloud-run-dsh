# ADR-0001: Cloud Run Instances を Terraform の管理外に置く

- **状態:** 決定済み（Accepted）
- **日付:** 2026-09-04
- **関連 Issue:** [#28](https://github.com/mpppk/cloud-run-dsh/issues/28)
- **関連:** [アーキテクチャ](../architecture.md)、[deployment-runbook.md](../deployment-runbook.md) Step 5、`infra/terraform/README.md`

## 背景

Cloud Run Instances に Terraform リソースが無く、`infra/terraform/run_instances.tf.example` が
TODO として残っていた。選択肢は (a) provider の対応を待つ (b) `terraform_data` +
`local-exec` で包む (c) Terraform の管理外と割り切る、のいずれかだった（#28）。

## 決定

**Cloud Run Instances は Terraform に載せない。** たとえ将来
`hashicorp/google`（`-beta`）に `google_cloud_run_instance`
相当のリソースが追加されても、Instance を Terraform リソース化しない。
それに伴い `run_instances.tf.example` は削除した。

Terraform が持つのは**静的な土台**（API 有効化、Cloud SQL、GCS、Secret、IAM、
サービスアカウント）までであり、その境界は現状のままで正しい。

## 理由

1. **Instance はワークスペースごとの短命リソースであり、ライフサイクルの主体は
   アプリケーションである。** Instance は「ワークスペースを開く」と control-plane が
   create し、アイドル検知や明示の stop で stop / delete する。
   作り・壊しの判断材料（同時 open の合流、コントローラリース、アイドル状態）は
   すべて実行時のアプリケーション状態であり、Terraform の plan 時に存在しない。
   ライフサイクルの主体がアプリケーションである以上、管理の記述場所も
   アプリケーション側（`packages/cloud-run-instance-client` と runbook Step 5）が正しい。

2. **宣言的管理下に置くと `terraform plan` が恒常的に汚れる。**
   実行時に作られた Instance は、Terraform の視点ではすべて drift である。
   ワークスペースを開くたびに差分が生まれ、plan の出力は「インフラの異常」か
   「通常運転の痕跡」か判別不能になる。drift 検知という Terraform の主価値を
   自ら潰すことになる。逆に Terraform を作成主体にすると、「ワークスペースを開く」
   という日常操作がインフラ変更（apply）になってしまい、権限面でも速度面でも実用にならない。

3. **Preview surface を無理に Terraform で包む価値が無い。**
   Instances API は Preview であり予告なく変わりうる（仕様書 §29 が毎デプロイ前の
   Known Issues / release notes 確認を求めているのはこのため）。
   `terraform_data` + `local-exec` で包んでも、得られるのは見かけの統一だけで、
   実態は REST 直叩きと変わらない。素直に REST クライアントと手順書で担保する方が、
   壊れたときに壊れた箇所が分かる。

## 結果

- Instance の作成・起動・停止・削除は control-plane の `InstanceRuntime` アダプタ
  （`packages/cloud-run-instance-client` → Cloud Run v2 REST）が担い、
  手動の検証・デバッグ手順は deployment-runbook.md Step 5 に残す。
- Terraform の責務は静的な土台のまま。Instance が増減しても `terraform plan` は clean のままである。
- この決定を見直す条件: ワークスペースと Instance の対応が 1:1 でなくなる
  （常駐プール化など）、または Instances API が GA 化し provider が安定したうえで
  drift 問題の解（`ignore_changes` では済まない lifecycle 分離）が見つかった場合。
   そのときは本 ADR を Superseded として新しい ADR を切る。

## 追記: 2026-09-05 の実機検証による裏付け

2026-09-05 の GCP 実機検証（`docs/e2e-verification-report.md`）で、control-plane が
実際に Instance を **create → start** し、アイドル／明示操作で **stop** した。
ライフサイクルの主体がアプリケーションであるという本 ADR の前提は実証された。

ただし2点、未検証・未決の残件がある（いずれも本決定を覆すものではない）:

- **delete は未実施。** 実装は `stop` のみ呼び、停止した Instance が残る。
  図（`docs/architecture.md`）と実装の差として
  [#72](https://github.com/mpppk/cloud-run-dsh/issues/72) が open のままである。
  本 ADR の「stop / delete する」という記述のうち delete 側はまだ実証されていない。
- **停止した Instance の GC（いつ誰が消すか）とコスト影響は未決。** #72 で決める。
  1:1 対応が崩れる常駐プール化などに至れば、本 ADR の見直し条件に該当するため
  新しい ADR を切る。

## 追記（2026-09-05）— 上記の残件2点は決着した

**本文と「§ 実証」節の記述は本節が supersede する。** ADR 本体は当時の記録として
書き換えず残す。

### delete は「未実施」ではなく「しない」が正である

`stop` 後に Instance を delete するかどうかを、**停止中の課金の有無を実測して**決めた。
結論は **delete しない**。

Cloud Billing Catalog API で Cloud Run（`services/152E-C115-5142`）の SKU を確認したところ、
description が `Instances` で始まる SKU は2つしか無い。

```
asia-northeast1
  Instances CPU      0.00000027 USD / second          (category: Compute)
  Instances Memory   0.00000193 USD / gibibyte second (category: Compute)
```

**storage / disk の SKU は無い**（ディスク系は `Ephemeral Storage` = category
`EphemeralDisk` のみで、これは停止で消える）。どちらも稼働時間の計測なので、
**停止すれば課金はゼロになる。** 裏取りとして、この2つだけで
[公式ブログ](https://cloud.google.com/blog/products/serverless/introducing-cloud-run-instances)
の公表額 $5.70（1 vCPU / 1 GiB / 30日）が再現できる。全額が CPU とメモリで
説明しきれるため、隠れた保有料は無い。

（`Services CPU/Memory (Instance-based billing)` という description に Instance を含む
SKU が別に2つあるが、これは Cloud Run **Services** の課金モードであって Instances 製品の
ものではない。いずれにせよ時間課金メーターなので結論は変わらない。）

したがって **本文 §1 の「明示の stop で stop / delete する」は「stop する」が正。**
`docs/architecture.md` のシーケンス図も `stop → delete` から `stop` に修正した。

### 「残す＝速く再開できる」ではない

[公式ドキュメント](https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances):

> Stopping an instance terminates the active container runtime,
> **deleting all in-memory files and unpersisted system state.**

**停止した時点でワークスペースの中身は消えている。** Instance を残す利点は
`create` 1回を省けることだけで、状態は結局 GCS のチェックポイントから戻すしかない。
本 ADR の「短命リソース」という性格づけは、ライフサイクルの主体がアプリケーションで
あるという意味では有効だが、**オブジェクトが短命だという意味ではない。**

### GC は #85 に分離した

停止した Instance の GC（いつ誰が消すか）は
[#85](https://github.com/mpppk/cloud-run-dsh/issues/85) に切り出した。
課金はゼロだが Instance オブジェクトは workspace 数だけ増え続け、
[quota](https://docs.cloud.google.com/run/quotas) は region あたり 100 である
（停止中がこの 100 を消費するかは未確認）。

常駐プール化など 1:1 対応が崩れる方向に進む場合に新しい ADR を切る、という
見直し条件は変わらない。
