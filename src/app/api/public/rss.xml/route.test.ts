import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

beforeEach(() => {
  siteFindFirst.mockReset();
  postFindMany.mockReset();
});

describe("GET /api/public/rss.xml", () => {
  it("400s without ?platform=", async () => {
    const res = await GET(req("http://localhost/api/public/rss.xml"));
    expect(res.status).toBe(400);
    expect(siteFindFirst).not.toHaveBeenCalled();
  });

  it("404s when no site is registered for the platform", async () => {
    siteFindFirst.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/public/rss.xml?platform=nope"));
    expect(res.status).toBe(404);
  });

  it("sets the public CORS header", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([]);
    const res = await GET(req("http://localhost/api/public/rss.xml?platform=website"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns an RSS feed built from the site's url and its published posts", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([
      {
        slug: "hello",
        title: "Hello",
        excerpt: "Intro",
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(req("http://localhost/api/public/rss.xml?platform=website"));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    expect(body).toContain("<link>https://example.com/hello</link>");
  });

  it("includes author (visible byline wins over the linked profile), category, image enclosure and atom:updated", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([
      {
        slug: "hello",
        title: "Hello",
        excerpt: "Intro",
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
        content_updated_at: new Date("2026-02-01T00:00:00Z"),
        author_name: "Guest Byline",
        author: { name: "Real Author", display_name: "Real A." },
        category: { name: "Announcements" },
        featured_image: "https://cdn.example.com/hero.png",
      },
    ]);

    const res = await GET(req("http://localhost/api/public/rss.xml?platform=website"));
    const body = await res.text();

    expect(body).toContain("<dc:creator>Guest Byline</dc:creator>");
    expect(body).toContain("<category>Announcements</category>");
    expect(body).toContain('<enclosure url="https://cdn.example.com/hero.png" length="0" type="image/png"/>');
    expect(body).toContain("<atom:updated>2026-02-01T00:00:00.000Z</atom:updated>");
    expect(body).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
    expect(body).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
  });

  it("falls back to the linked author profile's name when there is no free-text author_name", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([
      {
        slug: "hello",
        title: "Hello",
        excerpt: null,
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
        author_name: null,
        author: { name: "Real Author", display_name: null },
      },
    ]);

    const res = await GET(req("http://localhost/api/public/rss.xml?platform=website"));
    const body = await res.text();

    expect(body).toContain("<dc:creator>Real Author</dc:creator>");
  });

  it("omits author/category/enclosure/atom:updated falls back to updated_at when a post has none of them", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([
      {
        slug: "bare",
        title: "Bare Post",
        excerpt: null,
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-05T00:00:00Z"),
      },
    ]);

    const res = await GET(req("http://localhost/api/public/rss.xml?platform=website"));
    const body = await res.text();

    expect(body).not.toContain("<dc:creator>");
    expect(body).not.toContain("<category>");
    expect(body).not.toContain("<enclosure");
    expect(body).toContain("<atom:updated>2026-01-05T00:00:00.000Z</atom:updated>");
  });

  it("guesses non-jpeg enclosure mime types from the image extension", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([
      {
        slug: "webp-post",
        title: "WebP Post",
        excerpt: null,
        published_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
        featured_image: "https://cdn.example.com/hero.webp?v=2",
      },
    ]);

    const res = await GET(req("http://localhost/api/public/rss.xml?platform=website"));
    const body = await res.text();

    expect(body).toContain('type="image/webp"');
  });
});
