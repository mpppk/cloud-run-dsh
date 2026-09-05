// Every workspace package must be COPY'd into both container images.
//
// Why this test exists: the Dockerfiles list `COPY packages/<name>/package.json`
// one line at a time so the dependency-install layer stays cacheable. That list
// is hand-maintained, and on 2026-09-05 PR #105 added
// `packages/gcp-token-provider` without touching either Dockerfile. Nothing
// local caught it — `bunx tsc --build` was green, `bun test` was green (848
// pass), and review found nothing, because the package IS on disk locally. Only
// the container build failed, at the start of a live GCP bring-up:
//
//   error: workspace "@cloud-run-dsh/agent-host" depends on workspace
//   "@cloud-run-dsh/gcp-token-provider" (packages/gcp-token-provider), which is
//   listed in bun.lock but not on disk
//
// See issue #107. Adding a package and forgetting a Dockerfile now fails here
// instead of during a billed bring-up.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DOCKERFILES = ["apps/agent-host/Dockerfile", "apps/control-plane/Dockerfile"] as const;

function workspacePackages(): string[] {
  const dir = join(REPO_ROOT, "packages");
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => {
      try {
        return statSync(join(dir, name, "package.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function copiedPackages(dockerfile: string): string[] {
  const text = readFileSync(join(REPO_ROOT, dockerfile), "utf8");
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^COPY\s+packages\/([^/\s]+)\/package\.json\s/);
    if (m?.[1]) found.add(m[1]);
  }
  return [...found].sort();
}

describe("Dockerfiles COPY every workspace package", () => {
  const onDisk = workspacePackages();

  test("packages/ is non-empty (guards against a broken discovery)", () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  for (const dockerfile of DOCKERFILES) {
    test(`${dockerfile} copies exactly the packages on disk`, () => {
      const copied = copiedPackages(dockerfile);
      const missing = onDisk.filter((p) => !copied.includes(p));
      const extra = copied.filter((p) => !onDisk.includes(p));
      // Reported as arrays so a failure names the offending package instead of
      // saying "expected 10 to be 9".
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });
  }
});
