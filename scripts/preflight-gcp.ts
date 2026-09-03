/**
 * GCP deployment preflight (read-only).
 *
 * Checks prerequisites for docs/deployment-runbook.md WITHOUT creating,
 * modifying or deleting anything:
 *   1. gcloud / terraform / docker present, with versions
 *   2. gcloud authenticated
 *   3. a project configured + billing enabled
 *   4. the 11 APIs the Terraform baseline enables
 *   5. caller permissions (via read-only probes against each service)
 *   6. infra/terraform fmt/validate
 *
 * Degrades gracefully: when a check is impossible (unauthenticated, daemon
 * down, SDK component missing) it reports "CANNOT CHECK" with the reason
 * instead of crashing. Exits non-zero when any check FAILS.
 *
 * Only local side effect: `terraform init -backend=false` writes .terraform/
 * inside infra/terraform/ (providers download; no cloud calls).
 *
 * Usage: bun run preflight:gcp
 */

import { spawnSync } from "node:child_process";

type Status = "pass" | "fail" | "cannot-check";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): RunOutput {
  try {
    const p = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 120_000,
      windowsHide: true,
    });
    return {
      code: p.status ?? (p.error ? -1 : 1),
      stdout: (p.stdout ?? "").toString(),
      stderr: (p.stderr ?? "").toString(),
    };
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

const AUTH_MISSING = /not authenticated|gcloud auth login|no credentialed accounts|reauth|invalid_grant|credentials?( were| not| expired)|access not configured/i;
const COMPONENT_MISSING = /component.*requires the installation|component.*not installed|You do not currently have this command group/i;

function classify(err: string): { status: Status; detail: string } {
  const trimmed = err.trim().split("\n").slice(0, 3).join(" / ").slice(0, 300);
  if (AUTH_MISSING.test(err)) {
    return { status: "cannot-check", detail: `cannot check (gcloud not authenticated): ${trimmed}` };
  }
  if (COMPONENT_MISSING.test(err)) {
    return { status: "cannot-check", detail: `cannot check (SDK component missing): ${trimmed}` };
  }
  return { status: "fail", detail: trimmed || "command failed" };
}

const MARKS: Record<Status, string> = { pass: "PASS", fail: "FAIL", "cannot-check": "SKIP" };

const results: CheckResult[] = [];
function report(name: string, status: Status, detail: string): CheckResult {
  const r: CheckResult = { name, status, detail };
  results.push(r);
  return r;
}

// ---------------------------------------------------------------- 1. tools

function checkTool(name: string, versionArgs: string[], parseVersion?: (out: string) => string): void {
  const which = run("which", [name]);
  if (which.code !== 0 || which.stdout.trim() === "") {
    report(`tool: ${name}`, "fail", `${name} is not installed / not on PATH. Install it before following the runbook.`);
    return;
  }
  const v = run(name, versionArgs);
  if (v.code !== 0) {
    report(`tool: ${name}`, "cannot-check", `present at ${which.stdout.trim()} but version call failed: ${(v.stderr || v.stdout).trim().slice(0, 200)}`);
    return;
  }
  const version = parseVersion ? parseVersion(v.stdout) : v.stdout.trim().split("\n")[0] ?? "";
  report(`tool: ${name}`, "pass", `${version} (${which.stdout.trim()})`);
}

// terraform version prints a two-line banner ("Terraform v1.16.0", "on darwin_arm64")
function parseTerraformVersion(out: string): string {
  return out.trim().split("\n")[0] ?? "";
}

// ------------------------------------------------------------- 2-6. gcloud

const REQUIRED_APIS = [
  "cloudresourcemanager.googleapis.com",
  "iam.googleapis.com",
  "run.googleapis.com",
  "sqladmin.googleapis.com",
  "secretmanager.googleapis.com",
  "artifactregistry.googleapis.com",
  "storage.googleapis.com",
  "iap.googleapis.com",
  "logging.googleapis.com",
  "monitoring.googleapis.com",
  "servicenetworking.googleapis.com",
];

interface AuthListEntry {
  account: string;
  status: string;
}

