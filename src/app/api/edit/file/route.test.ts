import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { editKeyFromRequest, applyPostImport, postFindUnique, editKeyUpdate } = vi.hoisted(() => ({
  editKeyFromRequest: vi.fn(),
  applyPostImport: vi.fn(),
  postFindUnique: vi.fn(),
  editKeyUpdate: vi.fn(),
}));

vi.mock("@/lib/post-edit-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/post-edit-keys")>()),
  editKeyFromRequest,
}));
vi.mock("@/lib/post-sync", () => ({ applyPostImport }));
vi.mock("@/lib/db", () => ({ prisma: { postEditKey: { update: editKeyUpdate } } }));

import { GET, PUT } from "./route";

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
  platforms: ["website"],
  featured_image: null,
  featured_image_alt: null,
  meta_description: null,
  meta_keywords: null,
  content_format: "markdown",
  published_at: null,
  content: "Body",
  updated_at: UPDATED,
};

function auth(
  permissions: string[] = ["content:view", "content:edit"],
  siteScopes: string[] = [],
  lastWriteAt: Date | null = null
) {
  return {
    actor: { permissions: new Set(permissions) },
    db: { post: { findUnique: postFindUnique } },
    key: { id: "k1", post_id: "p1", site_scopes: siteScopes, last_write_at: lastWriteAt },
  };
}

function req(method: string, headers: Record<string, string> = {}, body?: string) {
  return new NextRequest("http://localhost/api/edit/file", { method, headers, body });
}

beforeEach(() => {
  editKeyFromRequest.mockReset();
  applyPostImport.mockReset();
  postFindUnique.mockReset().mockResolvedValue(post);
  editKeyUpdate.mockReset().mockResolvedValue({});
});

describe("GET /api/edit/file", () => {
  it("401s without a live edit key, saying the session ended", async () => {
    editKeyFromRequest.mockResolvedValue(null);
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/session has ended/);
  });

  it("returns the key's post as Markdown with an ETag, without content_hash", async () => {
    editKeyFromRequest.mockResolvedValue(auth());
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1790000000000"');
    const text = await res.text();
    expect(text).toContain("title: Hello");
    expect(text).not.toContain("content_hash");
    expect(postFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1" } }));
  });

  it("answers 304 when the caller already has this version", async () => {
    editKeyFromRequest.mockResolvedValue(auth());
    const res = await GET(req("GET", { "if-none-match": '"1790000000000"' }));
    expect(res.status).toBe(304);
  });

  it("honours the site scope copied from the minting token", async () => {
    editKeyFromRequest.mockResolvedValue(auth(undefined, ["product-manager"]));
    expect((await GET(req("GET"))).status).toBe(403);
  });
});

describe("PUT /api/edit/file", () => {
  const file = "---\nid: p1\ntitle: Hello again\nslug: hello\n---\nNew body\n";

  it("requires If-Match", async () => {
    editKeyFromRequest.mockResolvedValue(auth());
    expect((await PUT(req("PUT", {}, file))).status).toBe(428);
    expect(applyPostImport).not.toHaveBeenCalled();
  });

  it("409s when the post moved on, and names the current version", async () => {
    editKeyFromRequest.mockResolvedValue(auth());
    const res = await PUT(req("PUT", { "if-match": '"111"' }, file));
    expect(res.status).toBe(409);
    expect((await res.json()).version).toBe("1790000000000");
    expect(applyPostImport).not.toHaveBeenCalled();
  });

  it("needs content:edit", async () => {
    editKeyFromRequest.mockResolvedValue(auth(["content:view"]));
    expect((await PUT(req("PUT", { "if-match": '"1790000000000"' }, file))).status).toBe(403);
  });

  it("refuses a status change from the file", async () => {
    editKeyFromRequest.mockResolvedValue(auth());
    const res = await PUT(
      req("PUT", { "if-match": '"1790000000000"' }, file.replace("slug: hello", "slug: hello\nstatus: published"))
    );
    expect(res.status).toBe(400);
    expect(applyPostImport).not.toHaveBeenCalled();
  });

  it("saves through applyPostImport with the key's scope and returns the new version", async () => {
    editKeyFromRequest.mockResolvedValue(auth(undefined, ["website"]));
    applyPostImport.mockResolvedValue({ kind: "applied", post: {}, created: false });
    const saved = { ...post, title: "Hello again", updated_at: new Date(1_790_000_000_500) };
    postFindUnique.mockResolvedValueOnce(post).mockResolvedValueOnce(saved);

    const res = await PUT(req("PUT", { "if-match": '"1790000000000"' }, file));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1790000000500"');
    expect(await res.text()).toContain("title: Hello again");

    const call = applyPostImport.mock.calls[0][0];
    expect(call.siteScope).toEqual(["website"]);
    expect(call.raw).toContain("content_hash: h1"); // compare-and-set on the import
    expect(call.raw).toContain("id: p1");
    // First save of the session → one "writing" checkpoint, and the session
    // remembers it saved.
    expect(call.revision).toEqual({ snapshot: true, source: "writing" });
    expect(editKeyUpdate).toHaveBeenCalledWith({ where: { id: "k1" }, data: { last_write_at: expect.any(Date) } });
  });

  it("doesn't snapshot a revision for a save in the middle of a writing burst", async () => {
    editKeyFromRequest.mockResolvedValue(auth(undefined, [], new Date(Date.now() - 3_000)));
    applyPostImport.mockResolvedValue({ kind: "applied", post: {}, created: false });
    await PUT(req("PUT", { "if-match": '"1790000000000"' }, file));
    expect(applyPostImport.mock.calls[0][0].revision).toEqual({ snapshot: false, source: "writing" });
  });

  it("turns an import conflict (lost race) into a 409", async () => {
    editKeyFromRequest.mockResolvedValue(auth());
    applyPostImport.mockResolvedValue({ kind: "conflict", currentHash: "h2", conflict: {} });
    expect((await PUT(req("PUT", { "if-match": '"1790000000000"' }, file))).status).toBe(409);
  });
});
