/**
 * Policy for the members admin (`/members`): who may change whose role, and what
 * a role-change request even means now that authorization lives on
 * `Membership.role`.
 *
 * Two role systems coexist in this app and the admin surface used to conflate
 * them into one checkbox list:
 *
 *   - `Membership.role` — SINGLE-valued, per organization, and the thing
 *     `toActor()` flattens permissions from. This is the effective role.
 *   - the global `super_admin` UserRole — cross-org, unioned on top of the
 *     membership role, and the ONLY user_roles row that still does anything.
 *
 * Keeping them apart is the point: a list that mixes "editor" and
 * "super_admin" cannot express "one role here, plus a global flag", which is
 * how a request naming two organization roles used to persist one and silently
 * drop the other.
 *
 * Pure and dependency-free (no Prisma, no NextResponse) so the rules can be
 * unit-tested directly and so the route reads as a list of refusals rather
 * than as the policy itself.
 */

import type { Actor } from "@/lib/rbac";

/** The one role that is global (cross-org) rather than per-organization. */
export const GLOBAL_SUPER_ADMIN = "super_admin";

/** The per-org role that may grant/revoke the other per-org roles' top seat. */
export const ORG_OWNER = "owner";

/**
 * True when the actor holds the GLOBAL super_admin UserRole, in any org.
 *
 * Reads `actor.isSuperAdmin`, NOT `actor.roles`. toActor() builds that array as
 * [membershipRole, ...(global grant ? ["super_admin"] : [])], so a member whose
 * Membership.role is the literal string "super_admin" is indistinguishable in
 * it from someone holding the real cross-org grant — and would walk through
 * every gate below. Unpicking that conflation is the whole point here, so this
 * gate must not re-introduce it.
 */
export function isGlobalSuperAdmin(actor: Pick<Actor, "isSuperAdmin">): boolean {
  return actor.isSuperAdmin;
}

/** Every role name except the global one can be held through a Membership. */
export function isOrganizationRole(name: string): boolean {
  return name !== GLOBAL_SUPER_ADMIN;
}

/** What an actor needs to be judged against the grant rules. */
export type Granter = Pick<Actor, "isSuperAdmin" | "membershipRole">;

/**
 * THE grant rule: may this actor hand out this role name at all?
 *
 * Single source of truth for every surface that offers or accepts a role —
 * `roleGrantRefusal()` (PUT /api/users/[id]/roles), the `assignable` flag on
 * GET /api/roles, and POST /api/invitations, which writes a Membership.role by
 * a slower route. Each of those had, or would have grown, its own copy of the
 * branch; a policy that disagrees with itself between the picker, the invite
 * and the write is how "inert today, live tomorrow" escalations happen.
 */
export function canGrantRole(actor: Granter, roleName: string): boolean {
  if (roleName === GLOBAL_SUPER_ADMIN) return isGlobalSuperAdmin(actor);
  if (isGlobalSuperAdmin(actor)) return true;
  if (roleName === ORG_OWNER) return actor.membershipRole === ORG_OWNER;
  return true;
}

/**
 * Plain-language refusal for a role {@link canGrantRole} turned down — the
 * same sentence whether the caller reached it through the members editor or
 * the invite form, so the rule reads the same wherever you meet it.
 */
export function roleGrantDenial(roleName: string): string {
  return roleName === GLOBAL_SUPER_ADMIN
    ? "Only a super administrator can make someone a super administrator. Ask one to make this change."
    : "Only the organization's owner can make someone an owner. Ask your owner to make this change.";
}

/**
 * A requested change, already split along the two axes above. `null` on either
 * axis means "leave this one alone" — a caller that only flips super_admin
 * must not have to restate the member's org role, and vice versa.
 */
export type RoleChange = {
  role: string | null;
  superAdmin: boolean | null;
};

export type ParsedRoleRequest =
  | { ok: true; change: RoleChange }
  | { ok: false; error: string };

function quote(names: string[]): string {
  return names.map((n) => `"${n}"`).join(" and ");
}

/**
 * Read a role-change request in either shape:
 *
 *   { role: "editor", super_admin: false }   — canonical; omit a key to leave
 *                                              that axis unchanged.
 *   { roles: ["editor", "super_admin"] }     — the legacy replace-the-set
 *                                              shape the old route took. It is
 *                                              read as a full replacement, so
 *                                              a list WITHOUT "super_admin"
 *                                              means revoke it.
 *
 * The legacy shape is kept because it is what shipped and what a REST caller
 * may still send; it is translated here rather than at the write, so there is
 * exactly one set of rules downstream.
 */