function gcloudAuthCheck(): void {
  const r = run("gcloud", ["auth", "list", "--format=json"]);
  if (r.code !== 0) {
    const c = classify(r.stderr || r.stdout);
    report("gcloud: authenticated", c.status === "cannot-check" ? "fail" : "fail",
      c.status === "cannot-check"
        ? `gcloud is NOT authenticated (this is the expected state on a fresh machine). Fix: gcloud auth login && gcloud auth application-default login`
        : c.detail);
    return;
  }
  let accounts: AuthListEntry[] = [];
  try {
    accounts = JSON.parse(r.stdout) as AuthListEntry[];
  } catch {
    report("gcloud: authenticated", "cannot-check", "could not parse `gcloud auth list` output");
    return;
  }
  const active = accounts.filter((a) => a.status === "ACTIVE");
  if (active.length === 0) {
    report("gcloud: authenticated", "fail", `no ACTIVE account. Fix: gcloud auth login && gcloud auth application-default login`);
    return;
  }
  report("gcloud: authenticated", "pass", `active: ${active.map((a) => a.account).join(", ")}`);
}

function getConfiguredProject(): string | null {
  const r = run("gcloud", ["config", "get-value", "core/project"]);
  const value = r.stdout.trim();
  return r.code === 0 && value !== "" && value !== "(unset)" ? value : null;
}

function checkBilling(project: string): void {
  const r = run("gcloud", ["beta", "billing", "projects", "describe", project, "--format=json"], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    const c = classify(r.stderr || r.stdout);
    report("billing: enabled", c.status, c.detail);
    return;
  }
  try {
    const info = JSON.parse(r.stdout) as { billingEnabled?: boolean; billingAccountName?: string };
    if (info.billingEnabled) {
      report("billing: enabled", "pass", `linked to ${info.billingAccountName ?? "billing account"}`);
    } else {
      report("billing: enabled", "fail",
        `project ${project} has billing DISABLED. Fix: gcloud billing projects link ${project} --billing-account=<ID>`);
    }
  } catch {
    report("billing: enabled", "cannot-check", "could not parse billing describe output");
  }
}

function checkApis(project: string): void {
  const r = run("gcloud", ["services", "list", "--enabled", "--project", project, "--format=json"]);
  if (r.code !== 0) {
    const c = classify(r.stderr || r.stdout);
    report("apis: enabled", c.status, c.detail);
    return;
  }
  let enabled: string[];
  try {
    enabled = (JSON.parse(r.stdout) as Array<{ config?: { name?: string } }>).map((s) => s.config?.name ?? "");
  } catch {
    report("apis: enabled", "cannot-check", "could not parse services list output");
    return;
  }
  const missing = REQUIRED_APIS.filter((api) => !enabled.includes(api));
  if (missing.length === 0) {
    report("apis: enabled", "pass", `all ${REQUIRED_APIS.length} required APIs enabled`);
  } else {
    report("apis: enabled", "fail",
      `missing ${missing.length}/${REQUIRED_APIS.length}: ${missing.join(", ")}. Fix: they are normally enabled by terraform apply (apis.tf); enable manually with gcloud services enable <api>`);
  }
}

interface Probe {
  name: string;
  permissionHint: string;
  args: string[];
}

function checkPermissions(project: string): void {
  const probes: Probe[] = [
    { name: "SQL (cloudsql.instances.list)", permissionHint: "roles/cloudsql.viewer+", args: ["sql", "instances", "list", "--project", project, "--limit", "1"] },
    { name: "Artifact Registry (repositories list)", permissionHint: "roles/artifactregistry.reader+", args: ["artifacts", "repositories", "list", "--project", project] },
    { name: "Secret Manager (secrets list)", permissionHint: "roles/secretmanager.viewer+", args: ["secrets", "list", "--project", project, "--limit", "1"] },
    { name: "Cloud Run (services list)", permissionHint: "roles/run.viewer+", args: ["run", "services", "list", "--project", project] },
    { name: "Cloud Storage (buckets list)", permissionHint: "roles/storage.admin / storage.buckets.list", args: ["storage", "ls", "--project", project] },
  ];
  for (const probe of probes) {
    const r = run("gcloud", [...probe.args, "--quiet"], { timeoutMs: 30_000 });
    if (r.code === 0) {
      report(`permissions: ${probe.name}`, "pass", "read probe succeeded");
      continue;
    }
    const err = r.stderr || r.stdout;
    const c = classify(err);
    if (c.status === "cannot-check") {
      report(`permissions: ${probe.name}`, "cannot-check", c.detail);
    } else if (/permission|denied|forbidden|403|has not been used|disabled/i.test(err)) {
      const apiDisabled = /has not been used|disabled/i.test(err);
      report(`permissions: ${probe.name}`, "fail",
        `${apiDisabled ? "API disabled or " : ""}probe denied — check ${probe.permissionHint}: ${c.detail}`);
    } else {
      report(`permissions: ${probe.name}`, "fail", c.detail);
    }
  }
}

