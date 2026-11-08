import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Minting is where a token's tenant is decided, and it is decided once —
 * nothing later can move it. So the rules that matter here are: an explicit
 * choice is honoured, a choice the user has no membership for is refused, and
 * every token comes out bound to something.
 */

const apiTokenCreate = vi.fn();
const apiTokenFindMany = vi.fn();
const membershipFindMany = vi.fn();

const actor = {
  user: { id: "u1", email: "peter@example.com", name: "Peter", status: "active" },
  organizationId: "org-interactor",
  membershipRole: "author",
  roles: ["author"],
  permissions: new Set<string>(),
};

vi.mock("@/lib/guard", () => ({
  requirePermission: vi.fn(async () => ({ actor, db: {}, via: "session" })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      create: (...a: unknown[]) => apiTokenCreate(...a),
      findMany: (...a: unknown[]) => apiTokenFindMany(...a),
    },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
  },
  isUniqueViolation: () => false,
}));

vi.mock("@/lib/tenant-db", () => ({
  tenantDb: () => ({
    site: {
      findMany: vi.fn().mockResolvedValue([
        { id: "s1", slug: "website", name: "Website", description: null, sort_order: 0 },
        { id: "s2", slug: "product-manager", name: "Product Manager", description: null, sort_order: 1 },
      ]),
    },
  }),
}));

vi.mock("@/lib/sites-server", () => ({
  orgSiteSlugs: vi.fn().mockResolvedValue(["website", "product-manager"]),
}));

import { GET, POST } from "./route";

const MEMBERSHIPS = [
  { organization_id: "org-interactor" },
  { organization_id: "org-blog" },
  { organization_id: "org-mysonceo" },
];

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/cms/tokens", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  apiTokenCreate.mockReset();
  apiTokenFindMany.mockReset();
  membershipFindMany.mockReset();
  membershipFindMany.mockResolvedValue(MEMBERSHIPS);
  apiTokenCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "t1",
    last_used_at: null,
    revoked_at: null,
    inserted_at: new Date(),
    organization: { id: data.organization_id, name: "Some Org", slug: "some-org" },
    ...data,
  }));
});

describe("POST /api/cms/tokens — organization binding", () => {
  it("binds the token to the organization asked for", async () => {
    const res = await post({ name: "MySonCEO MCP", organization_id: "org-mysonceo" });

    expect(res.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organization_id: "org-mysonceo" }),
      })
    );
  });

  it("refuses an organization the user is not a member of, without creating anything", async () => {
    const res = await post({ name: "Someone else's org", organization_id: "org-acme" });

    expect(res.status).toBe(403);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("falls back to the session's active organization when none is given", async () => {
    await post({ name: "Default" });

    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organization_id: "org-interactor" }),
      })
    );
  });

  it("refuses to mint for a user who belongs to no organization at all", async () => {
    // There would be no tenant to bind to, and an unbound token is refused at
    // request time anyway — better to say so at the point of creation.
    membershipFindMany.mockResolvedValue([]);

    const res = await post({ name: "Orphan" });

    expect(res.status).toBe(400);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("returns the organization alongside the one-time secret, so it can be labelled", async () => {
    const res = await post({ name: "Blog", organization_id: "org-blog" });
    const { data } = (await res.json()) as { data: Record<string, any> };

    expect(data.organization_id).toBe("org-blog");
    expect(data.organization.name).toBe("Some Org");
    expect(data.token).toMatch(/^cms_pat_/);
  });

  it("still requires a name", async () => {
    const res = await post({ organization_id: "org-blog" });

    expect(res.status).toBe(400);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("persists only the hash, never the raw token", async () => {
    const res = await post({ name: "Hashing" });
    const { data } = (await res.json()) as { data: Record<string, any> };
    const written = apiTokenCreate.mock.calls[0][0].data;

    expect(written.token_hash).toEqual(expect.any(String));
    expect(JSON.stringify(written)).not.toContain(data.token);
  });
});

describe("GET /api/cms/tokens", () => {
  it("lists each token with the organization it acts on", async () => {
    apiTokenFindMany.mockResolvedValue([
      {
        id: "t1",
        name: "Blog",
        token_prefix: "cms_pat_aaaa",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        inserted_at: new Date(),
        organization_id: "org-blog",
        organization: { id: "org-blog", name: "Personal Blog", slug: "personal-blog" },
      },
    ]);

    const { data } = (await (await GET()).json()) as { data: Array<Record<string, any>> };

    expect(data[0].organization).toEqual({
      id: "org-blog",
      name: "Personal Blog",
      slug: "personal-blog",
    });
  });

  it("renders a pre-binding token as unbound rather than hiding it", async () => {
    apiTokenFindMany.mockResolvedValue([
      {
        id: "t0",
        name: "Legacy",
        token_prefix: "cms_pat_old0",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        inserted_at: new Date(),
        organization_id: null,
        organization: null,
        site_scopes: [],
      },
    ]);

    const { data } = (await (await GET()).json()) as { data: Array<Record<string, any>> };

    expect(data[0].organization_id).toBeNull();
    expect(data[0].organization).toBeNull();
  });
});

describe("POST /api/cms/tokens — site scoping (G#21)", () => {
  it("creates a token with site scopes when specified", async () => {
    const res = await post({
      name: "Product-Manager only",
      organization_id: "org-interactor",
      site_scopes: ["product-manager"],
    });

    expect(res.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          site_scopes: ["product-manager"],
        }),
      })
    );
  });

  it("accepts multiple site scopes", async () => {
    const res = await post({
      name: "Multi-site token",
      organization_id: "org-interactor",
      site_scopes: ["website", "product-manager"],
    });

    expect(res.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          site_scopes: ["website", "product-manager"],
        }),
      })
    );
  });

  it("refuses site scopes with no valid slugs", async () => {
    const res = await post({
      name: "Invalid sites",
      organization_id: "org-interactor",
      site_scopes: ["nonexistent"],
    });

    expect(res.status).toBe(400);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("creates an unscoped token when site_scopes is empty or omitted", async () => {
    const res1 = await post({
      name: "Unscoped 1",
      organization_id: "org-interactor",
    });

    const res2 = await post({
      name: "Unscoped 2",
      organization_id: "org-interactor",
      site_scopes: [],
    });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          site_scopes: [],
        }),
      })
    );
    expect(apiTokenCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          site_scopes: [],
        }),
      })
    );
  });

  it("refuses a mix of known and unknown slugs instead of minting a narrower token", async () => {
    const res = await post({
      name: "Typo",
      organization_id: "org-interactor",
      site_scopes: ["product-manager", "prodcut-manager"],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("prodcut-manager");
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("refuses site_scopes that isn't a list", async () => {
    const res = await post({
      name: "Not a list",
      organization_id: "org-interactor",
      site_scopes: "product-manager",
    });

    expect(res.status).toBe(400);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it("includes site_scopes in the list response", async () => {
    apiTokenFindMany.mockResolvedValue([
      {
        id: "t1",
        name: "Scoped token",
        token_prefix: "cms_pat_aaaa",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        inserted_at: new Date(),
        organization_id: "org-blog",
        organization: { id: "org-blog", name: "Blog", slug: "blog" },
        site_scopes: ["website"],
      },
    ]);

    const { data } = (await (await GET()).json()) as { data: Array<Record<string, any>> };

    expect(data[0].site_scopes).toEqual(["website"]);
  });
});
