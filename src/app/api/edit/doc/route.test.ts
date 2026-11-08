import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { editKeyFromRequest, applyPostImport, postFindUnique, editKeyUpdate, editKeyUpdateMany, trashPosts } = vi.hoisted(
  () => ({
    editKeyFromRequest: vi.fn(),
    applyPostImport: vi.fn(),
    postFindUnique: vi.fn(),
    editKeyUpdate: vi.fn(),
    editKeyUpdateMany: vi.fn(),
    trashPosts: vi.fn(),
  })
);

vi.mock("@/lib/post-edit-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/post-edit-keys")>()),
  editKeyFromRequest,
}));
vi.mock("@/lib/post-sync", () => ({ applyPostImport }));
vi.mock("@/lib/db", () => ({ prisma: { postEditKey: { update: editKeyUpdate, updateMany: editKeyUpdateMany } } }));
vi.mock("@/lib/post-trash", () => ({ trashPosts }));

import { DELETE, GET, PUT } from "./route";

const post = {
  id: "p1",
  organization_id: "org1",
  content_hash: "h1",
  title: "Hello",
  slug: "hello",
  status: "draft",
  workflow_status: "pending_review",
  type: "blog",
  excerpt: "Short",
  category: { slug: "tech" },
  tags: ["seo"],
  platforms: ["website"],
  featured_image: null,
  featured_image_alt: null,
  meta_description: "Meta",
  meta_keywords: null,
  content_format: "markdown",
  published_at: null,
  content: "Body text",
  metadata: { verify_every_days: 90 },
  updated_at: new Date(1_790_000_000_000),
};

const auth = {
  actor: {
    permissions: new Set(["content:view", "content:edit"]),
    user: { email: "admin@example.com" },
    organizations: [{ id: "org1", name: "Interactor" }],
  },
  db: { post: { findUnique: postFindUnique } },
  key: { id: "k1", post_id: "p1", site_scopes: [], last_write_at: null },
};

function req(method: string, headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest("http://localhost/api/edit/doc", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  editKeyFromRequest.mockReset().mockResolvedValue(auth);
  applyPostImport.mockReset();
  postFindUnique.mockReset().mockResolvedValue(post);
  editKeyUpdate.mockReset().mockResolvedValue({});
  editKeyUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  trashPosts.mockReset().mockResolvedValue(1);
});

describe("GET /api/edit/doc", () => {
  it("returns the editor's fields and the version", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1790000000000"');
    expect((await res.json()).data).toEqual({
      version: "1790000000000",
      account: "admin@example.com",
      organization: "Interactor",
      title: "Hello",
      excerpt: "Short",
      body: "Body text",
      content_format: "markdown",
      slug: "hello",
      status: "draft",
      workflow_status: "pending_review",
      platforms: ["website"],
      post_id: "p1",
      details: {
        slug: "hello",
        category: "tech",
        tags: ["seo"],
        platforms: ["website"],
        featured_image: "",
        featured_image_alt: "",
        meta_description: "Meta",
        meta_keywords: "",
      },
    });
  });

  it("answers 304 when the page already has this version", async () => {
    expect((await GET(req("GET", { "if-none-match": '"1790000000000"' }))).status).toBe(304);
  });

  it("401s without a live key", async () => {
    editKeyFromRequest.mockResolvedValue(null);
    expect((await GET(req("GET"))).status).toBe(401);
  });
});

