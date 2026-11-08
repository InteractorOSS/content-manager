import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { flattenPermissions } from "@/lib/rbac";
import {
  GLOBAL_SUPER_ADMIN,
  changedAxes,
  parseRoleRequest,
  roleGrantRefusal,
  selfLockoutRefusal,
} from "@/lib/member-roles";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Change a member's role.
 *
 *   PUT { "role": "editor" }                    — their role in THIS org
 *   PUT { "super_admin": true }                 — the global grant
 *   PUT { "roles": ["editor"] }                 — legacy shape, still accepted
 *
 * This route used to delete and recreate `user_roles` rows, which — since
 * punchlist T3 moved authorization onto `Membership.role` — changed nothing at
 * all for every role except super_admin. A member's effective role was set
 * once by their invitation and could never be adjusted again. It now writes
 * the membership, which is the row `toActor()` actually reads.
 *
 * The global super_admin grant stays on `user_roles` and is authorized
 * separately (see roleGrantRefusal): one request may carry both axes, but each
 * is gated on its own.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { actor, error } = await requirePermission("users:manage_roles");
  if (error) return error;

  if (!actor.organizationId) {
    return NextResponse.json(
      { error: "Join or create an organization before managing its members." },
      { status: 400 }
    );
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send the role to apply as JSON." }, { status: 400 });
  }

  const parsed = parseRoleRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { change } = parsed;

  // Membership in the ACTOR's org is both the lookup and the authorization:
  // someone who is not a member here is not this admin's to re-role, and a
  // user id from another tenant must not resolve at all.
  const membership = await prisma.membership.findUnique({
    where: {
      organization_id_user_id: { organization_id: actor.organizationId, user_id: id },
    },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          roles: { include: { role: { select: { id: true, name: true, active: true } } } },
        },
      },
    },
  });
  if (!membership) {
    return NextResponse.json(
      {
        error:
          "That person isn't a member of this organization. Invite them from the Invitations tab first.",
      },
      { status: 404 }
    );
  }

  const current = {
    role: membership.role,
    superAdmin: membership.user.roles.some(
      (ur) => ur.role.active && ur.role.name === GLOBAL_SUPER_ADMIN
    ),
  };
  const changed = changedAxes(change, current);

  const nextRole = changed.role ? change.role! : current.role;
  const nextSuperAdmin = changed.superAdmin ? change.superAdmin! : current.superAdmin;

  if (changed.role) {
    const role = await prisma.role.findUnique({ where: { name: nextRole } });
    if (!role || !role.active) {
      return NextResponse.json(
        { error: `"${nextRole}" isn't a role you can assign. Pick one from the role list.` },
        { status: 400 }
      );
    }
  }

  // SECURITY: escalation gate BEFORE any write, and before the lockout check,
  // so a refused request persists nothing on either axis.
  const refusal = roleGrantRefusal(actor, change, current);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });

  if (id === actor.user.id && (changed.role || changed.superAdmin)) {
    // Ask the seeded permission matrix what the caller would still hold, rather
    // than pattern-matching role names: "admin" is not the only role carrying
    // users:manage_roles, and the matrix is free to change.
    const nextPermissions = await flattenPermissions([
      nextRole,
      ...(nextSuperAdmin ? [GLOBAL_SUPER_ADMIN] : []),
    ]);
    const lockout = selfLockoutRefusal(nextPermissions);
    if (lockout) return NextResponse.json({ error: lockout }, { status: 400 });
  }

  const writes = [];

  if (changed.role) {
    writes.push(
      prisma.membership.upsert({
        where: {
          organization_id_user_id: {
            organization_id: actor.organizationId,
            user_id: id,
          },
        },
        update: { role: nextRole },
        create: {
          organization_id: actor.organizationId,
          user_id: id,
          role: nextRole,
        },
      })
    );
  }

  if (changed.superAdmin) {
    const globalRole = await prisma.role.findUnique({
      where: { name: GLOBAL_SUPER_ADMIN },
    });
    if (!globalRole) {
      return NextResponse.json(
        { error: "Super administrator isn't configured on this install." },
        { status: 400 }
      );
    }
    writes.push(
      nextSuperAdmin
        ? prisma.userRole.upsert({
            where: { user_id_role_id: { user_id: id, role_id: globalRole.id } },
            update: {},
            create: { user_id: id, role_id: globalRole.id },
          })
        : prisma.userRole.deleteMany({
            where: { user_id: id, role_id: globalRole.id },
          })
    );
  }

  // Both axes land together or not at all — a request that grants super_admin
  // while demoting the org role must never half-apply.
  if (writes.length > 0) await prisma.$transaction(writes);

  return NextResponse.json({
    data: {
      id,
      organization_id: actor.organizationId,
      membership_role: nextRole,
      super_admin: nextSuperAdmin,
    },
  });
}
