import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MCP_DELEGATE_HEADER } from "@/lib/post-revisions";

/**
 * G#16: the own-posts-only 403 must be actionable, and reassigning
 * authorship (author_id, or an author_name that diverges from the post's
 * current one) requires content:edit_any — but a same-value author_name
 * must NOT be gated, since post-editor.tsx round-trips it on every save
 * regardless of whether the user touched the field.
 */

const actor = {
  user: { id: "u1", email: "author@example.com", name: "Author One", status: "active" },
  organizationId: "org1",
  membershipRole: "author",
  roles: ["author"],
  permissions: new Set<string>(["content:edit"]),
};

let via: "session" | "token" = "session";

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    organization_id: "org1",
    title: "Hello",
    slug: "hello",
    content: "Body",
    content_html: "<p>Body</p>",
    content_format: "markdown",
    excerpt: null,
    content_hash: null,
    status: "draft",
    workflow_status: "draft",
    author_id: "u1",
    author_name: "Author One",
    updated_by_id: null,
    updated_by_name: null,
    published_at: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    category_id: null,
    category: null,
    platforms: ["website"],
    ...overrides,
  };
}

// A minimal in-memory row so the write path's read-check-write-reread
// sequence (findUnique -> updateMany conditioned on content_hash ->
// findUnique again for the response) behaves like a real database instead
// of three independent stubs that could disagree with each other.
let baseline = existingRow();

const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const postUpdateMany = vi.fn();
const membershipFindUnique = vi.fn();
const categoryFindUnique = vi.fn();
const postRevisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
const postRevisionFindMany = vi.fn(async () => [] as { id: string }[]);
const postRevisionDeleteMany = vi.fn();
const postSlugHistoryUpsert = vi.fn(async (..._a: unknown[]) => ({}));
// Registers no sites, so orgSiteSlugs() yields just the built-in seeds
// (website, product-manager) — what these fixtures already target. Also
// what resolveIndexNowSites() (src/lib/indexnow.ts) reads through — a plain
// vi.fn() rather than a bare arrow so tests can assert WHICH platform set an
// IndexNow ping resolved sites from.
const siteFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

const db = {
  post: {
    findUnique: (...a: unknown[]) => postFindUnique(...a),
    update: (...a: unknown[]) => postUpdate(...a),
    updateMany: (...a: unknown[]) => postUpdateMany(...a),
  },
  membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
  category: { findUnique: (...a: unknown[]) => categoryFindUnique(...a) },
  site: { findMany: (...a: unknown[]) => siteFindMany(...a) },
  postRevision: {
    create: postRevisionCreate,
    findMany: postRevisionFindMany,
    deleteMany: postRevisionDeleteMany,
  },
  postSlugHistory: { upsert: (...a: unknown[]) => postSlugHistoryUpsert(...a) },
  // Interactive-transaction mock: runs the callback against this same `db`
  // (there's no separate tx client in these fakes) and just forwards its
  // rejection — good enough to exercise the route's rollback-on-throw logic
  // without a real database. Wrapped in vi.fn() (rather than a plain arrow)
  // so tests can assert whether the route actually opened a transaction —
  // it should only do so when a revision snapshot needs to commit atomically
  // with the write.
  $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: NextRequest, ...perms: string[]) => {
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return {
        error: new Response(JSON.stringify({ error: "Forbidden", missing_permissions: missing }), {
          status: 403,
        }),
      };
    }
    return { actor, db, via };
  }),
}));

vi.mock("@/lib/db", () => ({ isUniqueViolation: () => false }));

const generateFeaturedImageOrNull = vi.fn();
vi.mock("@/lib/featured-image", () => ({
  generateFeaturedImageOrNull: (...a: unknown[]) => generateFeaturedImageOrNull(...a),
}));

import { GET, PUT } from "./route";

function put(body: unknown, headers: Record<string, string> = {}) {
  return PUT(
    new NextRequest("http://localhost/api/cms/posts/p1", {
      method: "PUT",
      body: JSON.stringify(body),
      headers,
    }),
    { params: Promise.resolve({ id: "p1" }) }
  );
}

function get() {
  return GET(new NextRequest("http://localhost/api/cms/posts/p1"), {
    params: Promise.resolve({ id: "p1" }),
  });
}

