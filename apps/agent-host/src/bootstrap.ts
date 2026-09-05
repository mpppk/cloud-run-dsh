// Workspace bootstrap (実装手順書 section 19):
//   mkdir /workspace -> obtain installation token -> git clone ->
//   base SHA checkout -> checkpoint restore -> discard token.
//
// The GitHub installation token lives in memory only, is passed to git via
// `http.extraheader` (never embedded in a remote URL, never written to disk),
// and is discarded when the restore step ends — including on failure paths
// via `discardToken()` from the recovery orchestrator.

import {
  deserializeBundle,
  restoreWorkspace,
} from "@cloud-run-dsh/workspace-checkpoint";
import type {
  CheckpointBundle,
  CheckpointStorage,
  Clock,
  FileSystem,
  GitRunner,
} from "@cloud-run-dsh/workspace-checkpoint";
import {
  assertNoTokenInValue,
  buildSafeRemoteUrl,
  createGitHubCredentialBroker,
} from "@cloud-run-dsh/github-credential-broker";
import type {
  Repository,
  TemporaryToken,
} from "@cloud-run-dsh/github-credential-broker";
import { BootstrapError } from "./errors.js";

/** Broker surface including the token-scoped git helpers (T7). */
export type CredentialBroker = ReturnType<typeof createGitHubCredentialBroker>;

export interface WorkspaceBootstrapperOptions {
  readonly workspaceId: string;
  readonly workspaceDir: string;
  readonly repository: Repository;
  readonly baseBranch: string;
  readonly checkpointKey: string;
  readonly broker: CredentialBroker;
  readonly storage: CheckpointStorage;
  readonly git: GitRunner;
  readonly fs: FileSystem;
}

export class WorkspaceBootstrapper {
  private token: TemporaryToken | null = null;

  constructor(private readonly options: WorkspaceBootstrapperOptions) {}

  /** True when no installation token is currently held in memory. */
  get isTokenDiscarded(): boolean {
    return this.token === null;
  }

  /** Step 1-3: mkdir /workspace -> installation token -> git clone. */
  async cloneRepository(): Promise<void> {
    await this.options.fs.mkdir(this.options.workspaceDir);

    const token = await this.options.broker.getInstallationToken(this.options.repository);
    this.token = token;

    // The remote URL never embeds the token (仕様書 section 18).
    const remoteUrl = buildSafeRemoteUrl(this.options.repository);
    assertNoTokenInValue(remoteUrl, token.token);

    const result = await this.options.git.run([
      ...this.options.broker.gitAuthArgs(token.token),
      "clone",
      "--branch",
      this.options.baseBranch,
      remoteUrl,
      this.options.workspaceDir,
    ]);
    if (result.exitCode !== 0) {
      throw new BootstrapError(`git clone failed: ${result.stderr}`);
    }
  }

  /** Step 4: base SHA checkout — the SHA comes from the checkpoint manifest. */
  async checkoutBase(): Promise<void> {
    const bundle = await this.loadBundle();
    if (!bundle) {
      return; // fresh workspace without a checkpoint — restore step skips too
    }
    const result = await this.options.git.run(
      ["checkout", bundle.manifest.baseCommit],
      { cwd: this.options.workspaceDir },
    );
    if (result.exitCode !== 0) {
      throw new BootstrapError(`git checkout failed: ${result.stderr}`);
    }
  }

  /** Step 5: checkpoint restore (download + apply + untracked restore). */
  async restoreCheckpoint(): Promise<void> {
    try {
      const bundle = await this.loadBundle();
      if (!bundle) {
        return; // fresh workspace: nothing to restore
      }
      await restoreWorkspace({
        workspaceDir: this.options.workspaceDir,
        checkpointKey: this.options.checkpointKey,
        storage: this.options.storage,
        git: this.options.git,
        fs: this.options.fs,
      });
    } finally {
      // 実装手順書 section 19: checkout完了後tokenを破棄する。
      this.discardToken();
    }
  }

  /** Drops the installation token from host memory. Idempotent. */
  discardToken(): void {
    this.token = null;
  }

  private async loadBundle(): Promise<CheckpointBundle | null> {
    if (!(await this.options.storage.head(this.options.checkpointKey))) {
      return null;
    }
    const data = await this.options.storage.get(this.options.checkpointKey);
    if (!data) return null;
    return deserializeBundle(data);
  }
}

// ---------------------------------------------------------------------------
// Checkpoint coordination (T5 composition)
// ---------------------------------------------------------------------------

export interface CheckpointCoordinatorOptions {
  readonly workspaceDir: string;
  readonly checkpointKey: string;
  readonly storage: CheckpointStorage;
  readonly git: GitRunner;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly dirtyThresholdMs?: number;
  /**
   * Called after a checkpoint bundle is durably stored (issue #95 案A).
   * The production composition records the generation in the
   * `workspace_checkpoints` index (base commit + GCS object key) here.
   * A throwing callback fails create(): the snapshot exists in GCS but is
   * not indexed, which must stay loud — the lifecycle path turns it into
   * CHECKPOINT_FAILED (stop aborts) and the periodic path retries.
   */
  readonly onCheckpointCreated?: (info: {
    readonly baseCommitSha: string;
    readonly gcsObject: string;
  }) => Promise<void>;
}

/**
 * Composes the T5 checkpoint package for the host: creates bundles from
 * /workspace and exposes the periodic/lifecycle scheduler.
 */
export class CheckpointCoordinator {
  readonly dirtyThresholdMs: number;

  constructor(private readonly options: CheckpointCoordinatorOptions) {
    this.dirtyThresholdMs = options.dirtyThresholdMs ?? 120_000;
  }

  /**
   * Creates a checkpoint bundle of the current workspace and uploads it,
   * then records the generation in the checkpoint index (issue #95).
   *
   * Ordering is deliberate: GCS first, index second. A crash between the
   * two leaves an unindexed object that restore still finds via the
   * `workspaces/<id>/checkpoint.bin` key convention; the reverse order
   * would leave an index row pointing at an object that was never written.
   */
  async create(): Promise<{ baseCommit: string }> {
    const { createCheckpointBundle, serializeBundle } = await import(
      "@cloud-run-dsh/workspace-checkpoint"
    );
    const head = await this.options.git.run(["rev-parse", "HEAD"], {
      cwd: this.options.workspaceDir,
    });
    if (head.exitCode !== 0) {
      throw new BootstrapError(`git rev-parse HEAD failed: ${head.stderr}`);
    }
    const baseCommit = head.stdout.trim();
    const bundle = await createCheckpointBundle({
      workspaceDir: this.options.workspaceDir,
      baseCommit,
      git: this.options.git,
      fs: this.options.fs,
      clock: this.options.clock,
    });
    await this.options.storage.put(
      this.options.checkpointKey,
      serializeBundle(bundle),
    );
    await this.options.onCheckpointCreated?.({
      baseCommitSha: baseCommit,
      gcsObject: this.options.checkpointKey,
    });
    return { baseCommit };
  }
}
