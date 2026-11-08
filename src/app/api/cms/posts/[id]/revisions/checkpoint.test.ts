import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { requirePermissionApi, postFindUnique, revFindFirst, revCreate, revUpdate } = vi.hoisted(() => ({
  requirePermissionApi: vi.fn(),
  postFindUnique: vi.fn(),
  revFindFirst: vi.fn(),
  revCreate: vi.fn(),
  revUpdate: vi.fn(),
}));

vi.mock("@/lib/guard", () => ({ requirePermissionApi }));
vi.mock("@/lib/post-revisions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/post-revisions")>()),
  pruneOldRevisions: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";

const post = {
  id: "p1",
  title: "Hello",
  content: "Body",
  content_format: "markdown",
  content_html: "<p>Body</p>",
  excerpt: null,
  content_hash: "h1",
  author_id: "u1",
  author_name: "Ada",
  platforms: ["website"],
};
const meta = {
  id: "r1",
  title: "Hello",
  source: "checkpoint",
  label: "Before the rewrite",
  inserted_at: new Date("2026-09-23T12:00:00Z"),
  edited_by: null,
};

function call(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/cms/posts/p1/revisions", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "p1" }) }
  );
}

beforeEach(() => {
  for (const f of [postFindUnique, revFindFirst, revCreate, revUpdate]) f.mockReset();
  requirePermissionApi.mockResolvedValue({
    actor: { user: { id: "u1" }, permissions: new Set(["content:edit"]) },
    db: {
      post: { findUnique: postFindUnique },
      postRevision: { findFirst: revFindFirst, create: revCreate, update: revUpdate },
    },
  });
  postFindUnique.mockResolvedValue(post);
});

describe("POST /api/cms/posts/[id]/revisions (checkpoint)", () => {
  it("stores the current state as a labelled checkpoint", async () => {
    revFindFirst.mockResolvedValue(null);
    revCreate.mockResolvedValue(meta);
    const res = await call({ label: "  Before the rewrite " });
    expect(res.status).toBe(201);
    const data = revCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ post_id: "p1", content: "Body", source: "checkpoint", label: "Before the rewrite" });
    expect((await res.json()).data.label).toBe("Before the rewrite");
  });

  it("labels the newest revision instead of duplicating an identical state", async () => {
    revFindFirst.mockResolvedValue({ ...meta, label: null, content: "Body", content_format: "markdown", excerpt: null });
    revUpdate.mockResolvedValue(meta);
    const res = await call({ label: "Before the rewrite" });
    expect(res.status).toBe(200);
    expect(revCreate).not.toHaveBeenCalled();
    expect(revUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { label: "Before the rewrite" } }));
  });

  it("requires a label", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ label: "x".repeat(201) })).status).toBe(400);
  });

  it("is gated like editing the post", async () => {
    requirePermissionApi.mockResolvedValue({
      actor: { user: { id: "someone-else" }, permissions: new Set(["content:edit"]) },
      db: { post: { findUnique: postFindUnique }, postRevision: {} },
    });
    expect((await call({ label: "x" })).status).toBe(403);
  });
});
