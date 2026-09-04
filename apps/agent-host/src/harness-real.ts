// Real DeepSeek Harness filesystem composition (仕様書 section 6.2, 実装手順書 section 10).
//
// This assembles the published @deepseek-ai Harness packages behind the
// `HarnessComposition` adapter defined in harness.ts (cordis plugin mounting):
//
//   - @deepseek-ai/dsh-session-projection  (ctx.sessionProjections — required
//       by the sandbox policy's per-session mode-override fold)
//   - @deepseek-ai/dsh-system-prompt       (ctx.systemPrompt — the tool
//       plugins register their guidance sections here)
//   - @deepseek-ai/dsh-tools               (ctx.tools — the tool registry the
//       model-facing tool plugins register into)
//   - @deepseek-ai/dsh-sandbox-policy      (ctx.sandboxPolicy — the shared
//       policy home; mounted with mode `workspace-write` and
//       workspaceRoot=<workspaceRoot> per 仕様書 section 6.2)
//   - @deepseek-ai/dsh-fs-sandbox          (ctx.fs — the sandbox-enforcing
//       filesystem backend over dsh-fs-local: writes contained to the
//       workspace root + platform temp areas under workspace-write, atomic
//       publication, version guards)
//   - @deepseek-ai/dsh-fs-observation-policy (the read-before-write /
//       stale-write event policy over fs/write-intent + fs/observed)
//   - @deepseek-ai/dsh-tool-fs             (the model-facing read/write/edit
//       tools — the composition's write seam routes through the REAL write
//       tool, so per-call sandbox policy resolution, the observation-policy
//       intent, the containment fence, and fs/observed bookkeeping are the
//       published packages' code, not a reimplementation)
//   - @deepseek-ai/dsh-tool-fs-search      (the model-facing glob/grep tools
//       over the packaged ripgrep binary — the search seam calls the REAL
//       grep tool)
//   - a local SubprocessRuntime (harness-subprocess.ts) as ctx.subprocess,
//       which tool-fs-search spawns the packaged ripgrep binary through.
//
// Adapter behavior notes (the `HarnessComposition` surface is unchanged):
//   - `filesystem.write` executes the real `write` tool with a fabricated
//     ToolRunContext whose agent session carries the workspace root. A denial
//     (FS_SANDBOX_DENIED — target outside the workspace root and platform
//     temp areas, traversal escape) surfaces as HarnessPathRefusedError;
//     read-before-write (FS_NOT_OBSERVED) and stale-write (FS_STALE_VERSION)
//     refusals surface as HarnessWriteRefusedError — the same error semantics
//     the fake composition exposes.
//   - `filesystem.read` mirrors the real read tool's observation semantics
//     (resolve → stat → fs/observed present/absent → read) and returns raw
//     bytes via the provider's readBytes. Like the adapter contract, reads
//     are confined to the workspace root at the adapter boundary; the Harness
//     fs-sandbox fence itself only confines MUTATIONS (by design, reads pass
//     through in every mode).
//   - The filesystem seam is UTF-8-text-oriented (the real write tool takes
//     string content); binary payloads are decoded with replacement
//     characters on write.
//   - `search.search` takes a ripgrep regular expression (the fake took a
//     literal substring) and returns workspace-relative paths.

import { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import { apply as applyFsObservationPolicy } from "@deepseek-ai/dsh-fs-observation-policy";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import {
  apply as applyToolFs,
  Config as ToolFsConfig,
  inject as toolFsInject,
} from "@deepseek-ai/dsh-tool-fs";
import {
  apply as applyToolFsSearch,
  Config as ToolFsSearchConfig,
  inject as toolFsSearchInject,
} from "@deepseek-ai/dsh-tool-fs-search";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { Session } from "@cloud-run-dsh/session-persistence-postgres";
import { AgentHostLocalSubprocessRuntime } from "./harness-subprocess.js";
import type {
  HarnessComposition,
  HarnessFilesystem,
  HarnessObservationPolicy,
  HarnessSearchTool,
  HarnessSessionRestoreInput,
} from "./harness.js";
import { HarnessPathRefusedError, HarnessWriteRefusedError } from "./harness.js";
import { resolveInsideWorkspace } from "./paths.js";

/**
 * The actor identity the adapter fabricates for direct tool calls. The real
 * packages only read `agent.session` (header.cwd for per-session workspace
 * resolution, object identity as the observation-policy state owner) and
 * `signal`, so a minimal stable object satisfies the seam.
 */
interface AdapterActorSession {
  readonly id: string;
  readonly seq: number;
  readonly header: { readonly cwd: string };
  readonly inheritedEventCount: number;
  snapshotEvents(): readonly never[];
}

export class RealHarnessCompositionError extends Error {
  readonly name = "RealHarnessCompositionError";
}

function mapFsError(error: unknown, path: string, workspaceRoot: string): unknown {
  if (!(error instanceof FsError)) return error;
  switch (error.code) {
    case "FS_SANDBOX_DENIED":
      // workspace-write containment refused the target (outside the workspace
      // root and platform temp areas, traversal escape, read-only, …).
      return new HarnessPathRefusedError(path, workspaceRoot, error.message);
    case "FS_NOT_FOUND":
      return new HarnessPathRefusedError(path, workspaceRoot, "file not found");
    case "FS_NOT_OBSERVED":
    case "FS_STALE_VERSION":
      return new HarnessWriteRefusedError(path, error.message);
    default:
      return error;
  }
}

/**
 * Mount the filesystem/search base plugins on `ctx` (issue #21 shared with
 * the agent-turn composition in turn.ts): sessionProjections, systemPrompt,
 * tools, sandboxPolicy, fs, fs-observation-policy, subprocess, tool-fs,
 * tool-fs-search. Service mounting order follows the inject chains (see
 * createHarnessComposition).
 */
export async function mountHarnessBasePlugins(
  ctx: Context,
  workspaceRoot: string,
): Promise<void> {
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, SystemPrompt.Config({ includeHarnessIdentity: false }));
  await ctx.plugin(ToolRuntime, { mode: "native" });
  await ctx.plugin(
    SandboxPolicyService,
    SandboxPolicyService.Config({ mode: "workspace-write", workspaceRoot }),
  );
  await ctx.plugin(SandboxedFileSystem, SandboxedFileSystem.Config({ cwd: workspaceRoot }));
  await ctx.plugin(applyFsObservationPolicy);
  await ctx.plugin(AgentHostLocalSubprocessRuntime);
  // Function plugins export their config schema and service inject list
  // separately (the Loader applies both; direct cordis mounting does not), so
  // re-declare them here and resolve the config defaults via the schema.
  await ctx.plugin({ inject: toolFsInject, apply: applyToolFs }, ToolFsConfig({}));
  await ctx.plugin(
    { inject: toolFsSearchInject, apply: applyToolFsSearch },
    ToolFsSearchConfig({ sampleOverCapGlobResults: false }),
  );
}

/**
 * Assemble the real DeepSeek Harness composition behind the
 * `HarnessComposition` adapter. Mounting is asynchronous (cordis plugin
 * settlement), so this returns a promise; the production entrypoint awaits it
 * in `createProductionDependencies` before composing the host.
 * @param workspaceRoot - the `workspace-write` workspace root (production: /workspace).
 */