beforeEach(() => {
  via = "session";
  actor.permissions = new Set(["content:edit"]);
  baseline = existingRow();
  postFindUnique.mockReset();
  postUpdate.mockReset();
  postUpdateMany.mockReset();
  membershipFindUnique.mockReset();
  categoryFindUnique.mockReset();
  generateFeaturedImageOrNull.mockReset();
  postRevisionCreate.mockClear();
  postRevisionFindMany.mockClear();
  postRevisionDeleteMany.mockClear();
  postSlugHistoryUpsert.mockClear();
  siteFindMany.mockReset();
  siteFindMany.mockResolvedValue([]);
  db.$transaction.mockClear();
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
});

describe("PUT /api/cms/posts/[id] — own-posts-only refusal", () => {
  it("names the actual author and the permission that would lift the block", async () => {
    baseline = existingRow({ author_id: "someone-else", author_name: "Jane Doe" });

    const res = await put({ title: "New title" });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("Jane Doe");
    expect(body.error).toContain("content:edit_any");
    expect(postUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/cms/posts/[id] — authorship", () => {
  it("does not gate a same-value author_name — the editor round-trips it on every save", async () => {
    const res = await put({ author_name: "Author One" });

    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ author_name: expect.anything() }) })
    );
  });

  it("refuses an author_name change from a caller without content:edit_any", async () => {
    const res = await put({ author_name: "Someone New" });

    expect(res.status).toBe(403);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("lets a content:edit_any holder change the free-text author_name", async () => {
    actor.permissions = new Set(["content:edit", "content:edit_any"]);

    const res = await put({ author_name: "Someone New" });
    const { data } = await res.json();

    expect(data.author_name).toBe("Someone New");
  });

  it("refuses to clear an existing author_name to blank without content:edit_any", async () => {
    const res = await put({ author_name: "" });

    expect(res.status).toBe(403);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("lets a content:edit_any holder clear an existing author_name to null", async () => {
    actor.permissions = new Set(["content:edit", "content:edit_any"]);

    const res = await put({ author_name: "" });
    const { data } = await res.json();

    expect(data.author_name).toBeNull();
  });

  it("still applies an author_name change sent alongside an unchanged (no-op) author_id", async () => {
    // Regression: author_id present-but-unchanged must not short-circuit
    // past a real author_name change in the same payload.
    actor.permissions = new Set(["content:edit", "content:edit_any"]);

    const res = await put({ author_id: "u1", author_name: "Someone New" });
    const { data } = await res.json();

    expect(membershipFindUnique).not.toHaveBeenCalled();
    expect(data.author_name).toBe("Someone New");
    expect(data.author_id).toBe("u1");
  });

  it("refuses author_id from a caller without content:edit_any", async () => {
    const res = await put({ author_id: "u2" });

    expect(res.status).toBe(403);
    expect(postUpdateMany).not.toHaveBeenCalled();
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });

  it("does not gate author_id round-tripped unchanged from a GET — no permission needed for a no-op", async () => {
    // Regression: a read-modify-write client (GET the post, change something
    // else, PUT the whole object back) includes the post's own author_id
    // every time, whether or not it changed.
    const res = await put({ author_id: "u1", title: "New title" });

    expect(res.status).toBe(200);
    expect(membershipFindUnique).not.toHaveBeenCalled();
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ author_id: expect.anything() }) })
    );
  });

  it("treats an explicit null author_id/author_name as no change, not the literal string \"null\"", async () => {
    const res = await put({ author_id: null, author_name: null, title: "New title" });

    expect(res.status).toBe(200);
    expect(membershipFindUnique).not.toHaveBeenCalled();
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ author_id: expect.anything(), author_name: expect.anything() }),
      })
    );
  });

  it("refuses an author_id that doesn't name a member of the caller's org", async () => {
    actor.permissions = new Set(["content:edit", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue(null);

    const res = await put({ author_id: "u2" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/member of your organization/);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("reassigns author_id and author_name together for a content:edit_any holder", async () => {
    actor.permissions = new Set(["content:edit", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey Writer", email: "casey@example.com", status: "active" },
    });

    const res = await put({ author_id: "u2" });
    const { data } = await res.json();

    expect(data.author_id).toBe("u2");
    expect(data.author_name).toBe("Casey Writer");
  });

  it("ignores a free-text author_name sent alongside author_id — author_id is the sole source of the name", async () => {
    actor.permissions = new Set(["content:edit", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey Writer", email: "casey@example.com", status: "active" },
    });

    const res = await put({ author_id: "u2", author_name: "Ghost Writer" });
    const { data } = await res.json();

    expect(data.author_id).toBe("u2");
    expect(data.author_name).toBe("Casey Writer");
  });
});

describe("PUT /api/cms/posts/[id] — revision capture", () => {
  it("snapshots the outgoing content and attributes source=cms_ui for a session call", async () => {
    const res = await put({ title: "New title" });
    expect(res.status).toBe(200);
    expect(postRevisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        post_id: "p1",
        title: "Hello",
        content: "Body",
        source: "cms_ui",
        edited_by_id: "u1",
      }),
    });
    // A revision snapshot must commit atomically with the write, so this
    // save needs the transaction wrapper — not the direct-db fast path.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("attributes source=api for a bare token call", async () => {
    via = "token";
    const res = await put({ title: "New title" });
    expect(res.status).toBe(200);
    expect(postRevisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: "api" }) })
    );
  });

  it("attributes source=mcp for a token call carrying the MCP delegate marker", async () => {
    via = "token";
    const res = await put({ title: "New title" }, { [MCP_DELEGATE_HEADER]: "1" });
    expect(res.status).toBe(200);
    expect(postRevisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: "mcp" }) })
    );
  });

  it("does not snapshot a revision when no snapshotted field changes", async () => {
    const res = await put({ author_name: "Author One" });
    expect(res.status).toBe(200);
    expect(postRevisionCreate).not.toHaveBeenCalled();
    expect(postUpdate).toHaveBeenCalledTimes(1);
    // No revision to pair atomically with the write — the transaction
    // wrapper would be pure overhead here, so this must skip it entirely.
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("404s when the post doesn't resolve (e.g. another org)", async () => {
    postFindUnique.mockResolvedValueOnce(null);
    const res = await put({ title: "New title" });
    expect(res.status).toBe(404);
    expect(postRevisionCreate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/cms/posts/[id] — content_updated_at (G#31)", () => {
  it("bumps content_updated_at when a snapshotted field changes", async () => {
    const res = await put({ title: "New title" });
    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content_updated_at: expect.any(Date) }) })
    );
  });

  it("leaves content_updated_at untouched on a pure metadata edit", async () => {
    const res = await put({ author_name: "Author One", tags: ["x"] });
    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledWith(
      expect.not.objectContaining({ data: expect.objectContaining({ content_updated_at: expect.anything() }) })
    );
  });

  it("bumps content_updated_at on mark_updated even with no snapshotted field change", async () => {
    const res = await put({ author_name: "Author One", mark_updated: true });
    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content_updated_at: expect.any(Date) }) })
    );
    // mark_updated alone touches no snapshotted content field.
    expect(postRevisionCreate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/cms/posts/[id] — slug history (G#31)", () => {
  it("retires the outgoing slug when the slug changes", async () => {
    const res = await put({ slug: "renamed" });
    expect(res.status).toBe(200);
    expect(postSlugHistoryUpsert).toHaveBeenCalledWith({
      where: { organization_id_old_slug: { organization_id: "org1", old_slug: "hello" } },
      create: { organization_id: "org1", post_id: "p1", old_slug: "hello" },
      update: { post_id: "p1" },
    });
    // A slug-only change touches no snapshotted content field, but the
    // slug-history write still needs to commit atomically with the update.
    expect(postRevisionCreate).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not touch slug history when the slug is unchanged", async () => {
    const res = await put({ slug: "hello", author_name: "Author One" });
    expect(res.status).toBe(200);
    expect(postSlugHistoryUpsert).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("GET /api/cms/posts/[id] — preview_url is gated on canEditPost, not content:view alone", () => {
  it("omits preview_url (never leaks the raw preview_token_expires_at either) for a content:view-only caller reading someone else's post", async () => {
    actor.permissions = new Set(["content:view"]);
    baseline = existingRow({ author_id: "someone-else", preview_token_expires_at: new Date(Date.now() + 100_000) });

    const res = await get();
    const { data } = await res.json();

    expect(data.preview_url).toBeNull();
    expect(data.preview_token_expires_at).toBeUndefined();
  });

  it("returns the openable preview_url for the post's own author with content:edit", async () => {
    actor.permissions = new Set(["content:view", "content:edit"]);
    baseline = existingRow({ author_id: "u1", preview_token_expires_at: new Date(Date.now() + 100_000) });

    const res = await get();
    const { data } = await res.json();

    expect(data.preview_url).toMatch(/\/preview\//);
  });

  it("returns the preview_url for a content:edit_any holder reading someone else's post", async () => {
    actor.permissions = new Set(["content:view", "content:edit", "content:edit_any"]);
    baseline = existingRow({ author_id: "someone-else", preview_token_expires_at: new Date(Date.now() + 100_000) });

    const res = await get();
    const { data } = await res.json();

    expect(data.preview_url).toMatch(/\/preview\//);
  });
});

describe("PUT /api/cms/posts/[id] — optimistic concurrency", () => {
  it("succeeds when expected_content_hash matches the current hash", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ content: "Updated content", expected_content_hash: "hash-v1" });

    expect(res.status).toBe(200);
    expect(postUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ updated_by_id: "u1", updated_by_name: "Author One" }),
      })
    );
  });

  it("refuses with 409 when expected_content_hash is stale, and does not write", async () => {
    baseline = existingRow({
      content_hash: "hash-v2",
      updated_by_id: "u2",
      updated_by_name: "Other Editor",
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    });

    const res = await put({ content: "Racing edit", expected_content_hash: "hash-v1" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current_hash).toBe("hash-v2");
    expect(body.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(body.last_editor).toEqual({ id: "u2", name: "Other Editor" });
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("treats an explicit null expected_content_hash as matching a post with no content_hash yet", async () => {
    baseline = existingRow({ content_hash: null });

    const res = await put({ content: "First real content", expected_content_hash: null });

    expect(res.status).toBe(200);
    expect(postUpdateMany).toHaveBeenCalled();
  });

  it("behaves exactly as before when expected_content_hash is omitted — no conflict check", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ content: "Force-saved content" });

    expect(res.status).toBe(200);
    // No hash requested — the plain, race-free update() path, not the
    // conditional updateMany.
    expect(postUpdate).toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("also accepts the hash via an If-Match header", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ content: "Racing edit" }, { "if-match": "stale-header-hash" });

    expect(res.status).toBe(409);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("strips RFC 7232 quoting from a spec-compliant If-Match entity-tag before comparing", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ content: "Updated content" }, { "if-match": '"hash-v1"' });

    expect(res.status).toBe(200);
    expect(postUpdateMany).toHaveBeenCalled();
  });

  it("treats a wildcard If-Match: * as matching unconditionally, per RFC 7232", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ content: "Updated content" }, { "if-match": "*" });

    expect(res.status).toBe(200);
    // "*" resolves to "no check requested" — the plain update() path.
    expect(postUpdate).toHaveBeenCalled();
  });

  it("refuses when the write races between the read and the conditional update, even though the initial check passed — and does not orphan a revision snapshot", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });
    // Simulate another request changing content_hash after our findUnique
    // read it but before our updateMany runs: override the mock for exactly
    // this one call so the pre-check (which reads `existing`, captured
    // before this override) still passes, but the conditional write doesn't.
    postUpdateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const res = await put({ content: "Racing edit", expected_content_hash: "hash-v1" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current_hash).toBe("hash-v1");
    // The updateMany that lost the race never applied — a revision snapshot
    // for content that was never actually written would be a phantom entry.
    expect(postRevisionCreate).not.toHaveBeenCalled();
  });

  it("does not re-read the post after a successful write — the response is built from the write itself, not a second independent findUnique that could observe a concurrent write in the gap", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ content: "Updated content", expected_content_hash: "hash-v1" });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).toBe("Updated content");
    // Exactly the pre-write existence/hash check — no follow-up re-fetch.
    expect(postFindUnique).toHaveBeenCalledTimes(1);
  });

  it("skips the transaction wrapper for a CAS write that touches no snapshotted field — the updateMany still runs, just not paired with a revision", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });

    const res = await put({ tags: ["news"], expected_content_hash: "hash-v1" });

    expect(res.status).toBe(200);
    expect(postUpdateMany).toHaveBeenCalled();
    expect(postRevisionCreate).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("resolves the response's category from this write's own category_id, via a single lookup", async () => {
    baseline = existingRow({ content_hash: "hash-v1", category_id: "cat-1" });
    categoryFindUnique.mockResolvedValue({ id: "cat-1", name: "News", slug: "news" });

    const res = await put({ content: "Updated content", expected_content_hash: "hash-v1" });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.category).toEqual({ id: "cat-1", name: "News", slug: "news" });
    expect(categoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cat-1" } })
    );
  });

  it("propagates a revision-snapshot failure as an error rather than reporting success on an unaudited write", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });
    postRevisionCreate.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    // Both live inside one $transaction callback now — a failure here must
    // surface as a route error (a real Prisma transaction would also roll
    // back the paired updateMany; this mock doesn't model that part, but the
    // "don't silently report success" contract is what's under test).
    await expect(
      put({ content: "Updated content", expected_content_hash: "hash-v1" })
    ).rejects.toThrow("db down");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/cms/posts/[id] — featured image on publish", () => {
  beforeEach(() => {
    actor.permissions = new Set(["content:edit", "content:publish"]);
  });

  it("generates a title card when publishing a post with no image", async () => {
    generateFeaturedImageOrNull.mockResolvedValue({
      url: "https://cdn.example/card.png",
      alt: 'Title card reading "Hello"',
      media_id: "m1",
    });

    const res = await put({ status: "published" });

    expect(res.status).toBe(200);
    expect(generateFeaturedImageOrNull).toHaveBeenCalledWith(
      db,
      actor,
      expect.objectContaining({ title: "Hello", slug: "hello", author_name: "Author One" })
    );
    expect(baseline).toMatchObject({
      status: "published",
      featured_image: "https://cdn.example/card.png",
      featured_image_alt: 'Title card reading "Hello"',
    });
  });

  it("keeps a hand-written alt text when generating", async () => {
    baseline = existingRow({ featured_image_alt: "My alt" });
    generateFeaturedImageOrNull.mockResolvedValue({ url: "https://cdn.example/c.png", alt: "gen", media_id: "m" });

    await put({ status: "published" });
    expect(baseline).toMatchObject({ featured_image: "https://cdn.example/c.png", featured_image_alt: "My alt" });
  });

  it("refuses when generation fails, writing nothing", async () => {
    generateFeaturedImageOrNull.mockResolvedValue(null);
    const res = await put({ status: "published" });
    expect(res.status).toBe(400);
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("does not regenerate for a post that already has an image", async () => {
    baseline = existingRow({ featured_image: "https://x/a.png" });
    await put({ status: "published" });
    expect(generateFeaturedImageOrNull).not.toHaveBeenCalled();
  });
});

