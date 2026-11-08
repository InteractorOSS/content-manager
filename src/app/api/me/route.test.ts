import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/me is the endpoint that answers "who am I, on which tenant, and what
 * may I do", so the guard is the thing under test here — it is deliberately
 * NOT mocked. Only Prisma and the session are faked, which lets the real PAT
 * path run: token hash lookup, revocation/expiry, ORG BINDING, loadActor, and
 * permission flattening from the owner's membership role in the bound org.
 *
 * The multi-org cases are the security ones. A person can belong to an
 * employer, a personal blog and a family project at once; a bearer token
 * carries no session to say which it means. Before tokens were bound, the org
 * was inferred from the USER (current_organization_id, which nothing writes,
 * then an unordered first membership), so which tenant a token wrote to was
 * effectively arbitrary. These tests pin that a token acts on its own org and
 * dies rather than drifting to another.
 */

const apiTokenFindUnique = vi.fn();
const apiTokenUpdate = vi.fn();
const userFindUnique = vi.fn();
const userFindFirst = vi.fn();
const roleFindMany = vi.fn();
const membershipFindMany = vi.fn();
const authMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      findUnique: (...a: unknown[]) => apiTokenFindUnique(...a),
      update: (...a: unknown[]) => apiTokenUpdate(...a),
    },
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      findFirst: (...a: unknown[]) => userFindFirst(...a),
    },
    role: { findMany: (...a: unknown[]) => roleFindMany(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    // tenantDb() builds its scoped client eagerly; /api/me never queries through it.
    $extends: () => ({}),
  },
  isUniqueViolation: () => false,
}));

vi.mock("@/lib/auth", () => ({
  auth: (...a: unknown[]) => authMock(...a),
  oidcEnabled: false,
}));

import { GET } from "./route";
import { hashToken } from "@/lib/api-tokens";

const TOKEN = "cms_pat_live-token";

// One person, three organizations — an employer where they are an author, a
// personal blog they own, and a family project they administer.
const ORGS = {
  interactor: { id: "org-interactor", name: "Interactor", slug: "interactor" },
  blog: { id: "org-blog", name: "Personal Blog", slug: "personal-blog" },
  mysonceo: { id: "org-mysonceo", name: "MySonCEO", slug: "mysonceo" },
};

const MEMBERSHIPS = [
  { organization: ORGS.interactor, role: "author" },
  { organization: ORGS.blog, role: "owner" },
  { organization: ORGS.mysonceo, role: "admin" },
];

/** Role → permissions, mirroring prisma/seed.mjs closely enough to matter. */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  author: ["content:view", "content:create", "content:edit", "media:view"],
  admin: ["content:view", "content:create", "content:edit", "content:publish"],
  owner: ["content:view", "content:create", "content:edit", "content:publish", "admin:settings"],
  super_admin: ["content:view", "content:publish", "users:manage_roles"],
};

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "peter@example.com",
    name: "Peter",
    status: "active",
    // Never written by the app — the reason token org had to stop depending on it.
    current_organization_id: null,
    roles: [], // global UserRole rows; only super_admin is effective
    // The nested `organization` mirrors ACTOR_INCLUDE, which loads the org row
    // alongside each membership so loadActor can expose name+slug for the
    // switcher without a second query.
    memberships: MEMBERSHIPS.map((m) => ({
      organization_id: m.organization.id,
      role: m.role,
      organization: m.organization,
    })),
    ...overrides,
  };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    user_id: "u1",
    name: "MCP connector",
    token_prefix: "cms_pat_live",
    token_hash: hashToken(TOKEN),
    organization_id: ORGS.mysonceo.id,
    revoked_at: null,
    expires_at: null,
    ...overrides,
  };
}

