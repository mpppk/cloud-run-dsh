# 停止済み Instance の GC（#85）

## 重大度: 未確認のまま

停止中の Instance が region あたり 100 の quota
（[Cloud Run Quotas and Limits](https://docs.cloud.google.com/run/quotas):
"Instance — Maximum number of instances — 100 — per project and region"）
を消費するかは、**公開ドキュメントを調べても分からなかった**。
quota 表の1行はそれだけで、停止中を除外する記述も含める記述も無い。
[create-and-manage-instances](https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances)
の stop 節は課金ではなく in-memory 破棄の警告のみで、quota への言及は無い。

弱い示唆はある: list の節は "You can view all **active and inactive**
instances in your project" と書いており、停止した Instance はオブジェクト
として残り続け list に現れる。quota が「存在数」であれば消費するが、
「稼働数」であれば消費しない — **どちらとも読めるため、推測で決めない。**

## 実機で確認する手順（次の bring-up でコーディネーターが実施）

GCP は撤収済み・課金ゼロのため再構築しないこと。次に bring-up する際に：

```bash
export PROJECT_ID=cloud-run-dsh REGION=asia-northeast1
export TOK="$(gcloud auth print-access-token)"
export BASE="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}"

# 1. Instance を1つ作って停止する（従量課金は create/start の秒数分のみ）。
#    IMG は bring-up 時に push した agent-host イメージ（runbook Step 5 の $IMG）。
gcloud beta run instances create dsh-quota-probe \
  --image "${IMG}" --region "${REGION}"
gcloud beta run instances stop dsh-quota-probe --region "${REGION}"

# 2. 停止後も list に残ることを確認する。
curl -sS -H "Authorization: Bearer ${TOK}" "${BASE}/instances" | python3 -c \
  'import json,sys; [print(i["name"]) for i in json.load(sys.stdin).get("instances", [])]'

# 3. quota の使用量を見る。確実なのは Console: IAM & Admin > Quotas &
#    System Limits で Cloud Run Admin API の Instance 系 quota を Filter し、
#    停止前後で使用量が変わるかを見る。変わらなければ「消費しない」、
#    1 増えたままなら「消費する」。
#    （CLI で見る場合は metric 名を Console で確認してから。例:
#    gcloud beta services quota list --service=run.googleapis.com ...
#    の形だが、正確な metric 名は現地で確認すること）
```

結果はこのファイルと #85 に記録し、**「消費しない」と確定したら sweeper
の既定を無効化（`INSTANCE_GC_INTERVAL_MS=0`）してよい**。逆に「消費する」
なら 30 日の閾値を短縮を検討する。

## 採った案: A と B の両方（排他ではない）

- **案A: 最終利用からの経過時間で削除する。** control-plane 内の1時間おきの
  sweeper（`apps/control-plane/src/instance-gc.ts`）が、**STOPPED かつ
  30 日以上無触**の workspace の Instance オブジェクトを delete する。
  workspace 行・セッション・GCS チェックポイントは残るため、次の open()
  は create から始まりチェックポイントから復元する。
- **案B: 明示的な削除 API。** `DELETE /v1/workspaces/:id` を新設した。
  先に Instance を消し、成功したら workspace 行を子（sessions /
  session_events / checkpoints / lease）ごと削除する。Instance 削除に失敗
  したら 502 で行を残す（リトライ可能）。**STOPPED 以外（稼働中含む）でも
  強制削除する**（rm -rf semantics。409 ゲートを付けても list→delete と
  同じ TOCTOU が残り保証にならないため、付けずに文書化した）。
  メンバーシップ検査は既存ハンドラと同じ `assertMember`（非メンバーは 403）。

両方にした理由: B だけでは「消し忘れ」が溜まり続け、A だけでは「今すぐ
消したい」に応えられない。どちらも失うのは起動時間だけで、状態は GCS
チェックポイントから戻る（stop 時点で in-memory は既に消えているため、
残す利点は create 1回分のみ）。よって削除ポリシーは積極側に倒した。

## 安全規則（破ったらバグ）

- GC 適格は **STOPPED のみ**。READY / BUSY / CHECKPOINTING / STOPPING /
  STARTING / RESTORING / ERROR / RESTORE_FAILED / CHECKPOINT_FAILED は、
  何日経っても触らない（`isGcEligible` が純粋関数として行列テストを持つ）。
- 最終利用は `max(lastActivityAt, updatedAt, createdAt)` の3要素。
  **ただし `lastActivityAt` は現状 production のどこからも書かれていない**
  （書くのはテストのみ）ため、実質は `max(updatedAt, createdAt)` で判定
  している。将来 `lastActivityAt` の書き手が増えても GC 側の変更は不要。
  STOPPED 行の `updatedAt` は stop 完了の遷移時刻そのものなので、
  **スキーマ変更（新列）は不要**と判断した（#73 の destroy 問題を抱える
  マイグレーションを増やさない）。
- 削除直前に行を取り直し、**STOPPED のまま・`instanceName` が同一**のとき
  だけ消す（TOCTOU 対策。list→delete の間に open された稼働中 Instance
  は skip＋ログ。完全な fencing ではないが window は API 1往復分）。
- 1 sweep の削除は **10 件まで**（oldest-first、残りは次回＋ログ）。
  判定バグや operator error の blast radius を抑える。
  `staleAfterMs` は1時間未満を受け付けない。
- 1 workspace の失敗は sweep 全体を止めない（per-workspace try/catch）。
- 削除・失敗・skip・defer は必ず構造化ログに残す
  （`control-plane.instance-gc.deleted` / `.failed` / `.skipped` /
  `.deferred`、`control-plane.workspace-deleted` — いずれも `workspaceId` +
  `instanceName` 付き）。
- `DELETE /v1/workspaces/:id` は既存ハンドラと同じ `assertMember` を通す
  （他人の workspace は 403 で何も消えない）。

## 運用

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `INSTANCE_GC_INTERVAL_MS` | 3600000（1時間） | sweeper の間隔。`0` で無効化（DELETE API は使えるまま） |
| `INSTANCE_GC_STALE_AFTER_MS` | 2592000000（30日） | この期間無触の STOPPED workspace の Instance を消す。1時間未満は起動時エラー |
| `INSTANCE_GC_MAX_DELETES_PER_SWEEP` | 10 | 1 sweep の削除上限（oldest-first、残りは次回）。1未満は起動時エラー |

## 既知の残件

- **DELETE は GCS 上の checkpoint 実体を残す。** 消えるのは DB の
  `workspace_checkpoints` 行だけで、バケットの tar.gz は orphan として
  残る。バケットはバージョニング有効・非現行30日削除だが、現行 orphan
  の掃除手段は無い（将来: DELETE 時に GCS オブジェクトも消すか、orphan
  sweeper を足す）。

ログの見方:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="control-plane.instance-gc.deleted"' \
  --limit 20 --freshness=7d --format='value(jsonPayload.workspaceId,jsonPayload.instanceName)'
```
