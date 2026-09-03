// Security tests — the REAL DeepSeek Harness composition (harness-real.ts,
// assembled from the published @deepseek-ai packages at 0.1.2-rc.1).
//
// The sibling tests in this directory drive the harness adapter through fakes;
// these tests prove the same security-refusal contract against the real
// composition mounted in production (実装手順書 section 10: fs-sandbox +
// fs-observation-policy + tool-fs + tool-fs-search, workspace-write on
// /workspace):
//   - writes outside the workspace root are refused by the real fs-sandbox
//     containment fence (FS_SANDBOX_DENIED → HarnessPathRefusedError),
//   - pre-existing files cannot be overwritten without a prior read and
//     stale writes are refused by the real fs-observation-policy
//     (FS_NOT_OBSERVED / FS_STALE_VERSION → HarnessWriteRefusedError),
//   - the composition exposes only the adapter seams (no secret accessor).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  HarnessPathRefusedError,
  HarnessWriteRefusedError,
} from "../../apps/agent-host/src/harness.js";
import { createHarnessComposition } from "../../apps/agent-host/src/harness-real.js";

describe("SECURITY (real composition): model-driven writes outside /workspace are refused", () => {
  test("harness filesystem refuses write to /etc/test", async () => {
    const harness = await createHarnessComposition("/workspace");
    await expect(
      harness.filesystem.write("/etc/test", new TextEncoder().encode("pwned")),
    ).rejects.toThrow(HarnessPathRefusedError);
    // The refusal is the real fs-sandbox fence (FS_SANDBOX_DENIED); the
    // adapter's exists() seam is also workspace-confined, so an escape attempt
    // throws rather than reporting a path outside the root.
    await expect(harness.filesystem.exists("/etc/test")).rejects.toThrow();
  });

  test("harness filesystem refuses traversal escapes", async () => {
    const harness = await createHarnessComposition("/workspace");
    await expect(
      harness.filesystem.write("../../etc/test", new TextEncoder().encode("pwned")),
    ).rejects.toThrow(HarnessPathRefusedError);
    await expect(
      harness.filesystem.write("/workspace/../../../etc/test", new Uint8Array(1)),
    ).rejects.toThrow(HarnessPathRefusedError);
  });

  test("harness filesystem refuses read outside the workspace root (adapter read fence)", async () => {
    const harness = await createHarnessComposition("/workspace");
    await expect(
      harness.filesystem.read("/etc/hostname"),
    ).rejects.toThrow(HarnessPathRefusedError);
    await expect(
      harness.filesystem.read("/workspace/../../../etc/hostname"),
    ).rejects.toThrow(HarnessPathRefusedError);
  });

  test("read-before-write: a pre-existing file is not overwritten without a prior read", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-sec-real-"));
    const harness = await createHarnessComposition(workspaceRoot);
    writeFileSync(join(workspaceRoot, "existing.txt"), "seed");
    await expect(
      harness.filesystem.write("existing.txt", new TextEncoder().encode("pwned")),
    ).rejects.toThrow(HarnessWriteRefusedError);
    expect(readFileSync(join(workspaceRoot, "existing.txt"), "utf8")).toBe("seed");
    // After the harness owner reads the file, the mutation is allowed.
    await harness.filesystem.read("existing.txt");
    await harness.filesystem.write("existing.txt", new TextEncoder().encode("updated"));
    expect(readFileSync(join(workspaceRoot, "existing.txt"), "utf8")).toBe("updated");
  });

  test("stale-write: a file changed since the last observation is refused", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-sec-real-"));
    const harness = await createHarnessComposition(workspaceRoot);
    const path = join(workspaceRoot, "watched.txt");
    await harness.filesystem.write("watched.txt", new TextEncoder().encode("v1"));
    writeFileSync(path, "externally modified");
    await expect(
      harness.filesystem.write("watched.txt", new TextEncoder().encode("clobber")),
    ).rejects.toThrow(HarnessWriteRefusedError);
    expect(readFileSync(path, "utf8")).toBe("externally modified");
  });

  test("the composition exposes only the adapter seams — no secret accessor", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "dsh-sec-real-"));
    const harness = await createHarnessComposition(workspaceRoot);
    expect(Object.keys(harness).sort()).toEqual([
      "filesystem",
      "observationPolicy",
      "restoreSessions",
      "restoredSessions",
      "search",
      "writtenPayloads",
    ]);
  });
});