export async function createHarnessComposition(
  workspaceRoot: string = "/workspace",
): Promise<HarnessComposition> {
  const ctx = new Context();

  // Service mounting order follows the inject chains: sessionProjections ←
  // sandboxPolicy; systemPrompt ← tools ← tool-fs / tool-fs-search; and
  // sandboxPolicy ← ctx.fs (SandboxedFileSystem).
  await mountHarnessBasePlugins(ctx, workspaceRoot);

  const fs = ctx.get("fs");
  if (fs === undefined) {
    throw new RealHarnessCompositionError("harness filesystem service did not mount");
  }
  const writeTool: ToolDefinition | undefined = ctx.tools.get("write");
  const grepTool: ToolDefinition | undefined = ctx.tools.get("grep");
  if (writeTool === undefined) {
    throw new RealHarnessCompositionError("harness write tool did not register");
  }
  if (grepTool === undefined) {
    throw new RealHarnessCompositionError("harness grep tool did not register");
  }

  // One stable actor object for the composition's lifetime: the observation
  // policy keys its per-owner observed-file state off `actor.agent.session`,
  // so read-before-write and stale-write protection are scoped to this
  // composition, and the sandbox policy resolves this session's cwd as the
  // per-call workspace root.
  const actorSession: AdapterActorSession = {
    id: "agent-host-harness-adapter",
    seq: 0,
    header: { cwd: workspaceRoot },
    inheritedEventCount: 0,
    snapshotEvents: () => [],
  };
  let callCounter = 0;
  const newExec = (): ToolRunContext => {
    callCounter += 1;
    return {
      callId: `agent-host-adapter-${callCounter}`,
      name: "agent-host-adapter",
      arguments: {},
      signal: new AbortController().signal,
      agent: { session: actorSession },
      deferContext: () => {
        throw new RealHarnessCompositionError("the adapter execution context cannot defer context");
      },
      concludeTurn: () => {
        throw new RealHarnessCompositionError("the adapter execution context cannot conclude a turn");
      },
    } as unknown as ToolRunContext;
  };
  const actorOf = (): object => ({ agent: { session: actorSession } });

  const writtenPayloads: { path: string; data: Uint8Array }[] = [];
  const restored: Session[] = [];

  const observationPolicy: HarnessObservationPolicy = {
    mode: "workspace-write",
    workspaceRoot,
  };

  const filesystem: HarnessFilesystem = {
    async read(path: string): Promise<Uint8Array> {
      // Adapter-level read confinement (HarnessPathRefusedError on escapes);
      // the Harness fs-sandbox fence itself only confines mutations.
      let contained: string;
      try {
        contained = resolveInsideWorkspace(workspaceRoot, path);
      } catch (error) {
        throw new HarnessPathRefusedError(
          path,
          workspaceRoot,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        const target = await fs.resolve(contained, { cwd: workspaceRoot });
        const info = await fs.stat(target);
        if (info === undefined) {
          ctx.emit("fs/observed", target, { kind: "absent" }, actorOf());
          throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
        }
        if (info.type !== "file") {
          throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
        }
        const bytes = await fs.readBytes(target, undefined, READ_MAX_BYTES);
        // Mirror the read tool: record the present observation so a subsequent
        // write satisfies the observation policy's replaceIfVersion guard.
        ctx.emit("fs/observed", target, { kind: "present", version: info.version }, actorOf());
        return bytes;
      } catch (error) {
        throw mapFsError(error, path, workspaceRoot);
      }
    },
    async write(path: string, data: Uint8Array): Promise<void> {
      const content = new TextDecoder("utf-8").decode(data);
      try {
        // The REAL model-facing write tool: per-call sandbox policy resolution,
        // observation-policy intent (createIfAbsent / replaceIfVersion), the
        // fs-sandbox containment fence, atomic publication, and fs/observed.
        await writeTool.execute?.({ file_path: path, content }, newExec());
      } catch (error) {
        throw mapFsError(error, path, workspaceRoot);
      } finally {
        writtenPayloads.push({ path, data });
      }
    },
    async exists(path: string): Promise<boolean> {
      let contained: string;
      try {
        contained = resolveInsideWorkspace(workspaceRoot, path);
      } catch (error) {
        throw new HarnessPathRefusedError(
          path,
          workspaceRoot,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        const target = await fs.resolve(contained, { cwd: workspaceRoot });
        const info = await fs.stat(target);
        return info !== undefined && info.type === "file";
      } catch {
        return false;
      }
    },
  };

  const search: HarnessSearchTool = {
    async search(query: string): Promise<readonly string[]> {
      // The REAL model-facing grep tool: fixed ripgrep --json argv through the
      // subprocess seam, workdir-relative result display. `query` is a ripgrep
      // regular expression.
      const result = (await grepTool.execute?.(
        { pattern: query, path: workspaceRoot },
        newExec(),
      )) as { matches: readonly { path: string }[] };
      return result.matches.map((match) => match.path);
    },
  };

  return {
    filesystem,
    observationPolicy,
    search,
    async restoreSessions(input: HarnessSessionRestoreInput) {
      restored.push(...input.sessions);
    },
    restoredSessions: () => [...restored],
    writtenPayloads: () => writtenPayloads.map((w) => ({ ...w })),
  };
}

/** Upper bound for one adapter read (the seam serves whole files, bounded defensively). */
const READ_MAX_BYTES = 16 * 1024 * 1024;
