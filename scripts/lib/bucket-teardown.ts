/**
 * Core "empty a versioned GCS bucket until terraform destroy can succeed"
 * logic, network-free: all Google calls go through the injected
 * GcsTeardownClient so unit tests run against fakes.
 *
 * Why this exists: `google_storage_bucket.checkpoints` has object versioning
 * enabled, and `terraform destroy` cannot delete a bucket that still contains
 * objects (live OR archived versions). Skipping this step means `destroy`
 * fails and the project KEEPS BILLING. See docs/cost.md#teardown.
 */

export interface GcsObjectVersion {
  name: string;
  generation: string;
}

export interface ListVersionsPage {
  items: GcsObjectVersion[];
  nextPageToken?: string;
}

export interface GcsTeardownClient {
  /** Lists every object version (live + archived) in the bucket, paged. */
  listObjectVersions(bucket: string, pageToken?: string): Promise<ListVersionsPage>;
  /** Permanently deletes one object version. */
  deleteObjectVersion(bucket: string, name: string, generation: string): Promise<void>;
}

export interface EmptyBucketResult {
  bucket: string;
  /** Total object versions permanently deleted. */
  deleted: number;
  /** Listing passes; >1 means deletions exposed more versions (unlikely, defensive). */
  passes: number;
}

export class BucketNotEmptyError extends Error {
  constructor(
    public readonly bucket: string,
    public readonly remaining: number,
  ) {
    super(
      `bucket "${bucket}" still has ${remaining} object version(s) after emptying — ` +
        `terraform destroy WILL FAIL and billing continues`,
    );
    this.name = "BucketNotEmptyError";
  }
}

export const DEFAULT_MAX_PASSES = 5;

/**
 * Deletes every object version in the bucket, re-listing until the bucket is
 * verifiably empty. Deletion is IRREVERSIBLE for all listed versions.
 */
export async function emptyBucket(
  client: GcsTeardownClient,
  bucket: string,
  opts: { maxPasses?: number; onProgress?: (msg: string) => void } = {},
): Promise<EmptyBucketResult> {
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;
  const log = opts.onProgress ?? (() => {});
  let deleted = 0;
  let pass = 0;

  while (pass < maxPasses) {
    pass += 1;
    let remaining: GcsObjectVersion[] = [];
    let pageToken: string | undefined;
    do {
      const page = await client.listObjectVersions(bucket, pageToken);
      remaining = remaining.concat(page.items);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    if (remaining.length === 0) {
      return { bucket, deleted, passes: pass };
    }

    log(`pass ${pass}: deleting ${remaining.length} object version(s) from gs://${bucket}`);
    for (const v of remaining) {
      await client.deleteObjectVersion(bucket, v.name, v.generation);
      deleted += 1;
    }
  }

  throw new BucketNotEmptyError(bucket, (await countVersions(client, bucket)));
}

async function countVersions(client: GcsTeardownClient, bucket: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const page = await client.listObjectVersions(bucket, pageToken);
    count += page.items.length;
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return count;
}
