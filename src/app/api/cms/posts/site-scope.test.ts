import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * G#21 through the real post route handlers: a token minted with a site scope
 * can create/read/change posts for its sites only and is refused BY NAME for
 * any other site; a token minted with none (and a browser session) keeps
 * reaching every site in its org.
 */

const PM = "product-manager";

const actor = {
  user: { id: "u1", email: "author@example.com", name: "Author One", status: "active" },
  organizationId: "org1",
  membershipRole: "admin",
  roles: ["admin"],
  permissions: new Set<string>([
    "content:view",
    "content:create",
    "content:edit",
    "content:edit_any",
    "content:delete",
  ]),
};

let apiToken: { site_scopes: string[] } | undefined;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    title: "Hello",
    slug: "hello",
    content: "Body",
    content_html: "<p>Body</p>",
    content_format: "markdown",
    excerpt: null,
    content_hash: null,
    status: "draft",
    workflow_status: "draft",
    type: "blog",
    tags: [],
    platforms: [PM],
    metadata: null,
    author_id: "u1",
    author_name: "Author One",
    updated_by_id: null,
    updated_by_name: null,
    published_at: null,
    approved_at: null,
    approved_by_id: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    category_id: null,
    category: null,
    ...overrides,
  };
}

let stored = row();

const postCreate = vi.fn();
const postFindMany = vi.fn();
const postUpdate = vi.fn();
const postUpdateMany = vi.fn();
const postDelete = vi.fn();
const postDeleteMany = vi.fn();
const trashCreateMany = vi.fn();

const db = {
  post: {
    create: (...a: unknown[]) => postCreate(...a),
    findUnique: async () => stored,
    findMany: (...a: unknown[]) => postFindMany(...a),
    count: async () => 1,
    update: (...a: unknown[]) => postUpdate(...a),
    updateMany: (...a: unknown[]) => postUpdateMany(...a),
    delete: (...a: unknown[]) => postDelete(...a),
    deleteMany: (...a: unknown[]) => postDeleteMany(...a),
  },
  membership: { findUnique: async () => null },
  category: { findUnique: async () => null },
  // Deletes go to the trash (src/lib/post-trash.ts) before the row goes.
  deletedPost: {
    createMany: (...a: unknown[]) => trashCreateMany(...a),
    deleteMany: async () => ({ count: 0 }),
  },
  socialPost: { findMany: async () => [] },
  // This org has both sites registered (src/lib/sites.ts has no cross-org
  // built-in seeds — a real org gets a real row for each site it targets),
  // so orgSiteSlugs() allows exactly these two, and site-scope refusals
  // below are about the TOKEN's scope, not about site registration.
  site: {
    findMany: async () => [
      { id: "site-website", slug: "website", name: "Website", description: null, url: "https://example.com", sort_order: 0 },
      { id: "site-pm", slug: PM, name: "Product Manager", description: null, url: "https://pm.example.com", sort_order: 1 },
    ],
  },
  postRevision: {
    create: async ({ data }: { data: unknown }) => data,
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
  },
  $transaction: async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as unknown[]),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({
    actor,
    db,
    via: apiToken ? "token" : "session",
    apiToken,
  })),
}));

vi.mock("@/lib/db", () => ({ isUniqueViolation: () => false }));

import { GET as listPosts, POST as createPost } from "./route";
import { GET as getPost, PUT as updatePost, DELETE as deletePost } from "./[id]/route";
import { DELETE as bulkDelete } from "./bulk-delete/route";

const ctx = { params: Promise.resolve({ id: "p1" }) };

const create = (body: unknown) =>
  createPost(new NextRequest("http://localhost/api/cms/posts", { method: "POST", body: JSON.stringify(body) }));
const list = () => listPosts(new NextRequest("http://localhost/api/cms/posts"));
const get = () => getPost(new NextRequest("http://localhost/api/cms/posts/p1"), ctx);
const put = (body: unknown) =>
  updatePost(new NextRequest("http://localhost/api/cms/posts/p1", { method: "PUT", body: JSON.stringify(body) }), ctx);
const del = () => deletePost(new NextRequest("http://localhost/api/cms/posts/p1", { method: "DELETE" }), ctx);
const bulk = (body: unknown) =>
  bulkDelete(new NextRequest("http://localhost/api/cms/posts/bulk-delete", { method: "DELETE", body: JSON.stringify(body) }));

beforeEach(() => {
  apiToken = { site_scopes: [PM] };
  stored = row();
  for (const fn of [postCreate, postFindMany, postUpdate, postUpdateMany, postDelete, postDeleteMany, trashCreateMany]) {
    fn.mockReset();
  }
  postCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
  postFindMany.mockImplementation(async () => [stored]);
  postUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    stored = { ...stored, ...data };
    return stored;
  });
  postUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    stored = { ...stored, ...data };
    return { count: 1 };
  });
  postDelete.mockResolvedValue(stored);
  postDeleteMany.mockResolvedValue({ count: 1 });
});

async function expectNamedRefusal(res: Response, ...named: string[]) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).not.toMatch(/not found/i);
  expect(body.error).toContain(PM);
  for (const site of named) expect(body.error).toContain(site);
  return body;
}

