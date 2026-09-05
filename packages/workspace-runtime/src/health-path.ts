// Agent-host externally-pollable health path (issue #68).
//
// THE PATH MUST NOT BE "/healthz". Cloud Run's frontend reserves the exact
// path "/healthz" (no trailing slash, case-sensitive): on GCP (2026-09-05,
// measured against the control-plane service with identical service/token
// and only the path varied) `GET /healthz` answered 404 text/html from
// Google's own error page and NEVER reached the container, while /readyz,
// /healthz/, /Healthz, /healthzz and every other path reached it (401 behind
// invoker IAM, as expected). The container's TCP startup probe is unaffected
// (different path into the container), which is why boot looked fine while
// the control-plane health poll could never succeed.
//
// DO NOT "simplify" this back to "/healthz" — health checks are /healthz by
// convention, and that convention is exactly what silently broke workspace
// open on Cloud Run (control-plane polled 30x and gave up on a healthy
// host). If this constant ever reads "/healthz" again, the open flow is
// broken by construction.
//
// Why "/readyz":
//   1. Proven reachable through the same Cloud Run frontend (the
//      control-plane's own GET /readyz returned 200 in the same measurement).
//   2. Semantically correct: the agent-host reports READY only after restart
//      recovery (clone + checkout + checkpoint restore) completes, i.e. this
//      is readiness, not liveness — matching the k8s /readyz convention.
//   3. Shared vocabulary: both services already speak /readyz, so no new
//      bespoke path to remember.
//
// Single source of truth: the agent-host gateway serves this path and the
// control-plane health poll builds `${instanceUrl}${AGENT_HOST_HEALTH_PATH}`.
// Both import it from here (the one workspace package both apps already
// depend on) so changing one side without the other is a compile-time shape
// mismatch, not a silent GCP-only outage. The cross-side equality is pinned
// by tests on both sides (agent-host gateway.test.ts, control-plane
// runtime-factory.test.ts, issue #68).

/** Externally-pollable agent-host health path. Never "/healthz" (see above). */
export const AGENT_HOST_HEALTH_PATH = "/readyz" as const;
