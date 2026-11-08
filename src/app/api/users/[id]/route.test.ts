import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET/PUT/DELETE here used to act on any user id with NO org check at all —
 * anyone holding users:view/edit/delete in their OWN org (trivially true for
 * the owner of even a brand-new self-serve org) could read, edit, or
 * permanently delete ANY user account on the platform, across every tenant.
 * These tests pin the Membership check that closes that.
 */

const { findUnique, update, del, isOrgMember } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  isOrgMember: vi.fn(),
}));

const actor = {
  user: { id: "actor-1", email: "actor@example.com", name: "Actor", status: "active" },
  organizationId: "org-mine",
  organizations: [{ id: "org-mine", name: "Mine", slug: "mine", role: "owner" }],
  membershipRole: "owner",
  roles: ["owner"],
  permissions: new Set(["users:view", "users:edit", "users:delete"]),
};

vi.mock("@/lib/guard", () => ({
  requirePermission: vi.fn(async () => ({ actor, db: {}, via: "session" })),
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a), delete: (...a: unknown[]) => del(...a) } },
}));
vi.mock("@/lib/rbac", () => ({ isOrgMember: (...a: unknown[]) => isOrgMember(...a) }));

import { GET, PUT, DELETE } from "./route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  isOrgMember.mockReset();
  findUnique.mockReset();
  update.mockReset();
  del.mockReset();
});

describe("GET /api/users/[id]", () => {
  it("404s for a user outside the caller's organization, without reading it", async () => {
    isOrgMember.mockResolvedValue(false);
    const res = await GET(new NextRequest("http://localhost/api/users/other-org-user"), ctx("other-org-user"));

    expect(res.status).toBe(404);
    expect(isOrgMember).toHaveBeenCalledWith("org-mine", "other-org-user");
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/[id]", () => {
  it("404s for a user outside the caller's organization, without writing", async () => {
    isOrgMember.mockResolvedValue(false);
    const req = new NextRequest("http://localhost/api/users/other-org-user", {
      method: "PUT",
      body: JSON.stringify({ status: "suspended" }),
    });
    const res = await PUT(req, ctx("other-org-user"));

    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/users/[id]", () => {
  it("404s for a user outside the caller's organization, without deleting", async () => {
    isOrgMember.mockResolvedValue(false);
    const res = await DELETE(new NextRequest("http://localhost/api/users/other-org-user"), ctx("other-org-user"));

    expect(res.status).toBe(404);
    expect(del).not.toHaveBeenCalled();
  });

  it("still refuses self-deletion before the org check even runs", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/users/actor-1"), ctx("actor-1"));
    expect(res.status).toBe(400);
    expect(del).not.toHaveBeenCalled();
  });
});
