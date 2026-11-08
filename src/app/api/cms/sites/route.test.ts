import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const siteFindMany = vi.fn();
const siteFindUnique = vi.fn();
const siteCreate = vi.fn();
const siteUpdate = vi.fn();
const siteDelete = vi.fn();
const postFindMany = vi.fn();
const postCount = vi.fn();

const db = {
  site: {
    findMany: (...a: unknown[]) => siteFindMany(...a),
    findUnique: (...a: unknown[]) => siteFindUnique(...a),
    create: (...a: unknown[]) => siteCreate(...a),
    update: (...a: unknown[]) => siteUpdate(...a),
    delete: (...a: unknown[]) => siteDelete(...a),
  },
  post: {
    findMany: (...a: unknown[]) => postFindMany(...a),
    count: (...a: unknown[]) => postCount(...a),
  },
};

const permissions = new Set<string>();

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: NextRequest, ...perms: string[]) => {
    const { NextResponse } = await import("next/server");
    const missing = perms.filter((p) => !permissions.has(p));
    if (missing.length > 0) {
      return {
        error: NextResponse.json(
          { error: "Forbidden", missing_permissions: missing },
          { status: 403 }
        ),
      };
    }
    return { db };
  }),
}));

vi.mock("@/lib/db", () => ({ isUniqueViolation: (e: unknown) => e === "dup" }));

import { GET, POST } from "./route";
import { PUT, DELETE } from "./[id]/route";

