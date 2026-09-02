import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("workspace-checkpoint", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("workspace-checkpoint");
    const p = createPlaceholder();
    expect(p.kind).toBe("workspace-checkpoint");
  });
});
