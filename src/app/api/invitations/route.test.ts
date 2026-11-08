import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * An invitation is a DEFERRED role grant: applyPendingInvitation() writes
 * Membership.role from `role_name` at first sign-in. So the escalation the
 * members editor refuses has to be refused here too — otherwise a users:create
 * holder mints the role they cannot grant by inviting an address they control.
 *
 * DB-free, following the src/lib/rbac.test.ts idiom: prisma and the guard are
 * both mocked and the refusal is asserted by the invitation row NOT existing.
 */
const requirePermission = vi.fn();
const roleFindUnique = vi.fn();
const userFindUnique = vi.fn();
const invitationFindFirst = vi.fn();
const invitationCreate = vi.fn();

vi.mock("@/lib/guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    role: { findUnique: (...a: unknown[]) => roleFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));

import { POST } from "./route";

const KNOWN_ROLES = ["super_admin", "owner", "admin", "editor", "author"];

function actor(overrides: { membershipRole?: string; superAdmin?: boolean }) {
  const membershipRole = overrides.membershipRole ?? "admin";
  return {
    actor: {
      user: { id: "admin-1", email: "admin@interactor.com", name: "Admin" },
      organizationId: "org-a",
      membershipRole,
      organizations: [],
      roles: [membershipRole, ...(overrides.superAdmin ? ["super_admin"] : [])],
      isSuperAdmin: overrides.superAdmin ?? false,
      permissions: new Set(["users:view", "users:create"]),
    },
    db: {
      invitation: {
        findFirst: (...a: unknown[]) => invitationFindFirst(...a),
        create: (...a: unknown[]) => invitationCreate(...a),
      },
    },
  };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/invitations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  requirePermission.mockReset();
  roleFindUnique.mockReset();
  roleFindUnique.mockImplementation(({ where }: { where: { name: string } }) =>
    Promise.resolve(
      KNOWN_ROLES.includes(where.name)
        ? { id: `role-${where.name}`, name: where.name, active: true }
        : null
    )
  );
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue(null);
  invitationFindFirst.mockReset();
  invitationFindFirst.mockResolvedValue(null);
  invitationCreate.mockReset();
  invitationCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "inv-1",
      status: "pending",
      expires_at: new Date("2026-10-01T00:00:00Z"),
      ...data,
    })
  );
});

describe("POST /api/invitations — the grant rules apply to invitations too", () => {
  it("refuses an org admin inviting someone as super_admin, and creates no row", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));

    const res = await POST(
      post({ email: "new@interactor.com", role_name: "super_admin" })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/super administrator/i);
    expect(invitationCreate).not.toHaveBeenCalled();
  });

  it("refuses an org admin inviting someone as owner, and creates no row", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));

    const res = await POST(post({ email: "new@interactor.com", role_name: "owner" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/owner/i);
    expect(invitationCreate).not.toHaveBeenCalled();
  });

  it("lets the organization's owner invite an owner", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "owner" }));

    const res = await POST(post({ email: "new@interactor.com", role_name: "owner" }));

    expect(res.status).toBe(201);
    expect(invitationCreate.mock.calls[0][0].data.role_name).toBe("owner");
  });

  it("refuses super_admin as an invitation role even for a super_admin", async () => {
    // Not an escalation — it is a category error. An invitation only writes
    // Membership.role, so this would create an org role named "super_admin"
    // that reads as global power and confers none of it.
    requirePermission.mockResolvedValue(
      actor({ membershipRole: "admin", superAdmin: true })
    );

    const res = await POST(
      post({ email: "new@interactor.com", role_name: "super_admin" })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/global role/i);
    expect(invitationCreate).not.toHaveBeenCalled();
  });

  it("still invites an ordinary org role", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));

    const res = await POST(post({ email: "new@interactor.com", role_name: "editor" }));

    expect(res.status).toBe(201);
    expect(invitationCreate.mock.calls[0][0].data.role_name).toBe("editor");
  });

  it("refuses a role that isn't in the catalog", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));

    const res = await POST(post({ email: "new@interactor.com", role_name: "wizard" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("wizard");
    expect(invitationCreate).not.toHaveBeenCalled();
  });
});
