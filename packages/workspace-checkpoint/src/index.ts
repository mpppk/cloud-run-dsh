export * from "./types.js";
export * from "./errors.js";
export * from "./exclusions.js";
export * from "./storage.js";
export * from "./dirty.js";
export * from "./bundle.js";
export * from "./restore.js";
export * from "./scheduler.js";
export * from "./tar.js";

// Re-export placeholder for backwards compat
export const PLACEHOLDER_KIND = "workspace-checkpoint" as const;
export function createPlaceholder() {
  return { kind: PLACEHOLDER_KIND };
}
