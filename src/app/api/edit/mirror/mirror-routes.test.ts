import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mirrorKeyFromRequest, applyPostImport, postFindMany, postFindUnique, trashFindMany, keyUpdate } = vi.hoisted(() => ({
  mirrorKeyFromRequest: vi.fn(),
  applyPostImport: vi.fn(),
  postFindMany: vi.fn(),
  postFindUnique: vi.fn(),
  trashFindMany: vi.fn(),
  keyUpdate: vi.fn(),
}));

vi.mock("@/lib/post-browse-keys", () => ({ mirrorKeyFromRequest }));
vi.mock("@/lib/post-sync", () => ({ applyPostImport }));
vi.mock("@/lib/db", () => ({ prisma: { postBrowseKey: { update: keyUpdate }, postEditKey: { update: vi.fn() } } }));

import { GET as listPosts } from "./posts/route";
import { GET as getFile, PUT as putFile } from "./file/route";
import { DELETE as endMirror } from "./session/route";

const UPDATED = new Date(1_790_000_000_000);
const post = {
  id: "p1",
  content_hash: "h1",
  title: "Hello",
  slug: "hello",
  status: "draft",
  type: "blog",
  excerpt: null,
  category: null,
  tags: [],
  platforms: ["acme-site"],
  featured_image: null,
  featured_image_alt: null,
  meta_description: null,
  meta_keywords: null,
  seo_title: null,
  canonical_url: null,
  og_image: null,
  og_image_alt: null,
  noindex: false,
  answer_summary: null,
  redirect_to: null,
  content_format: "markdown",
  published_at: null,
  content: "Body",
  updated_at: UPDATED,
  author_id: "u1",
  author_name: "Peter",
};

function auth(over: { site?: string | null; scopes?: string[]; perms?: string[] } = {}) {
  return {
    actor: {
      user: { id: "u1", email: "writer@example.com" },
      permissions: new Set(over.perms ?? ["content:view", "content:edit"]),
      organizations: [{ id: "org-blog", name: "Peter Jung", slug: "peterjung" }],
    },
    db: { post: { findMany: postFindMany, findUnique: postFindUnique }, deletedPost: { findMany: trashFindMany } },
    key: {
      id: "mk1",
      api_token_id: "tok",
      site_scopes: over.scopes ?? [],
      site: over.site === undefined ? "acme-site" : over.site,
      organization_id: "org-blog",
    },
  };
}

const req = (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(url, { ...init, headers: { authorization: "Bearer cms_mirror_x", ...init.headers } });

beforeEach(() => {
  mirrorKeyFromRequest.mockReset().mockResolvedValue(auth());
  applyPostImport.mockReset();
  postFindMany.mockReset().mockResolvedValue([{ id: "p1", slug: "hello", status: "draft", updated_at: UPDATED }]);
  postFindUnique.mockReset().mockResolvedValue(post);
  trashFindMany.mockReset().mockResolvedValue([{ post_id: "p9" }]);
  keyUpdate.mockReset().mockResolvedValue({});
});

describe("GET /api/edit/mirror/posts", () => {
  it("refuses without a live mirror key", async () => {
    mirrorKeyFromRequest.mockResolvedValue(null);
    expect((await listPosts(req("http://x/api/edit/mirror/posts"))).status).toBe(401);
  });

  it("lists the workspace's posts with filename and version, and the trash", async () => {
    const res = await listPosts(req("http://x/api/edit/mirror/posts"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ account: "writer@example.com", organization: "peterjung", site: "acme-site", next_cursor: null });
    expect(data.posts).toEqual([{ id: "p1", filename: "hello.md", version: String(UPDATED.getTime()), status: "draft" }]);
    expect(data.trashed).toEqual(["p9"]);
    const where = postFindMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ platforms: { has: "acme-site" } });
    expect(trashFindMany.mock.calls[0][0].where).toEqual(where);
  });

  it("narrows to the minting token's site scope", async () => {
    mirrorKeyFromRequest.mockResolvedValue(auth({ site: null, scopes: ["acme-site"] }));
    await listPosts(req("http://x/api/edit/mirror/posts"));
    expect(postFindMany.mock.calls[0][0].where.AND).toContainEqual({ platforms: { hasSome: ["acme-site"] } });
  });

  it("answers 304 when the page hasn't changed", async () => {
    const first = await listPosts(req("http://x/api/edit/mirror/posts"));
    const etag = first.headers.get("etag")!;
    const again = await listPosts(req("http://x/api/edit/mirror/posts", { headers: { "if-none-match": etag } }));
    expect(again.status).toBe(304);
    postFindMany.mockResolvedValue([{ id: "p1", slug: "hello", status: "draft", updated_at: new Date(UPDATED.getTime() + 1) }]);
    const moved = await listPosts(req("http://x/api/edit/mirror/posts", { headers: { "if-none-match": etag } }));
    expect(moved.status).toBe(200);
  });

  it("pages by id with a cursor, trash on the first page only", async () => {
    postFindMany.mockResolvedValue([
      { id: "a", slug: "a", status: "draft", updated_at: UPDATED },
      { id: "b", slug: "b", status: "draft", updated_at: UPDATED },
    ]);
    const { data } = await (await listPosts(req("http://x/api/edit/mirror/posts?limit=1"))).json();
    expect(data.posts.map((p: { id: string }) => p.id)).toEqual(["a"]);
    expect(data.next_cursor).toBe("a");
    trashFindMany.mockClear();
    await listPosts(req("http://x/api/edit/mirror/posts?cursor=a"));
    expect(postFindMany.mock.calls[1][0]).toMatchObject({ cursor: { id: "a" }, skip: 1 });
    expect(trashFindMany).not.toHaveBeenCalled();
  });
});

