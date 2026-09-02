import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("observability", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("observability");
    const p = createPlaceholder();
    expect(p.kind).toBe("observability");
  });
});
