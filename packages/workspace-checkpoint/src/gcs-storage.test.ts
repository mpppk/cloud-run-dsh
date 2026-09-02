import { describe, test, expect } from "bun:test";
import { GcsCheckpointStorage } from "./gcs-storage.js";
import type { GcsClient } from "./gcs-storage.js";

class FakeGcsClient implements GcsClient {
  objects = new Map<string, Uint8Array>();
  uploadCalls: { key: string; size: number }[] = [];

  async getObject(_bucket: string, key: string): Promise<Uint8Array | null> {
    const v = this.objects.get(key);
    return v ? new Uint8Array(v) : null;
  }

  async uploadObject(_bucket: string, key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(data));
    this.uploadCalls.push({ key, size: data.length });
  }

  async objectExists(_bucket: string, key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

describe("GcsCheckpointStorage", () => {
  test("implements CheckpointStorage against injected GcsClient", async () => {
    const client = new FakeGcsClient();
    const storage = new GcsCheckpointStorage(client, "dsh-checkpoints");
    const key = "checkpoints/ws-1/bundle.json";
    const data = new TextEncoder().encode("bundle-bytes");

    expect(await storage.head(key)).toBe(false);
    expect(await storage.get(key)).toBeNull();

    await storage.put(key, data);
    expect(await storage.head(key)).toBe(true);
    expect(client.uploadCalls).toEqual([{ key, size: data.length }]);
    const got = await storage.get(key);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe("bundle-bytes");
  });

  test("get returns null for missing object", async () => {
    const storage = new GcsCheckpointStorage(new FakeGcsClient(), "dsh-checkpoints");
    expect(await storage.get("nope")).toBeNull();
    expect(await storage.head("nope")).toBe(false);
  });

  test("scopes operations to the configured bucket", async () => {
    const seenBuckets: string[] = [];
    const client: GcsClient = {
      async getObject(bucket) {
        seenBuckets.push(bucket);
        return null;
      },
      async uploadObject(bucket) {
        seenBuckets.push(bucket);
      },
      async objectExists(bucket) {
        seenBuckets.push(bucket);
        return false;
      },
    };
    const storage = new GcsCheckpointStorage(client, "expected-bucket");
    await storage.put("k", new Uint8Array([1]));
    await storage.get("k");
    await storage.head("k");
    expect(seenBuckets).toEqual(["expected-bucket", "expected-bucket", "expected-bucket"]);
  });
});
