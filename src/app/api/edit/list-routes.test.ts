import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { browseKeyFromRequest, mintEditKey, postFindMany, postFindUnique, trashFindMany } = vi.hoisted(() => ({
  browseKeyFromRequest: vi.fn(),
  mintEditKey: vi.fn(),
  postFindMany: vi.fn(),
  postFindUnique: vi.fn(),
  trashFindMany: vi.fn(),
}));

vi.mock("@/lib/post-browse-keys", () => ({ browseKeyFromRequest }));
vi.mock("@/lib/post-edit-keys", () => ({ mintEditKey }));

import { GET as listPosts } from "./posts/route";
import { POST as openPost } from "./open/route";

function auth(over: { site?: string | null; scopes?: string[]; perms?: string[]; userId?: string } = {}) {
  return {
    actor: {
      user: { id: over.userId ?? "u1", email: "writer@example.com" },
      permissions: new Set(over.perms ?? ["content:view", "content:edit"]),
      roles: ["author"],
      isSuperAdmin: false,
      organizations: [{ id: "org-blog", name: "Peter Jung" }],
    },
    db: {
      post: { findMany: postFindMany, findUnique: postFindUnique, count: async () => 1 },
      deletedPost: { findMany: trashFindMany, count: async () => 2, deleteMany: async () => ({ count: 0 }) },
    },
    key: {
      id: "bk1",
      api_token_id: "tok-personal",
      site_scopes: over.scopes ?? [],
      site: over.site === undefined ? "acme-site" : over.site,
      organization_id: "org-blog",
    },
  };
}

const post = { id: "p1", title: "Hello", platforms: ["acme-site"], author_id: "u1", author_name: "Peter" };
const req = (url: string, init: { method?: string; body?: string } = {}) =>
  new NextRequest(url, { ...init, headers: { authorization: "Bearer cms_list_x", "content-type": "application/json" } });

beforeEach(() => {
  browseKeyFromRequest.mockReset().mockResolvedValue(auth());
  mintEditKey.mockReset().mockResolvedValue({ key: "cms_edit_new", expiresAt: new Date() });
  postFindMany.mockReset().mockResolvedValue([{ ...post, excerpt: null, status: "draft", workflow_status: "draft", content_format: "markdown", updated_at: new Date(0) }]);
  postFindUnique.mockReset().mockResolvedValue(post);
  trashFindMany.mockReset().mockResolvedValue([
    {
      id: "t1",
      post_id: "p9",
      title: "Fatherhood",
      slug: "fatherhood",
      status: "draft",
      platforms: ["acme-site"],
      deleted_at: new Date("2026-09-20T00:00:00Z"),
      deleted_by_name: "Peter",
    },
  ]);
});

describe("GET /api/edit/posts (the writer's post list)", () => {
  it("lists the key's site, names the account and organization", async () => {
    const res = await listPosts(req("http://x/api/edit/posts"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ account: "writer@example.com", organization: "Peter Jung", site: "acme-site", view: "all" });
    expect(data.counts).toEqual({ all: 1, drafts: 1, review: 1, published: 1, trash: 2 });
    expect(postFindMany.mock.calls[0][0].where.AND).toContainEqual({ platforms: { has: "acme-site" } });
  });

  it("applies the search and the minting token's site scope", async () => {
    browseKeyFromRequest.mockResolvedValue(auth({ site: null, scopes: ["acme-site"] }));
    await listPosts(req("http://x/api/edit/posts?search=layoffs"));
    const where = postFindMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ platforms: { hasSome: ["acme-site"] } });
    expect(JSON.stringify(where.AND)).toContain("layoffs");
  });

  it("filters by tab", async () => {
    await listPosts(req("http://x/api/edit/posts?view=published"));
    expect(postFindMany.mock.calls[0][0].where.AND).toContainEqual({ status: "published" });
    await listPosts(req("http://x/api/edit/posts?view=review"));
    expect(postFindMany.mock.calls[1][0].where.AND).toContainEqual({
      status: { not: "published" },
      workflow_status: "pending_review",
    });
  });

  it("lists the trash on the Trash tab, narrowed the same way", async () => {
    const res = await listPosts(req("http://x/api/edit/posts?view=trash"));
    const { data } = await res.json();
    expect(postFindMany).not.toHaveBeenCalled();
    expect(trashFindMany.mock.calls[0][0].where.AND).toContainEqual({ platforms: { has: "acme-site" } });
    expect(data.trash[0]).toMatchObject({ id: "t1", title: "Fatherhood", deleted_by: "Peter" });
    expect(data.trash[0].expires_at).toBe("2026-10-20T00:00:00.000Z");
  });

  it("401s an expired or unknown list key", async () => {
    browseKeyFromRequest.mockResolvedValue(null);
    const res = await listPosts(req("http://x/api/edit/posts"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/Ask Claude to show your posts again/);
  });
});

describe("POST /api/edit/open (open a post from the list)", () => {
  const open = (body: unknown) => openPost(req("http://x/api/edit/open", { method: "POST", body: JSON.stringify(body) }));

  it("mints an edit key tied to the same connection, as a list session", async () => {
    const res = await open({ post_id: "p1" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.edit_key).toBe("cms_edit_new");
    expect(mintEditKey).toHaveBeenCalledWith(
      expect.objectContaining({ postId: "p1", organizationId: "org-blog", apiTokenId: "tok-personal", source: "list" })
    );
  });

  it("refuses a post outside the list's site, or outside the token's scope", async () => {
    postFindUnique.mockResolvedValue({ ...post, platforms: ["website"] });
    expect((await open({ post_id: "p1" })).status).toBe(403);
    browseKeyFromRequest.mockResolvedValue(auth({ site: null, scopes: ["acme-site"] }));
    postFindUnique.mockResolvedValue({ ...post, platforms: ["acme-site", "website"] });
    expect((await open({ post_id: "p1" })).status).toBe(403);
    expect(mintEditKey).not.toHaveBeenCalled();
  });

  it("needs content:edit and a post this person may edit", async () => {
    browseKeyFromRequest.mockResolvedValue(auth({ perms: ["content:view"] }));
    expect((await open({ post_id: "p1" })).status).toBe(403);
    browseKeyFromRequest.mockResolvedValue(auth({ userId: "someone-else" }));
    expect((await open({ post_id: "p1" })).status).toBe(403);
    expect(mintEditKey).not.toHaveBeenCalled();
  });

  it("404s a missing post and 401s a dead key", async () => {
    postFindUnique.mockResolvedValue(null);
    expect((await open({ post_id: "gone" })).status).toBe(404);
    browseKeyFromRequest.mockResolvedValue(null);
    expect((await open({ post_id: "p1" })).status).toBe(401);
  });
});
