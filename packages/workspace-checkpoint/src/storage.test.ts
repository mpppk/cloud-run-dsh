import { describe, test, expect } from "bun:test";
import { InMemoryCheckpointStorage } from "./storage.js";

describe("CheckpointStorage InMemory", () => {
  test("put/get/head", async () => {
    const storage = new InMemoryCheckpointStorage();
    const key = "checkpoints/ws-1/bundle.json";
    const data = new TextEncoder().encode("hello");

    expect(await storage.head(key)).toBe(false);
    expect(await storage.get(key)).toBeNull();

    await storage.put(key, data);
    expect(await storage.head(key)).toBe(true);
    const got = await storage.get(key);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe("hello");
  });

  test("put is copy-on-write", async () => {
    const storage = new InMemoryCheckpointStorage();
    const data = new Uint8Array([1, 2, 3]);
    await storage.put("k", data);
    data[0] = 99;
    const got = await storage.get("k");
    expect(got![0]).toBe(1);
  });

  test("get returns copy", async () => {
    const storage = new InMemoryCheckpointStorage();
    await storage.put("k", new Uint8Array([1, 2]));
    const a = await storage.get("k");
    a![0] = 99;
    const b = await storage.get("k");
    expect(b![0]).toBe(1);
  });

  test("multiple keys isolated", async () => {
    const storage = new InMemoryCheckpointStorage();
    await storage.put("a", new TextEncoder().encode("a"));
    await storage.put("b", new TextEncoder().encode("b"));
    expect(new TextDecoder().decode((await storage.get("a"))!)).toBe("a");
    expect(new TextDecoder().decode((await storage.get("b"))!)).toBe("b");
  });
});
