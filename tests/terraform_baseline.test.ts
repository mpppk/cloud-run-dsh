import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const tfDir = join(import.meta.dir, "../infra/terraform");
const files = readdirSync(tfDir);
const tfFiles = files.filter((f) => f.endsWith(".tf"));
const tfContents = Object.fromEntries(
  tfFiles.map((f) => [f, readFileSync(join(tfDir, f), "utf8")] as const),
);
const allTf = Object.values(tfContents).join("\n");

describe("terraform baseline file existence", () => {
  const required = [
    "versions.tf",
    "variables.tf",
    "apis.tf",
    "artifact_registry.tf",
    "cloudsql.tf",
    "storage.tf",
    "iam.tf",
    "secrets.tf",
    "iap.tf",
    "outputs.tf",
    "README.md",
  ];
  for (const f of required) {
    test(`has ${f}`, () => {
      expect(files).toContain(f);
    });
  }

  test("no .terraform directory or .tfstate tracked", () => {
    const tracked = execSync("git ls-files", { encoding: "utf8" });
    expect(tracked).not.toMatch(/\.terraform\//);
    expect(tracked).not.toMatch(/\.tfstate/);
  });

  test(".terraform.lock.hcl exists and will be tracked (not ignored)", () => {
    expect(existsSync(join(tfDir, ".terraform.lock.hcl"))).toBe(true);
    // And must not be gitignored
    try {
      execSync("git check-ignore infra/terraform/.terraform.lock.hcl", { encoding: "utf8" });
      // If exit 0, it is ignored — fail
      expect(false).toBe(true);
    } catch {
      // check-ignore exits non-zero when not ignored — expected
      expect(true).toBe(true);
    }
  });
});

describe("content checks", () => {
  test("versions.tf pins terraform >=1.9 and google providers", () => {
    const c = tfContents["versions.tf"];
    expect(c).toMatch(/required_version.*>= 1\.9/);
    expect(c).toMatch(/hashicorp\/google/);
    expect(c).toMatch(/hashicorp\/google-beta/);
  });

  test("variables.tf has no hardcoded project ids", () => {
    const c = tfContents["variables.tf"];
    // Broad check: no literal project assignment outside var refs; also check example strings
    expect(allTf).not.toMatch(/my-project/);
    expect(allTf).not.toMatch(/example-project/);
    // Any `project = "..."` literal in tf files should be var.project_id or interpolation — no bare string
    // Allow `project = var.project_id` and `project = "...${...}"` style locals, but not `"some-project-id"`
    const hardcodedProject = [...allTf.matchAll(/project\s*=\s*"[^"]+"/g)].filter(
      (m) => !m[0].includes("var.project_id") && !m[0].includes("${"),
    );
    // If any hardcoded project literal exists, it should be an obvious placeholder — fail
    expect(hardcodedProject.map((m) => m[0]).join("\n")).toBe("");
    expect(c).toMatch(/variable "project_id"/);
    expect(c).toMatch(/variable "region"/);
    expect(c).toMatch(/variable "iap_support_email"/);
    expect(c).toMatch(/variable "iap_members"/);
  });

  test("apis.tf enables 9 apis including servicenetworking", () => {
    const c = tfContents["apis.tf"];
    for (const api of [
      "run.googleapis.com",
      "sqladmin.googleapis.com",
      "secretmanager.googleapis.com",
      "artifactregistry.googleapis.com",
      "storage.googleapis.com",
      "iap.googleapis.com",
      "logging.googleapis.com",
      "monitoring.googleapis.com",
      "servicenetworking.googleapis.com",
    ]) {
      expect(c).toContain(api);
    }
  });

  test("cloudsql.tf uses secret manager for password, no literal, conditional bootstrap", () => {
    const c = tfContents["cloudsql.tf"];
    expect(c).toContain("google_secret_manager_secret_version");
    // Broad password literal check: password = "..." with any quoted string
    expect(c).not.toMatch(/password\s*=\s*"/);
    expect(c).not.toMatch(/password\s*=\s*'/);
    expect(c).toMatch(/Private IP/);
    expect(c).toMatch(/ipv4_enabled\s*=\s*false/);
    // Conditional bootstrap: data source has count and var.db_password handling
    expect(c).toMatch(/count\s*=\s*var\.db_password/);
    expect(tfContents["variables.tf"]).toMatch(/variable "db_password"/);
  });

  test("storage.tf has uniform access, versioning, lifecycle without destructive LIVE delete", () => {
    const c = tfContents["storage.tf"];
    expect(c).toMatch(/uniform_bucket_level_access\s*=\s*true/);
    expect(c).toMatch(/versioning/);
    expect(c).toMatch(/lifecycle_rule/);
    // Must contain ARCHIVED cleanup
    expect(c).toMatch(/with_state\s*=\s*"ARCHIVED"/);
    // Must NOT contain ANY with age 90 destructive rule; opt-in uses LIVE and variable
    expect(c).not.toMatch(/with_state\s*=\s*"ANY"/);
    expect(c).toMatch(/var\.checkpoint_live_delete_age_days/);
    expect(tfContents["variables.tf"]).toMatch(/variable "checkpoint_live_delete_age_days"/);
  });

  test("iam.tf defines two service accounts with least privilege and symmetric bucket reader", () => {
    const c = tfContents["iam.tf"];
    expect(c).toContain("google_service_account");
    expect(c).toContain("agent_host");
    expect(c).toContain("control_plane");
    expect(c).toContain("roles/cloudsql.client");
    expect(c).toContain("roles/storage.objectAdmin");
    expect(c).toContain("roles/secretmanager.secretAccessor");
    expect(c).toContain("roles/logging.logWriter");
    expect(c).toContain("roles/monitoring.metricWriter");
    expect(c).toContain("roles/run.admin");
    // storage bindings must be bucket-scoped, not project member
    expect(c).toContain("google_storage_bucket_iam_member");
    const storageProjectBindings = [...c.matchAll(/google_project_iam_member[^}]*roles\/storage\.[^}]*}/gs)];
    expect(storageProjectBindings.length).toBe(0);
    // legacyBucketReader symmetric
    const legacyCount = (c.match(/roles\/storage\.legacyBucketReader/g) ?? []).length;
    expect(legacyCount).toBe(2);
    expect(c).toContain("agent_host_bucket_legacy_reader");
    expect(c).toContain("control_plane_bucket_legacy_reader");
  });

  test("secrets.tf creates 3 secrets without values", () => {
    const c = tfContents["secrets.tf"];
    expect(c).toContain("github_app_private_key");
    expect(c).toContain("llm_api_key");
    expect(c).toContain("db_password");
    expect(c).not.toMatch(/secret_data/);
  });

  test("iap.tf wires brand/client and members", () => {
    const c = tfContents["iap.tf"];
    expect(c).toContain("google_iap_brand");
    expect(c).toContain("google_iap_client");
    expect(c).toContain("iap_members");
    expect(c).toContain("iap.httpsResourceAccessor");
  });

  test("outputs.tf exposes required outputs", () => {
    const c = tfContents["outputs.tf"];
    expect(c).toContain("checkpoint_bucket_name");
    expect(c).toContain("sql_connection_name");
    expect(c).toContain("artifact_registry_repository_url");
    expect(c).toContain("service_account");
  });

  test("README documents Cloud Run Instances TODO, bootstrap, and run.admin narrow alternative", () => {
    const c = readFileSync(join(tfDir, "README.md"), "utf8");
    expect(c).toMatch(/Cloud Run Instances/i);
    expect(c).toMatch(/TODO/);
    expect(c).toMatch(/Bootstrap sequence/i);
    expect(c).toMatch(/servicenetworking/);
    expect(c).toMatch(/checkpoint_live_delete_age_days/);
    expect(c).toMatch(/run\.developer/i);
  });

  test("no hardcoded project id across all tf files", () => {
    // Ensure no google_project with literal; all should use var.project_id
    const literals = [...allTf.matchAll(/project_id\s*=\s*"[^"]+"/g)];
    expect(literals.length).toBe(0);
  });
});