function request(token?: string) {
  return new NextRequest("http://localhost/api/me", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function body(res: Response) {
  return (await res.json()) as { data?: Record<string, any>; error?: string };
}

beforeEach(() => {
  apiTokenFindUnique.mockReset();
  apiTokenUpdate.mockReset();
  apiTokenUpdate.mockResolvedValue({});
  userFindUnique.mockReset();
  userFindFirst.mockReset();
  roleFindMany.mockReset();
  membershipFindMany.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(null);

  userFindUnique.mockResolvedValue(userRow());
  membershipFindMany.mockResolvedValue(MEMBERSHIPS);
  roleFindMany.mockImplementation(async ({ where }: { where: { name: { in: string[] } } }) =>
    where.name.in.map((name) => ({
      name,
      permissions: (ROLE_PERMISSIONS[name] ?? []).map((p) => ({ permission: { name: p } })),
    }))
  );
});

describe("GET /api/me — token site scope (G#21)", () => {
  it("reports the sites a scoped token is limited to, so a site refusal is explainable", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow({ site_scopes: ["product-manager"] }));

    const { data } = await body(await GET(request(TOKEN)));

    expect(data?.auth_method).toBe("token");
    expect(data?.token.site_scopes).toEqual(["product-manager"]);
  });

  it("reports an empty scope — every site in the org — for a token minted without one", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow({ site_scopes: [] }));

    const { data } = await body(await GET(request(TOKEN)));

    expect(data?.token.site_scopes).toEqual([]);
  });
});

describe("GET /api/me — token organization binding", () => {
  it("acts on the organization the token names, not the user's first membership", async () => {
    // `interactor` is this user's first membership and would have won under
    // the old inference. The token says MySonCEO, so MySonCEO it is.
    apiTokenFindUnique.mockResolvedValue(tokenRow({ organization_id: ORGS.mysonceo.id }));

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.organization_id).toBe(ORGS.mysonceo.id);
    expect(data!.organization).toEqual(ORGS.mysonceo);
    expect(data!.membership_role).toBe("admin");
  });

  it("gives the same person different permissions through different tokens", async () => {
    // The employer token: author there, so no publishing.
    apiTokenFindUnique.mockResolvedValue(
      tokenRow({ id: "t-work", organization_id: ORGS.interactor.id })
    );
    const work = await body(await GET(request(TOKEN)));

    // The personal-blog token: owner there, so publishing is fine.
    apiTokenFindUnique.mockResolvedValue(
      tokenRow({ id: "t-blog", organization_id: ORGS.blog.id })
    );
    const blog = await body(await GET(request(TOKEN)));

    expect(work.data!.organization!.name).toBe("Interactor");
    expect(work.data!.permissions).not.toContain("content:publish");

    expect(blog.data!.organization!.name).toBe("Personal Blog");
    expect(blog.data!.permissions).toContain("content:publish");
  });

  it("dies when the owner is no longer a member of the bound org — never falls back to another", async () => {
    // Removed from MySonCEO, still in the other two. The old resolver would
    // have quietly handed this token the first remaining membership, moving a
    // revoked-from-one-tenant token onto a different tenant.
    apiTokenFindUnique.mockResolvedValue(tokenRow({ organization_id: ORGS.mysonceo.id }));
    userFindUnique.mockResolvedValue(
      userRow({
        memberships: [
          {
            organization_id: ORGS.interactor.id,
            role: "author",
            organization: ORGS.interactor,
          },
          {
            organization_id: ORGS.blog.id,
            role: "owner",
            organization: ORGS.blog,
          },
        ],
      })
    );

    expect((await GET(request(TOKEN))).status).toBe(401);
  });

  it("refuses an unbound (pre-binding) token instead of treating it as any-org", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow({ organization_id: null }));

    expect((await GET(request(TOKEN))).status).toBe(401);
  });

  it("reports the token's identity so several tokens can be told apart", async () => {
    apiTokenFindUnique.mockResolvedValue(
      tokenRow({ id: "t-blog", name: "Personal blog MCP", token_prefix: "cms_pat_abcd" })
    );

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.token).toMatchObject({
      id: "t-blog",
      name: "Personal blog MCP",
      token_prefix: "cms_pat_abcd",
    });
    // The secret itself never comes back.
    expect(JSON.stringify(data)).not.toContain(TOKEN);
  });

  it("reports a Claude sign-in connection by its real lifetime, not the hourly access token's", async () => {
    const hourly = new Date(Date.now() + 8 * 60 * 1000);
    const connection = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    apiTokenFindUnique.mockResolvedValue(
      tokenRow({ oauth_client_id: "client-1", expires_at: hourly, refresh_expires_at: connection })
    );

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.token).toMatchObject({
      kind: "connection",
      expires_at: connection.toISOString(),
      refreshes_automatically: true,
    });
    expect(JSON.stringify(data!.token)).not.toContain(hourly.toISOString());
  });

  it("reports a personal access token's own expiry, unchanged", async () => {
    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    apiTokenFindUnique.mockResolvedValue(tokenRow({ expires_at: expiry }));

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.token).toMatchObject({ kind: "personal_access_token", expires_at: expiry.toISOString() });
    expect(data!.token).not.toHaveProperty("refreshes_automatically");
  });

  it("lists every organization the owner belongs to, flagging the active one", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow({ organization_id: ORGS.blog.id }));

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.organizations).toHaveLength(3);
    expect(data!.organizations.filter((o: { active: boolean }) => o.active)).toEqual([
      { ...ORGS.blog, role: "owner", active: true },
    ]);
  });
});

