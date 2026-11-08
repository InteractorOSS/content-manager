import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { findMany, count, findFirst, slugHistoryFindFirst, siteFindFirst, orgFindUnique } = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  slugHistoryFindFirst: vi.fn(),
  siteFindFirst: vi.fn(),
  orgFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    post: { findMany, count, findFirst },
    postSlugHistory: { findFirst: slugHistoryFindFirst },
    site: { findFirst: siteFindFirst },
    organization: { findUnique: orgFindUnique },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { GET as listPosts } from "./route";
import { GET as getPostBySlug } from "./slug/[slug]/route";

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    organization_id: "org1",
    title: "Hello",
    slug: "hello",
    content_html: "<p>Body</p>",
    status: "published",
    published_at: new Date(),
    inserted_at: new Date(),
    updated_at: new Date(),
    category: null,
    tags: [],
    platforms: ["website"],
    // A live preview link on an otherwise-published post — internal
    // editorial metadata that must never reach an anonymous caller.
    preview_token_expires_at: new Date(Date.now() + 100_000),
    // Who last touched the row internally — not the post's public byline
    // (that's author_name), and must never reach an anonymous caller either.
    updated_by_id: "internal-user-1",
    updated_by_name: "Internal Editor",
    ...overrides,
  };
}

beforeEach(() => {
  findMany.mockReset();
  count.mockReset();
  findFirst.mockReset();
  slugHistoryFindFirst.mockReset();
  siteFindFirst.mockReset();
  orgFindUnique.mockReset();
});

