import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("dsh-subprocess-cloud-run", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("dsh-subprocess-cloud-run");
    const p = createPlaceholder();
    expect(p.kind).toBe("dsh-subprocess-cloud-run");
  });
});
