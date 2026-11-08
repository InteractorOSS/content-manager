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

import { buildLlmsTxt, loadLlmsData, LLMS_BATCH_SIZE } from "./llms";

describe("buildLlmsTxt", () => {
  const site = { name: "Example Site", url: "https://example.com" };

  it("builds an H1 + Posts section with one markdown link per post", () => {
    const txt = buildLlmsTxt(site, [
      { slug: "hello", title: "Hello World", excerpt: "An intro", meta_description: null },
    ]);

    expect(txt).toContain("# Example Site");
    expect(txt).toContain("## Posts");
    expect(txt).toContain("- [Hello World](https://example.com/hello): An intro");
  });

  it("prefers meta_description over excerpt for the link's description", () => {
    const txt = buildLlmsTxt(site, [
      { slug: "hello", title: "Hello", excerpt: "Excerpt text", meta_description: "Meta description text" },
    ]);

    expect(txt).toContain("Meta description text");
    expect(txt).not.toContain("Excerpt text");
  });

  it("omits the trailing ': description' when a post has neither", () => {
    const txt = buildLlmsTxt(site, [{ slug: "bare", title: "Bare Post", excerpt: null, meta_description: null }]);

    expect(txt).toContain("- [Bare Post](https://example.com/bare)");
    expect(txt).not.toContain("Bare Post):");
  });

  it("escapes a ']' in a title so it can't prematurely close the markdown link", () => {
    const txt = buildLlmsTxt(site, [
      { slug: "weird", title: "Weird [Title]", excerpt: null, meta_description: null },
    ]);

    expect(txt).toContain("[Weird \\[Title\\]](https://example.com/weird)");
  });

  it("collapses newlines in a description to keep each post on one line", () => {
    const txt = buildLlmsTxt(site, [
      { slug: "multiline", title: "Multiline", excerpt: "Line one\nLine two", meta_description: null },
    ]);

    expect(txt).toContain("- [Multiline](https://example.com/multiline): Line one Line two");
  });
});

describe("loadLlmsData", () => {
  beforeEach(() => {
    siteFindFirst.mockReset();
    postFindMany.mockReset();
  });

  it("returns null when no site is registered for the platform", async () => {
    siteFindFirst.mockResolvedValue(null);
    expect(await loadLlmsData("unknown")).toBeNull();
    expect(postFindMany).not.toHaveBeenCalled();
  });

  it("scopes to published posts targeting this platform", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example", url: "https://example.com" });
    postFindMany.mockResolvedValue([]);

    await loadLlmsData("website");

    expect(postFindMany.mock.calls[0][0].where).toMatchObject({
      status: "published",
      platforms: { has: "website" },
    });
  });

  it("pages through more posts than fit in one batch via cursor pagination", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example", url: "https://example.com" });
    const firstBatch = Array.from({ length: LLMS_BATCH_SIZE }, (_, i) => ({
      id: `p${i}`,
      slug: `post-${i}`,
      title: `Post ${i}`,
      excerpt: null,
      meta_description: null,
    }));
    const secondBatch = [{ id: "last", slug: "last-post", title: "Last Post", excerpt: null, meta_description: null }];
    postFindMany.mockResolvedValueOnce(firstBatch).mockResolvedValueOnce(secondBatch);

    const result = await loadLlmsData("website");

    expect(postFindMany).toHaveBeenCalledTimes(2);
    expect(result?.posts).toHaveLength(LLMS_BATCH_SIZE + 1);
  });

  it("strips a trailing slash from the site URL", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example", url: "https://example.com/" });
    postFindMany.mockResolvedValue([]);

    const result = await loadLlmsData("website");

    expect(result?.site.url).toBe("https://example.com");
  });
});