describe("/api/edit/mirror/file", () => {
  it("serves a post of the workspace as the same file live-sync gets", async () => {
    const res = await getFile(req("http://x/api/edit/mirror/file?id=p1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${UPDATED.getTime()}"`);
    const text = await res.text();
    expect(text).toContain("title: Hello");
    expect(text).not.toContain("content_hash");
  });

  it("answers 304 for an unchanged version", async () => {
    const res = await getFile(req("http://x/api/edit/mirror/file?id=p1", { headers: { "if-none-match": `"${UPDATED.getTime()}"` } }));
    expect(res.status).toBe(304);
  });

  it("treats a post on another site as gone from this workspace", async () => {
    postFindUnique.mockResolvedValue({ ...post, platforms: ["other-site"] });
    expect((await getFile(req("http://x/api/edit/mirror/file?id=p1"))).status).toBe(404);
  });

  it("refuses a save without content:edit", async () => {
    mirrorKeyFromRequest.mockResolvedValue(auth({ perms: ["content:view"] }));
    const res = await putFile(req("http://x/api/edit/mirror/file?id=p1", { method: "PUT", body: "x", headers: { "if-match": `"${UPDATED.getTime()}"` } }));
    expect(res.status).toBe(403);
    expect(applyPostImport).not.toHaveBeenCalled();
  });

  it("refuses to save someone else's post without content:edit_any", async () => {
    postFindUnique.mockResolvedValue({ ...post, author_id: "someone-else", author_name: "Claire" });
    const res = await putFile(req("http://x/api/edit/mirror/file?id=p1", { method: "PUT", body: "x", headers: { "if-match": `"${UPDATED.getTime()}"` } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Claire");
  });

  it("refuses a save of a post that also targets a site outside the token's scope", async () => {
    mirrorKeyFromRequest.mockResolvedValue(auth({ site: null, scopes: ["acme-site"] }));
    postFindUnique.mockResolvedValue({ ...post, platforms: ["acme-site", "other-site"] });
    const res = await putFile(req("http://x/api/edit/mirror/file?id=p1", { method: "PUT", body: "x", headers: { "if-match": `"${UPDATED.getTime()}"` } }));
    expect(res.status).toBe(403);
  });

  it("answers 409 when the post moved on since the file's version", async () => {
    const res = await putFile(req("http://x/api/edit/mirror/file?id=p1", { method: "PUT", body: "x", headers: { "if-match": `"1"` } }));
    expect(res.status).toBe(409);
  });

  it("refuses a status change from the file", async () => {
    const raw = "---\nid: p1\ntitle: Hello\nstatus: published\n---\nBody\n";
    const res = await putFile(req("http://x/api/edit/mirror/file?id=p1", { method: "PUT", body: raw, headers: { "if-match": `"${UPDATED.getTime()}"` } }));
    expect(res.status).toBe(400);
    expect(applyPostImport).not.toHaveBeenCalled();
  });

  it("saves through the shared import, pinned to the post, checkpointing after a pause", async () => {
    const saved = { ...post, content: "New", updated_at: new Date(UPDATED.getTime() + 5000) };
    applyPostImport.mockResolvedValue({ kind: "applied", post: saved, created: false });
    postFindUnique.mockResolvedValueOnce(post).mockResolvedValueOnce(saved);
    const raw = "---\nid: p1\ntitle: Hello\nstatus: draft\n---\nNew\n";
    const res = await putFile(req("http://x/api/edit/mirror/file?id=p1", { method: "PUT", body: raw, headers: { "if-match": `"${UPDATED.getTime()}"` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${saved.updated_at.getTime()}"`);
    const call = applyPostImport.mock.calls[0][0];
    expect(call.raw).toContain("id: p1");
    expect(call.raw).toContain("content_hash: h1");
    expect(call.revision.source).toBe("writing");
  });
});

describe("DELETE /api/edit/mirror/session", () => {
  it("revokes the mirror key, idempotently", async () => {
    expect((await endMirror(req("http://x/api/edit/mirror/session", { method: "DELETE" }))).status).toBe(204);
    expect(keyUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mk1" } }));
    mirrorKeyFromRequest.mockResolvedValue(null);
    expect((await endMirror(req("http://x/api/edit/mirror/session", { method: "DELETE" }))).status).toBe(204);
  });
});
