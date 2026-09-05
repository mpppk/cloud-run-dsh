// 実行方法（#26 の実 GCS 検証。リポジトリ内に置くのは bun のワークスペースリンクの都合）:
//   GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)" \
//   CHECKPOINT_BUCKET=<bucket> bun run apps/agent-host/verify-gcs-checkpoint.ts
//
// 認証は本番と同じ createGcsTokenProvider()（#27: metadata-server → ADC →
// GCP_ACCESS_TOKEN の順）を使うため、GCP_ACCESS_TOKEN はフォールバックである。
// ADC 済み環境（`gcloud auth application-default login` 後）ではそちらが優先
// される。CHECKPOINT_BUCKET は必須。
//
// 本番アダプタのみを使う（フェイクなし）。2026-09-05 に実バケットで成功を確認。

// #26 verification: checkpoint save/restore against the REAL GCS bucket.
// Uses the production adapters only — FetchGcsClient + GcsCheckpointStorage +
// createCheckpointBundle + restoreWorkspace. No fakes.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeFileSystem,
  ExecGitRunner,
  FetchGcsClient,
  createCheckpointStorage,
} from "./src/adapters.js";
import { createGcsTokenProvider } from "@cloud-run-dsh/gcp-token-provider";
import {
  createCheckpointBundle,
  serializeBundle,
  restoreWorkspace,
  SystemClock,
} from "@cloud-run-dsh/workspace-checkpoint";

const BUCKET = process.env["CHECKPOINT_BUCKET"]!;
const git = new ExecGitRunner();
const fs = new NodeFileSystem();
const clock = new SystemClock();
const gcs = new FetchGcsClient({ tokenProvider: createGcsTokenProvider() });
const storage = createCheckpointStorage(gcs, BUCKET);

const ok = (m: string) => console.log(`  OK   ${m}`);
const step = (m: string) => console.log(`\n== ${m}`);

// --- 1. build a real workspace: a git repo with committed + dirty + untracked
step("1. 実ワークスペースを作る（コミット済み + 変更 + 未追跡）");
const src = mkdtempSync(join(tmpdir(), "dsh-src-"));
await git.run(["init", "-q", "-b", "main"], { cwd: src });
await git.run(["config", "user.email", "verify@example.com"], { cwd: src });
await git.run(["config", "user.name", "verify"], { cwd: src });
writeFileSync(join(src, "committed.txt"), "original content\n");
await git.run(["add", "."], { cwd: src });
await git.run(["commit", "-q", "-m", "base"], { cwd: src });
const shaRes = await git.run(["rev-parse", "HEAD"], { cwd: src });
const baseCommit = shaRes.stdout.trim();
ok(`base commit ${baseCommit.slice(0, 12)}`);

// dirty the workspace the way an agent would
writeFileSync(join(src, "committed.txt"), "original content\nAGENT EDIT\n");
writeFileSync(join(src, "new-file.txt"), "created by the agent\n");
ok("committed.txt を変更、new-file.txt を新規作成（未追跡）");

// --- 2. bundle + upload to REAL GCS
step("2. チェックポイントを作って実 GCS にアップロード");
const bundle = await createCheckpointBundle({ workspaceDir: src, baseCommit, git, fs, clock });
if (!bundle.patchDiff.includes("AGENT EDIT")) throw new Error("patch does not contain the edit");
if (!bundle.untrackedFiles.includes("new-file.txt")) throw new Error("untracked file missing");
ok(`patch ${bundle.patchDiff.length}B / untracked ${bundle.untrackedFiles.length} 件`);
const key = `verify/${Date.now()}-checkpoint.bin`;
const bytes = serializeBundle(bundle);
await storage.put(key, bytes);
ok(`put gs://${BUCKET}/${key} (${bytes.length}B)`);

// --- 3. head + get round-trip from REAL GCS
step("3. 実 GCS から head / get");
if (!(await storage.head(key))) throw new Error("head returned false for an object we just wrote");
ok("head=true");
const fetched = await storage.get(key);
if (!fetched) throw new Error("get returned null");
if (fetched.length !== bytes.length) throw new Error(`size mismatch ${fetched.length} != ${bytes.length}`);
ok(`get ${fetched.length}B（バイト長一致）`);
const missing = await storage.get(`verify/definitely-absent-${Date.now()}`);
if (missing !== null) throw new Error("get of an absent object should be null");
ok("存在しないキーは null（404 を例外にしていない）");

// --- 4. restore into a FRESH clone
step("4. 別の新規クローンに復元");
const dst = mkdtempSync(join(tmpdir(), "dsh-dst-"));
const cloneRes = await git.run(["clone", "-q", src, dst]);
if (cloneRes.exitCode !== 0) throw new Error(`clone failed: ${cloneRes.stderr}`);
if (readFileSync(join(dst, "committed.txt"), "utf8").includes("AGENT EDIT")) {
  throw new Error("fresh clone already has the edit — the test proves nothing");
}
if (existsSync(join(dst, "new-file.txt"))) throw new Error("fresh clone already has the untracked file");
ok("新規クローンには変更も未追跡ファイルも無い（前提の確認）");

await restoreWorkspace({ workspaceDir: dst, baseCommit, checkpointKey: key, storage, git, fs });

const restored = readFileSync(join(dst, "committed.txt"), "utf8");
if (!restored.includes("AGENT EDIT")) throw new Error("restore did NOT bring back the edit");
ok("committed.txt の変更が復元された");
if (!existsSync(join(dst, "new-file.txt"))) throw new Error("restore did NOT bring back the untracked file");
if (readFileSync(join(dst, "new-file.txt"), "utf8") !== "created by the agent\n") {
  throw new Error("untracked file content differs");
}
ok("new-file.txt（未追跡）が内容ごと復元された");

console.log(`\n#26 検証成功 — 実 GCS バケット gs://${BUCKET} で保存・復元が成立`);
console.log(`残ったオブジェクト: gs://${BUCKET}/${key}`);
