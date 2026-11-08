import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const postFindUnique = vi.fn();
const revisionFindFirst = vi.fn();

const fakeDb = {
  post: { findUnique: postFindUnique },
  postRevision: { findFirst: revisionFindFirst },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor: {}, db: fakeDb, via: "session" })),
}));

import { GET } from "./route";

beforeEach(() => {
  postFindUnique.mockReset();
  revisionFindFirst.mockReset();
});

describe("GET /api/cms/posts/[id]/revisions/[revisionId]", () => {
  it("404s when the post doesn't resolve", async () => {
    postFindUnique.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "post-1", revisionId: "rev-1" }),
    });
    expect(res.status).toBe(404);
    expect(revisionFindFirst).not.toHaveBeenCalled();
  });

  it("404s when the revision doesn't belong to this post (cross-org id guess)", async () => {
    postFindUnique.mockResolvedValue({ id: "post-1" });
    revisionFindFirst.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "post-1", revisionId: "rev-from-another-org" }),
    });
    expect(res.status).toBe(404);
    expect(revisionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rev-from-another-org", post_id: "post-1" } })
    );
  });

  it("returns the full snapshot including content", async () => {
    postFindUnique.mockResolvedValue({ id: "post-1" });
    revisionFindFirst.mockResolvedValue({
      id: "rev-1",
      post_id: "post-1",
      title: "Old title",
      content: "Old content",
      content_format: "markdown",
      content_html: "<p>Old content</p>",
      excerpt: "Old excerpt",
      content_hash: "hash-1",
      source: "cms_ui",
      edited_by_id: "user-1",
      edited_by: { id: "user-1", name: "Writer", email: "writer@example.com" },
      inserted_at: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "post-1", revisionId: "rev-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe("Old content");
    expect(body.data.inserted_at).toBe("2026-01-01T00:00:00.000Z");
  });
});
