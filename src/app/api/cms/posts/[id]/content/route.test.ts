import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MCP_DELEGATE_HEADER } from "@/lib/post-revisions";

const notifyIndexNowForPost = vi.fn();
vi.mock("@/lib/indexnow", () => ({ notifyIndexNowForPost: (...a: unknown[]) => notifyIndexNowForPost(...a) }));

/**
 * G#15: PATCH /api/cms/posts/[id]/content applies find/replace edits without
 * re-sending the whole body, sharing PUT's optimistic-concurrency guard
 * (G-C) and revision capture (G-A).
 */

const actor = {
  user: { id: "u1", email: "author@example.com", name: "Author One", status: "active" },
  organizationId: "org1",
  membershipRole: "author",
  roles: ["author"],
  permissions: new Set<string>(["content:edit"]),
};

let via: "session" | "token" = "session";

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    title: "Hello",
    slug: "hello",
    content: "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.",
    content_html: "<p>Alpha paragraph.</p>\n<p>Beta paragraph.</p>\n<p>Gamma paragraph.</p>",
    content_format: "markdown",
    excerpt: null,
    content_hash: null,
    status: "draft",
    workflow_status: "draft",
    author_id: "u1",
    author_name: "Author One",
    updated_by_id: null,
    updated_by_name: null,
    published_at: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    category_id: null,
    category: null,
    platforms: ["website"],
    ...overrides,
  };
}

let baseline = existingRow();

const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const postUpdateMany = vi.fn();
const categoryFindUnique = vi.fn();
const postRevisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
const postRevisionFindMany = vi.fn(async () => [] as { id: string }[]);
const postRevisionDeleteMany = vi.fn();

const db = {
  post: {
    findUnique: (...a: unknown[]) => postFindUnique(...a),
    update: (...a: unknown[]) => postUpdate(...a),
    updateMany: (...a: unknown[]) => postUpdateMany(...a),
  },
  category: { findUnique: (...a: unknown[]) => categoryFindUnique(...a) },
  postRevision: {
    create: postRevisionCreate,
    findMany: postRevisionFindMany,
    deleteMany: postRevisionDeleteMany,
  },
  $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: NextRequest, ...perms: string[]) => {
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return {
        error: new Response(JSON.stringify({ error: "Forbidden", missing_permissions: missing }), {
          status: 403,
        }),
      };
    }
    return { actor, db, via };
  }),
}));

import { PATCH } from "./route";

function patch(body: unknown, headers: Record<string, string> = {}) {
  return PATCH(
    new NextRequest("http://localhost/api/cms/posts/p1/content", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers,
    }),
    { params: Promise.resolve({ id: "p1" }) }
  );
}

beforeEach(() => {
  via = "session";
  actor.permissions = new Set(["content:edit"]);
  baseline = existingRow();
  postFindUnique.mockReset();
  postUpdate.mockReset();
  postUpdateMany.mockReset();
  categoryFindUnique.mockReset();
  postRevisionCreate.mockClear();
  postRevisionFindMany.mockClear();
  postRevisionDeleteMany.mockClear();
  db.$transaction.mockClear();
  notifyIndexNowForPost.mockClear();
  postFindUnique.mockImplementation(async () => baseline);
  postUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    baseline = { ...baseline, ...data };
    return baseline;
  });
  postUpdateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if ("content_hash" in where && where.content_hash !== baseline.content_hash) {
        return { count: 0 };
      }
      baseline = { ...baseline, ...data };
      return { count: 1 };
    }
  );
});

