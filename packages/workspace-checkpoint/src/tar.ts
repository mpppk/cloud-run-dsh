/**
 * Minimal in-memory tar helpers using JSON encoding for testability.
 * Production would use real tar binary; these helpers are injectable and
 * allow deterministic unit tests without external binaries.
 */

export interface TarEntry {
  path: string;
  content: Uint8Array;
}

export function createUntrackedTar(entries: readonly TarEntry[]): Uint8Array {
  // Encode as JSON with base64 for binary safety; simple and deterministic.
  const obj: Record<string, string> = {};
  for (const e of entries) {
    obj[e.path] = Buffer.from(e.content).toString("base64");
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function extractUntrackedTar(data: Uint8Array): TarEntry[] {
  if (data.length === 0) return [];
  const text = new TextDecoder().decode(data);
  if (!text.trim()) return [];
  const obj = JSON.parse(text) as Record<string, string>;
  return Object.entries(obj).map(([path, b64]) => ({
    path,
    content: Uint8Array.from(Buffer.from(b64, "base64")),
  }));
}

// For real tar binary integration, provide helpers that shell out.
// These are not used in unit tests but document the production path.
export async function createTarWithCommand(
  files: readonly string[],
  cwd: string,
  run: (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<Uint8Array> {
  // Placeholder: in production, run `tar -cf - files` and capture stdout bytes.
  // For now, delegate to JSON tar via file reads (handled by bundle.ts).
  void files;
  void cwd;
  void run;
  return new Uint8Array(0);
}
