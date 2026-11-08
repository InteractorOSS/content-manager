import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Exercises the MCP endpoint end-to-end over JSON-RPC: PAT auth at the HTTP
 * layer, and RBAC parity by letting the real /api/cms route logic run
 * against a fake db — the guard mock below is permission-aware, so the
 * publish gates exercised here are the actual route implementations.
 */

const GOOD_TOKEN = "cms_pat_good";
const permissions = new Set<string>();

const ORG = { id: "org1", name: "MySonCEO", slug: "mysonceo" };

function makeActor() {
  return {
    user: { id: "u1", name: "Test User", email: "test@example.com", status: "active" },
    permissions,
    organizationId: ORG.id,
    membershipRole: "author",
    roles: ["author"],
  };
}

/** The token identity the guard hands back — bound to exactly one org. */
function makeTokenIdentity() {
  return {
    id: "t1",
    name: "MySonCEO MCP",
    token_prefix: "cms_pat_goo",
    organization_id: ORG.id,
    site_scopes: [],
    expires_at: null,
  };
}

const postCreate = vi.fn();
const postUpdate = vi.fn();
const postUpdateMany = vi.fn();
const postFindUnique = vi.fn();
const postFindMany = vi.fn();
const postCount = vi.fn();
const postDelete = vi.fn();
const mediaCreate = vi.fn();
const postRevisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
const postRevisionFindMany = vi.fn(async () => []);
const postRevisionDeleteMany = vi.fn();
const membershipFindUnique = vi.fn();

// G#26: social MCP tools (list_social_channels, get_social_network_rules,
// list_social_posts, compose_social_post, schedule_social_post,
// social_post_workflow, get_social_post_results) delegate to the real
// /api/social/* route handlers, same as every other tool here.
const socialChannelFindMany = vi.fn();
const socialPostFindMany = vi.fn();
const socialPostFindUnique = vi.fn();
const socialPostFindFirst = vi.fn();
const socialPostCreate = vi.fn();
const socialPostUpdate = vi.fn();
const socialPostApprovalCreate = vi.fn();
const socialPostApprovalFindMany = vi.fn(async () => []);

// G#27: list_manual_social_queue / mark_social_post_posted delegate to
// /api/social/manual/*, which reads through db.socialPost (findFirst added
// alongside the existing findMany/findUnique) and, for mark-posted, calls
// publisher.ts's markManualTargetPosted — mocked the same way
// posts/[id]/publish/route.test.ts mocks publishPost, since publisher.ts is
// `import "server-only"` and not otherwise exercised by any tool here.
const markManualTargetPosted = vi.fn();
vi.mock("@/lib/social/publisher", () => ({
  markManualTargetPosted: (...args: unknown[]) => markManualTargetPosted(...args),
  canMarkPosted: (target: { status: string }) => target.status === "awaiting_manual",
}));

