import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const create = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();

const fakeDb = { faq: { create, findUnique, update } };

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor: { user: { id: "automation-actor" } }, db: fakeDb })),
}));

vi.mock("@/lib/db", () => ({
  isUniqueViolation: () => false,
}));

import { POST as createFaq } from "./route";
import { PATCH as patchFaq } from "./[id]/route";

function faqRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    slug: "some-question",
    question: "Some question",
    answer: "TODO",
    category: "pricing",
    audience: "sales-only",
    status: "draft",
    last_verified: null,
    verify_every_days: 365,
    sources: [],
    related: [],
    asked_count: 0,
    inserted_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  create.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/automation/faq", () => {
  it("always creates status=draft, even if the caller sends a different status", async () => {
    create.mockImplementation(async ({ data }) => faqRow(data));

    const res = await createFaq(
      new NextRequest("http://localhost/api/automation/faq", {
        method: "POST",
        body: JSON.stringify({ question: "What does it cost?", category: "pricing", status: "published" }),
      })
    );

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "draft" }) }));
  });

  it("rejects a request with no question", async () => {
    const res = await createFaq(
      new NextRequest("http://localhost/api/automation/faq", {
        method: "POST",
        body: JSON.stringify({ category: "pricing" }),
      })
    );
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/automation/faq/[id]", () => {
  it("refuses status=published unconditionally — 403, no write attempted", async () => {
    const res = await patchFaq(
      new NextRequest("http://localhost/api/automation/faq/1", {
        method: "PATCH",
        body: JSON.stringify({ status: "published" }),
      }),
      { params: Promise.resolve({ id: "1" }) }
    );
    expect(res.status).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("allows draft/review status and increments asked_count", async () => {
    findUnique.mockResolvedValue(faqRow());
    update.mockImplementation(async ({ data }) => faqRow({ asked_count: 1, ...data }));

    const res = await patchFaq(
      new NextRequest("http://localhost/api/automation/faq/1", {
        method: "PATCH",
        body: JSON.stringify({ increment_asked_count: true }),
      }),
      { params: Promise.resolve({ id: "1" }) }
    );

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ asked_count: { increment: 1 } }) })
    );
  });

  it("404s for a FAQ that doesn't exist", async () => {
    findUnique.mockResolvedValue(null);
    const res = await patchFaq(
      new NextRequest("http://localhost/api/automation/faq/missing", {
        method: "PATCH",
        body: JSON.stringify({ question: "x" }),
      }),
      { params: Promise.resolve({ id: "missing" }) }
    );
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });
});
