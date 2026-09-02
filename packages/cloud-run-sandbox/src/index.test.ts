import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("cloud-run-sandbox", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("cloud-run-sandbox");
    const p = createPlaceholder();
    expect(p.kind).toBe("cloud-run-sandbox");
  });
});
