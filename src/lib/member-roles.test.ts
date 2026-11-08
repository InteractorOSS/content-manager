import { describe, expect, it } from "vitest";
import {
  GLOBAL_SUPER_ADMIN,
  ORG_OWNER,
  canGrantRole,
  isGlobalSuperAdmin,
  roleGrantRefusal,
} from "./member-roles";

const granter = (membershipRole: string | null, isSuperAdmin = false) => ({
  membershipRole,
  isSuperAdmin,
});

describe("isGlobalSuperAdmin", () => {
  /**
   * toActor() builds `roles` as [membershipRole, ...global grant], so the two
   * are indistinguishable in that array. A member whose Membership.role is the
   * literal string "super_admin" used to pass every gate meant for the global
   * user_roles grant — including, once the grant was revoked, forever after.
   */
  it("reads the dedicated flag, not a membership role that happens to be named super_admin", () => {
    expect(isGlobalSuperAdmin({ isSuperAdmin: false })).toBe(false);
    expect(isGlobalSuperAdmin({ isSuperAdmin: true })).toBe(true);
    expect(canGrantRole(granter(GLOBAL_SUPER_ADMIN, false), GLOBAL_SUPER_ADMIN)).toBe(
      false
    );
  });
});

describe("canGrantRole", () => {
  it("keeps super_admin to global super admins", () => {
    expect(canGrantRole(granter("admin"), GLOBAL_SUPER_ADMIN)).toBe(false);
    expect(canGrantRole(granter(ORG_OWNER), GLOBAL_SUPER_ADMIN)).toBe(false);
    expect(canGrantRole(granter("admin", true), GLOBAL_SUPER_ADMIN)).toBe(true);
  });

  it("keeps owner to the sitting owner or a global super admin", () => {
    expect(canGrantRole(granter("admin"), ORG_OWNER)).toBe(false);
    expect(canGrantRole(granter(ORG_OWNER), ORG_OWNER)).toBe(true);
    expect(canGrantRole(granter("admin", true), ORG_OWNER)).toBe(true);
  });

  it("lets any role manager hand out an ordinary org role", () => {
    expect(canGrantRole(granter("admin"), "editor")).toBe(true);
  });
});

describe("canGrantRole and roleGrantRefusal cannot disagree", () => {
  /**
   * The `assignable` flag on GET /api/roles and the refusal in
   * PUT /api/users/[id]/roles used to be two hand-written copies of the same
   * branch. Both now call canGrantRole, and this pins the property that made
   * the duplicate worth removing: the catalog never offers a grant the write
   * would turn down, for any actor, for any role.
   */
  const actors = [
    granter("admin"),
    granter(ORG_OWNER),
    granter("editor"),
    granter("admin", true),
    granter(null),
  ];
  const roles = [GLOBAL_SUPER_ADMIN, ORG_OWNER, "admin", "editor", "author"];

  it("agrees on every actor/role pair", () => {
    for (const actor of actors) {
      for (const role of roles) {
        const flagged = canGrantRole(actor, role);
        const change =
          role === GLOBAL_SUPER_ADMIN
            ? { role: null, superAdmin: true }
            : { role, superAdmin: null };
        // A member who currently holds none of the privileged roles, so the
        // only thing under test is the grant itself.
        const refusal = roleGrantRefusal(actor, change, {
          role: "author",
          superAdmin: false,
        });
        expect(refusal === null, `${actor.membershipRole} -> ${role}`).toBe(flagged);
      }
    }
  });
});
