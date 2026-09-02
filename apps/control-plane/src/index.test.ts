import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("control-plane", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("control-plane");
    const p = createPlaceholder();
    expect(p.kind).toBe("control-plane");
  });
});
