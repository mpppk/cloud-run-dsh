import { describe, expect, test } from "bun:test";
import {
  HarnessPathRefusedError,
  HarnessWriteRefusedError,
  createFakeHarnessComposition,
} from "./harness.js";

describe("fake harness composition", () => {
  test("observation policy is workspace-write on /workspace", () => {
    const harness = createFakeHarnessComposition("/workspace");
    expect(harness.observationPolicy.mode).toBe("workspace-write");
    expect(harness.observationPolicy.workspaceRoot).toBe("/workspace");
  });

  test("refuses write to /etc/test (outside the workspace root)", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    expect(harness.filesystem.write("/etc/test", new TextEncoder().encode("x"))).rejects.toThrow(
      HarnessPathRefusedError,
    );
  });

  test("refuses traversal escapes", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    await expect(
      harness.filesystem.write("../../etc/passwd", new Uint8Array(1)),
    ).rejects.toThrow(HarnessPathRefusedError);
    await expect(
      harness.filesystem.read("/workspace/../secrets.txt"),
    ).rejects.toThrow(HarnessPathRefusedError);
  });

  test("read-before-write on existing files (fs-observation-policy)", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    const data = new TextEncoder().encode("v1");
    await harness.filesystem.write("notes.txt", data); // new file: allowed
    // Existing file without a prior read must be refused (stale-write protection).
    await expect(harness.filesystem.write("notes.txt", data)).rejects.toThrow(
      HarnessWriteRefusedError,
    );
    const read = await harness.filesystem.read("notes.txt");
    expect(new TextDecoder().decode(read)).toBe("v1");
    await harness.filesystem.write("notes.txt", new TextEncoder().encode("v2"));
    const updated = await harness.filesystem.read("notes.txt");
    expect(new TextDecoder().decode(updated)).toBe("v2");
  });

  test("search matches workspace-relative paths", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    await harness.filesystem.write("src/a.txt", new TextEncoder().encode("needle here"));
    await harness.filesystem.write("src/b.txt", new TextEncoder().encode("nothing"));
    expect(await harness.search.search("needle")).toEqual(["src/a.txt"]);
  });

  test("restoreSessions records sessions", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    await harness.restoreSessions({
      sessions: [
        {
          id: "s1",
          workspaceId: "ws-1",
          metadata: {},
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      eventsBySession: {},
    });
    expect(harness.restoredSessions().map((s) => s.id)).toEqual(["s1"]);
  });
});