describe("site-scoped token — allowed within its scope", () => {
  it("creates a post targeting its site", async () => {
    const res = await create({ title: "PM news", content: "Body", platforms: [PM] });

    expect(res.status).toBeLessThan(300);
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ platforms: [PM] }) })
    );
  });

  it("lists only posts targeting its sites", async () => {
    await list();

    expect(postFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ platforms: { hasSome: [PM] } }) })
    );
  });

  it("reads a post shared between its site and another", async () => {
    stored = row({ platforms: ["website", PM] });
    expect((await get()).status).toBe(200);
  });

  it("changes a post that only targets its site", async () => {
    const res = await put({ title: "Renamed" });

    expect(res.status).toBe(200);
    expect(stored.title).toBe("Renamed");
  });

  it("deletes a post that only targets its site, into the trash", async () => {
    expect((await del()).status).toBe(204);
    expect(trashCreateMany.mock.calls[0][0].data[0]).toMatchObject({ post_id: stored.id, slug: stored.slug });
    expect(postDeleteMany).toHaveBeenCalledWith({ where: { id: { in: [stored.id] } } });
  });
});

describe("site-scoped token — refused by name outside its scope", () => {
  it("won't create a post for another site", async () => {
    const res = await create({ title: "Website news", content: "Body", platforms: ["website"] });

    await expectNamedRefusal(res, "website");
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("won't fall back to the default site when platforms is omitted, and says why", async () => {
    const res = await create({ title: "No platforms", content: "Body" });

    const body = await expectNamedRefusal(res, "website");
    expect(body.error).toMatch(/when platforms is omitted/);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("won't read a post that only targets another site", async () => {
    stored = row({ platforms: ["website"] });
    await expectNamedRefusal(await get(), "website");
  });

  it("won't change a post shared with another site", async () => {
    stored = row({ platforms: ["website", PM] });

    await expectNamedRefusal(await put({ title: "Renamed" }), "website");
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("won't pull another site's post into its scope by retargeting it", async () => {
    stored = row({ platforms: ["website"] });

    await expectNamedRefusal(await put({ platforms: [PM] }), "website");
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("won't retarget one of its posts to another site", async () => {
    await expectNamedRefusal(await put({ platforms: [PM, "website"] }), "website");
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("won't delete a post for another site", async () => {
    stored = row({ platforms: ["website"] });

    await expectNamedRefusal(await del(), "website");
    expect(postDelete).not.toHaveBeenCalled();
  });

  it("refuses a whole bulk delete that includes another site's post", async () => {
    postFindMany.mockResolvedValue([
      { slug: "pm-post", platforms: [PM] },
      { slug: "website-post", platforms: ["website"] },
    ]);

    const res = await bulk({ slugs: ["pm-post", "website-post"] });
    const body = await expectNamedRefusal(res);
    expect(body.out_of_scope_slugs).toEqual(["website-post"]);
    expect(postDeleteMany).not.toHaveBeenCalled();
  });
});

describe.each([
  ["a token minted with no site scope", { site_scopes: [] }],
  ["a browser session", undefined],
])("%s — every site in the org, as before", (_label, credential) => {
  beforeEach(() => {
    apiToken = credential;
    stored = row({ platforms: ["website"] });
  });

  it("creates a post with the default site", async () => {
    const res = await create({ title: "Website news", content: "Body" });

    expect(res.status).toBeLessThan(300);
    expect(postCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ platforms: ["website"] }) })
    );
  });

  it("lists without a site filter", async () => {
    await list();
    expect(postFindMany.mock.calls[0][0].where).not.toHaveProperty("platforms");
  });

  it("reads, retargets and deletes any site's post", async () => {
    expect((await get()).status).toBe(200);
    expect((await put({ platforms: [PM] })).status).toBe(200);
    expect(stored.platforms).toEqual([PM]);
    expect((await del()).status).toBe(204);
  });

  it("bulk deletes the matched posts into the trash", async () => {
    postFindMany.mockResolvedValueOnce([row({ id: "a", slug: "a" }), row({ id: "b", slug: "b" })]);
    expect((await bulk({ slugs: ["a", "b"] })).status).toBe(204);
    expect(postFindMany).toHaveBeenCalledWith({ where: { slug: { in: ["a", "b"] } } });
    expect(trashCreateMany.mock.calls[0][0].data.map((d: { slug: string }) => d.slug)).toEqual(["a", "b"]);
    expect(postDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } } });
  });
});

describe("listing filters: ?site= and ?search=", () => {
  const listWith = (qs: string) => listPosts(new NextRequest(`http://localhost/api/cms/posts?${qs}`));

  it("narrows to posts targeting the named site", async () => {
    await listWith("site=website");
    expect(postFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: [{ platforms: { has: "website" } }] }) })
    );
  });

  it("matches the search text against title, slug, excerpt and body, case-insensitively", async () => {
    await listWith("search=%20LLM%20");
    const contains = { contains: "LLM", mode: "insensitive" };
    expect(postFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ OR: [{ title: contains }, { slug: contains }, { excerpt: contains }, { content: contains }] }],
        }),
      })
    );
  });

  it("combines with a token's site scope instead of replacing it", async () => {
    apiToken = { site_scopes: [PM] };
    await listWith("site=website&search=llm");
    const where = postFindMany.mock.calls[0][0].where;
    expect(where.platforms).toEqual({ hasSome: [PM] });
    expect(where.AND).toHaveLength(2);
  });
});
