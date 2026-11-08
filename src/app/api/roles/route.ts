import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { canGrantRole, isOrganizationRole } from "@/lib/member-roles";

/**
 * The role catalog, annotated with what THIS caller may actually hand out.
 *
 * The catalog itself is global, so it always listed super_admin and owner to
 * every users:view holder. `assignable` lets the members and invite UIs stop
 * offering a grant the route would refuse anyway — the refusals in
 * `PUT /api/users/[id]/roles` and `POST /api/invitations` are the control; this
 * flag only spares people from discovering it the hard way. It asks
 * `canGrantRole()`, the same function those refusals ask, rather than restating
 * the branch here: a flag that can disagree with the write it advertises is
 * worse than no flag.
 *
 * `scope` says which of the two role systems a row belongs to: "global" for
 * super_admin (a cross-org user_roles grant) and "organization" for everything
 * else (a single-valued Membership.role).
 */
export async function GET() {
  const { actor, error } = await requirePermission("users:view");
  if (error) return error;

  const roles = await prisma.role.findMany({
    where: { active: true },
    include: {
      permissions: { include: { permission: { select: { name: true } } } },
      _count: { select: { users: true } },
    },
    orderBy: { priority: "asc" },
  });

  // Two surfaces hand a role out, behind different permissions: the members
  // editor (users:manage_roles) and the invite form (users:create). A caller
  // holding neither can assign nothing, whatever the grant rules say.
  const canAssignAtAll =
    actor.permissions.has("users:manage_roles") || actor.permissions.has("users:create");

  return NextResponse.json({
    data: roles.map((r) => ({
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      priority: r.priority,
      permissions: r.permissions.map((p) => p.permission.name).sort(),
      user_count: r._count.users,
      scope: isOrganizationRole(r.name) ? "organization" : "global",
      assignable: canAssignAtAll && canGrantRole(actor, r.name),
    })),
  });
}
