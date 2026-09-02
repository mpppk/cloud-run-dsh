import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("session-persistence-postgres", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("session-persistence-postgres");
    const p = createPlaceholder();
    expect(p.kind).toBe("session-persistence-postgres");
  });
});
