import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyPostImport } from "./post-sync";

vi.mock("@/lib/db", () => ({
  isUniqueViolation: () => false,
  isRecordNotFound: (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2025",
}));

// applyPostImport's own IndexNow-triggering LOGIC (which event → which
// slug(s)) is what this file's own "IndexNow (G#34)" describe block below
// tests; the network/DB-lookup mechanics behind the call are indexnow.test.ts's
// job, not re-tested here via a hand-rolled fetch stub layered on `fakeDb.site`.
const { notifyIndexNowForPostMock } = vi.hoisted(() => ({ notifyIndexNowForPostMock: vi.fn() }));
vi.mock("@/lib/indexnow", () => ({ notifyIndexNowForPost: notifyIndexNowForPostMock }));

function existingPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    organization_id: "org-1",
    author_id: "user-1",
    slug: "existing-post",
    title: "Existing title",
    content: "Existing content",
    content_format: "markdown",
    content_html: "<p>Existing content</p>",
    content_hash: "hash-existing",
    excerpt: "Existing excerpt",
    status: "draft",
    workflow_status: "draft",
    type: "blog",
    tags: [],
    platforms: ["website"],
    category_id: null,
    featured_image: null,
    featured_image_alt: null,
    meta_description: null,
    meta_keywords: null,
    updated_by_id: null,
    updated_by_name: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    ...overrides,
  };
}

// A minimal in-memory row so the write path's read-check-write-reread
// sequence (findUnique -> updateMany conditioned on content_hash ->
// findUnique again for the response) behaves like a real database instead
// of three independent stubs that could disagree with each other.
let baseline = existingPost();

const postFindUnique = vi.fn();
const postFindFirst = vi.fn();
const postUpdateMany = vi.fn();
const postUpdate = vi.fn();
const postCreate = vi.fn();
const categoryFindFirst = vi.fn();
const categoryFindUnique = vi.fn();
const revisionCreate = vi.fn();
const revisionFindMany = vi.fn();
const revisionDeleteMany = vi.fn();
const slugHistoryUpsert = vi.fn();
// Interactive-transaction mock: runs the callback against `fakeDb` itself
// (there's no separate tx client in these fakes) and forwards its rejection
// — enough to exercise applyPostImport's rollback-on-throw logic without a
// real database.
const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb));

const fakeDb = {
  post: {
    findUnique: postFindUnique,
    findFirst: postFindFirst,
    updateMany: postUpdateMany,
    update: postUpdate,
    create: postCreate,
  },
  category: { findFirst: categoryFindFirst, findUnique: categoryFindUnique },
  // This org has both sites registered (src/lib/sites.ts has no cross-org
  // built-in seeds), matching what these fixtures already target.
  site: {
    findMany: async () => [
      { id: "site-website", slug: "website", name: "Website", description: null, url: "https://example.com", sort_order: 0 },
      { id: "site-pm", slug: "product-manager", name: "Product Manager", description: null, url: "https://pm.example.com", sort_order: 1 },
    ],
  },

  postRevision: { create: revisionCreate, findMany: revisionFindMany, deleteMany: revisionDeleteMany },
  postSlugHistory: { upsert: slugHistoryUpsert },
  $transaction: transaction,
} as never;

const actor = {
  user: { id: "user-1", email: "writer@example.com", name: "Writer", status: "active" },
  organizationId: "org-1",
  membershipRole: "editor",
  permissions: new Set(["content:edit"]),
} as never;

beforeEach(() => {
  baseline = existingPost();
  postFindUnique.mockReset();
  postFindFirst.mockReset();
  postUpdateMany.mockReset();
  postUpdate.mockReset();
  postCreate.mockReset();
  categoryFindFirst.mockReset();
  categoryFindUnique.mockReset();
  revisionCreate.mockReset();
  revisionFindMany.mockReset();
  revisionDeleteMany.mockReset();
  slugHistoryUpsert.mockReset();
  notifyIndexNowForPostMock.mockReset();
  transaction.mockClear();
  revisionFindMany.mockResolvedValue([]);
  slugHistoryUpsert.mockResolvedValue({});
  postUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...baseline, ...data }));
  postFindUnique.mockImplementation(async () => baseline);
  postUpdateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ("content_hash" in where && where.content_hash !== baseline.content_hash) {
        return { count: 0 };
      }
      baseline = { ...baseline, ...data };
      return { count: 1 };
    }
  );
  postCreate.mockImplementation(async ({ data }) => ({ ...existingPost(), ...data, category: null }));
  revisionCreate.mockImplementation(async ({ data }) => data);
});

