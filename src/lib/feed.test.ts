import { describe, expect, it, vi, beforeEach } from "vitest";

const { siteFindFirst, postFindMany } = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  postFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    site: { findFirst: siteFindFirst },
    post: { findMany: postFindMany },
  },
}));

import { buildRssXml, buildSitemapXml, loadFeedData, type FeedPost } from "./feed";

const site = { name: "Example Site", url: "https://example.com" };

describe("buildRssXml", () => {
  it("builds a channel with one <item> per post, linking under the site's base URL", () => {
    const xml = buildRssXml(site, [
      {
        slug: "hello-world",
        title: "Hello World",
        excerpt: "An intro post",
        published_at: new Date("2026-01-02T03:04:05Z"),
        updated_at: new Date("2026-01-02T03:04:05Z"),
      },
    ]);

    expect(xml).toContain("<title>Example Site</title>");
    expect(xml).toContain("<link>https://example.com</link>");
    expect(xml).toContain("<link>https://example.com/hello-world</link>");
    expect(xml).toContain('<guid isPermaLink="true">https://example.com/hello-world</guid>');
    expect(xml).toContain("<description>An intro post</description>");
  });

  it("strips a trailing slash from the site URL before joining the post slug", () => {
    const xml = buildRssXml(
      { name: "Example", url: "https://example.com/" },
      [
        {
          slug: "hello",
          title: "Hello",
          excerpt: null,
          published_at: new Date("2026-01-01T00:00:00Z"),
          updated_at: new Date("2026-01-01T00:00:00Z"),
        },
      ]
    );

    expect(xml).toContain("<link>https://example.com/hello</link>");
    expect(xml).not.toContain("https://example.com//hello");
  });

  it("falls back to updated_at for pubDate when a post has never been published_at-stamped", () => {
    const xml = buildRssXml(site, [
      {
        slug: "draft-turned-live",
        title: "Draft turned live",
        excerpt: null,
        published_at: null,
        updated_at: new Date("2026-03-04T00:00:00Z"),
      },
    ]);

    expect(xml).toContain(new Date("2026-03-04T00:00:00Z").toUTCString());
  });

  it("escapes XML-significant characters in title and description", () => {
    const xml = buildRssXml(site, [
      {
        slug: "amp-post",
        title: "Cats & Dogs <3",
        excerpt: 'A "great" post',
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    expect(xml).toContain("<title>Cats &amp; Dogs &lt;3</title>");
    expect(xml).toContain("<description>A &quot;great&quot; post</description>");
  });

  it("omits the item's <description> for a post with no excerpt", () => {
    const xml = buildRssXml(site, [
      {
        slug: "no-excerpt",
        title: "No excerpt",
        excerpt: null,
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const item = xml.slice(xml.indexOf("<item>"), xml.indexOf("</item>"));
    expect(item).not.toContain("<description>");
  });
});

describe("buildSitemapXml", () => {
  it("builds one <url> per post with <loc> and <lastmod> = content_updated_at when set", () => {
    const xml = buildSitemapXml(site, [
      {
        slug: "hello-world",
        updated_at: new Date("2026-01-05T00:00:00Z"),
        content_updated_at: new Date("2026-01-02T03:04:05Z"),
      },
    ]);

    expect(xml).toContain("<loc>https://example.com/hello-world</loc>");
    expect(xml).toContain(`<lastmod>${new Date("2026-01-02T03:04:05Z").toISOString()}</lastmod>`);
  });

  it("falls back to updated_at for lastmod when content_updated_at is null — NOT published_at (G#34: honest dates)", () => {
    const xml = buildSitemapXml(site, [
      {
        slug: "hello",
        updated_at: new Date("2026-02-01T00:00:00Z"),
        content_updated_at: null,
      },
    ]);

    expect(xml).toContain(`<lastmod>${new Date("2026-02-01T00:00:00Z").toISOString()}</lastmod>`);
  });

  it("falls back to updated_at when content_updated_at is entirely absent (the CMS's own dogfood blog's FeedPost shape, G#36)", () => {
    // `blogFeedData` (src/lib/blog.ts) selects no `content_updated_at` at all
    // and passes `FeedPost[]` straight into this function — this is the
    // structural-compatibility contract `SitemapPost`'s doc comment promises.
    // Typed as `FeedPost` (not an inline literal) so TS checks assignability
    // the same way that real call site does, rather than excess-property
    // checking a literal against the narrower `SitemapPost` parameter type.
    const legacyShapedPost: FeedPost = {
      slug: "no-content-updated-at-field",
      title: "Legacy shape",
      excerpt: null,
      published_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-03-01T00:00:00Z"),
    };
    const xml = buildSitemapXml(site, [legacyShapedPost]);

    expect(xml).toContain(`<lastmod>${new Date("2026-03-01T00:00:00Z").toISOString()}</lastmod>`);
  });
});

describe("loadFeedData", () => {
  beforeEach(() => {
    siteFindFirst.mockReset();
    postFindMany.mockReset();
  });

  it("returns null when no site is registered for the platform", async () => {
    siteFindFirst.mockResolvedValue(null);
    expect(await loadFeedData("unknown-site")).toBeNull();
    expect(postFindMany).not.toHaveBeenCalled();
  });

  it("scopes posts to published + this platform, most recent first", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example", url: "https://example.com" });
    postFindMany.mockResolvedValue([]);

    await loadFeedData("website");

    expect(postFindMany.mock.calls[0][0].where).toMatchObject({
      status: "published",
      platforms: { has: "website" },
    });
    expect(postFindMany.mock.calls[0][0].orderBy).toEqual({ published_at: "desc" });
  });

  it("returns the site's name/url alongside the posts", async () => {
    siteFindFirst.mockResolvedValue({
      name: "Example",
      url: "https://example.com",
      id: "site-1",
      slug: "website",
    });
    postFindMany.mockResolvedValue([{ slug: "a", title: "A", excerpt: null }]);

    const result = await loadFeedData("website");

    expect(result?.site).toEqual({ name: "Example", url: "https://example.com" });
    expect(result?.posts).toHaveLength(1);
  });
});
