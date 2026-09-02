import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("workspace-runtime", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("workspace-runtime");
    const p = createPlaceholder();
    expect(p.kind).toBe("workspace-runtime");
  });
});
