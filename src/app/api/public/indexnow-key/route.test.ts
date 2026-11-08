import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { siteFindFirst, siteUpdateMany, siteFindUnique } = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  siteUpdateMany: vi.fn(),
  siteFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    site: { findFirst: siteFindFirst, updateMany: siteUpdateMany, findUnique: siteFindUnique },
  },
}));

import { GET } from "./route";

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  siteFindFirst.mockReset();
  siteUpdateMany.mockReset();
  siteFindUnique.mockReset();
});

describe("GET /api/public/indexnow-key", () => {
  it("400s without ?platform=", async () => {
    const res = await GET(req("http://localhost/api/public/indexnow-key"));
    expect(res.status).toBe(400);
    expect(siteFindFirst).not.toHaveBeenCalled();
  });

  it("404s when no site is registered for the platform", async () => {
    siteFindFirst.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/public/indexnow-key?platform=nope"));
    expect(res.status).toBe(404);
  });

  it("sets the public CORS header", async () => {
    siteFindFirst.mockResolvedValue({ id: "site1", indexnow_key: "existing-key" });
    const res = await GET(req("http://localhost/api/public/indexnow-key?platform=website"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns the existing key without writing when the site already has one", async () => {
    siteFindFirst.mockResolvedValue({ id: "site1", indexnow_key: "existing-key" });

    const res = await GET(req("http://localhost/api/public/indexnow-key?platform=website"));
    const { data } = await res.json();

    expect(data.key).toBe("existing-key");
    expect(siteUpdateMany).not.toHaveBeenCalled();
  });

  it("lazily generates and persists a key for a site that predates the column", async () => {
    siteFindFirst.mockResolvedValue({ id: "site1", indexnow_key: null });
    siteUpdateMany.mockResolvedValue({ count: 1 });

    const res = await GET(req("http://localhost/api/public/indexnow-key?platform=website"));
    const { data } = await res.json();

    expect(typeof data.key).toBe("string");
    expect(data.key).toMatch(/^[0-9a-f]{32}$/);
    // Conditional on indexnow_key still being null (not a bare update) —
    // see getOrCreateSiteIndexNowKey's own race-safety doc comment.
    expect(siteUpdateMany).toHaveBeenCalledWith({
      where: { id: "site1", indexnow_key: null },
      data: { indexnow_key: data.key },
    });
    expect(siteFindUnique).not.toHaveBeenCalled();
  });

  it("hands back the WINNING key from a concurrent request instead of the one it minted, when it loses the race", async () => {
    siteFindFirst.mockResolvedValue({ id: "site1", indexnow_key: null });
    // count: 0 means another concurrent request's write landed first — the
    // conditional `indexnow_key: null` in the where clause no longer matched.
    siteUpdateMany.mockResolvedValue({ count: 0 });
    siteFindUnique.mockResolvedValue({ indexnow_key: "the-other-requests-key" });

    const res = await GET(req("http://localhost/api/public/indexnow-key?platform=website"));
    const { data } = await res.json();

    expect(data.key).toBe("the-other-requests-key");
  });
});
