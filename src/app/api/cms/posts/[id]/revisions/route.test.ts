import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const postFindUnique = vi.fn();
const revisionFindMany = vi.fn();
const revisionCount = vi.fn();
const transaction = vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));

const fakeDb = {
  post: { findUnique: postFindUnique },
  postRevision: { findMany: revisionFindMany, count: revisionCount },
  $transaction: transaction,
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor: {}, db: fakeDb, via: "session" })),
}));

import { GET } from "./route";

beforeEach(() => {
  postFindUnique.mockReset();
  revisionFindMany.mockReset();
  revisionCount.mockReset();
  transaction.mockClear();
});

describe("GET /api/cms/posts/[id]/revisions", () => {
  it("404s when the post doesn't resolve (e.g. another org)", async () => {
    postFindUnique.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/cms/posts/post-1/revisions"), {
      params: Promise.resolve({ id: "post-1" }),
    });
    expect(res.status).toBe(404);
    expect(revisionFindMany).not.toHaveBeenCalled();
  });

  it("returns paginated metadata only — no content bodies", async () => {
    postFindUnique.mockResolvedValue({ id: "post-1" });
    revisionFindMany.mockResolvedValue([
      {
        id: "rev-2",
        title: "Second edit",
        source: "cms_ui",
        inserted_at: new Date("2026-01-02T00:00:00Z"),
        edited_by: { id: "user-1", name: "Writer", email: "writer@example.com" },
      },
      {
        id: "rev-1",
        title: "First edit",
        source: "import",
        inserted_at: new Date("2026-01-01T00:00:00Z"),
        edited_by: null,
      },
    ]);
    revisionCount.mockResolvedValue(2);

    const res = await GET(new NextRequest("http://localhost/api/cms/posts/post-1/revisions"), {
      params: Promise.resolve({ id: "post-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toEqual({ total: 2, page: 1, per_page: 50 });
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: "rev-2",
      title: "Second edit",
      source: "cms_ui",
      label: null,
      edited_by: { id: "user-1", name: "Writer", email: "writer@example.com" },
      inserted_at: "2026-01-02T00:00:00.000Z",
    });
    // No content/content_html leaked into the list payload.
    expect(body.data[0].content).toBeUndefined();
    expect(revisionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { post_id: "post-1" },
        orderBy: { inserted_at: "desc" },
        skip: 0,
        take: 50,
      })
    );
  });
});
