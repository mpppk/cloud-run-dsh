// Typed API errors -> JSON error responses (仕様書 section 24, 実装手順書 section 24)
// Responses never include stack traces or secrets.

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "bad_gateway"
  | "unavailable"
  | "internal";

export class ApiError extends Error {
  // Typed as `string` so subclasses can carry their own name.
  readonly name: string = "ApiError";

  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}

export function unauthorized(message = "authentication required"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function forbidden(message = "forbidden"): ApiError {
  return new ApiError(403, "forbidden", message);
}

export function notFound(message = "not found"): ApiError {
  return new ApiError(404, "not_found", message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "conflict", message);
}

/**
 * 502: an upstream the request depends on (the workspace's agent-host
 * Instance) failed. The response message must stay actionable without
 * leaking upstream internals — details go to the structured log.
 */
export function badGateway(message: string): ApiError {
  return new ApiError(502, "bad_gateway", message);
}

/** 500 responses are generic — no internals leak (仕様書 section 26 item 7). */
export function internalError(): ApiError {
  return new ApiError(500, "internal", "internal server error");
}

/** 503: the service is up but a capability is unavailable (e.g. runtime not wired). */
export function unavailable(message: string): ApiError {
  return new ApiError(503, "unavailable", message);
}
