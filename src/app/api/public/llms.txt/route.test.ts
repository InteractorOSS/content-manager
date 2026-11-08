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

describe("GET /api/public/llms.txt", () => {
  it("400s without ?platform=", async () => {
    const res = await GET(req("http://localhost/api/public/llms.txt"));
    expect(res.status).toBe(400);
    expect(siteFindFirst).not.toHaveBeenCalled();
  });

  it("404s when no site is registered for the platform", async () => {
    siteFindFirst.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/public/llms.txt?platform=nope"));
    expect(res.status).toBe(404);
  });

  it("sets the public CORS header", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([]);
    const res = await GET(req("http://localhost/api/public/llms.txt?platform=website"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns a plain-text posts index for the site", async () => {
    siteFindFirst.mockResolvedValue({ name: "Example Site", url: "https://example.com" });
    postFindMany.mockResolvedValue([
      { slug: "hello", title: "Hello World", excerpt: "An intro post", meta_description: null },
    ]);

    const res = await GET(req("http://localhost/api/public/llms.txt?platform=website"));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(body).toContain("# Example Site");
    expect(body).toContain("- [Hello World](https://example.com/hello): An intro post");
  });
});
