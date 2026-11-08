import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// GET /api/public/health and GET /api/public/posts are real route files, not
// the cors.ts helper in isolation — this proves the wiring actually landed on
// the routes, not just that the helper works in a vacuum.
const { queryRaw, findMany, count } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: queryRaw,
    post: { findMany, count },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({
    actor: { user: { id: "u1" }, organizationId: "org1", permissions: new Set(["content:view"]) },
    db: { post: { findMany, count }, $transaction: (ops: Promise<unknown>[]) => Promise.all(ops) },
    via: "token",
    apiToken: undefined,
  })),
}));

import { GET as health, OPTIONS as healthOptions } from "@/app/api/public/health/route";
import { GET as listPosts } from "@/app/api/public/posts/route";
import { GET as listCmsPosts } from "@/app/api/cms/posts/route";

beforeEach(() => {
  queryRaw.mockReset();
  findMany.mockReset();
  count.mockReset();
});

describe("public read API CORS (G#22 D5)", () => {
  it("GET /api/public/* carries Access-Control-Allow-Origin: *", async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("still carries CORS headers on an error response, not just the happy path", async () => {
    queryRaw.mockRejectedValue(new Error("db down"));

    const res = await health();

    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("still carries CORS headers when the handler throws (uncaught, not a `return`)", async () => {
    // posts/route.ts never catches its own prisma error — this exercises the
    // wrapper's own try/catch, not a route-level error path.
    findMany.mockRejectedValue(new Error("db down"));
    count.mockResolvedValue(0);

    const res = await listPosts(new NextRequest("http://localhost/api/public/posts"));

    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("OPTIONS preflight on a public GET returns 204 with the CORS headers", async () => {
    const res = healthOptions();

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("GET /api/cms/* carries NO CORS header — credentialed surfaces stay same-origin", async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const res = await listCmsPosts(new NextRequest("http://localhost/api/cms/posts"));

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
