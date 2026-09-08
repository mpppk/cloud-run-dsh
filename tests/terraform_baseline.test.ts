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
    "control-plane.tf",
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

  // The canonical API list lives in apis.tf (local.required_apis); this
  // oracle pins it. The count in the test name is derived from the oracle's
  // length — not a second hardcoded number — so enabling or dropping an API
  // cannot silently drift the name again (issue #82: the name said 11 while
  // apis.tf already had 12, and compute.googleapis.com was never asserted).
  // The exact-set assertion below fails first on any list change, including
  // the G6 compute API that once blocked the first apply.
  const EXPECTED_APIS = [
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
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
  test(`apis.tf enables ${EXPECTED_APIS.length} apis including IAM, Resource Manager, and servicenetworking`, () => {
    const c = tfContents["apis.tf"];
    for (const api of EXPECTED_APIS) {
      expect(c).toContain(api);
    }
    // No more, no fewer: every *.googleapis.com literal in apis.tf must be
    // exactly this set, so a future API addition/removal fails here instead
    // of drifting silently.
    const found = [...new Set(
      [...c.matchAll(/"([a-z0-9-]+\.googleapis\.com)"/g)].map((m) => m[1]),
    )].sort();
    expect(found).toEqual([...EXPECTED_APIS].sort());
  });

  test("cloudsql.tf uses secret manager for password, no literal, conditional bootstrap", () => {
    const c = tfContents["cloudsql.tf"];
    expect(c).toContain("google_secret_manager_secret_version");
    // Broad password literal check: password = "..." with any quoted string
    expect(c).not.toMatch(/password\s*=\s*"/);
    expect(c).not.toMatch(/password\s*=\s*'/);
    expect(c).toMatch(/Private IP/);
    // The public IPv4 is opt-in through a variable, never hardcoded on.
    // Assert the wiring AND the safe default — matching a bare
    // `ipv4_enabled = false` would also be satisfied by a comment, so anchor
    // on the assignment itself.
    expect(c).toMatch(/^\s*ipv4_enabled\s*=\s*var\.db_enable_public_ip\s*$/m);
    expect(c).not.toMatch(/^\s*ipv4_enabled\s*=\s*true\s*$/m);
    expect(tfContents["variables.tf"]).toMatch(
      /variable "db_enable_public_ip"[\s\S]*?default\s*=\s*false/,
    );
    // The edition MUST be explicitly wired to var.db_edition with an
    // ENTERPRISE default. Left implicit the API picks ENTERPRISE_PLUS and
    // rejects db-custom-* / db-f1-micro tiers with "Invalid Tier ... for
    // (ENTERPRISE_PLUS) Edition" — a 400 that only surfaces at apply time,
    // while terraform validate stays green. Anchor the assignment itself
    // (`^\s*` cannot match a `#` comment line), never the comment text.
    expect(c).toMatch(/^\s*edition\s*=\s*var\.db_edition\s*$/m);
    // Scope to the variable block itself: a lazy `[\s\S]*?` from
    // `variable "db_edition"` could otherwise spill past the closing brace and
    // match a LATER variable's default, so breaking this variable's default
    // would go unnoticed (false negative).
    const editionBlock = tfContents["variables.tf"].match(/variable "db_edition" \{[\s\S]*?\n\}/);
    expect(editionBlock).not.toBeNull();
    expect(editionBlock![0]).toMatch(/default\s*=\s*"ENTERPRISE"/);
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

  test("iam.tf defines runtime accounts and enforces AI-agent operator constraints", () => {
    const c = tfContents["iam.tf"];
    expect(c).toContain("google_service_account");
    expect(c).toContain("agent_host");
    expect(c).toContain("control_plane");
    expect(c).toContain('google_service_account" "ai_agent"');
    expect(c).toContain("roles/iam.serviceAccountTokenCreator");
    expect(c).toContain("ai_agent_impersonators");
    expect(c).toContain("ai_agent_project_roles");
    expect(c).toContain("ai_agent_act_as_agent_host");
    expect(c).toContain("ai_agent_act_as_control_plane");
    expect(c).toContain("roles/cloudsql.client");
    expect(c).toContain("roles/storage.objectAdmin");
    expect(c).toContain("roles/secretmanager.secretAccessor");
    // Issue #93: the control-plane DATABASE_URL secret carries its own
    // accessor grant next to the other three — a secret must never exist
    // without its grant again.
    expect(c).toContain('google_secret_manager_secret_iam_member" "control_plane_database_url"');
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

  test("iam.tf grants artifactregistry.reader repo-scoped to both caller SAs (#58, #64)", () => {
    const c = tfContents["iam.tf"];
    // Repository-scoped binding — project-wide would over-grant.
    expect(c).toContain("google_artifact_registry_repository_iam_member");
    // Anchor on the assignment line itself: a bare toContain("roles/...reader")
    // also matches comments (the false-green seen before).
    const readerRoles = [...c.matchAll(/^\s*role\s*=\s*"roles\/artifactregistry\.reader"\s*$/gm)];
    expect(readerRoles.length).toBe(2);
    // Wired to the agent-host repository resource, not a literal string.
    const repoWirings = [
      ...c.matchAll(/repository\s*=\s*google_artifact_registry_repository\.agent_host\./g),
    ];
    expect(repoWirings.length).toBe(2);
    // Bound to both SAs: agent-host pulls the image at startup (#58), and
    // control-plane is checked by Cloud Run with the caller's permission at
    // Instance create time even though it never calls the AR API (#64).
    expect(c).toMatch(/member\s*=\s*"serviceAccount:\$\{google_service_account\.agent_host\.email\}"/);
    expect(c).toMatch(
      /member\s*=\s*"serviceAccount:\$\{google_service_account\.control_plane\.email\}"/,
    );
    expect(c).toContain('google_artifact_registry_repository_iam_member" "agent_host_reader"');
    expect(c).toContain('google_artifact_registry_repository_iam_member" "control_plane_reader"');
    // Exactly two AR bindings — one per SA.
    const arBlocks = [
      ...c.matchAll(/resource "google_artifact_registry_repository_iam_member" "[^"]+" \{[\s\S]*?\n\}/g),
    ];
    expect(arBlocks.length).toBe(2);
    // No project-wide AR grants for either runtime SA.
    const projectAr = [
      ...c.matchAll(/resource "google_project_iam_member" "[^"]+" \{[\s\S]*?\n\}/g),
    ].filter((b) => b[0].includes("roles/artifactregistry."));
    expect(projectAr.length).toBe(0);
  });

  test("AI-agent operator stays within least-privilege guardrails", () => {
    // No service-account keys anywhere in the baseline (all .tf files, not just iam.tf)
    expect(allTf).not.toContain("google_service_account_key");
    // No gcloud-key fallback patterns either
    expect(allTf).not.toMatch(/service_account_key/);

    // ai_agent_project_roles default must be EXACTLY run.admin + artifactregistry.writer,
    // so widening the role set fails this test.
    const vars = tfContents["variables.tf"];
    const rolesVarBlock = vars.match(/variable "ai_agent_project_roles" \{[\s\S]*?\n\}/);
    expect(rolesVarBlock).not.toBeNull();
    const defaultRoles = [...(rolesVarBlock![0].matchAll(/"(roles\/[a-z0-9._-]+)"/g))].map((m) => m[1]);
    expect([...defaultRoles].sort()).toEqual(["roles/artifactregistry.writer", "roles/run.admin"]);

    // serviceAccountUser for ai-agent must appear only in SA-scoped
    // google_service_account_iam_member blocks, never project-wide.
    const iam = tfContents["iam.tf"];
    const projectIamBlocks = [...iam.matchAll(/resource "google_project_iam_member" "[^"]+" \{[\s\S]*?\n\}/g)];
    const projectWideSaUser = projectIamBlocks.filter((b) => b[0].includes("serviceAccountUser"));
    expect(projectWideSaUser.length).toBe(0);
    const saIamSaUserBlocks = [
      ...iam.matchAll(/resource "google_service_account_iam_member" "[^"]+" \{[\s\S]*?\n\}/g),
    ].filter((b) => b[0].includes("roles/iam.serviceAccountUser"));
    // Exactly three: ai-agent actAs on agent_host + control_plane, and
    // control_plane actAs on agent_host. All SA-scoped.
    expect(saIamSaUserBlocks.length).toBe(3);
  });

  test("secrets.tf creates 5 secrets without values", () => {
    const c = tfContents["secrets.tf"];
    expect(c).toContain("github_app_private_key");
    expect(c).toContain("llm_api_key");
    expect(c).toContain("db_password");
    // Issue #93: the control-plane DATABASE_URL secret lives here too, so its
    // accessor grant (iam.tf) cannot drift out of sync with its existence.
    expect(c).toContain("control_plane_database_url");
    expect(tfContents["variables.tf"]).toContain("control_plane_database_url_secret_id");
    // Issue #151: the GitHub App OAuth client secret container (version
    // added out-of-band in runbook Step 6.x).
    expect(c).toContain("github_app_client_secret");
    expect(tfContents["variables.tf"]).toContain("github_app_client_secret_id");
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
    expect(c).toContain("ai_agent_service_account_email");
  });

  test("README documents the Cloud Run Instances decision (ADR-0001), bootstrap, and run.admin narrow alternative", () => {
    const c = readFileSync(join(tfDir, "README.md"), "utf8");
    expect(c).toMatch(/Cloud Run Instances/i);
    // #28 decided Instances stay outside Terraform (ADR-0001); the old
    // "Pre-GA TODO, promote .example once a resource ships" wording is gone.
    expect(c).toMatch(/ADR-0001/);
    expect(c).toMatch(/outside Terraform/i);
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

  test("cloudsql.tf pins destroy order database-before-user for issue #73", () => {    const c = tfContents["cloudsql.tf"];
    // The DATABASE must depend on the USER so that destroy runs
    // database -> user (destroy is the inverse of creation order).
    // The reverse direction (user depending on database) would destroy the
    // user first and reproduce the `role "dsh_app" cannot be dropped` 400.
    const dbBlock = c.match(/resource "google_sql_database" "dsh" \{[\s\S]*?\n\}/);
    expect(dbBlock).not.toBeNull();
    expect(dbBlock![0]).toMatch(/depends_on\s*=\s*\[google_sql_user\.app\]/);
    // The user must NOT carry the reverse edge — that would flip destroy
    // order back to user-first.
    const userBlock = c.match(/resource "google_sql_user" "app" \{[\s\S]*?\n\}/);
    expect(userBlock).not.toBeNull();
    expect(userBlock![0]).not.toMatch(/depends_on\s*=\s*\[google_sql_database\.dsh\]/);
  });
});

describe("issue #155: control-plane service with fail-closed public gate", () => {
  test("exactly one google_cloud_run_v2_service (control_plane); ADR-0001 preserved", () => {
    const services = [
      ...allTf.matchAll(/resource "google_cloud_run_v2_service" "([^"]+)" \{/g),
    ].map((m) => m[1]);
    expect(services).toEqual(["control_plane"]);
    // Preview Instances stay outside Terraform (ADR-0001): no agent-host
    // service, instance, or worker-pool resources anywhere.
    expect(allTf).not.toMatch(/resource "google_cloud_run_v2_service" "agent_host"/);
    expect(allTf).not.toMatch(/google_cloud_run_v2_service" "agent-host/);
    expect(allTf).not.toMatch(/cloud_run_v2_worker_pool/);
    expect(allTf).not.toMatch(/cloud_run_instance/);
    expect(tfContents["control-plane.tf"]).toMatch(/ADR-0001/);
  });

  test("no allUsers and no run-invoker IAM bindings anywhere (asymmetry by construction)", () => {
    // Public mode uses invoker_iam_disabled (official recommended mechanism),
    // never an allUsers grant — this must hold for every present and future
    // caller identity, including agent-host Instances. Anchored on quoted
    // member literals so prose mentions of the word cannot false-green.
    expect(allTf).not.toMatch(/"allUsers"/);
    expect(allTf).not.toMatch(/'allUsers'/);
    expect(allTf).not.toMatch(/google_cloud_run_v2_service_iam_(binding|member|policy)/);
    expect(allTf).not.toMatch(/roles\/run\.invoker/);
  });

  test("fail-closed defaults: no image means no service; public defaults to false", () => {
    const vars = tfContents["variables.tf"];
    const imageBlock = vars.match(/variable "control_plane_image" \{[\s\S]*?\n\}/);
    expect(imageBlock).not.toBeNull();
    expect(imageBlock![0]).toMatch(/default\s*=\s*""/);
    const publicBlock = vars.match(/variable "control_plane_public" \{[\s\S]*?\n\}/);
    expect(publicBlock).not.toBeNull();
    expect(publicBlock![0]).toMatch(/default\s*=\s*false/);
    const c = tfContents["control-plane.tf"];
    // count = 0 until an image is supplied: defaults create nothing.
    expect(c).toMatch(/count\s*=\s*local\.cp_enabled \? 1 : 0/);
    expect(c).toMatch(/cp_enabled = var\.control_plane_image != ""/);
  });

  test("public gate: restrictive ingress + IAM check by default, ALL + disabled only when public", () => {
    const c = tfContents["control-plane.tf"];
    expect(c).toMatch(/ingress = local\.cp_public \? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"/);
    expect(c).toMatch(/invoker_iam_disabled = local\.cp_public/);
    expect(c).toMatch(/cp_public\s*=\s*local\.cp_enabled && var\.control_plane_public/);
    // Literal `= true` on either field would publicize unconditionally.
    expect(c).not.toMatch(/^\s*ingress\s*=\s*"INGRESS_TRAFFIC_ALL"\s*$/m);
    expect(c).not.toMatch(/^\s*invoker_iam_disabled\s*=\s*true\s*$/m);
    // Lifecycle preconditions fail the PLAN when public mode lacks its
    // mandatory config (non-empty https origin, client/App IDs, images).
    expect(c).toContain("precondition");
    expect(c).toContain("control_plane_app_origin");
    expect(c).toContain("control_plane_github_client_id");
    expect(c).toContain("control_plane_github_app_id");
    expect(c).toContain("control_plane_agent_host_image");
    expect(c).toContain("https://");
  });

  test("credential env is secret_key_ref only; DB-URL secret backs both URL vars; no values", () => {
    const c = tfContents["control-plane.tf"];
    for (const name of [
      "DATABASE_URL",
      "AGENT_HOST_DATABASE_URL",
      "GITHUB_APP_PRIVATE_KEY_PEM",
      "OPENROUTER_API_KEY",
      "GITHUB_APP_CLIENT_SECRET",
    ]) {
      expect(c).toContain(`name = "${name}"`);
    }
    const refs = [...c.matchAll(/secret_key_ref \{[\s\S]*?\n\s*\}/g)];
    expect(refs.length).toBeGreaterThanOrEqual(5);
    // Both URL vars reference the same socket-form secret (runbook Step 6):
    // AGENT_HOST_DATABASE_URL must never be a plain value (it embeds the
    // DB password and would land in state).
    const dbUrlRefs = refs.filter((b) => b[0].includes("control_plane_database_url_secret_id"));
    expect(dbUrlRefs.length).toBe(2);
    // No plain `value = "..."` env assignment may carry a secret-looking
    // name; plain env is non-secret config only.
    const plainSecrets = [
      ...c.matchAll(/^\s*name\s*=\s*"(DATABASE_URL|AGENT_HOST_DATABASE_URL|GITHUB_APP_PRIVATE_KEY_PEM|OPENROUTER_API_KEY|GITHUB_APP_CLIENT_SECRET|.*PASSWORD.*|.*SECRET.*|.*PRIVATE_KEY.*)"\s*$/gm),
    ].filter((m) => {
      const block = c.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 400);
      return !block.includes("secret_key_ref");
    });
    expect(plainSecrets.map((m) => m[0]).join("\n")).toBe("");
    // Secret containers resolve through the *_secret_id variables (custom
    // IDs keep working), never hardcoded names.
    expect(c).toContain("var.control_plane_database_url_secret_id");
    expect(c).toContain("var.github_app_private_key_secret_id");
    expect(c).toContain("var.llm_api_key_secret_id");
    expect(c).toContain("var.github_app_client_secret_id");
  });

  test("production surface mirrored: SA, SQL volume, probes, timeout, traffic", () => {
    const c = tfContents["control-plane.tf"];
    // Runtime identity: the existing control-plane SA (IAM unchanged).
    expect(c).toMatch(/service_account\s*=\s*google_service_account\.control_plane\.email/);
    // Cloud SQL socket volume (runbook Step 6 --add-cloudsql-instances).
    expect(c).toContain("cloud_sql_instance");
    expect(c).toMatch(/mount_path\s*=\s*"\/cloudsql"/);
    expect(c).toContain("google_sql_database_instance.main.connection_name");
    // Probes: honest startup gate on /readyz, process liveness on /livez.
    expect(c).toMatch(/path\s*=\s*"\/readyz"/);
    expect(c).toMatch(/path\s*=\s*"\/livez"/);
    expect(c).toContain("startup_probe");
    expect(c).toContain("liveness_probe");
    expect(c).toMatch(/container_port\s*=\s*8080/);
    expect(c).toMatch(/timeout\s*=\s*"300s"/);
    expect(c).toMatch(/percent\s*=\s*100/);
    // Plain env mirrors runbook Step 6 REQUIRED keys (minus secrets).
    // Anchored on map-key assignments (env names are HCL keys, not quoted).
    for (const name of [
      "GCP_PROJECT_ID",
      "GCP_REGION",
      "AGENT_HOST_IMAGE",
      "AGENT_HOST_SERVICE_ACCOUNT",
      "CHECKPOINT_BUCKET",
      "CLOUD_SQL_CONNECTION_NAME",
      "GITHUB_APP_ID",
      "APP_ORIGIN",
      "GITHUB_APP_CLIENT_ID",
    ]) {
      expect(c).toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
    }
  });

  test("outputs expose service uri/name for the two-phase bootstrap", () => {
    const c = tfContents["outputs.tf"];
    expect(c).toContain("control_plane_service_uri");
    expect(c).toContain("control_plane_service_name");
    expect(c).toContain("google_cloud_run_v2_service.control_plane");
  });

  test("README documents the service, gate, bootstrap and #156 gating", () => {
    const c = readFileSync(join(tfDir, "README.md"), "utf8");
    expect(c).toContain("control-plane.tf");
    expect(c).toMatch(/control_plane_public/);
    expect(c).toMatch(/two-phase/i);
    expect(c).toMatch(/#156/);
    expect(c).toMatch(/ADR-0001/);
  });
});
