// Request validation helpers — typed 400 errors for every route
// (実装手順書 section 24: request validation responsibility).

import { badRequest } from "./errors.js";

export interface JsonBody {
  readonly [key: string]: unknown;
}

/** Parses a JSON body, rejecting missing/invalid payloads with 400. */
export async function parseJsonBody(request: Request): Promise<JsonBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw badRequest("content-type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("request body must be a JSON object");
  }
  return parsed as JsonBody;
}

/** Parses an optional JSON body: absent/empty bodies are treated as `{}`. */
export async function parseOptionalJsonBody(request: Request): Promise<JsonBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if ((await request.text()).trim() === "") return {};
    throw badRequest("content-type must be application/json");
  }
  return parseJsonBody(request);
}

export function requireString(body: JsonBody, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`field '${field}' must be a non-empty string`);
  }
  return value;
}

export function optionalString(body: JsonBody, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`field '${field}' must be a non-empty string when present`);
  }
  return value;
}

export function optionalObject(
  body: JsonBody,
  field: string,
): Record<string, unknown> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`field '${field}' must be an object when present`);
  }
  return value as Record<string, unknown>;
}

/** Requires a non-empty path segment value. */
export function requireSegment(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw badRequest(`path parameter '${name}' is required`);
  }
  return value;
}