describe("PUT /api/edit/doc", () => {
  const ifMatch = { "if-match": '"1790000000000"', "content-type": "application/json" };

  it("saves title, excerpt and body, keeping every frontmatter key the page doesn't show", async () => {
    applyPostImport.mockResolvedValue({ kind: "applied", post: {}, created: false });
    const res = await PUT(req("PUT", ifMatch, { title: "Hello again", excerpt: "New", body: "New body" }));
    expect(res.status).toBe(200);
    const raw: string = applyPostImport.mock.calls[0][0].raw;
    expect(raw).toContain("title: Hello again");
    expect(raw).toContain("excerpt: New");
    expect(raw).toContain("New body");
    // Untouched frontmatter survives: tags, category, sites, SEO, preserved metadata.
    for (const kept of ["- seo", "category: tech", "- website", "meta_description: Meta", "verify_every_days: 90"]) {
      expect(raw).toContain(kept);
    }
    expect(applyPostImport.mock.calls[0][0].revision).toEqual({ snapshot: true, source: "writing" });
  });

  it("requires If-Match and refuses a stale version", async () => {
    expect((await PUT(req("PUT", { "content-type": "application/json" }, { body: "x" }))).status).toBe(428);
    expect((await PUT(req("PUT", { "if-match": '"1"' }, { body: "x" }))).status).toBe(409);
    expect(applyPostImport).not.toHaveBeenCalled();
  });

  it("refuses an empty title and a missing body", async () => {
    expect((await PUT(req("PUT", ifMatch, { title: "  ", body: "x" }))).status).toBe(400);
    expect((await PUT(req("PUT", ifMatch, { title: "T" }))).status).toBe(400);
  });

  it("won't edit an HTML-format post, which the Markdown editor can't represent", async () => {
    postFindUnique.mockResolvedValue({ ...post, content_format: "html" });
    expect((await PUT(req("PUT", ifMatch, { body: "x" }))).status).toBe(409);
    expect(applyPostImport).not.toHaveBeenCalled();
  });
});

describe("PUT /api/edit/doc — the Details panel", () => {
  const ifMatch = { "if-match": '"1790000000000"', "content-type": "application/json" };
  const put = (details: unknown) => PUT(req("PUT", ifMatch, { body: "Body text", details }));

  it("writes changed details into the file and leaves the rest as they are", async () => {
    applyPostImport.mockResolvedValue({ kind: "applied", post: {}, created: false });
    const res = await put({
      slug: "hello-world",
      tags: ["seo", "ai"],
      featured_image: "https://cdn.example.com/a.png",
      featured_image_alt: "A picture",
    });
    expect(res.status).toBe(200);
    const raw: string = applyPostImport.mock.calls[0][0].raw;
    for (const expected of ["slug: hello-world", "- ai", "featured_image_alt: A picture"]) expect(raw).toContain(expected);
    expect(raw).toMatch(/featured_image: '?https:\/\/cdn\.example\.com\/a\.png'?/);
    for (const kept of ["category: tech", "meta_description: Meta", "- website"]) expect(raw).toContain(kept);
    // Nothing from an earlier save of the same post leaks in.
    expect(raw).toContain("title: Hello\n");
  });

  it("writes an emptied field as empty, which the import clears", async () => {
    applyPostImport.mockResolvedValue({ kind: "applied", post: {}, created: false });
    await put({ category: "", meta_description: "" });
    const raw: string = applyPostImport.mock.calls[0][0].raw;
    expect(raw).toMatch(/category: ''/);
    expect(raw).toMatch(/meta_description: ''/);
  });

  it("refuses a malformed slug, no sites, and wrong types before writing anything", async () => {
    expect((await put({ slug: "Hello World" })).status).toBe(400);
    expect((await put({ platforms: [] })).status).toBe(400);
    expect((await put({ tags: "seo" })).status).toBe(400);
    expect((await put({ featured_image: 5 })).status).toBe(400);
    expect(applyPostImport).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/edit/doc (Move to trash)", () => {
  it("moves the post to the trash and ends every session on it", async () => {
    editKeyFromRequest.mockResolvedValue({
      ...auth,
      actor: { ...auth.actor, permissions: new Set(["content:view", "content:edit", "content:delete"]) },
    });
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(204);
    expect(trashPosts.mock.calls[0][1]).toEqual([post]);
    expect(editKeyUpdateMany.mock.calls[0][0].where).toMatchObject({ post_id: "p1", revoked_at: null });
  });

  it("needs content:delete", async () => {
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    expect(trashPosts).not.toHaveBeenCalled();
  });
});
