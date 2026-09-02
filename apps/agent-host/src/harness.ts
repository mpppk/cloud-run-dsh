// Harness filesystem composition (仕様書 section 6.2, 実装手順書 section 10).
//
// TODO(harness): the real composition must assemble the DeepSeek Harness
// packages `fs-sandbox` + `fs-observation-policy` + `tool-fs` + `tool-fs-search`
// with permission mode `workspace-write` and `workspaceRoot=/workspace` behind
// the HarnessComposition adapter below. The DeepSeek Harness package is NOT
// installable in this environment, so the composition is defined behind this
// thin adapter interface and `createFakeHarnessComposition` provides a fake
// implementation for tests. The fake mirrors the required semantics:
//   - model-facing write/edit outside the workspace root is REFUSED
//     (fs-sandbox workspace-write mode),
//   - read-before-write and stale-write protection
//     (fs-observation-policy),
//   - model-facing filesystem + search tools (tool-fs / tool-fs-search).
// When the Harness package becomes installable, swap the fake for the real
// composition without touching the adapter surface.

import type {
  NewSessionEvent,
  Session,
  SessionEvent,
} from "@cloud-run-dsh/session-persistence-postgres";
import { resolveInsideWorkspace } from "./paths.js";

export interface HarnessObservationPolicy {
  readonly mode: "workspace-write";
  readonly workspaceRoot: string;
}

export interface HarnessFilesystem {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface HarnessSearchTool {
  /** tool-fs-search seam: returns workspace-relative paths whose content matches. */
  search(query: string): Promise<readonly string[]>;
}

export interface HarnessSessionRestoreInput {
  readonly sessions: readonly Session[];
  readonly eventsBySession: Readonly<Record<string, readonly SessionEvent[]>>;
}

export interface HarnessComposition {
  readonly filesystem: HarnessFilesystem;
  readonly observationPolicy: HarnessObservationPolicy;
  readonly search: HarnessSearchTool;
  /** Restore persisted harness session metadata + event log (実装手順書 sections 23/30). */
  restoreSessions(input: HarnessSessionRestoreInput): Promise<void>;
  /** Test/inspection surface: sessions restored so far. */
  restoredSessions(): readonly HarnessSessionRestoreInput["sessions"][number][];
  /** Test/inspection surface: every payload ever handed to the filesystem. */
  writtenPayloads(): readonly { readonly path: string; readonly data: Uint8Array }[];
}

export class HarnessPathRefusedError extends Error {
  readonly name = "HarnessPathRefusedError";
  constructor(
    public readonly path: string,
    public readonly workspaceRoot: string,
    reason: string,
  ) {
    super(`harness filesystem refused ${path}: ${reason} (workspaceRoot=${workspaceRoot})`);
  }
}

export class HarnessWriteRefusedError extends Error {
  readonly name = "HarnessWriteRefusedError";
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`harness filesystem refused write to ${path}: ${reason}`);
  }
}

export function createFakeHarnessComposition(
  workspaceRoot: string = "/workspace",
): HarnessComposition {
  const files = new Map<string, Uint8Array>();
  const readPaths = new Set<string>();
  const writes: { path: string; data: Uint8Array }[] = [];
  const restored: Session[] = [];

  const filesystem: HarnessFilesystem = {
    async read(path) {
      let resolved: string;
      try {
        resolved = resolveInsideWorkspace(workspaceRoot, path);
      } catch (e) {
        throw new HarnessPathRefusedError(
          path,
          workspaceRoot,
          e instanceof Error ? e.message : String(e),
        );
      }
      const data = files.get(resolved);
      if (!data) throw new HarnessPathRefusedError(path, workspaceRoot, "file not found");
      readPaths.add(resolved);
      return data;
    },
    async write(path, data) {
      let resolved: string;
      try {
        resolved = resolveInsideWorkspace(workspaceRoot, path);
      } catch (e) {
        throw new HarnessPathRefusedError(
          path,
          workspaceRoot,
          e instanceof Error ? e.message : String(e),
        );
      }
      const exists = files.has(resolved);
      if (exists && !readPaths.has(resolved)) {
        // fs-observation-policy: read-before-write on existing files.
        throw new HarnessWriteRefusedError(path, "existing file must be read before write");
      }
      files.set(resolved, data);
      writes.push({ path: resolved, data });
    },
    async exists(path) {
      return files.has(resolveInsideWorkspace(workspaceRoot, path));
    },
  };

  const search: HarnessSearchTool = {
    async search(query) {
      const prefix = workspaceRoot === "/" ? "/" : `${workspaceRoot}/`;
      const results: string[] = [];
      for (const [path, data] of files) {
        if (new TextDecoder().decode(data).includes(query)) {
          results.push(path.startsWith(prefix) ? path.slice(prefix.length) : path);
        }
      }
      return results;
    },
  };

  return {
    filesystem,
    observationPolicy: { mode: "workspace-write", workspaceRoot },
    search,
    async restoreSessions(input) {
      restored.push(...input.sessions);
    },
    restoredSessions: () => [...restored],
    writtenPayloads: () => writes.map((w) => ({ ...w })),
  };
}

/** Re-exported so callers can type session restore payloads without importing internals. */
export type { NewSessionEvent };
