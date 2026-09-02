import type { CheckpointStorage } from "./storage.js";

/**
 * Minimal GCS client surface used by GcsCheckpointStorage.
 * Network calls are injected so tests stay offline; a production
 * implementation wraps e.g. @google-cloud/storage or the JSON API.
 */
export interface GcsClient {
  /** Returns the object body or null when the object does not exist. */
  getObject(bucket: string, key: string): Promise<Uint8Array | null>;
  uploadObject(bucket: string, key: string, data: Uint8Array): Promise<void>;
  objectExists(bucket: string, key: string): Promise<boolean>;
}

/**
 * Thin GCS-backed CheckpointStorage adapter: delegates to an injected
 * GcsClient for a fixed bucket (仕様書 section 7: Cloud Storage に
 * uncommitted workspace checkpoint を保存).
 */
export class GcsCheckpointStorage implements CheckpointStorage {
  constructor(
    private readonly client: GcsClient,
    private readonly bucket: string,
  ) {}

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.client.uploadObject(this.bucket, key, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.client.getObject(this.bucket, key);
  }

  async head(key: string): Promise<boolean> {
    return this.client.objectExists(this.bucket, key);
  }
}
