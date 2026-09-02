export const EXCLUDED_PREFIXES = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  ".cache/",
  ".git/",
] as const;

export const EXCLUDED_EXACT = new Set([".git"]);

export function isExcluded(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  // Exact match for .git
  if (normalized === ".git" || normalized.startsWith(".git/")) return true;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function filterExcluded(files: readonly string[]): string[] {
  return files.filter((f) => !isExcluded(f));
}