describe("applyPostImport — token site scope (G#21)", () => {
  const PM = ["product-manager"];

  it("refuses to overwrite a post for a site outside the token's scope, naming it", async () => {
    const raw = `---\nid: post-1\ntitle: New title\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb, siteScope: PM });

    expect(result).toMatchObject({ kind: "error", status: 403 });
    expect((result as { message: string }).message).toContain("website");
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a new file that would land on the default site, and says how to fix it", async () => {
    const raw = `---\ntitle: Fresh post\n---\nBody\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb, siteScope: PM });

    expect(result).toMatchObject({ kind: "error", status: 403 });
    expect((result as { message: string }).message).toMatch(/frontmatter lists platforms/);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("imports a new file targeting the token's site", async () => {
    const raw = `---\ntitle: Fresh post\nplatforms:\n  - product-manager\n---\nBody\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb, siteScope: PM });

    expect(result.kind).toBe("applied");
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ platforms: PM }) })
    );
  });

  it("no regression: the same overwrite applies when there is no site scope", async () => {
    const raw = `---\nid: post-1\ntitle: New title\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb, siteScope: [] });

    expect(result.kind).toBe("applied");
  });
});

describe("applyPostImport revision capture", () => {
  it("snapshots the outgoing content with source=import when an existing post's content changes", async () => {
    const raw = `---\nid: post-1\ntitle: New title\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        post_id: "post-1",
        title: "Existing title",
        content: "Existing content",
        source: "import",
        edited_by_id: "user-1",
      }),
    });
    // No content_hash in the frontmatter means no CAS is requested, so this
    // goes through the plain update() path, not the conditional updateMany.
    expect(postUpdate).toHaveBeenCalledTimes(1);
    // A revision snapshot must commit atomically with the write, so this
    // import needs the transaction wrapper — not the direct-db fast path.
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not snapshot a revision when the import doesn't change any content field", async () => {
    // Same title/content as `existingPost()` — the only thing that could
    // differ is metadata this gate doesn't track.
    const raw = `---\nid: post-1\ntitle: Existing title\n---\nExisting content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(postUpdate).toHaveBeenCalledTimes(1);
    // No revision to pair atomically with the write — this metadata-only
    // re-sync must skip the transaction wrapper entirely.
    expect(transaction).not.toHaveBeenCalled();
  });

  it("skips the transaction wrapper for a CAS import that touches no snapshotted field — the updateMany still runs, just not paired with a revision", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });
    // Same title/content as baseline (so no snapshot is needed) but the
    // frontmatter still carries a matching content_hash, so this exercises
    // the CAS write path via updateMany rather than the plain update().
    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: hash-v1\n---\nExisting content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(postUpdateMany).toHaveBeenCalled();
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not snapshot a revision when creating a brand-new post", async () => {
    postFindUnique.mockResolvedValueOnce(null);
    postFindFirst.mockResolvedValueOnce(null);

    const raw = `---\nid: post-new\ntitle: Brand new\n---\nBrand new content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    // A new-post id lookup 404s per D3 (frontmatter id must already exist) —
    // exercise the lookup-by-slug path instead for a genuine create.
    expect(result.kind).toBe("error");

    postFindFirst.mockResolvedValueOnce(null);
    const rawNoId = `---\ntitle: Brand new\n---\nBrand new content\n`;
    const created = await applyPostImport({ raw: rawNoId, actor, db: fakeDb });
    expect(created.kind).toBe("applied");
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(postCreate).toHaveBeenCalledTimes(1);
  });
});

describe("applyPostImport — content_updated_at (G#31)", () => {
  it("bumps content_updated_at when the import changes substantive content", async () => {
    const raw = `---\nid: post-1\ntitle: New title\n---\nNew body content\n`;
    await applyPostImport({ raw, actor, db: fakeDb });

    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content_updated_at: expect.any(Date) }) })
    );
  });

  it("leaves content_updated_at untouched on a metadata-only re-sync", async () => {
    // Same title/content as existingPost() — only tags differ.
    const raw = `---\nid: post-1\ntitle: Existing title\ntags: [a]\n---\nExisting content\n`;
    await applyPostImport({ raw, actor, db: fakeDb });

    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content_updated_at: undefined }) })
    );
  });

  it("sets content_updated_at on a brand-new post", async () => {
    postFindFirst.mockResolvedValueOnce(null);
    const raw = `---\ntitle: Brand new\n---\nBrand new content\n`;
    await applyPostImport({ raw, actor, db: fakeDb });

    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content_updated_at: expect.any(Date) }) })
    );
  });
});

describe("applyPostImport — slug history (G#31)", () => {
  it("retires the outgoing slug when an import renames a post", async () => {
    const raw = `---\nid: post-1\nslug: renamed-post\ntitle: Existing title\n---\nExisting content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(slugHistoryUpsert).toHaveBeenCalledWith({
      where: { organization_id_old_slug: { organization_id: "org-1", old_slug: "existing-post" } },
      create: { organization_id: "org-1", post_id: "post-1", old_slug: "existing-post" },
      update: { post_id: "post-1" },
    });
    // A slug-only change touches no snapshotted content field, but the
    // slug-history row still must commit atomically with the write.
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not touch slug history when the slug is unchanged", async () => {
    const raw = `---\nid: post-1\nslug: existing-post\ntitle: Existing title\n---\nExisting content\n`;
    await applyPostImport({ raw, actor, db: fakeDb });

    expect(slugHistoryUpsert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not touch slug history when creating a brand-new post", async () => {
    postFindFirst.mockResolvedValueOnce(null);
    const raw = `---\ntitle: Brand new\n---\nBrand new content\n`;
    await applyPostImport({ raw, actor, db: fakeDb });

    expect(slugHistoryUpsert).not.toHaveBeenCalled();
  });
});

