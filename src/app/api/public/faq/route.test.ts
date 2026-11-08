import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const FAQ_FIXTURES = [
  {
    id: "1",
    slug: "public-published",
    question: "Q1",
    answer: "Answer with {{facts.k}}",
    category: "pricing",
    audience: "public",
    status: "published",
    last_verified: null,
    verify_every_days: 365,
    sources: [],
    related: [],
    asked_count: 0,
  },
  {
    id: "2",
    slug: "sales-only-draft",
    question: "Q2 — internal",
    answer: "Sales-only answer",
    category: "pricing",
    audience: "sales-only",
    status: "draft",
    last_verified: null,
    verify_every_days: 365,
    sources: [],
    related: [],
    asked_count: 0,
  },
];

function matchesWhere(faq: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => faq[k] === v);
}

vi.mock("@/lib/db", () => ({
  prisma: {
    faq: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        FAQ_FIXTURES.find((f) => matchesWhere(f, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        FAQ_FIXTURES.filter((f) => matchesWhere(f, where))
      ),
    },
  },
}));

// Real substituteFacts/UnknownFactsKeyError — only getFacts touches the
// network/filesystem, so that's the only part worth stubbing here.
vi.mock("@/lib/facts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/facts")>("@/lib/facts");
  return { ...actual, getFacts: vi.fn(async () => ({ k: "resolved" })) };
});

import { GET as listFaqs } from "./route";
import { GET as getFaqById } from "./[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/public/faq", () => {
  it("returns only published + public entries, never the sales-only draft", async () => {
    const res = await listFaqs(new NextRequest("http://localhost/api/public/faq"));
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("public-published");
  });

  it("rejects an unknown category with 400", async () => {
    const res = await listFaqs(new NextRequest("http://localhost/api/public/faq?category=not-a-real-category"));
    expect(res.status).toBe(400);
  });

  it("resolves {{facts.<key>}} tokens in the answer", async () => {
    const res = await listFaqs(new NextRequest("http://localhost/api/public/faq"));
    const body = await res.json();
    expect(body.data[0].answer).toBe("Answer with resolved");
    expect(body.data[0].answer_error).toBeNull();
  });
});

describe("GET /api/public/faq/[id]", () => {
  it("returns the public+published entry by its slug", async () => {
    const res = await getFaqById(new NextRequest("http://localhost/api/public/faq/public-published"), {
      params: Promise.resolve({ id: "public-published" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("public-published");
  });

  it("is unreachable for a sales-only entry even by its exact id — 404, not the record", async () => {
    const res = await getFaqById(new NextRequest("http://localhost/api/public/faq/sales-only-draft"), {
      params: Promise.resolve({ id: "sales-only-draft" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.data).toBeUndefined();
  });

  it("404s for an id that doesn't exist at all", async () => {
    const res = await getFaqById(new NextRequest("http://localhost/api/public/faq/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