describe("GET /api/public/posts", () => {
  it("never leaks preview_token_expires_at on a published post with a live preview link", async () => {
    findMany.mockResolvedValue([postRow()]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].preview_token_expires_at).toBeUndefined();
  });

  it("never leaks updated_by_id/updated_by_name — an internal editor identity, not the public byline", async () => {
    findMany.mockResolvedValue([postRow()]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].updated_by_id).toBeUndefined();
    expect(data[0].updated_by_name).toBeUndefined();
  });

  it("never leaks internal fields no denylist ever named (G#31 allowlist)", async () => {
    // The point of switching to an allowlist: a column added to Post AFTER
    // this route was last touched is safe by default, with no matching omit
    // to remember. workflow_status/rejection_reason/approved_by_id/
    // ai_generated_content/ai_style_profile_id predate this change and were
    // always leaking through the old `{...post}` spread.
    findMany.mockResolvedValue([
      postRow({
        workflow_status: "pending_review",
        rejection_reason: "needs a source",
        approved_by_id: "user-9",
        ai_generated_content: "draft text",
        ai_style_profile_id: "profile-1",
      }),
    ]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].workflow_status).toBeUndefined();
    expect(data[0].rejection_reason).toBeUndefined();
    expect(data[0].approved_by_id).toBeUndefined();
    expect(data[0].ai_generated_content).toBeUndefined();
    expect(data[0].ai_style_profile_id).toBeUndefined();
  });

  it("serves the G#31 SEO fields, and omits the CMS's-newer-subsystem ones when unset", async () => {
    findMany.mockResolvedValue([
      postRow({
        seo_title: "Better SERP title",
        canonical_url: "https://interactor.com/blog/hello",
        og_image: "/og/hello.png",
        og_image_alt: "hello",
        noindex: true,
        content_updated_at: new Date("2026-09-20T00:00:00.000Z"),
        answer_summary: "A 40-60 word answer.",
        redirect_to: "/post/new-home",
      }),
    ]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].seo_title).toBe("Better SERP title");
    expect(data[0].canonical_url).toBe("https://interactor.com/blog/hello");
    expect(data[0].og_image).toBe("/og/hello.png");
    expect(data[0].og_image_alt).toBe("hello");
    expect(data[0].noindex).toBe(true);
    expect(data[0].content_updated_at).toBe("2026-09-20T00:00:00.000Z");
    expect(data[0].answer_summary).toBe("A 40-60 word answer.");
    expect(data[0].redirect_to).toBe("/post/new-home");
  });

  it("omits content_updated_at/answer_summary/redirect_to entirely, not as null, when unset", async () => {
    findMany.mockResolvedValue([postRow({ content_updated_at: null, answer_summary: null, redirect_to: null })]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const raw = await res.text();
    const { data } = JSON.parse(raw);

    expect("content_updated_at" in data[0]).toBe(false);
    expect("answer_summary" in data[0]).toBe(false);
    expect("redirect_to" in data[0]).toBe(false);
  });

  it("resolves the author as an entity once they have a public author_slug", async () => {
    findMany.mockResolvedValue([
      postRow({
        author: {
          name: "jsmith",
          display_name: "Peter Jung",
          email: "p@x.com",
          author_slug: "acme",
          job_title: "Founder",
          bio: "Building Interactor.",
          avatar_url: "/a.png",
          same_as: ["https://x.com/peterjung"],
        },
      }),
    ]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].author).toEqual({
      name: "Peter Jung",
      slug: "acme",
      job_title: "Founder",
      bio: "Building Interactor.",
      avatar_url: "/a.png",
      same_as: ["https://x.com/peterjung"],
    });
  });

  it("still serves content_html and platforms — the allowlist must not silently drop pre-existing fields", async () => {
    findMany.mockResolvedValue([postRow({ content_html: "<p>Body</p>", platforms: ["website", "product-manager"] })]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].content_html).toBe("<p>Body</p>");
    expect(data[0].platforms).toEqual(["website", "product-manager"]);
  });

  it("never leaks a private email as the public author's name", async () => {
    // display_name and the SSO name are both unset — authorDisplayName's own
    // fallback chain would reach `email` next, which is fine for an
    // authenticated CMS caller but not for this public entity.
    findMany.mockResolvedValue([
      postRow({
        author: {
          name: "",
          display_name: null,
          email: "private@example.com",
          author_slug: "someone",
          job_title: null,
          bio: null,
          avatar_url: null,
          same_as: [],
        },
      }),
    ]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].author.name).toBeNull();
    expect(JSON.stringify(data[0].author)).not.toContain("private@example.com");
  });

  it("has no author entity until the credited user sets a public author_slug", async () => {
    findMany.mockResolvedValue([
      postRow({
        author: { name: "jsmith", display_name: null, email: "p@x.com", author_slug: null, job_title: null, bio: null, avatar_url: null, same_as: [] },
      }),
    ]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));
    const { data } = await res.json();

    expect(data[0].author).toBeNull();
  });

  it("resolves the site+org context once for a page of posts from the same org (G#33)", async () => {
    findMany.mockResolvedValue([postRow({ id: "p1", slug: "a" }), postRow({ id: "p2", slug: "b" })]);
    count.mockResolvedValue(2);
    siteFindFirst.mockResolvedValue({ url: "https://example.com", name: "Example Blog", publisher_name: null, logo_url: null });
    orgFindUnique.mockResolvedValue({ name: "Example Inc", logo: null, same_as: [] });

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts?platform=website"));
    const { data } = await res.json();

    expect(data[0].seo.canonical).toBe("https://example.com/a");
    expect(data[1].seo.canonical).toBe("https://example.com/b");
    expect(siteFindFirst).toHaveBeenCalledTimes(1);
    expect(orgFindUnique).toHaveBeenCalledTimes(1);
  });

  it("filters by ?author_slug=, joining on the author relation", async () => {
    findMany.mockResolvedValue([postRow()]);
    count.mockResolvedValue(1);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts?author_slug=jane-doe"));
    const { data, meta } = await res.json();

    const args = findMany.mock.calls[0][0];
    expect(args.where.author).toEqual({ author_slug: "jane-doe" });
    // Still the published-only list: same ordering, same joined author/category.
    expect(args.where.status).toBe("published");
    expect(args.orderBy).toEqual({ published_at: "desc" });
    expect(Object.keys(args.include).sort()).toEqual(["author", "category"]);
    // The total counts the same filtered set, so pagination stays honest.
    expect(count.mock.calls[0][0].where).toEqual(args.where);
    expect(data).toHaveLength(1);
    expect(meta.total).toBe(1);
  });

  it("combines ?author_slug= with the existing filters rather than replacing them", async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    await listPosts(
      new NextRequest(
        "http://localhost/api/public/posts?author_slug=jane-doe&type=article&category_id=cat1&platform=website"
      )
    );

    const { where } = findMany.mock.calls[0][0];
    expect(where.author).toEqual({ author_slug: "jane-doe" });
    expect(where.type).toBe("article");
    expect(where.category_id).toBe("cat1");
    expect(where.platforms).toEqual({ has: "website" });
  });

  it("an unrecognized ?author_slug= matches nothing — empty list, not an error", async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts?author_slug=nobody-here"));
    const { data, meta } = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual([]);
    expect(meta.total).toBe(0);
  });

  it("omits the author filter entirely when ?author_slug= is not given", async () => {
    findMany.mockResolvedValue([postRow()]);
    count.mockResolvedValue(1);

    await listPosts(new NextRequest("http://localhost/api/public/posts"));

    expect(findMany.mock.calls[0][0].where.author).toBeUndefined();
  });
});