describe("PATCH /api/cms/posts/[id]/content — anchored edits", () => {
  it("applies a single-paragraph replacement without touching the rest of the document", async () => {
    const res = await patch({ replacements: [{ find: "Beta paragraph.", replace: "Delta paragraph." }] });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).toBe("Alpha paragraph.\n\nDelta paragraph.\n\nGamma paragraph.");
  });

  it("applies multiple replacements atomically", async () => {
    const res = await patch({
      replacements: [
        { find: "Alpha", replace: "Uno" },
        { find: "Gamma", replace: "Tres" },
      ],
    });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).toBe("Uno paragraph.\n\nBeta paragraph.\n\nTres paragraph.");
  });

  it("refuses a zero-match anchor with 400 naming the failed replacement and match count, and does not write", async () => {
    const res = await patch({ replacements: [{ find: "Nonexistent text", replace: "X" }] });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.index).toBe(0);
    expect(body.found_occurrences).toBe(0);
    expect(body.expected_occurrences).toBe(1);
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous anchor (more matches than expected) with 400, and does not write", async () => {
    baseline = existingRow({ content: "repeat repeat repeat" });
    const res = await patch({ replacements: [{ find: "repeat", replace: "once" }] });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.found_occurrences).toBe(3);
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("changes nothing when one replacement in a multi-replacement call fails", async () => {
    const res = await patch({
      replacements: [
        { find: "Alpha", replace: "Uno" },
        { find: "Nonexistent", replace: "X" },
      ],
    });

    expect(res.status).toBe(400);
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
    // The post's own content is untouched — a follow-up read would see the original.
    expect(baseline.content).toBe("Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.");
  });

  it("treats a find===replace call as a no-op: no write, no revision, no reattributed updated_by", async () => {
    const res = await patch({ replacements: [{ find: "Alpha", replace: "Alpha" }] });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).toBe(baseline.content);
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
    expect(postRevisionCreate).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("treats an html replacement fully stripped by sanitization as a no-op — no write, no revision", async () => {
    baseline = existingRow({ content_format: "html", content: "<p>hello</p>" });
    const res = await patch({
      replacements: [{ find: "hello", replace: "hello<script>alert(1)</script>" }],
    });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).toBe("<p>hello</p>");
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postRevisionCreate).not.toHaveBeenCalled();
  });

  it("rejects a request with no replacements", async () => {
    const res = await patch({ replacements: [] });
    expect(res.status).toBe(400);
  });

  it("rejects a replacement missing find/replace", async () => {
    const res = await patch({ replacements: [{ find: "", replace: "x" }] });
    expect(res.status).toBe(400);
  });

  it("recomputes content_html, content_hash, and reading_time after a successful patch", async () => {
    const res = await patch({ replacements: [{ find: "Beta paragraph.", replace: "Delta paragraph." }] });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content_html).toContain("Delta paragraph.");
    expect(data.content_hash).toEqual(expect.any(String));
    expect(data.reading_time).toEqual(expect.any(Number));
  });

  it("sanitizes html-format content after the patch, not just on save", async () => {
    baseline = existingRow({
      content_format: "html",
      content: "<p>Alpha paragraph.</p>",
    });
    const res = await patch({
      replacements: [{ find: "Alpha paragraph.", replace: "<script>alert(1)</script>Alpha paragraph." }],
    });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).not.toContain("<script>");
  });

  it("404s when the post doesn't resolve", async () => {
    postFindUnique.mockResolvedValueOnce(null);
    const res = await patch({ replacements: [{ find: "Alpha", replace: "Uno" }] });
    expect(res.status).toBe(404);
  });

  it("403s when the caller doesn't own the post and lacks content:edit_any", async () => {
    baseline = existingRow({ author_id: "someone-else", author_name: "Jane Doe" });
    const res = await patch({ replacements: [{ find: "Alpha", replace: "Uno" }] });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("Jane Doe");
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to leave a published post with empty content", async () => {
    baseline = existingRow({ status: "published", content: "Only paragraph." });
    const res = await patch({ replacements: [{ find: "Only paragraph.", replace: "" }] });

    expect(res.status).toBe(400);
    expect(postUpdate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/cms/posts/[id]/content — revision capture", () => {
  it("snapshots the outgoing content when a patch actually changes it", async () => {
    const res = await patch({ replacements: [{ find: "Alpha", replace: "Uno" }] });

    expect(res.status).toBe(200);
    expect(postRevisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        post_id: "p1",
        content: "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.",
        source: "cms_ui",
        edited_by_id: "u1",
      }),
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("attributes source=mcp for a token call carrying the MCP delegate marker", async () => {
    via = "token";
    const res = await patch({ replacements: [{ find: "Alpha", replace: "Uno" }] }, { [MCP_DELEGATE_HEADER]: "1" });
    expect(res.status).toBe(200);
    expect(postRevisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: "mcp" }) })
    );
  });

  it("does not orphan a revision snapshot when the write loses the concurrency race", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });
    postUpdateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const res = await patch({
      replacements: [{ find: "Alpha", replace: "Uno" }],
      expected_content_hash: "hash-v1",
    });

    expect(res.status).toBe(409);
    expect(postRevisionCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/cms/posts/[id]/content — optimistic concurrency (G-C)", () => {
  it("succeeds when expected_content_hash matches the current hash", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });
    const res = await patch({
      replacements: [{ find: "Alpha", replace: "Uno" }],
      expected_content_hash: "hash-v1",
    });

    expect(res.status).toBe(200);
    expect(postUpdateMany).toHaveBeenCalled();
  });

  it("refuses with 409 when expected_content_hash is stale, and does not write", async () => {
    baseline = existingRow({
      content_hash: "hash-v2",
      updated_by_id: "u2",
      updated_by_name: "Other Editor",
    });
    const res = await patch({
      replacements: [{ find: "Alpha", replace: "Uno" }],
      expected_content_hash: "hash-v1",
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.current_hash).toBe("hash-v2");
    expect(body.last_editor).toEqual({ id: "u2", name: "Other Editor" });
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("behaves exactly as before when expected_content_hash is omitted — no conflict check", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });
    const res = await patch({ replacements: [{ find: "Alpha", replace: "Uno" }] });

    expect(res.status).toBe(200);
    expect(postUpdate).toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("also accepts the hash via an If-Match header", async () => {
    baseline = existingRow({ content_hash: "hash-v1" });
    const res = await patch(
      { replacements: [{ find: "Alpha", replace: "Uno" }] },
      { "if-match": "stale-header-hash" }
    );

    expect(res.status).toBe(409);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/cms/posts/[id]/content — freshness + IndexNow (G#34)", () => {
  it("bumps content_updated_at on every genuine edit — this route only ever touches content, so unlike PUT it needs no postContentChanged gate", async () => {
    const res = await patch({ replacements: [{ find: "Beta paragraph.", replace: "Delta paragraph." }] });
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.content_updated_at).toBeTruthy();
  });

  it("pings IndexNow for a published post's edit", async () => {
    baseline = existingRow({ status: "published", platforms: ["website"] });
    await patch({ replacements: [{ find: "Beta paragraph.", replace: "Delta paragraph." }] });

    expect(notifyIndexNowForPost).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ platforms: ["website"] }),
      ["hello"]
    );
  });

  it("never pings IndexNow for a draft edit — its URL was never live to re-crawl", async () => {
    baseline = existingRow({ status: "draft" });
    await patch({ replacements: [{ find: "Beta paragraph.", replace: "Delta paragraph." }] });

    expect(notifyIndexNowForPost).not.toHaveBeenCalled();
  });
});
