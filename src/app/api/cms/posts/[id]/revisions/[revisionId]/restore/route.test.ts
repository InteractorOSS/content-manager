import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    author_id: "author-1",
    title: "Current title",
    content: "Current content",
    content_format: "markdown",
    content_html: "<p>Current content</p>",
    excerpt: "Current excerpt",
    content_hash: "hash-current",
    updated_by_id: null,
    updated_by_name: null,
    category_id: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    ...overrides,
  };
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    post_id: "post-1",
    title: "Old title",
    content: "Old content",
    content_format: "markdown",
    content_html: "<p>Old content</p>",
    excerpt: "Old excerpt",
    content_hash: "hash-old",
    ...overrides,
  };
}

// A minimal in-memory row so the write path's read-check-write-reread
// sequence behaves like a real database instead of independent stubs that
// could disagree with each other.
let baseline = postRow();

const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const postUpdateMany = vi.fn();
const categoryFindUnique = vi.fn();
const revisionFindFirst = vi.fn();
const revisionCreate = vi.fn();
const revisionFindMany = vi.fn();
const revisionDeleteMany = vi.fn();
// Interactive-transaction mock: runs the callback against `fakeDb` itself.
const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb));

const fakeDb = {
  post: { findUnique: postFindUnique, update: postUpdate, updateMany: postUpdateMany },
  category: { findUnique: categoryFindUnique },
  postRevision: {
    findFirst: revisionFindFirst,
    create: revisionCreate,
    findMany: revisionFindMany,
    deleteMany: revisionDeleteMany,
  },
  $transaction: transaction,
};

let actor: { user: { id: string; name: string; email: string }; permissions: Set<string> } = {
  user: { id: "author-1", name: "Author One", email: "author@example.com" },
  permissions: new Set(["content:edit"]),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor, db: fakeDb })),
}));

import { POST } from "./route";

function restore(body?: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/x", {
      method: "POST",
      ...(body && { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: "post-1", revisionId: "rev-1" }) }
  );
}

beforeEach(() => {
  actor = {
    user: { id: "author-1", name: "Author One", email: "author@example.com" },
    permissions: new Set(["content:edit"]),
  };
  baseline = postRow();
  postFindUnique.mockReset();
  postUpdate.mockReset();
  postUpdateMany.mockReset();
  categoryFindUnique.mockReset();
  revisionFindFirst.mockReset();
  revisionCreate.mockReset();
  revisionFindMany.mockReset();
  revisionDeleteMany.mockReset();
  transaction.mockClear();

  postFindUnique.mockImplementation(async () => baseline);
  // The plain (no expected_content_hash) write path — a real Prisma
  // update() returns the full row, including the requested category include.
  postUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    baseline = { ...baseline, ...data };
    return baseline;
  });
  postUpdateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ("content_hash" in where && where.content_hash !== baseline.content_hash) {
        return { count: 0 };
      }
      baseline = { ...baseline, ...data };
      return { count: 1 };
    }
  );
  revisionFindFirst.mockResolvedValue(revisionRow());
  revisionCreate.mockImplementation(async ({ data }) => data);
  revisionFindMany.mockResolvedValue([]);
});

describe("POST /api/cms/posts/[id]/revisions/[revisionId]/restore", () => {
  it("404s when the post doesn't resolve", async () => {
    postFindUnique.mockResolvedValueOnce(null);
    const res = await restore();
    expect(res.status).toBe(404);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("404s when the revision doesn't belong to this post", async () => {
    revisionFindFirst.mockResolvedValue(null);
    const res = await restore();
    expect(res.status).toBe(404);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("403s when the actor fails canEditPost (not the author, no content:edit_any)", async () => {
    actor = {
      user: { id: "someone-else", name: "Someone Else", email: "someone@example.com" },
      permissions: new Set(["content:edit"]),
    };
    const res = await restore();
    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("snapshots the CURRENT state as source=restore before applying the target revision", async () => {
    const res = await restore();
    expect(res.status).toBe(200);

    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        post_id: "post-1",
        title: "Current title",
        content: "Current content",
        source: "restore",
        edited_by_id: "author-1",
      }),
    });
    // No hash requested — the plain, race-free update() path.
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Old title",
          content: "Old content",
          content_format: "markdown",
          content_html: "<p>Old content</p>",
          excerpt: "Old excerpt",
          content_hash: "hash-old",
          updated_by_id: "author-1",
          updated_by_name: "Author One",
        }),
      })
    );

    const body = await res.json();
    expect(body.data.title).toBe("Old title");
  });

  it("409s with the shared conflict body when expected_content_hash is stale, and does not restore", async () => {
    const res = await restore({ expected_content_hash: "stale-hash" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current_hash).toBe("hash-current");
    expect(postUpdateMany).not.toHaveBeenCalled();
    expect(revisionCreate).not.toHaveBeenCalled();
  });

  it("succeeds when expected_content_hash matches", async () => {
    const res = await restore({ expected_content_hash: "hash-current" });

    expect(res.status).toBe(200);
    expect(postUpdateMany).toHaveBeenCalled();
  });

  it("does not re-read the post after a successful restore — the response is built from the write itself, not a second independent findUnique that could observe a concurrent write in the gap", async () => {
    const res = await restore({ expected_content_hash: "hash-current" });

    expect(res.status).toBe(200);
    // Exactly the pre-write existence/hash check — no follow-up re-fetch.
    expect(postFindUnique).toHaveBeenCalledTimes(1);
  });

  it("resolves the response's category from the post's own category_id, via a single lookup", async () => {
    baseline = postRow({ category_id: "cat-1" });
    categoryFindUnique.mockResolvedValue({ id: "cat-1", name: "News", slug: "news" });

    const res = await restore({ expected_content_hash: "hash-current" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.category).toEqual({ id: "cat-1", name: "News", slug: "news" });
    expect(categoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cat-1" } })
    );
  });

  it("refuses when the write races between the read and the conditional update, even though the initial check passed", async () => {
    postUpdateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const res = await restore({ expected_content_hash: "hash-current" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current_hash).toBe("hash-current");
    expect(revisionCreate).not.toHaveBeenCalled();
  });
});
