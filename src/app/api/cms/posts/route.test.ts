import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Authorship on create: defaults to the caller, but a content:edit_any
 * holder may credit a real member of their org instead — see G#16.
 */

const actor = {
  user: { id: "u1", email: "author@example.com", name: "Author One", status: "active" },
  organizationId: "org1",
  membershipRole: "author",
  roles: ["author"],
  permissions: new Set<string>(["content:create"]),
};

const postCreate = vi.fn();
const membershipFindUnique = vi.fn();

const db = {
  post: { create: (...a: unknown[]) => postCreate(...a) },
  membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
  // Registers no sites, so orgSiteSlugs() yields just the built-in seeds
  // (website, product-manager) — what these fixtures already target.
  site: { findMany: async () => [] },
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
    return { actor, db, via: "session" };
  }),
}));

vi.mock("@/lib/db", () => ({ isUniqueViolation: () => false }));

const generateFeaturedImageOrNull = vi.fn();
vi.mock("@/lib/featured-image", () => ({
  generateFeaturedImageOrNull: (...a: unknown[]) => generateFeaturedImageOrNull(...a),
}));

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/cms/posts", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    title: "Hello",
    slug: "hello",
    content: "Body",
    content_html: "<p>Body</p>",
    status: "draft",
    workflow_status: "draft",
    author_id: "u1",
    author_name: "Author One",
    published_at: null,
    approved_at: null,
    approved_by_id: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    category: null,
    ...overrides,
  };
}

beforeEach(() => {
  actor.permissions = new Set(["content:create"]);
  postCreate.mockReset();
  membershipFindUnique.mockReset();
  generateFeaturedImageOrNull.mockReset();
  postCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    row(data)
  );
});

describe("POST /api/cms/posts — authorship", () => {
  it("defaults a new post's author to the caller", async () => {
    await post({ title: "Hello", content: "Body" });

    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ author_id: "u1", author_name: "Author One" }),
      })
    );
  });

  it("refuses author_id from a caller without content:edit_any", async () => {
    const res = await post({ title: "Hello", content: "Body", author_id: "u2" });

    expect(res.status).toBe(403);
    expect(postCreate).not.toHaveBeenCalled();
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });

  it("refuses an author_id that doesn't name a member of the caller's org", async () => {
    actor.permissions = new Set(["content:create", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue(null);

    const res = await post({ title: "Hello", content: "Body", author_id: "u2" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/member of your organization/);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("credits a real org member for a content:edit_any holder", async () => {
    actor.permissions = new Set(["content:create", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey Writer", email: "casey@example.com", status: "active" },
    });

    const res = await post({ title: "Hello", content: "Body", author_id: "u2" });
    const { data } = await res.json();

    expect(membershipFindUnique).toHaveBeenCalledWith({
      where: { organization_id_user_id: { organization_id: "org1", user_id: "u2" } },
      select: { user: { select: { id: true, name: true, display_name: true, email: true, status: true } } },
    });
    expect(data.author_id).toBe("u2");
    expect(data.author_name).toBe("Casey Writer");
  });

  it("bylines a credited member with their chosen display name, not their SSO handle", async () => {
    actor.permissions = new Set(["content:create", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue({
      user: { id: "u2", name: "cwriter", display_name: "Casey Writer", email: "casey@example.com", status: "active" },
    });

    const res = await post({ title: "Hello", content: "Body", author_id: "u2" });
    expect((await res.json()).data.author_name).toBe("Casey Writer");
  });

  it("refuses a free-text author_name from a caller without content:edit_any", async () => {
    const res = await post({ title: "Hello", content: "Body", author_name: "Someone Else" });

    expect(res.status).toBe(403);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("lets a content:edit_any holder set a free-text author_name", async () => {
    actor.permissions = new Set(["content:create", "content:edit_any"]);

    const res = await post({ title: "Hello", content: "Body", author_name: "Guest Contributor" });
    const { data } = await res.json();

    expect(data.author_name).toBe("Guest Contributor");
    expect(data.author_id).toBe("u1");
  });

  it("does not 403 on the empty-string author_name the post editor always submits on create", async () => {
    // Regression: post-editor.tsx's create form defaults author_name to "" and
    // always includes it in the payload, whether or not the user touched the
    // field. An ordinary author (no content:edit_any) must still be able to
    // create a post.
    const res = await post({ title: "Hello", content: "Body", author_name: "" });

    expect(res.status).toBe(201);
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ author_id: "u1", author_name: "Author One" }) })
    );
  });

  it("treats an explicit null author_name as no override, not the literal string \"null\"", async () => {
    const res = await post({ title: "Hello", content: "Body", author_name: null });

    expect(res.status).toBe(201);
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ author_id: "u1", author_name: "Author One" }) })
    );
  });

  it("does not 403 a caller who (redundantly) submits their own real name", async () => {
    // Regression: a non-UI caller naming themselves correctly must not be
    // mistaken for an override attempt just because it isn't blank.
    const res = await post({ title: "Hello", content: "Body", author_name: "Author One" });

    expect(res.status).toBe(201);
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ author_id: "u1", author_name: "Author One" }) })
    );
  });

  it("ignores a free-text author_name sent alongside author_id — author_id is the sole source of the name", async () => {
    actor.permissions = new Set(["content:create", "content:edit_any"]);
    membershipFindUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey Writer", email: "casey@example.com", status: "active" },
    });

    const res = await post({
      title: "Hello",
      content: "Body",
      author_id: "u2",
      author_name: "Ghost Writer",
    });
    const { data } = await res.json();

    expect(data.author_id).toBe("u2");
    expect(data.author_name).toBe("Casey Writer");
  });
});

describe("POST /api/cms/posts — featured image on publish", () => {
  beforeEach(() => {
    actor.permissions = new Set(["content:create", "content:publish"]);
  });

  it("generates a title card instead of refusing a publish with no image", async () => {
    generateFeaturedImageOrNull.mockResolvedValue({
      url: "https://cdn.example/card.png",
      alt: 'Title card reading "Hello"',
      media_id: "m1",
    });

    const res = await post({ title: "Hello", content: "Body", status: "published" });

    expect(res.status).toBe(201);
    expect(generateFeaturedImageOrNull).toHaveBeenCalledWith(
      db,
      actor,
      expect.objectContaining({ title: "Hello", slug: "hello", author_name: "Author One" })
    );
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          featured_image: "https://cdn.example/card.png",
          featured_image_alt: 'Title card reading "Hello"',
        }),
      })
    );
  });

  it("keeps a supplied image and never generates", async () => {
    await post({ title: "Hello", content: "Body", status: "published", featured_image: "https://x/a.png" });
    expect(generateFeaturedImageOrNull).not.toHaveBeenCalled();
  });

  it("still refuses when generation fails", async () => {
    generateFeaturedImageOrNull.mockResolvedValue(null);
    const res = await post({ title: "Hello", content: "Body", status: "published" });
    expect(res.status).toBe(400);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("does not generate for a draft", async () => {
    await post({ title: "Hello", content: "Body" });
    expect(generateFeaturedImageOrNull).not.toHaveBeenCalled();
  });
});
