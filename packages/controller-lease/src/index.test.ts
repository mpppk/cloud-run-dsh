import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("controller-lease", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("controller-lease");
    const p = createPlaceholder();
    expect(p.kind).toBe("controller-lease");
  });
});
