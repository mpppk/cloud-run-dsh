export interface CheckpointManifest {
  readonly version: 1;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly patch: string;
  readonly untracked: string;
}

export interface CheckpointBundle {
  readonly manifest: CheckpointManifest;
  readonly patchDiff: string;
  readonly untrackedFiles: readonly string[];
  readonly untrackedTar: Uint8Array;
}

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export interface GitRunner {
  run(args: readonly string[], opts?: { cwd?: string }): Promise<GitResult>;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
}
