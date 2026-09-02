import type { GitRunner } from "./types.js";

export async function isDirty(git: GitRunner, cwd: string): Promise<boolean> {
  const result = await git.run(["status", "--porcelain"], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }
  return result.stdout.trim().length > 0;
}

export async function isDirtyFromPorcelain(output: string): Promise<boolean> {
  return output.trim().length > 0;
}
