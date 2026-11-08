import { describe, expect, it, vi, beforeEach } from "vitest";

const { findUnique, update, updateMany, create, transaction, loadActor } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
  loadActor: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { postEditKey: { findUnique, update, updateMany, create }, $transaction: transaction },
}));
vi.mock("@/lib/rbac", () => ({ loadActor }));
vi.mock("@/lib/tenant-db", () => ({ tenantDb: (org: string) => ({ org }) }));

import { looksLikeApiToken } from "@/lib/api-tokens";
import {
  generateEditKey,
  looksLikeEditKey,
  mintEditKey,
  prepareEditUpload,
  resolveEditKey,
  serializeEditFile,
  versionFromHeader,
} from "./post-edit-keys";

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue({});
  loadActor.mockReset();
});

const post = { id: "p1", status: "draft", content_hash: "h1" };

describe("edit key shape", () => {
  it("is never accepted as a personal access token", () => {
    const key = generateEditKey();
    expect(looksLikeEditKey(key)).toBe(true);
    // The key must not authenticate any /api/cms route or /api/mcp.
    expect(looksLikeApiToken(key)).toBe(false);
  });
});

describe("prepareEditUpload", () => {
  it("pins the post id and the post's current content_hash", () => {
    const out = prepareEditUpload("---\ntitle: Hi\n---\nBody\n", post);
    expect("raw" in out && out.raw).toContain("id: p1");
    expect("raw" in out && out.raw).toContain("content_hash: h1");
    expect("raw" in out && out.raw).toContain("Body");
  });

  it("replaces a content_hash the file carries rather than trusting it", () => {
    const out = prepareEditUpload("---\nid: p1\ncontent_hash: forged\ntitle: Hi\n---\nBody\n", post);
    expect("raw" in out && out.raw).not.toContain("forged");
  });

  it("refuses a file for another post", () => {
    const out = prepareEditUpload("---\nid: other\ntitle: Hi\n---\nBody\n", post);
    expect(out).toEqual({ error: expect.stringContaining("post other") });
  });

  it("refuses a status change — workflow moves stay in the workflow tools", () => {
    const out = prepareEditUpload("---\nid: p1\nstatus: published\ntitle: Hi\n---\nBody\n", post);
    expect(out).toEqual({ error: expect.stringContaining("status can't be changed") });
  });

  it("allows the unchanged status", () => {
    expect("raw" in prepareEditUpload("---\nid: p1\nstatus: draft\ntitle: Hi\n---\nB\n", post)).toBe(true);
  });

  it("reports broken YAML instead of throwing", () => {
    expect(prepareEditUpload("---\ntitle: [unclosed\n---\nB\n", post)).toEqual({
      error: expect.stringContaining("isn't valid YAML"),
    });
  });
});

describe("serializeEditFile", () => {
  it("leaves content_hash out of the file", () => {
    const file = serializeEditFile({
      id: "p1",
      content_hash: "h1",
      title: "Hi",
      slug: "hi",
      status: "draft",
      type: "blog",
      excerpt: null,
      category: null,
      tags: [],
      platforms: ["website"],
      featured_image: null,
      featured_image_alt: null,
      meta_description: null,
      meta_keywords: null,
      seo_title: null,
      canonical_url: null,
      og_image: null,
      og_image_alt: null,
      noindex: false,
      answer_summary: null,
      redirect_to: null,
      content_format: "markdown",
      published_at: null,
      content: "Body",
    });
    expect(file).not.toContain("content_hash");
    expect(file).toContain("id: p1");
  });
});

describe("versionFromHeader", () => {
  it("accepts quoted, weak and bare forms", () => {
    expect(versionFromHeader('"123"')).toBe("123");
    expect(versionFromHeader('W/"123"')).toBe("123");
    expect(versionFromHeader("123")).toBe("123");
    expect(versionFromHeader(null)).toBeNull();
  });
});

describe("resolveEditKey", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const liveKey = {
    id: "k1",
    post_id: "p1",
    user_id: "u1",
    organization_id: "org1",
    site_scopes: ["website"],
    revoked_at: null,
    expires_at: new Date("2026-09-23T13:00:00Z"),
    api_token: { revoked_at: null, expires_at: null },
  };

  it("ignores anything that isn't an edit key without a lookup", async () => {
    expect(await resolveEditKey("cms_pat_abc", now)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("resolves a live key to its post, org and owner", async () => {
    findUnique.mockResolvedValue(liveKey);
    loadActor.mockResolvedValue({ organizationId: "org1", user: { id: "u1" } });
    const auth = await resolveEditKey("cms_edit_x", now);
    expect(auth?.key).toEqual({ id: "k1", post_id: "p1", site_scopes: ["website"], last_write_at: null });
    expect(loadActor).toHaveBeenCalledWith({ id: "u1" }, { forceOrganizationId: "org1" });
  });

  it.each([
    ["revoked", { revoked_at: new Date() }],
    ["expired", { expires_at: new Date("2026-09-23T11:00:00Z") }],
    ["minted by a revoked connection", { api_token: { revoked_at: new Date(), expires_at: null } }],
  ])("refuses a key that is %s", async (_label, patch) => {
    findUnique.mockResolvedValue({ ...liveKey, ...patch });
    loadActor.mockResolvedValue({ organizationId: "org1", user: { id: "u1" } });
    expect(await resolveEditKey("cms_edit_x", now)).toBeNull();
  });

  it("refuses when the owner is no longer a member of the key's org", async () => {
    findUnique.mockResolvedValue(liveKey);
    // loadActor fell back to another membership — must not carry the key there.
    loadActor.mockResolvedValue({ organizationId: "personal-org", user: { id: "u1" } });
    expect(await resolveEditKey("cms_edit_x", now)).toBeNull();
  });
});

describe("mintEditKey", () => {
  it("replaces only the session opened through the same connection", async () => {
    updateMany.mockReturnValue("revoke-op");
    create.mockReturnValue("create-op");
    transaction.mockResolvedValue([]);
    await mintEditKey({ postId: "p1", userId: "u1", organizationId: "org1", apiTokenId: "tok-claude", siteScopes: [] });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { post_id: "p1", user_id: "u1", api_token_id: "tok-claude", source: "connection", revoked_at: null },
      })
    );
    // A browser sign-in (null token) replaces only earlier browser sessions,
    // so clicking a link never cuts off Claude's sync for the same post.
    await mintEditKey({ postId: "p1", userId: "u1", organizationId: "org1", apiTokenId: null, siteScopes: [] });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { post_id: "p1", user_id: "u1", api_token_id: null, source: "connection", revoked_at: null } })
    );
  });

  it("a session opened from the post list replaces only an earlier list session, never Claude's sync", async () => {
    updateMany.mockReturnValue("revoke-op");
    create.mockReturnValue("create-op");
    transaction.mockResolvedValue([]);
    await mintEditKey({ postId: "p1", userId: "u1", organizationId: "org1", apiTokenId: "tok-claude", siteScopes: [], source: "list" });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ api_token_id: "tok-claude", source: "list" }) })
    );
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ source: "list" }) }));
  });
});
