// Issue #154: repository authorization through the GitHub App.
// Fake transports only — no network, no real credentials.

import { describe, expect, test } from "bun:test";
import {
  createRepositoryAuthorizer,
  RepositoryAuthorizerTransientError,
  RepositoryInputError,
  validateRepositoryCoordinates,
  type HttpResponse,
  type HttpTransport,
  type Repository,
} from "./index.js";

const TOKEN = "ghs_installation-token-secret-xyz";

import { generateKeyPairSync } from "node:crypto";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

/** Scripted transport: records requests, answers permission lookups. */
function scriptedTransport(
  permission: { status: number; body?: unknown },
  opts: {
    installationStatus?: number;
    tokenStatus?: number;
    hang?: boolean;
    /** Hang only the permission lookup (issuance answers normally). */
    hangPermission?: boolean;
    /** Hang only issuance (installation/token URLs). */
    hangIssuance?: boolean;
    /** Numeric user id echoed in the permission response principal. */
    responseUserId?: number;
  } = {},
): { transport: HttpTransport; requests: Array<{ url: string; auth: string }> } {
  const requests: Array<{ url: string; auth: string }> = [];
  const transport: HttpTransport = async (req) => {
    if (opts.hang) return new Promise<HttpResponse>(() => {});
    const auth = req.headers["Authorization"] ?? "";
    if (req.url.includes("/installation") && req.method === "GET") {
      if (opts.hangIssuance) return new Promise<HttpResponse>(() => {});
      const status = opts.installationStatus ?? 200;
      return status === 200
        ? jsonResponse(200, { id: 12345 })
        : { status, headers: {}, body: `installation lookup failed: ${status}` };
    }
    if (req.url.includes("/access_tokens")) {
      if (opts.hangIssuance) return new Promise<HttpResponse>(() => {});
      const status = opts.tokenStatus ?? 201;
      return status === 201 || status === 200
        ? jsonResponse(status, { token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() })
        : { status, headers: {}, body: `token creation failed: ${status}` };
    }
    if (opts.hangPermission) return new Promise<HttpResponse>(() => {});
    requests.push({ url: req.url, auth });
    if (permission.status === 200) {
      const body = permission.body ?? { permission: "read" };
      // A4: the real endpoint resolves the principal; echo it unless the
      // test body already carries (or omits) one.
      const withUser =
        typeof body === "object" && body !== null && !("user" in body) && opts.responseUserId !== undefined
          ? { ...(body as Record<string, unknown>), user: { id: opts.responseUserId } }
          : body;
      return jsonResponse(200, withUser);
    }
    return { status: permission.status, headers: {}, body: `permission lookup: ${permission.status}` };
  };
  return { transport, requests };
}

const BROKER_SECRETS = { appId: "123", privateKeyPem: privateKey };

async function importBroker() {
  const { createGitHubCredentialBroker } = await import("./index.js");
  return createGitHubCredentialBroker;
}

describe("issue #154: validateRepositoryCoordinates", () => {
  test("accepts normal coordinates", () => {
    validateRepositoryCoordinates("mpppk", "cloud-run-dsh");
    validateRepositoryCoordinates("a", "b");
    validateRepositoryCoordinates("org-name-1", "repo.name-2_x");
  });

  test.each([
    ["", "repo"],
    ["owner", ""],
    ["../evil", "repo"],
    ["owner", "../../etc"],
    ["owner", "."],
    ["owner", ".."],
    ["own er", "repo"],
    ["owner", "re po"],
    ["owner%", "repo"],
    ["-leading-dash", "repo"],
    ["trailing-dash-", "repo"],
    ["o".repeat(40), "repo"],
    ["owner", "r".repeat(101)],
    ["owner_name", "repo"],
    ["owner\nX", "repo"],
  ])("rejects %j / %j", (owner, repo) => {
    expect(() => validateRepositoryCoordinates(owner, repo)).toThrow(RepositoryInputError);
  });
});

