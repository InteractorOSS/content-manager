import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// DB-free: prisma and the session guard are both mocked, following the
// src/lib/rbac.test.ts idiom. The route's own rules are what is under test —
// the write is asserted through the $transaction it hands to Prisma.
const requirePermission = vi.fn();
const membershipFindUnique = vi.fn();
const membershipUpsert = vi.fn();
const roleFindUnique = vi.fn();
const roleFindMany = vi.fn();
const userRoleUpsert = vi.fn();
const userRoleDeleteMany = vi.fn();
const userFindMany = vi.fn();
const membershipFindMany = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    membership: {
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
      findMany: (...a: unknown[]) => membershipFindMany(...a),
      upsert: (...a: unknown[]) => membershipUpsert(...a),
    },
    role: {
      findUnique: (...a: unknown[]) => roleFindUnique(...a),
      findMany: (...a: unknown[]) => roleFindMany(...a),
    },
    userRole: {
      upsert: (...a: unknown[]) => userRoleUpsert(...a),
      deleteMany: (...a: unknown[]) => userRoleDeleteMany(...a),
    },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { PUT } from "./[id]/roles/route";
import { GET as listMembers } from "./route";

const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: ["users:view", "users:manage_roles", "content:publish"],
  owner: ["users:view", "users:manage_roles", "content:publish"],
  admin: ["users:view", "users:manage_roles", "content:publish"],
  editor: ["content:publish"],
  author: [],
};

function actor(overrides: {
  id?: string;
  membershipRole?: string;
  superAdmin?: boolean;
  organizationId?: string | null;
}) {
  const membershipRole = overrides.membershipRole ?? "admin";
  const roles = [
    ...(membershipRole ? [membershipRole] : []),
    ...(overrides.superAdmin ? ["super_admin"] : []),
  ];
  const permissions = new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []));
  return {
    actor: {
      user: { id: overrides.id ?? "admin-1", email: "admin@interactor.com", name: "Admin" },
      organizationId:
        overrides.organizationId === undefined ? "org-a" : overrides.organizationId,
      membershipRole,
      organizations: [],
      roles,
      // The GLOBAL grant is its own field, never inferred from `roles` — a
      // Membership.role of "super_admin" must NOT read as the global one.
      isSuperAdmin: overrides.superAdmin ?? false,
      permissions,
    },
  };
}

/** A membership row as the route selects it. */
function member(role: string, superAdmin = false, id = "member-1") {
  return {
    role,
    user: {
      id,
      name: "Mem Ber",
      email: "mem@interactor.com",
      roles: superAdmin
        ? [{ role: { id: "role-sa", name: "super_admin", active: true } }]
        : [],
    },
  };
}