describe("applyPostImport — optimistic concurrency", () => {
  it("applies and stamps updated_by when frontmatter.content_hash matches the current hash", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: hash-v1\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(postUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ updated_by_id: "user-1", updated_by_name: "Writer" }),
      })
    );
  });

  it("returns a conflict naming current_hash, updated_at, and the last editor when frontmatter.content_hash is stale", async () => {
    baseline = existingPost({
      content_hash: "hash-v1",
      updated_by_id: "someone-else",
      updated_by_name: "Someone Else",
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    });

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: stale-hash\n---\nRacing edit\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("expected conflict");
    expect(result.currentHash).toBe("hash-v1");
    expect(result.conflict.current_hash).toBe("hash-v1");
    expect(result.conflict.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(result.conflict.last_editor).toEqual({ id: "someone-else", name: "Someone Else" });
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("no regression: omitting content_hash from frontmatter skips the conflict check entirely", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });

    const raw = `---\nid: post-1\ntitle: Existing title\n---\nSome other content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
  });

  it("refuses when the write races between the read and the conditional update, even though the initial check passed — and does not orphan a revision snapshot", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });
    postUpdateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: hash-v1\n---\nRacing edit\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("expected conflict");
    expect(result.conflict.current_hash).toBe("hash-v1");
    // The updateMany that lost the race never applied — a revision snapshot
    // for content that was never actually written would be a phantom entry.
    expect(revisionCreate).not.toHaveBeenCalled();
  });

  it("flags sync_conflict on a raced webhook write, same as the pre-write conflict check", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });
    postUpdateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: hash-v1\n---\nRacing webhook delivery\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb, onConflict: "flag" });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("expected conflict");
    expect(result.flagged).toBe(true);
    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: "post-1" },
      data: { sync_conflict: true },
    });
  });

  it("gracefully 404s the pre-write flag branch when the post is deleted in the race window, instead of throwing P2025 unhandled", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });
    postUpdate.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "P2025" }));
    postFindUnique.mockResolvedValueOnce(existingPost({ content_hash: "hash-v1" })).mockResolvedValueOnce(null);

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: stale-hash\n---\nRacing webhook delivery\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb, onConflict: "flag" });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.status).toBe(404);
  });

  it("does not re-read the post after a successful applied write — the response is built from the write itself, not a second independent findUnique that could observe a concurrent write in the gap", async () => {
    baseline = existingPost({ content_hash: "hash-v1" });

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: hash-v1\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    // Exactly the pre-write existence read — no follow-up re-fetch.
    expect(postFindUnique).toHaveBeenCalledTimes(1);
  });

  it("resolves the applied result's category from this write's own category_id, via a single lookup", async () => {
    baseline = existingPost({ content_hash: "hash-v1", category_id: "cat-1" });
    categoryFindUnique.mockResolvedValue({ id: "cat-1", name: "News", slug: "news" });

    const raw = `---\nid: post-1\ntitle: Existing title\ncontent_hash: hash-v1\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");
    expect((result.post as { category: unknown }).category).toEqual({ id: "cat-1", name: "News", slug: "news" });
    expect(categoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cat-1" } })
    );
  });
});