const fakeDb = {
  post: {
    create: postCreate,
    update: postUpdate,
    updateMany: postUpdateMany,
    findUnique: postFindUnique,
    findMany: postFindMany,
    count: postCount,
    delete: postDelete,
  },
  // Registers no sites, so orgSiteSlugs() yields just the built-in seeds
  // (website, product-manager) — what these fixtures already target.
  site: { findMany: async () => [] },
  postRevision: {
    create: postRevisionCreate,
    findMany: postRevisionFindMany,
    deleteMany: postRevisionDeleteMany,
  },
  media: { create: mediaCreate },
  membership: { findUnique: membershipFindUnique },
  socialChannel: { findMany: socialChannelFindMany },
  socialPost: {
    findMany: socialPostFindMany,
    findUnique: socialPostFindUnique,
    findFirst: socialPostFindFirst,
    create: socialPostCreate,
    update: socialPostUpdate,
  },
  socialPostApproval: {
    create: socialPostApprovalCreate,
    findMany: socialPostApprovalFindMany,
  },
  // Interactive-transaction mock: the CMS post PUT route's write path uses
  // the callback form; social_post_workflow's approve/reject use the array
  // form (a list of already-invoked query promises) — support both.
  $transaction: (fnOrArr: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) =>
    Array.isArray(fnOrArr) ? Promise.all(fnOrArr) : fnOrArr(fakeDb),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (req: NextRequest, ...perms: string[]) => {
    if (req.headers.get("authorization") !== `Bearer ${GOOD_TOKEN}`) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    const missing = perms.filter((p) => !permissions.has(p));
    if (missing.length > 0) {
      return {
        error: NextResponse.json(
          { error: "Forbidden", missing_permissions: missing },
          { status: 403 }
        ),
      };
    }
    return { actor: makeActor(), db: fakeDb, via: "token", apiToken: makeTokenIdentity() };
  }),
  actorFromApiTokenValue: vi.fn(async (raw: string) =>
    raw === GOOD_TOKEN ? { actor: makeActor(), token: makeTokenIdentity() } : null
  ),
  verifyApiTokenValue: vi.fn(async (raw: string) =>
    raw === GOOD_TOKEN ? { tokenId: "tok_1", userId: makeActor().user.id } : null
  ),
  apiTokenRowFromRequest: vi.fn(async () => null),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    // /api/me (behind the whoami tool) reads the owner's org list directly.
    membership: {
      findMany: async () => [{ role: "author", organization: ORG }],
    },
  },
  isUniqueViolation: () => false,
}));

vi.mock("@/lib/ai/client", () => ({ aiConfigured: () => false }));
vi.mock("@/lib/ai/style", () => ({ proposeGuideAmendment: vi.fn() }));
vi.mock("@/lib/s3", () => ({
  isS3Configured: () => true,
  uploadToS3: vi.fn(async (_buf: Buffer, filename: string) => ({
    publicUrl: `https://media.example.com/${filename}`,
  })),
}));
// G#26: tools.ts now imports the /api/social/channels and /api/social/services
// route handlers (list_social_channels, get_social_network_rules), which pull
// in @/lib/interactor — marked "server-only" so it throws on import unless the
// bundler sets the "react-server" export condition, which Vitest doesn't.
// Not exercised by any test here (no social tool is called); mocked purely so
// importing the module graph doesn't throw.
vi.mock("@/lib/interactor", () => ({
  InteractorError: class InteractorError extends Error {
    status?: number;
  },
  initiateOAuth: vi.fn(),
  searchServices: vi.fn(async () => []),
  serviceExists: vi.fn(async () => true),
}));

import { POST } from "./route";

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    // Long enough on its own to satisfy the readiness gate's title-length
    // check (G#32) for tests not specifically about that rule.
    title: "Hello, this is a test post title",
    slug: "hello",
    content: "<p>Body text</p>",
    content_html: "<p>Body text</p>",
    content_hash: "hash-v1",
    // A featured image is now required to publish — default one in so tests
    // not specifically about that rule don't have to know about it.
    featured_image: "https://example.com/cover.jpg",
    featured_image_alt: "Cover image",
    // Search & AI readiness (G#32) is now a publish/approve gate too — same
    // rationale as the featured image default above.
    meta_description: "A short meta description long enough to satisfy the readiness check's length requirement.",
    answer_summary:
      "This is a placeholder answer summary long enough to satisfy the readiness check's minimum word " +
      "count for tests that are not specifically about the readiness gate itself.",
    status: "draft",
    workflow_status: "draft",
    author_id: "u1",
    updated_by_id: "u1",
    updated_by_name: "Test User",
    ai_style_profile_id: null,
    ai_generated_content: null,
    published_at: null,
    approved_at: null,
    approved_by_id: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    category: null,
    platforms: ["website"],
    ...overrides,
  };
}

async function rpc(body: unknown, token?: string) {
  const res = await POST(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Streamable HTTP may answer as an SSE stream; the result is the last data: line.
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length)));
    json = events[events.length - 1] ?? null;
  }
  return { status: res.status, json: json as { result?: any; error?: any } | null };
}

