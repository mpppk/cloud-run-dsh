export interface CheckpointStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<boolean>;
}

export class InMemoryCheckpointStorage implements CheckpointStorage {
  private store = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    // copy to avoid external mutation
    this.store.set(key, new Uint8Array(data));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.store.get(key);
    return v ? new Uint8Array(v) : null;
  }

  async head(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  // helpers for tests
  keys(): string[] {
    return [...this.store.keys()];
  }

  clear(): void {
    this.store.clear();
  }
}
