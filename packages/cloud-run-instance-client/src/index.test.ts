import { describe, test, expect } from "bun:test";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

describe("cloud-run-instance-client", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("cloud-run-instance-client");
    const p = createPlaceholder();
    expect(p.kind).toBe("cloud-run-instance-client");
  });
});