// ---------------------------------------------------------------- terraform

function checkTerraform(): void {
  const tfDir = "infra/terraform";
  const fmt = run("terraform", [`-chdir=${tfDir}`, "fmt", "-check", "-recursive"]);
  if (fmt.code !== 0) {
    report("terraform: fmt", "fail",
      `formatting differs from terraform fmt. Fix: terraform -chdir=${tfDir} fmt -recursive\n${(fmt.stdout || fmt.stderr).trim().slice(0, 400)}`);
  } else {
    report("terraform: fmt", "pass", "all files formatted");
  }

  // validate needs providers; init them locally only (-backend=false → no remote state, no cloud calls)
  const providersDir = `${tfDir}/.terraform/providers`;
  let initOut: RunOutput | null = null;
  const ls = run("ls", [providersDir]);
  if (ls.code !== 0) {
    initOut = run("terraform", [`-chdir=${tfDir}`, "init", "-backend=false", "-input=false", "-no-color"], { timeoutMs: 300_000 });
    if (initOut.code !== 0) {
      report("terraform: validate", "cannot-check",
        `could not init providers locally (offline?): ${(initOut.stderr || initOut.stdout).trim().split("\n").slice(-3).join(" / ").slice(0, 300)}`);
      return;
    }
  }
  const validate = run("terraform", [`-chdir=${tfDir}`, "validate", "-no-color"]);
  if (validate.code !== 0) {
    report("terraform: validate", "fail", (validate.stderr || validate.stdout).trim().slice(0, 600));
  } else {
    report("terraform: validate", "pass", initOut ? "valid (after local init -backend=false)" : "valid");
  }
}

// -------------------------------------------------------------------- main

function main(): void {
  console.log("== GCP deployment preflight (READ-ONLY) ==");
  console.log("Probes nothing that mutates. Local-only side effect: terraform init -backend=false downloads providers into infra/terraform/.terraform/.\n");

  checkTool("gcloud", ["version"], (out) => (out.trim().split("\n")[0] ?? "").trim());
  checkTool("terraform", ["version"], parseTerraformVersion);
  checkTool("docker", ["version", "--format", "{{.Server.Version}}"], (out) => `docker daemon ${out.trim()}`);

  const dockerServerOk = results[results.length - 1];
  if (dockerServerOk?.name === "tool: docker" && dockerServerOk.status === "cannot-check") {
    console.error("(docker daemon unreachable — image build/push steps of the runbook cannot be checked, CLI presence only)\n");
  }

  gcloudAuthCheck();
  const authOk = results[results.length - 1]?.status === "pass";

  const project = getConfiguredProject();
  let haveProject = false;
  if (project !== null) {
    report("gcloud: project configured", authOk ? "pass" : "cannot-check", authOk ? project : `${project} (auth state unverified above)`);
    haveProject = authOk;
  } else {
    report("gcloud: project configured", "fail",
      `no project configured${authOk ? "" : " (also unauthenticated)"} — fix auth first, then: gcloud config set project <PROJECT_ID>`);
  }

  if (authOk && haveProject && project !== null) {
    checkBilling(project);
    checkApis(project);
    checkPermissions(project);
  } else {
    for (const name of ["billing: enabled", "apis: enabled"] as const) {
      report(name, "cannot-check", "requires an authenticated gcloud and a configured project");
    }
    report("permissions: service probes", "cannot-check",
      "requires an authenticated gcloud and a configured project — re-run after `gcloud auth login && gcloud config set project <ID>`");
  }

  checkTerraform();

  console.log("\n== Results ==");
  for (const r of results) {
    console.log(`[${MARKS[r.status]}] ${r.name} — ${r.detail}`);
  }
  const fails = results.filter((r) => r.status === "fail");
  const skips = results.filter((r) => r.status === "cannot-check");
  console.log(`\n${results.length} checks: ${results.length - fails.length - skips.length} pass, ${fails.length} fail, ${skips.length} cannot-check`);
  if (fails.length > 0) {
    console.error("\nActionable failures:");
    for (const f of fails) console.error(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Preflight OK — you can follow docs/deployment-runbook.md from Step 1.");
  }
  if (skips.length > 0) {
    console.error("\nCannot-check items (degraded, not failures): re-run in an authenticated environment to cover them.");
  }
}

main();