describe("GET /api/public/posts/slug/[slug]", () => {
  it("never leaks preview_token_expires_at on a published post with a live preview link", async () => {
    findFirst.mockResolvedValue(postRow());

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello"), {
      params: Promise.resolve({ slug: "hello" }),
    });
    const { data } = await res.json();

    expect(data.preview_token_expires_at).toBeUndefined();
  });

  it("never leaks updated_by_id/updated_by_name — an internal editor identity, not the public byline", async () => {
    findFirst.mockResolvedValue(postRow());

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello"), {
      params: Promise.resolve({ slug: "hello" }),
    });
    const { data } = await res.json();

    expect(data.updated_by_id).toBeUndefined();
    expect(data.updated_by_name).toBeUndefined();
  });

  it("answers an old, retired slug with a redirect instead of 404", async () => {
    findFirst.mockResolvedValue(null); // no live post at this slug
    slugHistoryFindFirst.mockResolvedValue({
      old_slug: "hello-old",
      post: { slug: "hello-new", status: "published", platforms: ["website"] },
    });

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello-old"), {
      params: Promise.resolve({ slug: "hello-old" }),
    });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ redirect_slug: "hello-new" });
  });

  it("404s a retired slug whose successor is no longer published", async () => {
    findFirst.mockResolvedValue(null);
    slugHistoryFindFirst.mockResolvedValue({
      old_slug: "hello-old",
      post: { slug: "hello-new", status: "draft", platforms: ["website"] },
    });

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello-old"), {
      params: Promise.resolve({ slug: "hello-old" }),
    });

    expect(res.status).toBe(404);
  });

  it("404s a slug with no live post and no retirement record", async () => {
    findFirst.mockResolvedValue(null);
    slugHistoryFindFirst.mockResolvedValue(null);

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/nope"), {
      params: Promise.resolve({ slug: "nope" }),
    });

    expect(res.status).toBe(404);
  });

  it("resolves seo when ?platform= names a registered site (G#33)", async () => {
    findFirst.mockResolvedValue(postRow());
    siteFindFirst.mockResolvedValue({ url: "https://example.com", name: "Example Blog", publisher_name: null, logo_url: null });
    orgFindUnique.mockResolvedValue({ name: "Example Inc", logo: null, same_as: [] });

    const res = await getPostBySlug(
      new NextRequest("http://localhost/api/public/posts/slug/hello?platform=website"),
      { params: Promise.resolve({ slug: "hello" }) }
    );
    const { data } = await res.json();

    expect(data.seo.canonical).toBe("https://example.com/hello");
    expect(siteFindFirst).toHaveBeenCalledWith({
      where: { organization_id: "org1", slug: "website" },
      select: { url: true, name: true, publisher_name: true, logo_url: true },
    });
  });

  it("omits seo entirely (never null) when no ?platform= is given", async () => {
    findFirst.mockResolvedValue(postRow());

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello"), {
      params: Promise.resolve({ slug: "hello" }),
    });
    const { data } = await res.json();

    expect("seo" in data).toBe(false);
    expect(siteFindFirst).not.toHaveBeenCalled();
  });

  it("omits seo when ?platform= names no registered site", async () => {
    findFirst.mockResolvedValue(postRow());
    siteFindFirst.mockResolvedValue(null);
    orgFindUnique.mockResolvedValue({ name: "Example Inc", logo: null, same_as: [] });

    const res = await getPostBySlug(
      new NextRequest("http://localhost/api/public/posts/slug/hello?platform=unregistered"),
      { params: Promise.resolve({ slug: "hello" }) }
    );
    const { data } = await res.json();

    expect("seo" in data).toBe(false);
  });
});

