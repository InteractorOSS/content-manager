import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    author_id: "actor-1",
    content_hash: "hash-v1",
    sync_conflict: true,
    last_synced_hash: "hash-old",
    updated_by_id: "actor-1",
    updated_by_name: "Actor One",
    updated_at: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

// A minimal in-memory row so the write path's read-check-write-reread
// sequence behaves like a real database instead of independent stubs that
// could disagree with each other.
let baseline = postRow();

const findUnique = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();

const fakeDb = { post: { findUnique, update, updateMany } };
const actor = {
  user: { id: "actor-1", email: "actor@example.com", name: "Actor One" },
  permissions: new Set(["content:edit", "content:edit_any"]),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor, db: fakeDb })),
}));

import { POST } from "./route";

function req(body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/cms/posts/post-1/resolve-conflict", {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
    headers,
  });
}

beforeEach(() => {
  baseline = postRow();
  findUnique.mockReset();
  update.mockReset();
  updateMany.mockReset();
  findUnique.mockImplementation(async () => baseline);
  // The plain (no expected_content_hash) write path — a real Prisma
  // update() returns the full row.
  update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    baseline = { ...baseline, ...data };
    return baseline;
  });
  updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ("content_hash" in where && where.content_hash !== baseline.content_hash) {
        return { count: 0 };
      }
      baseline = { ...baseline, ...data };
      return { count: 1 };
    }
  );
});

describe("POST /api/cms/posts/[id]/resolve-conflict", () => {
  it("clears sync_conflict and stamps the resolving user when no expected_content_hash is sent", async () => {
    const res = await POST(req(), { params: Promise.resolve({ id: "post-1" }) });

    expect(res.status).toBe(200);
    // No hash requested — the plain, race-free update() path.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sync_conflict: false,
          last_synced_hash: null,
          updated_by_id: "actor-1",
          updated_by_name: "Actor One",
        }),
      })
    );
  });

  it("409s with the shared conflict body when expected_content_hash is stale, and does not write", async () => {
    const res = await POST(
      req({ expected_content_hash: "stale-hash" }),
      { params: Promise.resolve({ id: "post-1" }) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current_hash).toBe("hash-v1");
    expect(body.last_editor).toEqual({ id: "actor-1", name: "Actor One" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("succeeds when expected_content_hash matches", async () => {
    const res = await POST(
      req({ expected_content_hash: "hash-v1" }),
      { params: Promise.resolve({ id: "post-1" }) }
    );

    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalled();
  });

  it("does not re-read the post after a successful write — the response is built from the write itself, not a second independent findUnique that could observe a concurrent write in the gap", async () => {
    const res = await POST(
      req({ expected_content_hash: "hash-v1" }),
      { params: Promise.resolve({ id: "post-1" }) }
    );

    expect(res.status).toBe(200);
    // Exactly the pre-write existence/hash check — no follow-up re-fetch.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("also accepts the hash via an If-Match header, same as PUT /api/cms/posts/[id]", async () => {
    const res = await POST(
      req(undefined, { "if-match": '"stale-hash"' }),
      { params: Promise.resolve({ id: "post-1" }) }
    );

    expect(res.status).toBe(409);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the write races between the read and the conditional update, even though the initial check passed", async () => {
    updateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const res = await POST(
      req({ expected_content_hash: "hash-v1" }),
      { params: Promise.resolve({ id: "post-1" }) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current_hash).toBe("hash-v1");
  });
});
