# GCP AI-agent access

このドキュメントは、AIエージェントが `gcloud` を使ってこのリポジトリのGCP環境を操作するための設定記録です。

## 現在の設定

| 項目 | 値 |
|---|---|
| GCP project ID | `cloud-run-dsh` |
| AIエージェント用サービスアカウント | `ai-agent@cloud-run-dsh.iam.gserviceaccount.com` |
| TerraformでのSA ID | `ai-agent` |
| Terraformの既定環境 | `dev` |
| Terraformの既定リージョン | `asia-northeast1` |
| サービスアカウントキー | 作成しない（Impersonationのみ） |

### AIエージェント用SAの権限

- プロジェクトロール：`roles/run.admin`
- プロジェクトロール：`roles/artifactregistry.writer`
- Cloud Run実行用SA（`dev-dsh-agent-host` / `dev-dsh-control-plane`）への `roles/iam.serviceAccountUser`

Impersonateを行う人またはワークロードには、AIエージェント用SA自身に対して
`roles/iam.serviceAccountTokenCreator` を付与しています。設定済みのIAM memberは、
セットアップ時に利用した `gcloud` のアカウントです。
この付与はTerraformのリソース定義とは別に `gcloud` で直接（out-of-band）行われたため、
実際に付与されているメンバーがTerraform stateに反映されていない可能性があります。
将来の混乱を避けるため、実際のメンバーを `TF_VAR_ai_agent_impersonators` に設定して
Terraform管理下に置いてください。

### ⚠️ 権限の上限（エスカレーション経路）— Impersonation は「フルランタイムシークレット」

**注意: この構成は真の least-privilege ではありません。** `ai_agent_impersonators` に追加された
メンバーの実効的な権限上限は **「すべてのランタイム認証情報」** です。確認されている
エスカレーション経路は次のとおりです:

1. `ai-agent` SAをimpersonateする（`roles/iam.serviceAccountTokenCreator`）。
2. プロジェクトレベルの `roles/run.admin` + `roles/artifactregistry.writer`、および両ランタイムSA
   （`dev-dsh-agent-host` / `dev-dsh-control-plane`）への `roles/iam.serviceAccountUser`（`actAs`）を
   使い、任意のコンテナイメージをArtifact Registryへpushして、**`dev-dsh-agent-host` として
   動作する** Cloud Runサービスをデプロイできる。
3. そのコンテナはSecret Managerの3つのシークレット（`github-app-private-key`、`llm-api-key`、
   `db-password`）とチェックポイントバケットをすべて読み取れる。`control_plane` として
   動作させた場合も同様。

したがって、`ai_agent_impersonators` にメンバーを追加するかどうかは、上記を理解したうえでの
意思決定です。単一オーナーのMVPスクラッチプロジェクトとしてはこの経路を許容しますが、
Impersonationの権限を「最小権限」と表現することは避けてください。

`roles/run.developer` は `roles/run.admin` のより狭い代替です（Cloud RunサービスのIAMポリシー
管理などが不可になる一方、サービスの作成・更新・デプロイは可能）。ただし **`run.developer` に
切り替えてもシークレット流出経路は閉じません** — `actAs` が残るため `agent-host` として動作する
サービスをデプロイでき、そのIDは3つのシークレットすべてに対する `secretAccessor` を持つためです。
シークレット経路を閉じるには、ランタイムSA側の `secretAccessor` 付与の見直しが必要です。

## gcloudの設定

```bash
gcloud config set project cloud-run-dsh
gcloud config set auth/impersonate_service_account \
  ai-agent@cloud-run-dsh.iam.gserviceaccount.com
```

設定確認とトークン取得の確認：

```bash
gcloud config list \
  --format='yaml(core.project,core.account,auth.impersonate_service_account)'
gcloud auth print-access-token >/dev/null
```

`gcloud auth print-access-token` が成功し、次の警告が表示されれば、
Impersonationが有効です。

```text
This command is using service account impersonation.
```

Impersonationを解除する場合：

```bash
gcloud config unset auth/impersonate_service_account
```

## Terraformでの管理

定義は [`infra/terraform/iam.tf`](../infra/terraform/iam.tf) と
[`infra/terraform/variables.tf`](../infra/terraform/variables.tf) にあります。
Impersonationを許可するmemberは、個人メールアドレスをコードに書かず、Terraform変数として渡します。

```bash
export TF_VAR_project_id="cloud-run-dsh"
GCLOUD_ACCOUNT="$(gcloud config get-value account)"
export TF_VAR_ai_agent_impersonators="[\"user:${GCLOUD_ACCOUNT}\"]"
```

AI-agent関連だけを初回適用する場合は、次のtargetを使います。これはAI-agent用SAと、
Cloud RunのランタイムSAへの限定的な `actAs` を準備するための手順です。

```bash
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform apply \
  -target=google_service_account.ai_agent \
  -target=google_project_iam_member.ai_agent_project_roles \
  -target=google_service_account_iam_member.ai_agent_impersonators \
  -target=google_service_account_iam_member.ai_agent_act_as_agent_host \
  -target=google_service_account_iam_member.ai_agent_act_as_control_plane
```

Terraform stateは現在ローカル管理で、stateファイルはリポジトリにコミットされません。
既存環境を別の端末で管理する場合は、stateを安全に引き継ぐか、既存リソースをTerraformへimportしてからapplyしてください。

## 注意事項

- (2026-09-05 時点では解消済み: 下記の API は有効化され、Cloud Run・Cloud SQL・
  バケット等の実リソースが存在する。手順は
  [`docs/deployment-runbook.md`](deployment-runbook.md) が正典)
- AI-agent 用 SA (`ai-agent`) は Terraform 管理 (`infra/terraform/iam.tf`) のため、
  2026-09-05 の撤収検証で destroy により一度削除された後、apply で作り直されている。
  手動で作られた SA が残っていると 409 で衝突する場合は、先に state へ取り込む
  (`terraform import google_service_account.ai_agent …`) こと。
  ([`docs/architecture.md`](architecture.md) §03 も参照)
- ベースライン全体の構築は [`infra/terraform/README.md`](../infra/terraform/README.md) と
  [`docs/deployment-runbook.md`](deployment-runbook.md) を参照してください。
- サービスアカウントキーを作成して認証を回避しないでください。