function req(body?: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/cms/sites", {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: "site-1" }) };

beforeEach(() => {
  for (const m of [
    siteFindMany,
    siteFindUnique,
    siteCreate,
    siteUpdate,
    siteDelete,
    postFindMany,
    postCount,
  ]) {
    m.mockReset();
  }
  siteFindMany.mockResolvedValue([]);
  postFindMany.mockResolvedValue([]);
  permissions.clear();
  permissions.add("content:view");
  permissions.add("categories:manage");
});

describe("GET /api/cms/sites", () => {
  it("returns nothing for a brand-new org with no registered sites and no posts", async () => {
    const body = await (await GET(req(undefined, "GET"))).json();
    expect(body.data).toEqual([]);
  });

  it("folds in a slug that posts use but nobody registered", async () => {
    postFindMany.mockResolvedValue([{ platforms: ["website", "intranet"] }]);
    const body = await (await GET(req(undefined, "GET"))).json();
    const slugs = body.data.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain("intranet");
  });

  it("lets a registered row override an in-use slug of the same name", async () => {
    postFindMany.mockResolvedValue([{ platforms: ["website"] }]);
    siteFindMany.mockResolvedValue([
      {
        id: "site-1",
        slug: "website",
        name: "Marketing Site",
        description: null,
        url: "https://marketing.example.com",
        sort_order: 0,
      },
    ]);
    const body = await (await GET(req(undefined, "GET"))).json();
    const website = body.data.filter((s: { slug: string }) => s.slug === "website");
    expect(website).toHaveLength(1);
    expect(website[0].name).toBe("Marketing Site");
  });

  it("403s without content:view", async () => {
    permissions.delete("content:view");
    expect((await GET(req(undefined, "GET"))).status).toBe(403);
  });
});

describe("POST /api/cms/sites", () => {
  const url = "https://docs.example.com";

  it("registers a site, defaulting the name from the slug", async () => {
    siteCreate.mockResolvedValue({ id: "s1", slug: "docs-site", name: "Docs Site", url });
    const res = await POST(req({ site: { slug: "docs-site", url } }));
    expect(res.status).toBe(201);
    expect(siteCreate.mock.calls[0][0].data.name).toBe("Docs Site");
    expect(siteCreate.mock.calls[0][0].data.url).toBe(url);
  });

  it("rejects a slug that would not survive a URL or frontmatter file", async () => {
    for (const bad of ["Docs Site", "docs_site", "", "-leading"]) {
      const res = await POST(req({ site: { slug: bad, url } }));
      expect(res.status).toBe(400);
    }
    expect(siteCreate).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid URL", async () => {
    for (const bad of [undefined, "", "not-a-url"]) {
      const res = await POST(req({ site: { slug: "docs-site", url: bad } }));
      expect(res.status).toBe(400);
    }
    expect(siteCreate).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate as 409 rather than a 500", async () => {
    siteCreate.mockRejectedValue("dup");
    const res = await POST(req({ site: { slug: "website", name: "Website", url } }));
    expect(res.status).toBe(409);
  });

  it("403s without categories:manage", async () => {
    permissions.delete("categories:manage");
    const res = await POST(req({ site: { slug: "docs-site", url } }));
    expect(res.status).toBe(403);
    expect(siteCreate).not.toHaveBeenCalled();
  });

  it("generates a working IndexNow key for a brand-new site (G#34)", async () => {
    siteCreate.mockResolvedValue({ id: "s1", slug: "docs-site", name: "Docs Site", url });
    await POST(req({ site: { slug: "docs-site", url } }));

    const key = siteCreate.mock.calls[0][0].data.indexnow_key;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("PUT /api/cms/sites/[id]", () => {
  it("renames a registered site without touching its slug or url", async () => {
    siteFindUnique.mockResolvedValue({
      id: "site-1",
      slug: "docs-site",
      name: "Docs",
      url: "https://docs.example.com",
    });
    siteUpdate.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs Site" });

    const res = await PUT(req({ site: { name: "Docs Site" } }, "PUT"), ctx);

    expect(res.status).toBe(200);
    expect(siteUpdate.mock.calls[0][0].data.slug).toBe("docs-site");
    expect(siteUpdate.mock.calls[0][0].data.name).toBe("Docs Site");
    expect(siteUpdate.mock.calls[0][0].data.url).toBe("https://docs.example.com");
  });

  it("updates the url", async () => {
    siteFindUnique.mockResolvedValue({
      id: "site-1",
      slug: "docs-site",
      name: "Docs",
      url: "https://old.example.com",
    });
    siteUpdate.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs" });

    const res = await PUT(
      req({ site: { url: "https://new.example.com" } }, "PUT"),
      ctx
    );

    expect(res.status).toBe(200);
    expect(siteUpdate.mock.calls[0][0].data.url).toBe("https://new.example.com");
  });

  it("rejects an invalid url", async () => {
    siteFindUnique.mockResolvedValue({
      id: "site-1",
      slug: "docs-site",
      name: "Docs",
      url: "https://old.example.com",
    });

    const res = await PUT(req({ site: { url: "not-a-url" } }, "PUT"), ctx);

    expect(res.status).toBe(400);
    expect(siteUpdate).not.toHaveBeenCalled();
  });

  /**
   * A virtual in-use entry has no row: the tenant-scoped findUnique misses,
   * so it 404s instead of pretending to edit something that isn't stored.
   */
  it("404s for an id with no row behind it", async () => {
    siteFindUnique.mockResolvedValue(null);
    const res = await PUT(req({ site: { name: "Nope" } }, "PUT"), ctx);
    expect(res.status).toBe(404);
    expect(siteUpdate).not.toHaveBeenCalled();
  });

  it("403s without categories:manage", async () => {
    permissions.delete("categories:manage");
    const res = await PUT(req({ site: { name: "X" } }, "PUT"), ctx);
    expect(res.status).toBe(403);
  });

  it("lets an org bring its own already-verified IndexNow key", async () => {
    siteFindUnique.mockResolvedValue({
      id: "site-1",
      slug: "docs-site",
      name: "Docs",
      url: "https://docs.example.com",
    });
    siteUpdate.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs" });

    await PUT(req({ site: { indexnow_key: "already-verified-key" } }, "PUT"), ctx);

    expect(siteUpdate.mock.calls[0][0].data.indexnow_key).toBe("already-verified-key");
  });

  it("clears the IndexNow key back to null on an empty string, for the public endpoint to regenerate", async () => {
    siteFindUnique.mockResolvedValue({
      id: "site-1",
      slug: "docs-site",
      name: "Docs",
      url: "https://docs.example.com",
    });
    siteUpdate.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs" });

    await PUT(req({ site: { indexnow_key: "" } }, "PUT"), ctx);

    expect(siteUpdate.mock.calls[0][0].data.indexnow_key).toBeNull();
  });

  it("also clears the IndexNow key to a real null on an explicit JSON null, not the 4-char string \"null\"", async () => {
    // `String(null)` is the truthy string "null" — stringifying BEFORE
    // checking for an explicit null would persist that literal text as if
    // it were a real key, and getOrCreateSiteIndexNowKey's `if
    // (site.indexnow_key) return site.indexnow_key;` would then never
    // regenerate a working one.
    siteFindUnique.mockResolvedValue({
      id: "site-1",
      slug: "docs-site",
      name: "Docs",
      url: "https://docs.example.com",
    });
    siteUpdate.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs" });

    await PUT(req({ site: { indexnow_key: null } }, "PUT"), ctx);

    expect(siteUpdate.mock.calls[0][0].data.indexnow_key).toBeNull();
  });
});

describe("DELETE /api/cms/sites/[id]", () => {
  /**
   * Post.platforms has no FK to sites, so nothing in the database stops this
   * delete — without the count check the posts would keep publishing to a slug
   * the editor no longer offers.
   */
  it("refuses while posts still target the site, and says how many", async () => {
    siteFindUnique.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs Site" });
    postCount.mockResolvedValue(3);

    const res = await DELETE(req(undefined, "DELETE"), ctx);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/3 posts still target/i);
    expect(siteDelete).not.toHaveBeenCalled();
  });

  it("removes a site nothing targets", async () => {
    siteFindUnique.mockResolvedValue({ id: "site-1", slug: "docs-site", name: "Docs Site" });
    postCount.mockResolvedValue(0);

    const res = await DELETE(req(undefined, "DELETE"), ctx);

    expect(res.status).toBe(204);
    expect(siteDelete).toHaveBeenCalledWith({ where: { id: "site-1" } });
  });

  it("403s without categories:manage", async () => {
    permissions.delete("categories:manage");
    const res = await DELETE(req(undefined, "DELETE"), ctx);
    expect(res.status).toBe(403);
    expect(siteDelete).not.toHaveBeenCalled();
  });
});