export function parseRoleRequest(body: unknown): ParsedRoleRequest {
  const b = (body ?? {}) as Record<string, unknown>;

  if (Array.isArray(b.roles)) {
    if (b.roles.some((n) => typeof n !== "string")) {
      return { ok: false, error: "Each role must be given by name." };
    }
    const names = [
      ...new Set((b.roles as string[]).map((n) => n.trim()).filter(Boolean)),
    ];
    const orgRoles = names.filter(isOrganizationRole);
    if (orgRoles.length > 1) {
      return {
        ok: false,
        error: `A member has one role in this organization, so ${quote(
          orgRoles
        )} cannot both apply. Choose the single role this person should have.`,
      };
    }
    const superAdmin = names.includes(GLOBAL_SUPER_ADMIN);
    if (orgRoles.length === 0 && !superAdmin) {
      return {
        ok: false,
        error:
          "Choose the role this person should have in this organization. To remove their access instead, remove them from the organization.",
      };
    }
    return { ok: true, change: { role: orgRoles[0] ?? null, superAdmin } };
  }

  if (b.role !== undefined || b.super_admin !== undefined) {
    let role: string | null = null;
    if (b.role !== undefined && b.role !== null) {
      if (typeof b.role !== "string" || !b.role.trim()) {
        return { ok: false, error: "Choose the role this person should have in this organization." };
      }
      role = b.role.trim();
      if (!isOrganizationRole(role)) {
        return {
          ok: false,
          error:
            "Super administrator is a global role rather than an organization role. Send it as super_admin: true alongside the organization role.",
        };
      }
    }

    let superAdmin: boolean | null = null;
    if (b.super_admin !== undefined && b.super_admin !== null) {
      if (typeof b.super_admin !== "boolean") {
        return { ok: false, error: "super_admin must be either true or false." };
      }
      superAdmin = b.super_admin;
    }

    return { ok: true, change: { role, superAdmin } };
  }

  return {
    ok: false,
    error: 'Say which role to apply, for example {"role": "editor"}.',
  };
}

/** The member's state before the change, for comparison. */
export type CurrentMemberRoles = { role: string; superAdmin: boolean };

/** Which axes this request actually moves — a no-op is never gated. */
export function changedAxes(change: RoleChange, current: CurrentMemberRoles) {
  return {
    role: change.role !== null && change.role !== current.role,
    superAdmin: change.superAdmin !== null && change.superAdmin !== current.superAdmin,
  };
}

/**
 * SECURITY (the escalation gate). `GET /api/roles` hands the whole catalog to
 * anyone with users:view, so "super_admin" and "owner" are offered to every
 * org admin. That was harmless only while the writes were inert. Now that they
 * take effect, the two privileged grants are refused here — in the route, not
 * in the dialog — so hiding the option in the UI is a courtesy rather than the
 * control.
 *
 * Returns a plain-language refusal, or null when the change is allowed.
 */
export function roleGrantRefusal(
  actor: Granter,
  change: RoleChange,
  current: CurrentMemberRoles
): string | null {
  const changed = changedAxes(change, current);

  if (changed.superAdmin && !canGrantRole(actor, GLOBAL_SUPER_ADMIN)) {
    return change.superAdmin
      ? roleGrantDenial(GLOBAL_SUPER_ADMIN)
      : "Only a super administrator can remove super administrator access. Ask one to make this change.";
  }

  if (!changed.role) return null;
  if (!canGrantRole(actor, change.role!)) return roleGrantDenial(change.role!);

  // Demoting the sitting owner is the same privilege in reverse — an admin who
  // could do it would simply take the org over. This one is about the member's
  // CURRENT role rather than the requested one, so canGrantRole (which judges a
  // role name in isolation) cannot express it and it stays here.
  if (current.role === ORG_OWNER && !canGrantRole(actor, ORG_OWNER)) {
    return "Only the organization's owner can change the owner's role. Ask your owner to make this change.";
  }
  return null;
}

/**
 * Self-lockout guard. The old one inspected the incoming user_roles array for
 * the literal names "super_admin"/"admin", which stopped matching reality
 * twice over: the array is not what authorizes anything any more, and the set
 * of roles carrying users:manage_roles is defined by the seeded permission
 * matrix (owner has it too), not by that hardcoded pair.
 *
 * So the caller passes the permissions they would ACTUALLY still hold after
 * the write — flattened from the membership role being written, plus
 * super_admin if they keep it — and this just asks whether role management
 * survives.
 */
export function selfLockoutRefusal(nextPermissions: Set<string>): string | null {
  if (nextPermissions.has("users:manage_roles")) return null;
  return "This would leave you unable to manage roles, so you could not undo it. Ask another administrator or your organization's owner to change your own role.";
}