function put(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/users/${id}/roles`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requirePermission.mockReset();
  membershipFindUnique.mockReset();
  membershipFindMany.mockReset();
  membershipUpsert.mockReset();
  membershipUpsert.mockImplementation((args) => ({ __op: "membership.upsert", args }));
  roleFindUnique.mockReset();
  roleFindUnique.mockImplementation(({ where }: { where: { name: string } }) =>
    Promise.resolve(
      where.name in ROLE_PERMISSIONS
        ? { id: `role-${where.name}`, name: where.name, active: true }
        : null
    )
  );
  roleFindMany.mockReset();
  // Two callers: flattenPermissions() asks by name, GET /api/users asks for the
  // active catalog to label each row's role.
  roleFindMany.mockImplementation(
    ({ where }: { where: { name?: { in: string[] }; active?: boolean } }) =>
      Promise.resolve(
        where.name
          ? where.name.in.map((name) => ({
              name,
              permissions: (ROLE_PERMISSIONS[name] ?? []).map((p) => ({
                permission: { name: p },
              })),
            }))
          : Object.keys(ROLE_PERMISSIONS).map((name) => ({
              name,
              display_name: name.replace(/^./, (c) => c.toUpperCase()),
            }))
      )
  );
  userRoleUpsert.mockReset();
  userRoleUpsert.mockImplementation((args) => ({ __op: "userRole.upsert", args }));
  userRoleDeleteMany.mockReset();
  userRoleDeleteMany.mockImplementation((args) => ({ __op: "userRole.deleteMany", args }));
  userFindMany.mockReset();
  transaction.mockReset();
  transaction.mockResolvedValue([]);
});

describe("PUT /api/users/[id]/roles — the membership write", () => {
  it("writes Membership.role for the target member in the actor's org", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindUnique.mockResolvedValue(member("author"));

    const res = await PUT(put("member-1", { role: "editor" }), ctx("member-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "member-1",
      organization_id: "org-a",
      membership_role: "editor",
      super_admin: false,
    });

    expect(membershipUpsert).toHaveBeenCalledTimes(1);
    const args = membershipUpsert.mock.calls[0][0];
    expect(args.where.organization_id_user_id).toEqual({
      organization_id: "org-a",
      user_id: "member-1",
    });
    expect(args.update).toEqual({ role: "editor" });
    // One transaction carrying exactly that write.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0]).toHaveLength(1);
  });

  it("looks the member up only within the acting admin's organization", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindUnique.mockResolvedValue(null);

    const res = await PUT(put("other-org-user", { role: "editor" }), ctx("other-org-user"));

    expect(res.status).toBe(404);
    expect(membershipFindUnique.mock.calls[0][0].where.organization_id_user_id).toEqual({
      organization_id: "org-a",
      user_id: "other-org-user",
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not write when the role is unchanged", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindUnique.mockResolvedValue(member("editor"));

    const res = await PUT(put("member-1", { role: "editor" }), ctx("member-1"));

    expect(res.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a caller with no organization before it looks anyone up", async () => {
    // There is no org to scope the membership lookup to, so there is no member
    // this caller could be entitled to re-role — refuse rather than fall back
    // to an unscoped `where`.
    requirePermission.mockResolvedValue(actor({ organizationId: null }));

    const res = await PUT(put("member-1", { role: "editor" }), ctx("member-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/organization/i);
    expect(membershipFindUnique).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an unknown role by name", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindUnique.mockResolvedValue(member("author"));

    const res = await PUT(put("member-1", { role: "wizard" }), ctx("member-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("wizard");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/[id]/roles — one role per organization", () => {
  it("rejects a request naming two organization roles instead of picking one", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindUnique.mockResolvedValue(member("author"));

    const res = await PUT(
      put("member-1", { roles: ["editor", "reviewer"] }),
      ctx("member-1")
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/one role in this organization/i);
    expect(body.error).toContain("editor");
    expect(body.error).toContain("reviewer");
    expect(transaction).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it("still accepts the legacy single-element array shape", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindUnique.mockResolvedValue(member("author"));

    const res = await PUT(put("member-1", { roles: ["editor"] }), ctx("member-1"));

    expect(res.status).toBe(200);
    expect(membershipUpsert.mock.calls[0][0].update).toEqual({ role: "editor" });
  });
});

describe("PUT /api/users/[id]/roles — escalation is refused in the route", () => {
  it("refuses an org admin granting super_admin, and writes nothing", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));
    membershipFindUnique.mockResolvedValue(member("editor"));

    const res = await PUT(
      put("member-1", { role: "editor", super_admin: true }),
      ctx("member-1")
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/super administrator/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
    expect(userRoleUpsert).not.toHaveBeenCalled();
  });

  it("refuses an org admin revoking super_admin too", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));
    membershipFindUnique.mockResolvedValue(member("editor", true));

    const res = await PUT(put("member-1", { super_admin: false }), ctx("member-1"));

    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(userRoleDeleteMany).not.toHaveBeenCalled();
  });

  it("refuses an org admin granting owner, and writes nothing", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));
    membershipFindUnique.mockResolvedValue(member("editor"));

    const res = await PUT(put("member-1", { role: "owner" }), ctx("member-1"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/owner/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it("refuses an org admin demoting the sitting owner", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));
    membershipFindUnique.mockResolvedValue(member("owner"));

    const res = await PUT(put("member-1", { role: "author" }), ctx("member-1"));

    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("lets the organization's owner grant owner", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "owner" }));
    membershipFindUnique.mockResolvedValue(member("editor"));

    const res = await PUT(put("member-1", { role: "owner" }), ctx("member-1"));

    expect(res.status).toBe(200);
    expect(membershipUpsert.mock.calls[0][0].update).toEqual({ role: "owner" });
  });

  // The named escalation path: every self-serve signup is the OWNER of its own
  // freshly-created org and so holds users:manage_roles there. Owner is the
  // actor to pin, not admin — and the target being the actor themselves is the
  // shape that made it a free-signup-to-platform-super-admin route.
  it("refuses a self-serve org owner granting THEMSELVES super_admin", async () => {
    requirePermission.mockResolvedValue(actor({ id: "owner-1", membershipRole: "owner" }));
    membershipFindUnique.mockResolvedValue(member("owner", false, "owner-1"));

    const res = await PUT(put("owner-1", { super_admin: true }), ctx("owner-1"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/super administrator/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(userRoleUpsert).not.toHaveBeenCalled();
  });

  it("refuses an org owner revoking someone else's super_admin", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "owner" }));
    membershipFindUnique.mockResolvedValue(member("editor", true));

    const res = await PUT(put("member-1", { role: "editor", super_admin: false }), ctx("member-1"));

    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(userRoleDeleteMany).not.toHaveBeenCalled();
  });

  it("lets a global super_admin grant super_admin, on user_roles", async () => {
    requirePermission.mockResolvedValue(
      actor({ membershipRole: "admin", superAdmin: true })
    );
    membershipFindUnique.mockResolvedValue(member("editor"));

    const res = await PUT(put("member-1", { super_admin: true }), ctx("member-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.super_admin).toBe(true);
    expect(userRoleUpsert).toHaveBeenCalledTimes(1);
    expect(userRoleUpsert.mock.calls[0][0].create).toEqual({
      user_id: "member-1",
      role_id: "role-super_admin",
    });
    // The org role was untouched: one write, and it is not the membership.
    expect(membershipUpsert).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/[id]/roles — self-lockout guard", () => {
  it("refuses demoting your own membership below role management", async () => {
    requirePermission.mockResolvedValue(actor({ id: "admin-1", membershipRole: "admin" }));
    membershipFindUnique.mockResolvedValue(member("admin", false, "admin-1"));

    const res = await PUT(put("admin-1", { role: "editor" }), ctx("admin-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/unable to manage roles/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it("evaluates the membership being written, not a user_roles array", async () => {
    // owner also carries users:manage_roles — the old guard only knew the
    // literal names "super_admin" and "admin" and would have refused this.
    requirePermission.mockResolvedValue(actor({ id: "admin-1", membershipRole: "owner" }));
    membershipFindUnique.mockResolvedValue(member("owner", false, "admin-1"));

    const res = await PUT(put("admin-1", { role: "admin" }), ctx("admin-1"));

    expect(res.status).toBe(200);
    expect(membershipUpsert.mock.calls[0][0].update).toEqual({ role: "admin" });
  });

  it("lets a global super_admin step down as org admin — the grant still holds", async () => {
    requirePermission.mockResolvedValue(
      actor({ id: "admin-1", membershipRole: "admin", superAdmin: true })
    );
    membershipFindUnique.mockResolvedValue(member("admin", true, "admin-1"));

    const res = await PUT(put("admin-1", { role: "author" }), ctx("admin-1"));

    expect(res.status).toBe(200);
    expect(membershipUpsert.mock.calls[0][0].update).toEqual({ role: "author" });
  });

  it("refuses a super_admin who would drop both at once", async () => {
    requirePermission.mockResolvedValue(
      actor({ id: "admin-1", membershipRole: "admin", superAdmin: true })
    );
    membershipFindUnique.mockResolvedValue(member("admin", true, "admin-1"));

    const res = await PUT(
      put("admin-1", { role: "author", super_admin: false }),
      ctx("admin-1")
    );

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("GET /api/users", () => {
  const memberRow = (
    role: string,
    id: string,
    superAdmin = false,
    org = { id: "org-a", name: "Acme", slug: "acme" }
  ) => ({
    role,
    inserted_at: new Date("2026-01-02T00:00:00Z"),
    organization: org,
    user: {
      id,
      email: `${id}@interactor.com`,
      name: id,
      status: "active",
      avatar_url: null,
      last_login_at: null,
      inserted_at: new Date("2026-01-01T00:00:00Z"),
      roles: superAdmin ? [{ role: { name: "super_admin", active: true } }] : [],
      _count: { posts: 3 },
    },
  });

  function get(url = "http://localhost/api/users") {
    return new NextRequest(url);
  }

  it("lists only the acting admin's organization, with the effective role", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindMany.mockResolvedValue([
      memberRow("editor", "mem-1"),
      memberRow("owner", "mem-2", true),
    ]);

    const res = await listMembers(get());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(membershipFindMany.mock.calls[0][0].where.organization_id).toBe("org-a");
    expect(userFindMany).not.toHaveBeenCalled();
    expect(body.data.map((m: { membership_role: string }) => m.membership_role)).toEqual([
      "editor",
      "owner",
    ]);
    // The global flag rides alongside the org role, never merged into it.
    expect(body.data.map((m: { super_admin: boolean }) => m.super_admin)).toEqual([
      false,
      true,
    ]);
    expect(body.meta).toEqual({ organization_id: "org-a", scope: "organization" });
  });

  it("labels each row's role so the table needs no second request", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindMany.mockResolvedValue([memberRow("editor", "mem-1")]);

    const body = await (await listMembers(get())).json();

    expect(body.data[0].membership_role_display_name).toBe("Editor");
  });

  it("counts only this organization's posts", async () => {
    requirePermission.mockResolvedValue(actor({}));
    membershipFindMany.mockResolvedValue([memberRow("editor", "mem-1")]);

    await listMembers(get());

    expect(
      membershipFindMany.mock.calls[0][0].select.user.select._count.select.posts
    ).toEqual({ where: { organization_id: "org-a" } });
  });

  it("returns an empty list without querying when the caller has no organization", async () => {
    requirePermission.mockResolvedValue(actor({ organizationId: null }));

    const res = await listMembers(get());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.meta).toEqual({ organization_id: null, scope: "organization" });
    // No org means no filter to apply, so the query must not run at all rather
    // than run unfiltered.
    expect(membershipFindMany).not.toHaveBeenCalled();
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("refuses a cross-org listing to anyone but a global super_admin", async () => {
    requirePermission.mockResolvedValue(actor({ membershipRole: "admin" }));

    const res = await listMembers(get("http://localhost/api/users?scope=all"));

    expect(res.status).toBe(403);
    expect(userFindMany).not.toHaveBeenCalled();
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it("gives a global super_admin members across orgs, each row naming its org", async () => {
    requirePermission.mockResolvedValue(
      actor({ membershipRole: "admin", superAdmin: true })
    );
    const beta = { id: "org-b", name: "Beta", slug: "beta" };
    membershipFindMany.mockResolvedValue([
      memberRow("owner", "mem-1"),
      // The same person, a second org, a different role — this is the whole
      // point of the cross-org view, and the old user.findMany() shape (one
      // row per identity, role hardcoded to null) could not express it.
      memberRow("author", "mem-1", false, beta),
    ]);

    const res = await listMembers(get("http://localhost/api/users?scope=all"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta.scope).toBe("all");
    // The org filter is lifted, not swapped for an unfiltered user dump.
    expect(membershipFindMany.mock.calls[0][0].where.organization_id).toBeUndefined();
    expect(userFindMany).not.toHaveBeenCalled();
    expect(
      body.data.map((m: { membership_role: string; organization: { slug: string } }) => [
        m.organization.slug,
        m.membership_role,
      ])
    ).toEqual([
      ["acme", "owner"],
      ["beta", "author"],
    ]);
    // Nobody renders as "No role", and the two rows are separately keyable.
    expect(body.data.every((m: { membership_role: string }) => m.membership_role)).toBe(
      true
    );
    expect(body.data[0].membership_id).not.toBe(body.data[1].membership_id);
  });
});