describe("PUT /api/cms/posts/[id] — IndexNow (G#34)", () => {
  // db.site.findMany is ALSO how orgSiteSlugs() (platform validation, runs
  // on every save) reads the registry — that call has no `where.slug.in`
  // shape, so filtering to calls that DO is what isolates
  // resolveIndexNowSites()'s own resolution from that unrelated traffic.
  function indexNowSiteLookups() {
    return siteFindMany.mock.calls.filter(
      (call) => (call[0] as unknown as { where?: { slug?: { in?: unknown } } } | undefined)?.where?.slug?.in
    );
  }

  it("never pings IndexNow for a draft's content edit — its URL was never live to re-crawl", async () => {
    baseline = existingRow({ status: "draft" });
    await put({ content: "New body" });

    expect(indexNowSiteLookups()).toHaveLength(0);
  });

  it("pings IndexNow for a published post's content edit", async () => {
    baseline = existingRow({
      status: "published",
      platforms: ["website"],
      featured_image: "https://x/a.png",
    });
    await put({ content: "New body" });

    expect(indexNowSiteLookups()).toContainEqual([
      expect.objectContaining({ where: expect.objectContaining({ slug: { in: ["website"] } }) }),
    ]);
  });

  it("resolves the OLD slug's ping against the OLD platform set, not the narrowed new one, when a rename and a platform change land in the same save", async () => {
    baseline = existingRow({
      status: "published",
      slug: "old-post",
      platforms: ["site-a"],
      featured_image: "https://x/a.png",
    });
    // orgSiteSlugs()'s registry read (no `where`) — makes "site-b" a
    // legitimately registered target so the platform-narrowing itself is
    // accepted, distinct from the `where.slug.in`-shaped calls this test
    // actually asserts on.
    siteFindMany.mockImplementation(async (args: unknown) => {
      if ((args as { where?: unknown })?.where) return [];
      return [{ id: "s2", slug: "site-b", name: "Site B", description: null, sort_order: 1 }];
    });

    await put({ slug: "new-post", platforms: ["site-b"] });

    // Two independent resolutions: the retired "old-post" URL only ever
    // lived on site-a, and "new-post" only ever targets site-b. Using
    // site-b for BOTH (the bug this guards against) would ask a site that
    // never hosted the old URL to "recheck" it, while site-a — whose copy
    // just 404'd — would never hear about it at all.
    const lookups = indexNowSiteLookups();
    expect(lookups).toContainEqual([
      expect.objectContaining({ where: expect.objectContaining({ slug: { in: ["site-a"] } }) }),
    ]);
    expect(lookups).toContainEqual([
      expect.objectContaining({ where: expect.objectContaining({ slug: { in: ["site-b"] } }) }),
    ]);
  });
});
