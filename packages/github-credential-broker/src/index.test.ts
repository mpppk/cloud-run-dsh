import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("github-credential-broker", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("github-credential-broker");
    const p = createPlaceholder();
    expect(p.kind).toBe("github-credential-broker");
  });
});