function initializeBody(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>, id = 2) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Parse the JSON the tool serialized into its text content. */
function toolPayload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  permissions.clear();
  postCreate.mockReset();
  postUpdate.mockReset();
  postUpdateMany.mockReset();
  postFindUnique.mockReset();
  postFindMany.mockReset();
  postCount.mockReset();
  mediaCreate.mockReset();
  membershipFindUnique.mockReset();
  socialChannelFindMany.mockReset().mockResolvedValue([]);
  socialPostFindMany.mockReset().mockResolvedValue([]);
  socialPostFindUnique.mockReset();
  socialPostFindFirst.mockReset();
  socialPostCreate.mockReset();
  socialPostUpdate.mockReset();
  socialPostApprovalCreate.mockReset();
  socialPostApprovalFindMany.mockReset().mockResolvedValue([]);
  markManualTargetPosted.mockReset();
});

describe("POST /api/mcp — auth", () => {
  it("401s a request with no Authorization header", async () => {
    const { status } = await rpc(initializeBody());
    expect(status).toBe(401);
  });

  it("points an unauthenticated client at the OAuth metadata (RFC 9728)", async () => {
    // This header is the whole discovery chain for Claude's custom connector:
    // without resource_metadata it can't find our authorization server.
    const res = await POST(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(initializeBody()),
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(
      /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/api\/mcp"$/
    );
  });

  it("401s a bearer that is not a cms_pat_ token", async () => {
    const { status } = await rpc(initializeBody(), "not-a-pat");
    expect(status).toBe(401);
  });

  it("401s an unknown/revoked/expired cms_pat_ token", async () => {
    const { status } = await rpc(initializeBody(), "cms_pat_unknown");
    expect(status).toBe(401);
  });

  it("initializes with a valid token", async () => {
    const { status, json } = await rpc(initializeBody(), GOOD_TOKEN);
    expect(status).toBe(200);
    expect(json?.result?.serverInfo?.name).toBe("interactor-cms");
  });

  it("accepts a lowercase 'bearer' scheme (RFC 7235 schemes are case-insensitive)", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `bearer ${GOOD_TOKEN}`,
        },
        body: JSON.stringify(initializeBody()),
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/mcp — tools", () => {
  it("lists the v1 toolset", async () => {
    const { json } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      GOOD_TOKEN
    );
    const names = (json?.result?.tools ?? []).map((t: { name: string }) => t.name);
    for (const expected of [
      "whoami",
      "list_posts",
      "get_post",
      "create_post",
      "update_post",
      "delete_post",
      "post_workflow",
      "create_preview_link",
      "generate_featured_image",
      "list_categories",
      "create_category",
      "list_tags",
      "list_faqs",
      "create_faq",
      "update_faq",
      "list_media",
      "upload_media",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("whoami reports the token owner and the permissions every other tool is gated on", async () => {
    permissions.add("content:view");
    permissions.add("content:create");

    const { json } = await rpc(toolCall("whoami", {}), GOOD_TOKEN);
    const { data } = toolPayload(json!.result);

    expect(json?.result?.isError).toBeUndefined();
    expect(data.user.email).toBe("test@example.com");
    expect(data.organization_id).toBe(ORG.id);
    expect(data.membership_role).toBe("author");
    expect(data.permissions).toEqual(["content:create", "content:view"]);
    expect(data.auth_method).toBe("token");
  });

  it("whoami names the organization the token acts on, so content can't land in the wrong tenant", async () => {
    // An id alone doesn't let anyone confirm they're about to publish to the
    // family blog rather than the employer — the name is the point.
    permissions.add("content:view");

    const { json } = await rpc(toolCall("whoami", {}), GOOD_TOKEN);
    const { data } = toolPayload(json!.result);

    expect(data.organization).toEqual(ORG);
    expect(data.token).toMatchObject({ name: "MySonCEO MCP" });
  });

  it("whoami shows the absent permission behind a refused publish, in the same session", async () => {
    // The pair a client needs to explain a 403 instead of speculating about
    // how the token was minted: the refusal, and the owner's actual grant.
    permissions.add("content:view");
    postFindUnique.mockResolvedValue(postRow({ workflow_status: "approved" }));

    const refusal = await rpc(toolCall("post_workflow", { id: "p1", action: "publish" }), GOOD_TOKEN);
    expect(refusal.json?.result?.isError).toBe(true);
    expect(toolPayload(refusal.json!.result).error).toMatch(/content:publish/);

    const { json } = await rpc(toolCall("whoami", {}, 3), GOOD_TOKEN);
    expect(toolPayload(json!.result).data.permissions).not.toContain("content:publish");
  });

  it("create_post without content:publish saves a draft even when published was requested", async () => {
    permissions.add("content:create");
    postCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      postRow(data)
    );

    const { json } = await rpc(
      toolCall("create_post", {
        title: "Launch note",
        content: "Big news",
        status: "published",
      }),
      GOOD_TOKEN
    );

    const payload = toolPayload(json!.result);
    expect(payload.data.status).toBe("draft");
    expect(payload.warning).toMatch(/content:publish/);
  });

  it("create_post always returns author identity, and a content:edit_any holder can credit a named org member", async () => {
    permissions.add("content:create");
    postCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      postRow(data)
    );

    const own = await rpc(toolCall("create_post", { title: "Mine", content: "Body" }), GOOD_TOKEN);
    expect(toolPayload(own.json!.result).data.author_id).toBe("u1");

    const refused = await rpc(
      toolCall("create_post", { title: "Not mine", content: "Body", author_id: "u2" }, 3),
      GOOD_TOKEN
    );
    expect(refused.json?.result?.isError).toBe(true);
    expect(toolPayload(refused.json!.result).error).toMatch(/content:edit_any/);

    permissions.add("content:edit_any");
    membershipFindUnique.mockResolvedValue({
      user: { id: "u2", name: "Casey Writer", email: "casey@example.com", status: "active" },
    });
    const credited = await rpc(
      toolCall("create_post", { title: "Ghostwritten", content: "Body", author_id: "u2" }, 4),
      GOOD_TOKEN
    );
    const payload = toolPayload(credited.json!.result);
    expect(payload.data.author_id).toBe("u2");
    expect(payload.data.author_name).toBe("Casey Writer");
  });

  it("post_workflow publish without content:publish is a 403 tool error", async () => {
    permissions.add("content:view");
    postFindUnique.mockResolvedValue(postRow());

    const { json } = await rpc(
      toolCall("post_workflow", { id: "p1", action: "publish" }),
      GOOD_TOKEN
    );

    expect(json?.result?.isError).toBe(true);
    expect(toolPayload(json!.result).error).toMatch(/content:publish/);
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("create → update → publish flow succeeds with the right permissions", async () => {
    permissions.add("content:create");
    permissions.add("content:view");
    permissions.add("content:edit");
    permissions.add("content:publish");

    postCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      postRow(data)
    );
    const created = await rpc(
      toolCall("create_post", { title: "Launch note: what changed in this release", content: "Draft body" }),
      GOOD_TOKEN
    );
    expect(toolPayload(created.json!.result).data.status).toBe("draft");

    // A mutable row so update_post's PUT handler (findUnique -> updateMany
    // conditioned on content_hash -> findUnique again for the response) sees
    // its own write reflected, and the subsequent publish workflow action
    // (a separate route, still using db.post.update directly) sees it too.
    let row = postRow();
    postFindUnique.mockImplementation(async () => row);
    postUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      row = { ...row, ...data };
      return { count: 1 };
    });
    postUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      postRow(data)
    );
    const updated = await rpc(
      toolCall("update_post", { id: "p1", content: "Final body" }, 3),
      GOOD_TOKEN
    );
    expect(updated.json?.result?.isError).toBeUndefined();
    expect(toolPayload(updated.json!.result).data.content).toContain("Final body");

    const published = await rpc(
      toolCall("post_workflow", { id: "p1", action: "publish" }, 4),
      GOOD_TOKEN
    );
    expect(published.json?.result?.isError).toBeUndefined();
    expect(toolPayload(published.json!.result).data.status).toBe("published");
  });

  it("upload_media decodes base64 and returns the stored file", async () => {
    permissions.add("media:upload");
    mediaCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "m1",
      ...data,
      inserted_at: new Date(),
      updated_at: new Date(),
    }));

    const { json } = await rpc(
      toolCall("upload_media", {
        filename: "note.txt",
        mime_type: "text/plain",
        data_base64: Buffer.from("hello world").toString("base64"),
        alt_text: "a note",
      }),
      GOOD_TOKEN
    );

    const payload = toolPayload(json!.result);
    expect(payload.data.file_path).toMatch(/^https:\/\/media\.example\.com\//);
    expect(payload.data.file_size).toBe(11);
    expect(payload.data.alt_text).toBe("a note");
  });

  it("upload_media rejects invalid base64 before anything is stored", async () => {
    permissions.add("media:upload");

    const { json } = await rpc(
      toolCall("upload_media", {
        filename: "x.png",
        mime_type: "image/png",
        data_base64: "!!!not-base64!!!",
      }),
      GOOD_TOKEN
    );

    expect(json?.result?.isError).toBe(true);
    expect(toolPayload(json!.result).error).toMatch(/base64/);
    expect(mediaCreate).not.toHaveBeenCalled();
  });

  it("upload_media strips a data-URI prefix instead of storing a corrupt file", async () => {
    permissions.add("media:upload");
    mediaCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "m1",
      ...data,
      inserted_at: new Date(),
      updated_at: new Date(),
    }));

    const { json } = await rpc(
      toolCall("upload_media", {
        filename: "note.txt",
        mime_type: "text/plain",
        data_base64: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}`,
      }),
      GOOD_TOKEN
    );

    expect(json?.result?.isError).toBeUndefined();
    expect(toolPayload(json!.result).data.file_size).toBe(5);
  });

  it("a route handler that throws becomes a sanitized isError result, not a protocol error", async () => {
    permissions.add("content:delete");
    postFindUnique.mockResolvedValue(postRow());
    postDelete.mockRejectedValue(
      Object.assign(new Error("Record to delete does not exist."), { code: "P2025" })
    );

    const { json } = await rpc(toolCall("delete_post", { id: "p1" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBe(true);
    expect(toolPayload(json!.result).error).toBe("Internal error");
    expect(JSON.stringify(json)).not.toMatch(/Record to delete/);
  });

  it("tool results surface REST-level errors as isError with the API's message", async () => {
    permissions.add("content:view");
    postFindUnique.mockResolvedValue(null);

    const { json } = await rpc(toolCall("get_post", { id: "missing" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBe(true);
    expect(toolPayload(json!.result).error).toBe("Not found");
  });

  it("get_post returns content_hash so it can be round-tripped into update_post", async () => {
    permissions.add("content:view");
    postFindUnique.mockResolvedValue(postRow({ content_hash: "hash-v1" }));

    const { json } = await rpc(toolCall("get_post", { id: "p1" }), GOOD_TOKEN);
    expect(toolPayload(json!.result).data.content_hash).toBe("hash-v1");
  });

  it("update_post with a stale expected_content_hash comes back as an isError 409 naming the current hash", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue(postRow({ content_hash: "hash-v2" }));

    const { json } = await rpc(
      toolCall("update_post", { id: "p1", content: "Racing edit", expected_content_hash: "hash-v1" }),
      GOOD_TOKEN
    );

    expect(json?.result?.isError).toBe(true);
    const payload = toolPayload(json!.result);
    expect(payload.current_hash).toBe("hash-v2");
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("get_post -> edit -> update_post round-trips cleanly with the fresh hash", async () => {
    permissions.add("content:view");
    permissions.add("content:edit");
    let row = postRow({ content_hash: "hash-v1" });
    postFindUnique.mockImplementation(async () => row);
    postUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      row = { ...row, ...data, content_hash: "hash-v2" };
      return { count: 1 };
    });

    const fetched = await rpc(toolCall("get_post", { id: "p1" }), GOOD_TOKEN);
    const hash = toolPayload(fetched.json!.result).data.content_hash;

    const { json } = await rpc(
      toolCall("update_post", { id: "p1", content: "Edited body", expected_content_hash: hash }, 3),
      GOOD_TOKEN
    );
    expect(json?.result?.isError).toBeUndefined();
    expect(toolPayload(json!.result).data.content).toContain("Edited body");
  });
});

describe("POST /api/mcp — draft preview links", () => {
  it("get_post omits a live preview_url when none is active", async () => {
    permissions.add("content:view");
    postFindUnique.mockResolvedValue(postRow({ preview_token_expires_at: null }));

    const { json } = await rpc(toolCall("get_post", { id: "p1" }), GOOD_TOKEN);
    expect(toolPayload(json!.result).data.preview_url).toBeNull();
  });

  it("get_post returns an openable preview_url when a link is live and the caller can edit the post", async () => {
    permissions.add("content:view");
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue(
      postRow({ author_id: "u1", preview_token_expires_at: new Date(Date.now() + 100_000) })
    );

    const { json } = await rpc(toolCall("get_post", { id: "p1" }), GOOD_TOKEN);
    expect(toolPayload(json!.result).data.preview_url).toMatch(/\/preview\//);
  });

  it("get_post omits preview_url from a caller who can view but not edit the post — it is a bypass credential, not view-only data", async () => {
    permissions.add("content:view");
    postFindUnique.mockResolvedValue(
      postRow({ author_id: "someone-else", preview_token_expires_at: new Date(Date.now() + 100_000) })
    );

    const { json } = await rpc(toolCall("get_post", { id: "p1" }), GOOD_TOKEN);
    expect(toolPayload(json!.result).data.preview_url).toBeNull();
  });

  it("create_preview_link mints a link for the post's own author", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue(postRow({ author_id: "u1" }));
    postUpdate.mockResolvedValue({});

    const { json } = await rpc(toolCall("create_preview_link", { id: "p1" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBeFalsy();
    expect(toolPayload(json!.result).data.url).toMatch(/\/preview\//);
  });

  it("create_preview_link is refused without content:edit", async () => {
    const { json } = await rpc(toolCall("create_preview_link", { id: "p1" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBe(true);
  });
});

// G#26: the social tools are thin wrappers over delegateToRoute, same as
// every CMS tool above — these exercise the real /api/social/* route
// handlers end-to-end through the live MCP server, not a mocked delegate.
describe("POST /api/mcp — social tools", () => {
  const TWITTER_CHANNEL = {
    id: "c_tw",
    service_id: "twitter",
    service_name: "Brand X",
    account_id: null,
  };

  function socialPostRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "sp1",
      body: "hello world",
      link: null,
      media: [],
      status: "draft",
      scheduled_at: null,
      published_at: null,
      approved_at: null,
      campaign: null,
      created_by: null,
      source_post: null,
      targets: [],
      inserted_at: new Date(),
      updated_at: new Date(),
      created_by_id: "u1",
      ...overrides,
    };
  }

  it("list_social_channels delegates to GET /api/social/channels", async () => {
    permissions.add("content:view");
    socialChannelFindMany.mockResolvedValue([TWITTER_CHANNEL]);

    const { json } = await rpc(toolCall("list_social_channels", {}), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data).toEqual([expect.objectContaining({ id: "c_tw", service_id: "twitter" })]);
  });

  it("get_social_network_rules delegates to GET /api/social/services", async () => {
    permissions.add("content:view");

    const { json } = await rpc(toolCall("get_social_network_rules", {}), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service_id: "twitter", char_limit: 280, requires_account_id: false }),
      ])
    );
  });

  it("compose_social_post creates a draft over the caller's token", async () => {
    permissions.add("content:create");
    socialPostCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      socialPostRow({ ...data })
    );

    const { json } = await rpc(toolCall("compose_social_post", { body: "hello world" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data.status).toBe("draft");
    expect(socialPostCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body: "hello world", status: "draft" }) })
    );
  });

  it("compose_social_post refuses to schedule a post that breaks a target channel's network rules", async () => {
    permissions.add("content:create");
    permissions.add("content:publish");
    socialChannelFindMany.mockResolvedValue([TWITTER_CHANNEL]);

    const { json } = await rpc(
      toolCall("compose_social_post", {
        body: "x".repeat(281), // over X's 280-char limit
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
      }),
      GOOD_TOKEN
    );
    expect(json?.result?.isError).toBe(true);
    const body = toolPayload(json!.result);
    expect(body.violations).toEqual([expect.objectContaining({ code: "char_limit", channel_id: "c_tw" })]);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("list_social_posts delegates to GET /api/social/posts", async () => {
    permissions.add("content:view");
    socialPostFindMany.mockResolvedValue([socialPostRow()]);

    const { json } = await rpc(toolCall("list_social_posts", {}), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data).toEqual([expect.objectContaining({ id: "sp1" })]);
  });

  it("schedule_social_post updates the post's scheduled_at and status via PUT /api/social/posts/[id]", async () => {
    permissions.add("content:edit");
    permissions.add("content:publish");
    socialPostFindUnique.mockResolvedValue(
      socialPostRow({ status: "draft", targets: [{ channel_id: "c_tw", channel: TWITTER_CHANNEL }] })
    );
    socialChannelFindMany.mockResolvedValue([TWITTER_CHANNEL]);
    socialPostUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      socialPostRow({ ...data })
    );

    const { json } = await rpc(
      toolCall("schedule_social_post", { id: "sp1", scheduled_at: "2099-01-01T00:00:00Z" }),
      GOOD_TOKEN
    );
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data.status).toBe("scheduled");
    expect(socialPostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "scheduled" }) })
    );
  });

  it("social_post_workflow submits the caller's own draft for review", async () => {
    permissions.add("content:view");
    socialPostFindUnique.mockResolvedValue(socialPostRow({ status: "draft", created_by_id: "u1" }));
    socialPostUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      socialPostRow({ ...data })
    );

    const { json } = await rpc(toolCall("social_post_workflow", { id: "sp1", action: "submit" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data.status).toBe("pending_review");
  });

  it("social_post_workflow approves a scheduled-time post straight into 'scheduled'", async () => {
    permissions.add("content:view");
    permissions.add("content:approve");
    socialPostFindUnique.mockResolvedValue(
      socialPostRow({ status: "pending_review", scheduled_at: new Date("2099-01-01T00:00:00Z") })
    );
    socialPostUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      socialPostRow({ ...data })
    );
    socialPostApprovalCreate.mockResolvedValue({});

    const { json } = await rpc(toolCall("social_post_workflow", { id: "sp1", action: "approve" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data.status).toBe("scheduled");
    expect(socialPostApprovalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "approved" }) })
    );
  });

  it("social_post_workflow refuses approve without content:approve", async () => {
    permissions.add("content:view");
    socialPostFindUnique.mockResolvedValue(socialPostRow({ status: "pending_review" }));

    const { json } = await rpc(toolCall("social_post_workflow", { id: "sp1", action: "approve" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBe(true);
    expect(socialPostUpdate).not.toHaveBeenCalled();
  });

  it("get_social_post_results fetches one social post's per-channel publish status", async () => {
    permissions.add("content:view");
    socialPostFindUnique.mockResolvedValue(
      socialPostRow({
        status: "published",
        targets: [{ channel_id: "c_tw", channel: TWITTER_CHANNEL, status: "published", external_url: "https://x.com/1" }],
      })
    );

    const { json } = await rpc(toolCall("get_social_post_results", { id: "sp1" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data.targets).toEqual([expect.objectContaining({ channel_id: "c_tw", status: "published" })]);
  });

  // G#27: manual delivery mode's own MCP tools.
  const MANUAL_CHANNEL = {
    id: "c_manual",
    service_id: "facebook-personal",
    service_name: "Facebook (personal profile)",
    delivery_mode: "manual",
  };

  it("list_manual_social_queue delegates to GET /api/social/manual, flattening awaiting_manual targets", async () => {
    permissions.add("content:view");
    socialPostFindMany.mockResolvedValue([
      socialPostRow({
        body: "Ready to paste on Facebook",
        targets: [
          {
            id: "t1",
            channel_id: "c_manual",
            channel: MANUAL_CHANNEL,
            status: "awaiting_manual",
            body_override: null,
            inserted_at: new Date(),
            updated_at: new Date(),
          },
        ],
      }),
    ]);

    const { json } = await rpc(toolCall("list_manual_social_queue", {}), GOOD_TOKEN);
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data).toEqual([
      expect.objectContaining({
        id: "t1",
        status: "awaiting_manual",
        // G#28: pre-resolved so an external caller (e.g. a Claude Desktop
        // session pasting into Facebook's own composer via Claude in
        // Chrome) never has to combine body_override/post.body/post.link
        // itself to know what to paste.
        effective_body: "Ready to paste on Facebook",
        paste_text: "Ready to paste on Facebook",
        post: expect.objectContaining({ id: "sp1", body: "Ready to paste on Facebook" }),
      }),
    ]);
  });

  it("mark_social_post_posted delegates to POST /api/social/manual/[targetId]/mark-posted", async () => {
    permissions.add("content:publish");
    socialPostFindFirst.mockResolvedValue({
      id: "sp1",
      targets: [{ id: "t1", status: "awaiting_manual", channel: MANUAL_CHANNEL }],
    });
    markManualTargetPosted.mockResolvedValue({
      id: "t1",
      post_id: "sp1",
      status: "published",
      external_url: "https://facebook.com/posts/123",
      channel: MANUAL_CHANNEL,
    });

    const { json } = await rpc(
      toolCall("mark_social_post_posted", { target_id: "t1", external_url: "https://facebook.com/posts/123" }),
      GOOD_TOKEN
    );
    expect(json?.result?.isError).toBeUndefined();
    const { data } = toolPayload(json!.result);
    expect(data.status).toBe("published");
    expect(markManualTargetPosted).toHaveBeenCalledWith("t1", {
      externalUrl: "https://facebook.com/posts/123",
      externalPostId: null,
    });
  });

  it("mark_social_post_posted refuses a target that isn't awaiting manual posting", async () => {
    permissions.add("content:publish");
    socialPostFindFirst.mockResolvedValue({
      id: "sp1",
      targets: [{ id: "t1", status: "published", channel: MANUAL_CHANNEL }],
    });

    const { json } = await rpc(toolCall("mark_social_post_posted", { target_id: "t1" }), GOOD_TOKEN);
    expect(json?.result?.isError).toBe(true);
    expect(markManualTargetPosted).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp — Humanizer", () => {
  it("names every Humanizer pattern in the server instructions the connector receives", async () => {
    const { humanizerPatterns, HUMANIZER_MCP_GUIDANCE } = await import("@/lib/humanizer");
    const { json } = await rpc(initializeBody(), GOOD_TOKEN);
    const instructions: string = json?.result?.instructions ?? "";
    expect(instructions).toContain(HUMANIZER_MCP_GUIDANCE);
    for (const p of humanizerPatterns()) expect(instructions).toContain(p);
  });

  it("serves the full skill through get_humanizer_guide", async () => {
    const { HUMANIZER_SKILL_BODY } = await import("@/lib/humanizer");
    const { json } = await rpc(toolCall("get_humanizer_guide", {}), GOOD_TOKEN);
    expect(json?.result?.isError).toBeFalsy();
    expect(json?.result?.content?.[0]?.text).toContain(HUMANIZER_SKILL_BODY);
  });

  it("points every prose-saving tool at it", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, GOOD_TOKEN);
    const tools: { name: string; description: string }[] = json?.result?.tools ?? [];
    for (const name of ["create_post", "update_post", "save_social_draft", "create_faq", "update_faq"]) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/Humanizer/);
    }
  });
});
