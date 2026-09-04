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
