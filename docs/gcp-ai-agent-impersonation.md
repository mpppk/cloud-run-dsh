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

- 今回の設定ではCloud RunとArtifact RegistryのAPIはまだ有効化していません。
- Cloud Run、Cloud SQL、バケットなどの実リソースは、AI-agent用SAの設定だけでは作成されません。
- ベースライン全体の構築は [`infra/terraform/README.md`](../infra/terraform/README.md) と
  [`docs/deployment-runbook.md`](deployment-runbook.md) を参照してください。
- サービスアカウントキーを作成して認証を回避しないでください。
