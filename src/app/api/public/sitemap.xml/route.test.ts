import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { SITEMAP_BATCH_SIZE } from "@/lib/feed";

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

import { GET } from "./route";

function req(url: string) {
  return new NextRequest(url);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    slug: "hello",
    updated_at: new Date("2026-01-01T00:00:00Z"),
    content_updated_at: null,
    canonical_url: null,
    ...overrides,
  };
}

beforeEach(() => {
  siteFindFirst.mockReset();
  postFindMany.mockReset();
});

describe("GET /api/public/sitemap.xml", () => {
  it("400s without ?platform=", async () => {
    const res = await GET(req("http://localhost/api/public/sitemap.xml"));
    expect(res.status).toBe(400);
    expect(siteFindFirst).not.toHaveBeenCalled();
  });

  it("404s when no site is registered for the platform", async () => {
    siteFindFirst.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/public/sitemap.xml?platform=nope"));
    expect(res.status).toBe(404);
  });

  it("sets the public CORS header", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([]);
    const res = await GET(req("http://localhost/api/public/sitemap.xml?platform=website"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns a sitemap built from the site's url and its published posts, lastmod = content_updated_at ?? updated_at", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValueOnce([
      row({ id: "p1", slug: "hello", updated_at: new Date("2026-01-01T00:00:00Z"), content_updated_at: null }),
      row({
        id: "p2",
        slug: "fresh",
        updated_at: new Date("2026-01-01T00:00:00Z"),
        content_updated_at: new Date("2026-02-01T00:00:00Z"),
      }),
    ]);

    const res = await GET(req("http://localhost/api/public/sitemap.xml?platform=website"));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    // No content_updated_at: falls back to updated_at.
    expect(body).toContain("<loc>https://example.com/hello</loc>");
    expect(body).toContain("<lastmod>2026-01-01T00:00:00.000Z</lastmod>");
    // Has content_updated_at: that wins over the (older, in this case) updated_at.
    expect(body).toContain("<loc>https://example.com/fresh</loc>");
    expect(body).toContain("<lastmod>2026-02-01T00:00:00.000Z</lastmod>");
  });

  it("excludes noindex posts at the query level", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValueOnce([row()]);

    await GET(req("http://localhost/api/public/sitemap.xml?platform=website"));

    expect(postFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ noindex: false }) })
    );
  });

  it("excludes a post whose canonical_url points at a different site (a syndicated copy)", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValueOnce([
      row({ slug: "native", canonical_url: null }),
      row({ id: "p2", slug: "syndicated", canonical_url: "https://other-site.example/syndicated" }),
      // Self-canonical (matches this exact site's own URL for the post): still listed.
      row({ id: "p3", slug: "self-canonical", canonical_url: "https://example.com/self-canonical" }),
    ]);

    const res = await GET(req("http://localhost/api/public/sitemap.xml?platform=website"));
    const body = await res.text();

    expect(body).toContain("<loc>https://example.com/native</loc>");
    expect(body).toContain("<loc>https://example.com/self-canonical</loc>");
    expect(body).not.toContain("syndicated");
  });

  it("pages through more posts than fit in one batch via cursor pagination", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    const firstBatch = Array.from({ length: SITEMAP_BATCH_SIZE }, (_, i) =>
      row({ id: `p${i}`, slug: `post-${i}` })
    );
    const secondBatch = [row({ id: "last", slug: "last-post" })];
    postFindMany.mockResolvedValueOnce(firstBatch).mockResolvedValueOnce(secondBatch);

    const res = await GET(req("http://localhost/api/public/sitemap.xml?platform=website"));
    const body = await res.text();

    expect(postFindMany).toHaveBeenCalledTimes(2);
    // Second call continues from the first batch's last row via cursor.
    expect(postFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: `p${SITEMAP_BATCH_SIZE - 1}` }, skip: 1 })
    );
    expect(body).toContain("<loc>https://example.com/post-0</loc>");
    expect(body).toContain("<loc>https://example.com/last-post</loc>");
  });

  it("stops after exactly one full batch when that batch was the last page", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    // Exactly SITEMAP_BATCH_SIZE rows: the loop can't tell this apart from
    // "there might be more" until it asks again and gets an empty page.
    const fullBatch = Array.from({ length: SITEMAP_BATCH_SIZE }, (_, i) => row({ id: `p${i}`, slug: `post-${i}` }));
    postFindMany.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce([]);

    await GET(req("http://localhost/api/public/sitemap.xml?platform=website"));

    expect(postFindMany).toHaveBeenCalledTimes(2);
  });
});
