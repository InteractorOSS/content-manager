import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { postFindUnique } = vi.hoisted(() => ({ postFindUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { post: { findUnique: postFindUnique } },
}));

import { signPreviewToken } from "@/lib/preview-link";
import { GET } from "./route";

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  postFindUnique.mockReset();
});

describe("GET /preview/[token]/version", () => {
  it("answers with the post's version and nothing else", async () => {
    const expiresAt = Date.now() + 100_000;
    postFindUnique.mockResolvedValue({
      id: "p1",
      title: "Secret title",
      content_html: "<p>secret body</p>",
      preview_token_expires_at: new Date(expiresAt),
      updated_at: new Date(1_700_000_000_000),
    });

    const res = await GET(new NextRequest("http://localhost/x"), ctx(signPreviewToken("p1", expiresAt)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ version: "1700000000000" });
  });

  it("404s a tampered token without touching the database", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), ctx("garbage"));
    expect(res.status).toBe(404);
    expect(postFindUnique).not.toHaveBeenCalled();
  });

  it("410s an expired token", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), ctx(signPreviewToken("p1", Date.now() - 1000)));
    expect(res.status).toBe(410);
  });

  it("404s a revoked link", async () => {
    postFindUnique.mockResolvedValue({ id: "p1", preview_token_expires_at: null });
    const res = await GET(new NextRequest("http://localhost/x"), ctx(signPreviewToken("p1", Date.now() + 100_000)));
    expect(res.status).toBe(404);
  });
});
