import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { auth, postFindUnique, loadActor, mintEditKey, mintBrowseKey } = vi.hoisted(() => ({
  auth: vi.fn(),
  postFindUnique: vi.fn(),
  loadActor: vi.fn(),
  mintEditKey: vi.fn(),
  mintBrowseKey: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ prisma: { post: { findUnique: postFindUnique } } }));
vi.mock("@/lib/rbac", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rbac")>()),
  loadActor,
}));
vi.mock("@/lib/post-edit-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/post-edit-keys")>()),
  mintEditKey,
}));
vi.mock("@/lib/post-browse-keys", () => ({ mintBrowseKey }));
vi.mock("@/lib/oauth/protocol", () => ({ publicOrigin: () => "https://cms.interactor.com" }));

import { POST } from "./route";

const post = { id: "p1", organization_id: "org-blog", author_id: "u1", author_name: "Peter" };
const actor = (over: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "writer@example.com" },
  organizationId: "org-blog",
  permissions: new Set(["content:view", "content:edit"]),
  roles: ["author"],
  isSuperAdmin: false,
  ...over,
});

function req(body: unknown = { post_id: "p1" }, origin = "https://cms.interactor.com") {
  return new NextRequest("https://cms.interactor.com/api/edit/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ user: { id: "u1", email: "writer@example.com" } });
  postFindUnique.mockReset().mockResolvedValue(post);
  loadActor.mockReset().mockResolvedValue(actor());
  mintEditKey.mockReset().mockResolvedValue({ key: "cms_edit_x", expiresAt: new Date(1_800_000_000_000) });
  mintBrowseKey.mockReset().mockResolvedValue({ key: "cms_list_x", expiresAt: new Date(1_800_000_000_000) });
});

describe("POST /api/edit/session (open from a link with the CMS sign-in)", () => {
  it("mints a key in the POST's organization, not the session's current one", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.edit_key).toBe("cms_edit_x");
    expect(loadActor).toHaveBeenCalledWith(expect.anything(), { forceOrganizationId: "org-blog" });
    expect(mintEditKey).toHaveBeenCalledWith(
      expect.objectContaining({ postId: "p1", organizationId: "org-blog", apiTokenId: null })
    );
  });

  it("tells a signed-out browser to sign in", async () => {
    auth.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect((await res.json()).sign_in).toBe(true);
    expect(mintEditKey).not.toHaveBeenCalled();
  });

  it("refuses a post in an organization this account isn't in, without naming it", async () => {
    // loadActor fell back to another membership: the account isn't in org-blog.
    loadActor.mockResolvedValue(actor({ organizationId: "org-other" }));
    const res = await POST(req());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.switch_account).toBe(true);
    expect(body.error).toContain("writer@example.com");
    expect(body.error).not.toContain("org-blog");
    expect(mintEditKey).not.toHaveBeenCalled();
  });

  it("answers an unknown post exactly like one the account can't reach", async () => {
    postFindUnique.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).switch_account).toBe(true);
  });

  it("needs content:edit, and the post must be one this person may edit", async () => {
    loadActor.mockResolvedValue(actor({ permissions: new Set(["content:view"]) }));
    expect((await POST(req())).status).toBe(403);
    loadActor.mockResolvedValue(actor({ user: { id: "someone-else", email: "x@y.z" } }));
    expect((await POST(req())).status).toBe(403);
    expect(mintEditKey).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request and a missing post id", async () => {
    expect((await POST(req(undefined, "https://evil.example"))).status).toBe(403);
    expect((await POST(req({}))).status).toBe(400);
  });
});

describe("POST /api/edit/session { list: true } (the post list opened as a plain page)", () => {
  it("mints a list key for the signed-in account's current organization, every site", async () => {
    const res = await POST(req({ list: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.list_key).toBe("cms_list_x");
    expect(mintBrowseKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", organizationId: "org-blog", apiTokenId: null, site: null, replacePrevious: false })
    );
  });

  it("asks a signed-out browser to sign in", async () => {
    auth.mockResolvedValue(null);
    const res = await POST(req({ list: true }));
    expect(res.status).toBe(401);
    expect((await res.json()).sign_in).toBe(true);
  });

  it("refuses an account that can't read posts, and a cross-site request", async () => {
    loadActor.mockResolvedValue(actor({ permissions: new Set() }));
    expect((await POST(req({ list: true }))).status).toBe(403);
    expect((await POST(req({ list: true }, "https://evil.example"))).status).toBe(403);
    expect(mintBrowseKey).not.toHaveBeenCalled();
  });
});
