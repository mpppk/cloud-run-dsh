/**
 * GcsTeardownClient backed by the GCS JSON API (no extra npm dependency).
 * Auth comes from an injected token provider (the CLI wires
 * `gcloud auth print-access-token`); fetch is injectable for offline tests.
 */

import type { GcsObjectVersion, GcsTeardownClient, ListVersionsPage } from "./bucket-teardown.ts";

export interface GcsApiTeardownClientOptions {
  tokenProvider: () => Promise<string>;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

interface JsonListResponse {
  items?: Array<{ name?: string; generation?: string | number }>;
  nextPageToken?: string;
}

const DEFAULT_API_BASE = "https://storage.googleapis.com/storage/v1";

export class GcsApiTeardownClient implements GcsTeardownClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly opts: GcsApiTeardownClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  }

  async listObjectVersions(bucket: string, pageToken?: string): Promise<ListVersionsPage> {
    const url = new URL(`${this.apiBase}/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("versions", "true");
    url.searchParams.set("maxResults", "1000");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);

    const res = await this.fetchImpl(url, { headers: await this.headers() });
    // A missing bucket is equivalent to "already empty" for teardown.
    if (res.status === 404) return { items: [] };
    if (!res.ok) {
      throw new Error(`listing gs://${bucket} failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as JsonListResponse;
    const items: GcsObjectVersion[] = (body.items ?? [])
      .filter((it): it is { name: string; generation: string } =>
        typeof it.name === "string" && typeof it.generation === "string",
      )
      .map((it) => ({ name: it.name, generation: it.generation }));
    return { items, nextPageToken: body.nextPageToken };
  }

  async deleteObjectVersion(bucket: string, name: string, generation: string): Promise<void> {
    const url =
      `${this.apiBase}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}` +
      `?generation=${encodeURIComponent(generation)}`;
    const res = await this.fetchImpl(url, { method: "DELETE", headers: await this.headers() });
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `deleting gs://${bucket}/${name}#gen:${generation} failed: HTTP ${res.status} ${await res.text()}`,
      );
    }
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.opts.tokenProvider()}` };
  }
}
