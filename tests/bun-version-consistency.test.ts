import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #83: the container Bun version drifted from the local/CI version
// because the Dockerfiles used the floating `oven/bun:1` tag while
// `.bun-version` pinned local/CI. The Dockerfiles now declare
// `ARG BUN_VERSION=<x.y.z>` whose default must match `.bun-version`.
// This test fails the suite if they drift, so the next upgrade cannot
// fix one side and forget the other.
const root = join(import.meta.dir, "..");
const expected = readFileSync(join(root, ".bun-version"), "utf8").trim();

const dockerfiles = [
  "apps/agent-host/Dockerfile",
  "apps/control-plane/Dockerfile",
];

describe("bun version consistency (issue #83)", () => {
  test(".bun-version is a pinned x.y.z release", () => {
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const rel of dockerfiles) {
    test(`${rel} pins BUN_VERSION to .bun-version (${expected})`, () => {
      const content = readFileSync(join(root, rel), "utf8");
      const match = content.match(/^ARG BUN_VERSION=(\S+)\s*$/m);
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe(expected);
    });

    test(`${rel} has no floating oven/bun tags`, () => {
      const content = readFileSync(join(root, rel), "utf8");
      // Every FROM must reference the pinned ARG (full or -slim variant).
      const fromLines = content
        .split("\n")
        .filter((line) => line.startsWith("FROM oven/bun"));
      expect(fromLines.length).toBeGreaterThan(0);
      for (const line of fromLines) {
        expect(line).toMatch(/^FROM oven\/bun:\$\{BUN_VERSION\}(-slim)? AS \w+$/);
      }
    });
  }
});
