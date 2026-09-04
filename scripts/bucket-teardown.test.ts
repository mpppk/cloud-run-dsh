import { describe, expect, test } from "bun:test";

import { BucketNotEmptyError, emptyBucket, type GcsTeardownClient, type ListVersionsPage } from "./lib/bucket-teardown.ts";
import { GcsApiTeardownClient } from "./lib/gcs-api-teardown-client.ts";
import { parseCliArgs } from "./empty-checkpoint-bucket.ts";

class FakeGcsClient implements GcsTeardownClient {
  /** bucket -> list of [name, generation]; deletions pop from the list. */
  versions: Map<string, Array<[string, string]>> = new Map();
  deleteCalls: Array<{ bucket: string; name: string; generation: string }> = [];
  failDeletesFor = new Set<string>();
  listCalls = 0;

  async listObjectVersions(bucket: string, pageToken?: string): Promise<ListVersionsPage> {
    this.listCalls += 1;
    const all = this.versions.get(bucket) ?? [];
    // Simulate server-side paging of 2 items per page.
    const start = pageToken === undefined ? 0 : Number(pageToken);
    const items = all.slice(start, start + 2).map(([name, generation]) => ({ name, generation }));
    const next = start + 2 < all.length ? String(start + 2) : undefined;
    return { items, nextPageToken: next };
  }

  async deleteObjectVersion(bucket: string, name: string, generation: string): Promise<void> {
    if (this.failDeletesFor.has(name)) throw new Error(`simulated delete failure for ${name}`);
    const all = this.versions.get(bucket) ?? [];
    const idx = all.findIndex(([n, g]) => n === name && g === generation);
    if (idx >= 0) all.splice(idx, 1);
    this.deleteCalls.push({ bucket, name, generation });
  }
}