describe("GET /api/public/posts/slug/[slug].md (G#34)", () => {
  it("returns clean markdown + YAML frontmatter for an HTML-format post, converted from content_html", async () => {
    findFirst.mockResolvedValue(
      postRow({ content_format: "html", content_html: "<p>Hello <strong>world</strong></p>", seo_title: "SEO Title" })
    );

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello.md"), {
      params: Promise.resolve({ slug: "hello.md" }),
    });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(body).toContain("title: SEO Title");
    expect(body).toContain("slug: hello");
    // Turndown's HTML → markdown conversion, not the raw content_html.
    expect(body).toContain("Hello **world**");
    expect(body).not.toContain("<strong>");
    // The dynamic `[slug]` segment resolves the post by its bare slug, not
    // literally "hello.md" — the ".md" suffix is stripped before lookup.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ slug: "hello" }) })
    );
  });

  it("passes a markdown-format post's content through verbatim, unconverted", async () => {
    findFirst.mockResolvedValue(
      postRow({ content_format: "markdown", content: "Hello **world**", content_html: "<p>Hello <strong>world</strong></p>" })
    );

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello.md"), {
      params: Promise.resolve({ slug: "hello.md" }),
    });
    const body = await res.text();

    expect(body).toContain("Hello **world**");
  });

  it("404s when the underlying post doesn't exist, same as the JSON route", async () => {
    findFirst.mockResolvedValue(null);
    slugHistoryFindFirst.mockResolvedValue(null);

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/nope.md"), {
      params: Promise.resolve({ slug: "nope.md" }),
    });

    expect(res.status).toBe(404);
  });

  it("answers a renamed post's old slug + .md with the redirect JSON, not markdown — same contract as the plain JSON route", async () => {
    // Mirrors the "answers an old, retired slug with a redirect instead of
    // 404" case above: the .md suffix is stripped to "hello-old" before
    // resolvePostBySlugOrHistory runs, so this exercises the identical
    // slug-history lookup, just reached via the markdown-suffixed URL. There
    // is no markdown to render for a slug that no longer has a live post —
    // the caller is expected to follow redirect_slug and re-request
    // `<redirect_slug>.md` for the actual content.
    findFirst.mockResolvedValue(null); // no live post at the old slug
    slugHistoryFindFirst.mockResolvedValue({
      old_slug: "hello-old",
      post: { slug: "hello-new", status: "published", platforms: ["website"] },
    });

    const res = await getPostBySlug(new NextRequest("http://localhost/api/public/posts/slug/hello-old.md"), {
      params: Promise.resolve({ slug: "hello-old.md" }),
    });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).not.toBe("text/markdown; charset=utf-8");
    expect(data).toEqual({ redirect_slug: "hello-new" });
    // The ".md" suffix was stripped before history lookup ran, same as it's
    // stripped before the live-post lookup in the other .md tests.
    expect(slugHistoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ old_slug: "hello-old" }) })
    );
  });
});
