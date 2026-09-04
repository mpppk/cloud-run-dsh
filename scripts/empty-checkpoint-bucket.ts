/**
 * DANGEROUS (irreversible): empties the versioned checkpoint bucket so that
 * `terraform destroy` can actually delete it. Run ONLY as part of teardown,
 * AFTER checkpoints have been exported if they are still wanted.
 *
 * Refuses to run without `--yes`:
 *   bun run teardown:empty-bucket -- --bucket <name> [--project <p>] --yes
 *
 * Why: `google_storage_bucket.checkpoints` keeps object versions, and
 * `terraform destroy` cannot delete a non-empty versioned bucket — a skipped
 * or failed destroy leaves the (billable) bucket behind. See docs/cost.md.
 */

import { spawnSync } from "node:child_process";
import { emptyBucket } from "./lib/bucket-teardown.ts";
import { GcsApiTeardownClient } from "./lib/gcs-api-teardown-client.ts";

export interface CliArgs {
  bucket: string;
  project?: string;
  yes: boolean;
  help: boolean;
}

export function parseCliArgs(argv: string[]): { ok: true; args: CliArgs } | { ok: false; error: string } {
  const args: CliArgs = { bucket: "", yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bucket") {
      args.bucket = argv[++i] ?? "";
    } else if (a.startsWith("--bucket=")) {
      args.bucket = a.slice("--bucket=".length);
    } else if (a === "--project") {
      args.project = argv[++i] ?? "";
    } else if (a.startsWith("--project=")) {
      args.project = a.slice("--project=".length);
    } else if (a === "--yes") {
      args.yes = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      return { ok: false, error: `unknown argument: ${a}` };
    }
  }
  if (args.help) return { ok: true, args };
  if (args.bucket.trim() === "") return { ok: false, error: "--bucket <name> is required" };
  if (!args.yes) {
    return {
      ok: false,
      error:
        "refusing to run without --yes: this PERMANENTLY deletes every checkpoint " +
        "(live objects + all archived versions) and cannot be undone",
    };
  }
  return { ok: true, args };
}

function gcloudAccessToken(): string {
  const p = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" });
  const token = (p.stdout ?? "").trim();
  if (p.status !== 0 || token === "") {
    const stderr = (p.stderr ?? "").trim().split("\n")[0] ?? "unknown error";
    throw new Error(`could not obtain an access token via gcloud (${stderr}). Run 'gcloud auth login' first.`);
  }
  return token;
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`ERROR: ${parsed.error}`);
    console.error("Usage: bun run teardown:empty-bucket -- --bucket <name> [--project <p>] --yes");
    return 2;
  }
  const { bucket, project, help } = parsed.args;
  if (help) {
    console.log(
      "Permanently deletes every object version in the given GCS bucket so that " +
        "'terraform destroy' can delete it. Requires --yes.",
    );
    return 0;
  }

  console.log(`Permanently deleting ALL object versions in gs://${bucket}${project ? ` (project ${project})` : ""}...`);
  const client = new GcsApiTeardownClient({ tokenProvider: gcloudAccessToken });
  const result = await emptyBucket(client, bucket, { onProgress: (m) => console.log(m) });
  console.log(`DONE: gs://${bucket} is empty (${result.deleted} object version(s) deleted, ${result.passes} pass(es)).`);
  console.log("You can now run: terraform -chdir=infra/terraform destroy");
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error("ERROR:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
