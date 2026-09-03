// Control Plane configuration — parsed from environment at the composition root only.
//
// The control plane is a stateless HTTP service on Cloud Run: it needs the
// Postgres connection string (Cloud SQL in production) and the PORT that
// Cloud Run injects. Everything else is composed in main.ts.

export const DEFAULT_PORT = 8080;

const REQUIRED_ENV_KEYS = ["DATABASE_URL"] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

export class MissingRequiredEnvError extends Error {
  readonly name = "MissingRequiredEnvError";
  constructor(public readonly missing: readonly string[]) {
    super(`missing required environment variables: ${missing.join(", ")}`);
  }
}

export interface ControlPlaneConfig {
  /** Cloud Run injects PORT; defaults to 8080 for local container runs. */
  readonly port: number;
  /** Cloud SQL (production) / docker compose Postgres (local) connection string. */
  readonly databaseUrl: string;
}

export function readControlPlaneConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ControlPlaneConfig {
  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new MissingRequiredEnvError(missing);
  }

  const portRaw = env["PORT"]?.trim();
  const port = portRaw === undefined || portRaw === "" ? DEFAULT_PORT : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }

  return {
    port,
    databaseUrl: env["DATABASE_URL"]!.trim(),
  };
}