describe("IndexNow (G#34)", () => {
  it("pings when a PUBLISHED post's content changes", async () => {
    baseline = existingPost({ status: "published", platforms: ["website"] });

    const raw = `---\nid: post-1\ntitle: Existing title\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(notifyIndexNowForPostMock).toHaveBeenCalledWith(
      fakeDb,
      { platforms: ["website"] },
      ["existing-post"]
    );
  });

  it("never pings for a DRAFT's content change — its URL was never live to re-crawl", async () => {
    baseline = existingPost({ status: "draft" });

    const raw = `---\nid: post-1\ntitle: Existing title\n---\nNew body content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(notifyIndexNowForPostMock).not.toHaveBeenCalled();
  });

  it("does not ping when nothing content/status/slug-relevant changed — a pure metadata re-sync", async () => {
    baseline = existingPost({ status: "published", platforms: ["website"] });

    // Same title/content as baseline, no slug/platforms/status in frontmatter.
    const raw = `---\nid: post-1\ntitle: Existing title\n---\nExisting content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    expect(notifyIndexNowForPostMock).not.toHaveBeenCalled();
  });

  it("resolves the RETIRED slug against its OLD platforms and the NEW slug against its NEW platforms, as two separate pings, when a rename and a platform narrowing land in the same import", async () => {
    baseline = existingPost({ status: "published", slug: "existing-post", platforms: ["website"] });

    const raw =
      `---\nid: post-1\ntitle: Existing title\nslug: new-slug\nplatforms:\n  - product-manager\n---\nExisting content\n`;
    const result = await applyPostImport({ raw, actor, db: fakeDb });

    expect(result.kind).toBe("applied");
    // Using the NEW platforms ("product-manager") for the OLD slug's ping —
    // the bug this guards against — would ask a site that never hosted
    // "existing-post" to recheck it, while "website" (whose copy just
    // 404'd) would never hear the URL is gone.
    expect(notifyIndexNowForPostMock).toHaveBeenCalledWith(
      fakeDb,
      { platforms: ["website"] },
      ["existing-post"]
    );
    expect(notifyIndexNowForPostMock).toHaveBeenCalledWith(
      fakeDb,
      { platforms: ["product-manager"] },
      ["new-slug"]
    );
    expect(notifyIndexNowForPostMock).toHaveBeenCalledTimes(2);
  });
});

describe("optionalText (an optional text column from a file)", () => {
  it("keeps the current value when the key is absent, and clears it when empty", async () => {
    const { optionalText } = await import("./post-sync");
    expect(optionalText(undefined, "kept")).toBe("kept");
    expect(optionalText(undefined, null)).toBeNull();
    expect(optionalText("", "old")).toBeNull();
    expect(optionalText("  ", "old")).toBeNull();
    expect(optionalText("new", "old")).toBe("new");
  });
});