describe("emptyBucket", () => {
  test("deletes every version across pages and reports a verifiably empty bucket", async () => {
    const client = new FakeGcsClient();
    client.versions.set(
      "bkt",
      Array.from({ length: 5 }, (_, i) => [`cp/${i}.tar.gz`, String(1000 + i)]),
    );
    const messages: string[] = [];
    const result = await emptyBucket(client, "bkt", { onProgress: (m) => messages.push(m) });
    expect(result).toEqual({ bucket: "bkt", deleted: 5, passes: 2 });
    expect(client.deleteCalls).toHaveLength(5);
    expect(client.deleteCalls[0]).toEqual({ bucket: "bkt", name: "cp/0.tar.gz", generation: "1000" });
    // final listing must observe zero remaining versions
    expect((await client.listObjectVersions("bkt")).items).toHaveLength(0);
    expect(messages[0]).toContain("5 object version(s)");
  });

  test("is a no-op when the bucket is already empty (destroy-safe)", async () => {
    const client = new FakeGcsClient();
    const result = await emptyBucket(client, "empty-bkt");
    expect(result).toEqual({ bucket: "empty-bkt", deleted: 0, passes: 1 });
    expect(client.deleteCalls).toHaveLength(0);
  });

  test("does a second pass when deletions expose more versions", async () => {
    const client = new FakeGcsClient();
    client.versions.set("bkt", [["a", "1"]]);
    // every pass re-populates one new version once, then stops
    let repopulated = false;
    const origDelete = client.deleteObjectVersion.bind(client);
    client.deleteObjectVersion = async (b, n, g) => {
      await origDelete(b, n, g);
      if (!repopulated) {
        repopulated = true;
        client.versions.get(b)!.push(["a", "2"]);
      }
    };
    const result = await emptyBucket(client, "bkt");
    // pass 1 deletes v1 (fake repopulates), pass 2 deletes v2, pass 3 confirms empty
    expect(result.passes).toBe(3);
    expect(result.deleted).toBe(2);
  });

  test("throws BucketNotEmptyError when versions survive maxPasses", async () => {
    const client = new FakeGcsClient();
    client.versions.set("bkt", [["immortal", "1"]]);
    const origDelete = client.deleteObjectVersion.bind(client);
    client.deleteObjectVersion = async (b, n, g) => {
      await origDelete(b, n, g);
      client.versions.get(b)!.push([n, String(Number(g) + 1)]);
    };
    let err: unknown;
    try {
      await emptyBucket(client, "bkt", { maxPasses: 2 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BucketNotEmptyError);
    expect((err as BucketNotEmptyError).remaining).toBe(1);
  });

  test("propagates delete failures", async () => {
    const client = new FakeGcsClient();
    client.versions.set("bkt", [["boom", "7"]]);
    client.failDeletesFor.add("boom");
    let err: unknown;
    try {
      await emptyBucket(client, "bkt");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("simulated delete failure");
  });
});

describe("GcsApiTeardownClient", () => {
  const makeFetch = (routes: (url: URL, init?: RequestInit) => { status: number; body?: unknown }) => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const r = routes(url, init);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  test("lists versions paged via versions=true and deletes with generation", async () => {
    const pages: Record<string, unknown> = {
      "": { items: [{ name: "a", generation: "11" }, { name: "b/c", generation: "22" }], nextPageToken: "T2" },
      T2: { items: [{ name: "d", generation: "33" }] },
    };
    const { calls, fetchImpl } = makeFetch((url) => {
      const token = url.searchParams.get("pageToken") ?? "";
      return { status: 200, body: pages[token] };
    });
    const tokens: string[] = [];
    const client = new GcsApiTeardownClient({
      tokenProvider: async () => {
        tokens.push("tok");
        return "tok";
      },
      fetchImpl,
    });

    const page1 = await client.listObjectVersions("bkt");
    expect(page1.items).toEqual([
      { name: "a", generation: "11" },
      { name: "b/c", generation: "22" },
    ]);
    expect(page1.nextPageToken).toBe("T2");
    expect(calls[0].url.searchParams.get("versions")).toBe("true");
    expect(calls[0].url.pathname).toBe("/storage/v1/b/bkt/o");

    const page2 = await client.listObjectVersions("bkt", "T2");
    expect(page2.items).toEqual([{ name: "d", generation: "33" }]);

    await client.deleteObjectVersion("bkt", "b/c", "22");
    const del = calls[calls.length - 1];
    expect(del.init?.method).toBe("DELETE");
    expect(del.url.pathname).toBe("/storage/v1/b/bkt/o/b%2Fc");
    expect(del.url.searchParams.get("generation")).toBe("22");
    expect(del.init?.headers).toEqual({ Authorization: "Bearer tok" });
  });

  test("treats 404 on list as an already-empty (nonexistent) bucket", async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, body: { error: { code: 404 } } }));
    const client = new GcsApiTeardownClient({ tokenProvider: async () => "tok", fetchImpl });
    expect(await client.listObjectVersions("missing")).toEqual({ items: [] });
  });

  test("ignores 404 on delete (already gone) but throws on other errors", async () => {
    let status = 500;
    const { fetchImpl } = makeFetch(() => ({ status, body: { error: { code: status } } }));
    const client = new GcsApiTeardownClient({ tokenProvider: async () => "tok", fetchImpl });
    status = 404;
    await client.deleteObjectVersion("bkt", "a", "1"); // must not throw
    status = 500;
    let err: unknown;
    try {
      await client.deleteObjectVersion("bkt", "a", "1");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("HTTP 500");
  });
});

describe("parseCliArgs", () => {
  test("refuses without --yes", () => {
    const r = parseCliArgs(["--bucket", "bkt"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--yes");
  });

  test("refuses without --bucket", () => {
    const r = parseCliArgs(["--yes"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--bucket");
  });

  test("accepts --bucket + --yes (space and = forms), optional --project", () => {
    expect(parseCliArgs(["--bucket", "bkt", "--yes"])).toEqual({
      ok: true,
      args: { bucket: "bkt", project: undefined, yes: true, help: false },
    });
    expect(parseCliArgs(["--bucket=bkt", "--project=p", "--yes"]).ok).toBe(true);
  });

  test("rejects unknown arguments", () => {
    expect(parseCliArgs(["--bucket", "bkt", "--yes", "--force"]).ok).toBe(false);
  });

  test("--help short-circuits validation", () => {
    const r = parseCliArgs(["--help"]);
    expect(r.ok).toBe(true);
  });
});
