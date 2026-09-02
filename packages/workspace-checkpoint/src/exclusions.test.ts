import { describe, test, expect } from "bun:test";
import { isExcluded, filterExcluded } from "./exclusions.js";

describe("exclusions", () => {
  test("excludes node_modules prefix", () => {
    expect(isExcluded("node_modules/foo/bar.js")).toBe(true);
    expect(isExcluded("node_modules/.bin/tsc")).toBe(true);
    expect(isExcluded("node_modules")).toBe(true);
  });

  test("excludes .next, dist, build, coverage, .cache, .git", () => {
    expect(isExcluded(".next/cache/file")).toBe(true);
    expect(isExcluded("dist/index.js")).toBe(true);
    expect(isExcluded("build/output.js")).toBe(true);
    expect(isExcluded("coverage/lcov.info")).toBe(true);
    expect(isExcluded(".cache/file")).toBe(true);
    expect(isExcluded(".git/objects/abc")).toBe(true);
    expect(isExcluded(".git")).toBe(true);
  });

  test("does not exclude normal files", () => {
    expect(isExcluded("src/index.ts")).toBe(false);
    expect(isExcluded("README.md")).toBe(false);
    expect(isExcluded("apps/control-plane/main.ts")).toBe(false);
  });

  test("filterExcluded filters correctly", () => {
    const files = ["src/a.ts", "node_modules/b.js", ".next/c", "dist/d.js", "normal.txt"];
    expect(filterExcluded(files)).toEqual(["src/a.ts", "normal.txt"]);
  });
});
