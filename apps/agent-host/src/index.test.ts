import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("agent-host", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("agent-host");
    const p = createPlaceholder();
    expect(p.kind).toBe("agent-host");
  });
});