describe("issue #154: canReadRepository", () => {
  test.each(["read", "triage", "write", "maintain", "admin"])(
    "permission %s authorizes",
    async (permission) => {
      const createBroker = await importBroker();
      const { transport, requests } = scriptedTransport(
        { status: 200, body: { permission } },
        { responseUserId: 4279342 },
      );
      const broker = createBroker({
        secretProvider: async () => BROKER_SECRETS,
        transport,
      });
      const authorizer = createRepositoryAuthorizer({ broker, transport });
      const allowed = await authorizer.canReadRepository({
        owner: "mpppk",
        repo: "demo",
        githubUserId: "4279342",
        githubLogin: "mpppk",
      });
      expect(allowed).toBe(true);
      // The permission URL names the user; the token authenticated it.
      expect(requests[0]!.url).toContain("/repos/mpppk/demo/collaborators/mpppk/permission");
      expect(requests[0]!.auth).toBe(`Bearer ${TOKEN}`);
    },
  );

  test("permission none denies; unknown levels deny", async () => {
    const createBroker = await importBroker();
    for (const body of [
      { permission: "none", user: { id: 1 } },
      { permission: "superadmin", user: { id: 1 } },
      {},
    ]) {
      const { transport } = scriptedTransport({ status: 200, body });
      const broker = createBroker({
        secretProvider: async () => BROKER_SECRETS,
        transport,
      });
      const authorizer = createRepositoryAuthorizer({ broker, transport });
      expect(
        await authorizer.canReadRepository({
          owner: "o",
          repo: "r",
          githubUserId: "1",
          githubLogin: "u",
        }),
      ).toBe(false);
    }
  });

  test("A4: reused login resolving to a different numeric id denies (login-rename TOCTOU)", async () => {
    // The login now belongs to account 999 (renamed + reused); the session
    // still keys on 4279342. Permission is admin — the bind must deny anyway.
    const createBroker = await importBroker();
    const { transport } = scriptedTransport({
      status: 200,
      body: { permission: "admin", user: { id: 999, login: "mpppk" } },
    });
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport });
    expect(
      await authorizer.canReadRepository({
        owner: "mpppk",
        repo: "demo",
        githubUserId: "4279342",
        githubLogin: "mpppk",
      }),
    ).toBe(false);
  });

  test("A4: permission response without a verifiable principal denies", async () => {
    const createBroker = await importBroker();
    for (const body of [
      { permission: "admin" },
      { permission: "admin", user: null },
      { permission: "admin", user: { login: "mpppk" } },
      { permission: "admin", user: { id: "4279342" } },
    ]) {
      const { transport } = scriptedTransport({ status: 200, body });
      const broker = createBroker({
        secretProvider: async () => BROKER_SECRETS,
        transport,
      });
      const authorizer = createRepositoryAuthorizer({ broker, transport });
      expect(
        await authorizer.canReadRepository({
          owner: "mpppk",
          repo: "demo",
          githubUserId: "4279342",
          githubLogin: "mpppk",
        }),
      ).toBe(false);
    }
  });

  test("404 (unknown repo / no access) denies without distinguishing", async () => {
    const createBroker = await importBroker();
    const { transport } = scriptedTransport({ status: 404 });
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport });
    expect(
      await authorizer.canReadRepository({
        owner: "private",
        repo: "hidden",
        githubUserId: "1",
        githubLogin: "u",
      }),
    ).toBe(false);
  });

  test("App not installed (installation 404) denies instead of erroring", async () => {
    const createBroker = await importBroker();
    const { transport } = scriptedTransport(
      { status: 200, body: { permission: "admin" } },
      { installationStatus: 404 },
    );
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport });
    expect(
      await authorizer.canReadRepository({
        owner: "o",
        repo: "r",
        githubUserId: "1",
        githubLogin: "u",
      }),
    ).toBe(false);
  });

  test("GitHub 5xx / transport failure -> transient (never a deny, never token in error)", async () => {
    const createBroker = await importBroker();
    for (const scripted of [{ status: 500 }, { status: 502 }, { status: 403 }]) {
      const { transport } = scriptedTransport(scripted);
      const broker = createBroker({
        secretProvider: async () => BROKER_SECRETS,
        transport,
      });
      const authorizer = createRepositoryAuthorizer({ broker, transport });
      const err = await authorizer
        .canReadRepository({ owner: "o", repo: "r", githubUserId: "1", githubLogin: "u" })
        .then(
          () => null,
          (e) => e as Error,
        );
      expect(err).toBeInstanceOf(RepositoryAuthorizerTransientError);
      expect(String(err?.message)).not.toContain(TOKEN);
    }
    // Transport throw.
    const throwing: HttpTransport = async () => {
      throw new Error("socket hang up");
    };
    const broker2 = createBroker({ secretProvider: async () => BROKER_SECRETS, transport: throwing });
    const authorizer2 = createRepositoryAuthorizer({ broker: broker2, transport: throwing });
    await expect(
      authorizer2.canReadRepository({ owner: "o", repo: "r", githubUserId: "1", githubLogin: "u" }),
    ).rejects.toBeInstanceOf(RepositoryAuthorizerTransientError);
  });

  test("malicious coordinates never reach the network", async () => {
    const createBroker = await importBroker();
    let calls = 0;
    const counting: HttpTransport = async () => {
      calls++;
      return jsonResponse(200, { permission: "admin" });
    };
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport: counting,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport: counting });
    await expect(
      authorizer.canReadRepository({
        owner: "..",
        repo: "x",
        githubUserId: "1",
        githubLogin: "u",
      }),
    ).rejects.toBeInstanceOf(RepositoryInputError);
    await expect(
      authorizer.canReadRepository({ owner: "o", repo: "r", githubUserId: "", githubLogin: "u" }),
    ).rejects.toBeInstanceOf(RepositoryInputError);
    expect(calls).toBe(0);
  });

  test("token issuance failure (non-404) -> transient", async () => {
    const createBroker = await importBroker();
    const { transport } = scriptedTransport(
      { status: 200, body: { permission: "read" } },
      { tokenStatus: 500 },
    );
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport });
    await expect(
      authorizer.canReadRepository({ owner: "o", repo: "r", githubUserId: "1", githubLogin: "u" }),
    ).rejects.toBeInstanceOf(RepositoryAuthorizerTransientError);
  });

  test("repository identity is used verbatim in the broker call (no login-as-key)", async () => {
    const createBroker = await importBroker();
    const seen: Repository[] = [];
    const { transport } = scriptedTransport(
      { status: 200, body: { permission: "read" } },
      { responseUserId: 4279342 },
    );
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const orig = broker.withInstallationToken.bind(broker);
    const authorizer = createRepositoryAuthorizer({
      broker: {
        withInstallationToken: (repo, fn) => {
          seen.push(repo);
          return orig(repo, fn);
        },
      },
      transport,
    });
    await authorizer.canReadRepository({
      owner: "Owner",
      repo: "Repo",
      githubUserId: "4279342",
      githubLogin: "mpppk",
    });
    expect(seen).toEqual([{ owner: "Owner", name: "Repo" }]);
  });

  test("A3: hanging issuance fails the whole check at the timeout (transient)", async () => {
    const createBroker = await importBroker();
    const { transport } = scriptedTransport(
      { status: 200, body: { permission: "read", user: { id: 1 } } },
      { hangIssuance: true },
    );
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport, timeoutMs: 50 });
    const start = Date.now();
    const err = await authorizer
      .canReadRepository({ owner: "o", repo: "r", githubUserId: "1", githubLogin: "u" })
      .then(
        () => null,
        (e) => e as Error,
      );
    expect(err).toBeInstanceOf(RepositoryAuthorizerTransientError);
    expect(String(err?.message)).toContain("timed out");
    expect(String(err?.message)).not.toContain(TOKEN);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("A3: hanging permission lookup fails at the timeout (transient)", async () => {
    const createBroker = await importBroker();
    const { transport } = scriptedTransport(
      { status: 200, body: { permission: "read", user: { id: 1 } } },
      { hangPermission: true },
    );
    const broker = createBroker({
      secretProvider: async () => BROKER_SECRETS,
      transport,
    });
    const authorizer = createRepositoryAuthorizer({ broker, transport, timeoutMs: 50 });
    const err = await authorizer
      .canReadRepository({ owner: "o", repo: "r", githubUserId: "1", githubLogin: "u" })
      .then(
        () => null,
        (e) => e as Error,
      );
    expect(err).toBeInstanceOf(RepositoryAuthorizerTransientError);
    expect(String(err?.message)).toContain("timed out");
  });

  test("A3: timeout timers are cleared on settle (success and failure)", async () => {
    const createBroker = await importBroker();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const created: unknown[] = [];
    const cleared = new Set<unknown>();
    try {
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const handle = realSetTimeout(fn, ms, ...args);
        created.push(handle);
        return handle;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((handle: unknown) => {
        cleared.add(handle);
        return realClearTimeout(handle as ReturnType<typeof setTimeout>);
      }) as typeof clearTimeout;

      // Success path.
      const { transport } = scriptedTransport(
        { status: 200, body: { permission: "read" } },
        { responseUserId: 7 },
      );
      const broker = createBroker({
        secretProvider: async () => BROKER_SECRETS,
        transport,
      });
      const authorizer = createRepositoryAuthorizer({ broker, transport });
      expect(
        await authorizer.canReadRepository({
          owner: "o",
          repo: "r",
          githubUserId: "7",
          githubLogin: "u",
        }),
      ).toBe(true);
      expect(created.length).toBeGreaterThan(0);
      for (const handle of created) expect(cleared.has(handle)).toBe(true);

      // Failure path (deny still settles both races).
      created.length = 0;
      cleared.clear();
      const { transport: denyTransport } = scriptedTransport({ status: 404 });
      const denyBroker = createBroker({
        secretProvider: async () => BROKER_SECRETS,
        transport: denyTransport,
      });
      const denyAuthorizer = createRepositoryAuthorizer({
        broker: denyBroker,
        transport: denyTransport,
      });
      expect(
        await denyAuthorizer.canReadRepository({
          owner: "o",
          repo: "r",
          githubUserId: "7",
          githubLogin: "u",
        }),
      ).toBe(false);
      for (const handle of created) expect(cleared.has(handle)).toBe(true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
