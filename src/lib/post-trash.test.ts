import { describe, expect, it, vi } from "vitest";
import { restoreData, trashExpiresAt, trashPosts, TRASH_RETENTION_DAYS } from "./post-trash";

const actor = {
  organizationId: "org1",
  user: { id: "u2", email: "admin@example.com", name: "Peter", display_name: null },
} as never;

function fakeDb(taken: { slugs?: string[]; ids?: string[]; categories?: string[]; users?: string[] } = {}) {
  return {
    post: {
      findFirst: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) =>
        (where.slug && taken.slugs?.includes(where.slug)) || (where.id && taken.ids?.includes(where.id)) ? { id: "x" } : null
      ),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    category: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (taken.categories?.includes(where.id) ? { id: where.id } : null)) },
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (taken.users?.includes(where.id) ? { id: where.id } : null)) },
    deletedPost: { createMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn(async () => ({ count: 1 })) },
    socialPost: { findMany: vi.fn(async () => [{ id: "s1", source_post_id: "p1" }]) },
  };
}

const snapshot = {
  id: "p1",
  title: "Fatherhood",
  slug: "fatherhood",
  content: "Body",
  status: "published",
  workflow_status: "approved",
  type: "blog",
  tags: ["family"],
  platforms: ["acme-site"],
  category_id: "cat1",
  author_id: "u1",
  published_at: "2026-09-01T00:00:00.000Z",
  inserted_at: "2026-08-01T00:00:00.000Z",
  preview_token_expires_at: "2026-09-30T00:00:00.000Z",
};

describe("restoreData", () => {
  it("brings the post back as a draft with its id, slug and fields", async () => {
    const data = await restoreData(fakeDb({ categories: ["cat1"], users: ["u1"] }) as never, snapshot, actor);
    expect(data).toMatchObject({
      id: "p1",
      slug: "fatherhood",
      status: "draft",
      workflow_status: "draft",
      tags: ["family"],
      platforms: ["acme-site"],
      category_id: "cat1",
      author_id: "u1",
      updated_by_id: "u2",
    });
    expect(data.published_at).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(data.inserted_at).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    // Never carried over: a live preview link.
    expect(data).not.toHaveProperty("preview_token_expires_at");
  });

  it("suffixes a slug another post has taken since, and drops a taken id", async () => {
    const data = await restoreData(fakeDb({ slugs: ["fatherhood"], ids: ["p1"] }) as never, snapshot, actor);
    expect(data.slug).toBe("fatherhood-restored");
    expect(data).not.toHaveProperty("id");
  });

  it("clears references to a category or author that no longer exist", async () => {
    const data = await restoreData(fakeDb() as never, snapshot, actor);
    expect(data.category_id).toBeNull();
    expect(data.author_id).toBeNull();
  });
});

describe("trashPosts", () => {
  it("snapshots each post before deleting it", async () => {
    const db = fakeDb();
    const post = { ...snapshot, published_at: new Date(snapshot.published_at) } as never;
    await trashPosts(db as never, [post], actor);
    const entry = (db.deletedPost.createMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>[] }])[0].data[0];
    expect(entry).toMatchObject({ post_id: "p1", title: "Fatherhood", slug: "fatherhood", deleted_by_id: "u2", deleted_by_name: "Peter" });
    expect((entry.snapshot as Record<string, unknown>).published_at).toBe("2026-09-01T00:00:00.000Z");
    // Remembers its social drafts, so a restore can relink them.
    expect((entry.snapshot as Record<string, unknown>).__social_post_ids).toEqual(["s1"]);
    expect(db.post.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["p1"] } } });
  });

  it("removes the trash entry again when the delete fails, so nothing restores twice", async () => {
    const db = fakeDb();
    db.post.deleteMany.mockRejectedValueOnce(new Error("db down"));
    await expect(trashPosts(db as never, [snapshot as never], actor)).rejects.toThrow("db down");
    expect(db.deletedPost.deleteMany).toHaveBeenCalledWith({ where: { post_id: { in: ["p1"] } } });
  });
});

it(`keeps deleted posts for ${TRASH_RETENTION_DAYS} days`, () => {
  expect(trashExpiresAt(new Date("2026-09-01T00:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
});
