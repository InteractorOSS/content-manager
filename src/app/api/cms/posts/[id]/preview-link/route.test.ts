import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const permissions = new Set<string>();
let actorUserId = "u1";

const postFindUnique = vi.fn();
const postUpdate = vi.fn();
const fakeDb = { post: { findUnique: postFindUnique, update: postUpdate } };

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (req: NextRequest, ...perms: string[]) => {
    if (req.headers.get("authorization") !== "Bearer good") {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    const missing = perms.filter((p) => !permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { actor: { user: { id: actorUserId }, permissions }, db: fakeDb };
  }),
}));

import { POST, DELETE } from "./route";

function req(method: string) {
  return new NextRequest("http://localhost/api/cms/posts/p1/preview-link", {
    method,
    headers: { authorization: "Bearer good" },
  });
}

function ctx(id = "p1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  permissions.clear();
  actorUserId = "u1";
  postFindUnique.mockReset();
  postUpdate.mockReset();
});

describe("POST /api/cms/posts/[id]/preview-link", () => {
  it("404s a post that doesn't exist", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue(null);
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(404);
  });

  it("403s an author trying to mint a link for someone else's post", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue({ id: "p1", author_id: "someone-else" });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(403);
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("mints a link and returns an openable URL for the post's own author", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue({ id: "p1", author_id: "u1" });
    postUpdate.mockResolvedValue({});

    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toMatch(/\/preview\//);
    expect(new Date(body.data.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { preview_token_expires_at: expect.any(Date) },
    });
  });

  it("content:edit_any can mint a link for someone else's post", async () => {
    permissions.add("content:edit");
    permissions.add("content:edit_any");
    postFindUnique.mockResolvedValue({ id: "p1", author_id: "someone-else" });
    postUpdate.mockResolvedValue({});

    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/cms/posts/[id]/preview-link", () => {
  it("404s a post that doesn't exist", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue(null);
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(404);
  });

  it("403s an author trying to revoke someone else's post's link", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue({ id: "p1", author_id: "someone-else" });
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(403);
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("clears preview_token_expires_at for the post's own author", async () => {
    permissions.add("content:edit");
    postFindUnique.mockResolvedValue({ id: "p1", author_id: "u1" });
    postUpdate.mockResolvedValue({});

    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(204);
    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { preview_token_expires_at: null },
    });
  });
});