describe("GET /api/me — personal access token", () => {
  it("answers over a PAT, with no session cookie in sight", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow());

    const res = await GET(request(TOKEN));
    const { data } = await body(res);

    expect(res.status).toBe(200);
    expect(data!.user.email).toBe("peter@example.com");
    expect(data!.auth_method).toBe("token");
    expect(authMock).not.toHaveBeenCalled();
  });

  it("looks the token up by hash, never by its raw value", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow());

    await GET(request(TOKEN));

    expect(apiTokenFindUnique).toHaveBeenCalledWith({
      where: { token_hash: hashToken(TOKEN) },
    });
    expect(JSON.stringify(apiTokenFindUnique.mock.calls)).not.toContain(TOKEN);
  });

  it("reports the membership role and its permissions — not the inert global UserRole", async () => {
    // The shape behind an unexplainable 403: the /users table renders
    // "Administrator" from this global UserRole row, while the permission
    // check reads the membership role in the token's org, which is `author`.
    apiTokenFindUnique.mockResolvedValue(tokenRow({ organization_id: ORGS.interactor.id }));
    userFindUnique.mockResolvedValue(
      userRow({ roles: [{ role: { name: "admin", active: true } }] })
    );

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.membership_role).toBe("author");
    expect(data!.roles).toEqual(["author"]);
    expect(data!.permissions).not.toContain("content:publish");
    expect(data!.permissions).toContain("content:create");
  });

  it("unions in the global super_admin role, which does cross orgs", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow({ organization_id: ORGS.interactor.id }));
    userFindUnique.mockResolvedValue(
      userRow({ roles: [{ role: { name: "super_admin", active: true } }] })
    );

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.roles).toEqual(["author", "super_admin"]);
    expect(data!.permissions).toContain("content:publish");
  });

  it("returns permissions sorted, so two answers can be diffed", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow());

    const { data } = await body(await GET(request(TOKEN)));

    expect(data!.permissions).toEqual([...data!.permissions].sort());
  });

  for (const [label, row] of [
    ["revoked", tokenRow({ revoked_at: new Date("2026-01-01") })],
    ["expired", tokenRow({ expires_at: new Date("2020-01-01") })],
    ["unknown", null],
  ] as const) {
    it(`401s a ${label} token rather than falling through to an anonymous answer`, async () => {
      apiTokenFindUnique.mockResolvedValue(row);

      expect((await GET(request(TOKEN))).status).toBe(401);
    });
  }

  it("401s a token whose owner has been deactivated", async () => {
    apiTokenFindUnique.mockResolvedValue(tokenRow());
    userFindUnique.mockResolvedValue(userRow({ status: "inactive" }));

    expect((await GET(request(TOKEN))).status).toBe(401);
  });

  it("ignores a bearer that isn't one of ours without consulting the database", async () => {
    const res = await GET(request("github_pat_something_else"));

    expect(res.status).toBe(401);
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/me — session", () => {
  it("still answers a browser session, and says so", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });

    const { data } = await body(await GET(request()));

    expect(data!.user.email).toBe("peter@example.com");
    expect(data!.auth_method).toBe("session");
    expect(data!.token).toBeNull();
  });

  it("credits the session when an unusable bearer falls back to it", async () => {
    // Sending a header is not the same as being authenticated by it. Claiming
    // "token" here would misreport whose permissions are on screen — the exact
    // ambiguity this field exists to remove.
    apiTokenFindUnique.mockResolvedValue(null);
    authMock.mockResolvedValue({ user: { id: "u1" } });

    const { data } = await body(await GET(request("cms_pat_revoked-yesterday")));

    expect(data!.auth_method).toBe("session");
  });

  it("401s when there is neither a session nor a token", async () => {
    expect((await GET(request())).status).toBe(401);
  });
});
