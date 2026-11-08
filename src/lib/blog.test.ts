import { beforeEach, describe, expect, it, vi } from "vitest";

const siteFindFirst = vi.fn();
const organizationFindUnique = vi.fn();
const postFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    site: { findFirst: (...a: unknown[]) => siteFindFirst(...a) },
    organization: { findUnique: (...a: unknown[]) => organizationFindUnique(...a) },
    post: { findMany: (...a: unknown[]) => postFindMany(...a) },
  },
}));
vi.mock("@/lib/oauth/protocol", () => ({ publicOrigin: () => "https://cms.example.com" }));

import {
  blogFeedData,
  blogLlmsData,
  blogPostWhere,
  blogSitemapData,
  blogSiteUrlCandidates,
  jsonLdScript,
  resolveBlogPostSeo,
  resolveBlogSite,
  type BlogSite,
} from "./blog";

beforeEach(() => {
  siteFindFirst.mockReset();
  organizationFindUnique.mockReset();
  postFindMany.mockReset();
});

const SITE: BlogSite = {
  id: "s1",
  slug: "cms",
  name: "CMS Blog",
  description: null,
  url: "https://cms.example.com/blog",
  organization_id: "org1",
  organization_name: "Interactor",
};

describe("resolveBlogSite", () => {
  it("finds the site registered at <origin>/blog, with or without a trailing slash", async () => {
    siteFindFirst.mockResolvedValue({
      id: "s1",
      slug: "cms",
      name: "Interactor CMS Blog",
      description: null,
      url: "https://cms.example.com/blog/",
      organization_id: "org_interactor",
      organization: { name: "Interactor" },
    });

    const site = await resolveBlogSite();

    expect(siteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { url: { in: ["https://cms.example.com/blog", "https://cms.example.com/blog/"] } },
      })
    );
    expect(site).toMatchObject({ slug: "cms", url: "https://cms.example.com/blog", organization_name: "Interactor" });
  });

  it("is null when no site claims the URL — every /blog route then 404s", async () => {
    siteFindFirst.mockResolvedValue(null);
    expect(await resolveBlogSite()).toBeNull();
  });

  it("normalizes the origin's trailing slash", () => {
    expect(blogSiteUrlCandidates("https://x.com/")[0]).toBe("https://x.com/blog");
  });
});

describe("blogPostWhere", () => {
  it("scopes to published posts of this org targeting this site, excluding future-scheduled ones", () => {
    const where = blogPostWhere({ organization_id: "o1", slug: "cms" });
    expect(where.organization_id).toBe("o1");
    expect(where.status).toBe("published");
    expect(where.platforms).toEqual({ has: "cms" });
    // Same guard as feed.ts/llms.ts/public-post.ts: status "published" with a
    // future published_at is a scheduled post, not a live one yet.
    expect(where.OR).toEqual([{ published_at: null }, { published_at: { lte: expect.any(Date) } }]);
  });
});

describe("jsonLdScript", () => {
  it("can't be broken out of its <script> by content", () => {
    expect(jsonLdScript({ t: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });
});

function basePostRow() {
  return {
    id: "p1",
    slug: "hello",
    title: "Hello World",
    excerpt: null,
    meta_description: null,
    featured_image: null,
    featured_image_alt: null,
    author_name: "Peter Jung",
    published_at: new Date("2026-09-23T00:00:00Z"),
    updated_at: new Date("2026-09-24T00:00:00Z"),
    reading_time: 4,
    category: null,
    seo_title: null,
    canonical_url: null,
    og_image: null,
    og_image_alt: null,
    noindex: false,
    content_updated_at: null,
    meta_keywords: null,
    content_html: "<p>Body</p>",
    tags: [] as string[],
    author: null,
  };
}

describe("resolveBlogPostSeo", () => {
  it("resolves the seo block for this site/org, absolutizing a relative featured image", async () => {
    siteFindFirst.mockResolvedValue({
      url: "https://cms.example.com/blog",
      name: "CMS Blog",
      publisher_name: null,
      logo_url: null,
    });
    organizationFindUnique.mockResolvedValue({ name: "Interactor", logo: null, same_as: [] });

    const post = { ...basePostRow(), featured_image: "/uploads/card.png" };
    const seo = await resolveBlogPostSeo(SITE, post);

    expect(siteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: "org1", slug: "cms" } })
    );
    expect(seo?.canonical).toBe("https://cms.example.com/blog/hello");
    expect(seo?.og.image).toBe("https://cms.example.com/uploads/card.png");
    expect(seo?.robots).toBe("index, follow");
  });

  it("is null when the site no longer resolves by (organization_id, slug)", async () => {
    siteFindFirst.mockResolvedValue(null);
    expect(await resolveBlogPostSeo(SITE, basePostRow())).toBeNull();
  });
});

describe("blogFeedData", () => {
  it("selects the full FeedPost shape, so the blog's own RSS gets the richer G#34 fields", async () => {
    postFindMany.mockResolvedValue([]);
    await blogFeedData(SITE, 50);

    const call = postFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ organization_id: "org1", platforms: { has: "cms" } });
    expect(call.select).toMatchObject({
      content_updated_at: true,
      author_name: true,
      featured_image: true,
      featured_image_alt: true,
      author: { select: { name: true, display_name: true } },
      category: { select: { name: true } },
    });
    expect(call.take).toBe(50);
  });
});

describe("blogSitemapData", () => {
  it("excludes noindex posts and posts syndicated elsewhere", async () => {
    postFindMany.mockResolvedValueOnce([
      { id: "1", slug: "self", updated_at: new Date(), content_updated_at: null, canonical_url: null },
      {
        id: "2",
        slug: "syndicated",
        updated_at: new Date(),
        content_updated_at: null,
        canonical_url: "https://elsewhere.example.com/syndicated",
      },
    ]);

    const feed = await blogSitemapData(SITE);

    expect(postFindMany.mock.calls[0][0].where).toMatchObject({ noindex: false, organization_id: "org1" });
    expect(feed.posts.map((p) => p.slug)).toEqual(["self"]);
  });

  it("paginates in SITEMAP_BATCH_SIZE-sized cursor pages", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: `p${i}`,
      slug: `post-${i}`,
      updated_at: new Date(),
      content_updated_at: null,
      canonical_url: null,
    }));
    postFindMany.mockResolvedValueOnce(full).mockResolvedValueOnce([]);

    const feed = await blogSitemapData(SITE);

    expect(postFindMany).toHaveBeenCalledTimes(2);
    expect(feed.posts).toHaveLength(500);
  });
});

describe("blogLlmsData", () => {
  it("scopes by this site's organization_id and platform, not a bare slug", async () => {
    postFindMany.mockResolvedValue([]);
    await blogLlmsData(SITE);

    expect(postFindMany.mock.calls[0][0].where).toMatchObject({
      organization_id: "org1",
      platforms: { has: "cms" },
    });
  });
});
