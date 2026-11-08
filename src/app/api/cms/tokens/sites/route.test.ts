import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The token dialog's site list must be the sites of the org the token is
 * being minted FOR, and only ever for an org the caller belongs to.
 */

const orgSites = vi.fn();

const actor = {
  user: { id: "u1", email: "peter@example.com", name: "Peter", status: "active" },
  organizationId: "org-interactor",
  organizations: [
    { id: "org-interactor", name: "Interactor", slug: "interactor", role: "author" },
    { id: "org-blog", name: "Blog", slug: "blog", role: "owner" },
  ],
  membershipRole: "author",
  roles: ["author"],
  permissions: new Set<string>(),
};

vi.mock("@/lib/guard", () => ({
  requirePermission: vi.fn(async () => ({ actor, db: {}, via: "session" })),
}));
vi.mock("@/lib/tenant-db", () => ({ tenantDb: (orgId: string) => ({ orgId }) }));
vi.mock("@/lib/sites-server", () => ({ orgSites: (...a: unknown[]) => orgSites(...a) }));

import { GET } from "./route";

function get(query = "") {
  return GET(new NextRequest(`http://localhost/api/cms/tokens/sites${query}`));
}

beforeEach(() => {
  orgSites.mockReset();
  orgSites.mockResolvedValue([{ id: "s1", slug: "blog-site", name: "Blog site" }]);
});

describe("GET /api/cms/tokens/sites", () => {
  it("lists the sites of the organization asked for, not the active one", async () => {
    const res = await get("?organization_id=org-blog");

    expect(res.status).toBe(200);
    expect(orgSites).toHaveBeenCalledWith({ orgId: "org-blog" });
    expect((await res.json()).data).toEqual([{ id: "s1", slug: "blog-site", name: "Blog site" }]);
  });

  it("defaults to the active organization", async () => {
    await get();
    expect(orgSites).toHaveBeenCalledWith({ orgId: "org-interactor" });
  });

  it("refuses an organization the caller is not a member of, without reading it", async () => {
    const res = await get("?organization_id=org-acme");

    expect(res.status).toBe(403);
    expect(orgSites).not.toHaveBeenCalled();
  });
});
