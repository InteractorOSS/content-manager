import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { GLOBAL_SUPER_ADMIN, isGlobalSuperAdmin } from "@/lib/member-roles";

/**
 * The members of the acting admin's current organization.
 *
 * This used to be `prisma.user.findMany()` with no org filter at all, so any
 * org admin holding users:view read every identity in every tenant — a
 * cross-org leak, and on a surface whose whole job is showing people you can
 * act on. The list is now a join through Membership, which is also what makes
 * the roles column truthful: an entry's effective role is `Membership.role`
 * (what toActor() flattens permissions from), NOT the global user_roles rows,
 * which are inert for every role but super_admin.
 *
 * The two are reported on separate keys on purpose — `membership_role` is a
 * single value scoped to this org, `super_admin` is a global flag — because
 * merging them into one `roles` array is precisely what let the old editor
 * offer "super_admin" as if it were an org role.
 *
 * `?scope=all` keeps a cross-org listing available, but only to a global
 * super_admin; for anyone else it is a 403 rather than a silently narrowed
 * result, so nobody reads a partial list believing it is complete. It is the
 * SAME membership join with the org filter lifted, so every row still names a
 * role and the organization it holds it in — a person in three orgs is three
 * rows, because "who holds what where" is the only question this listing
 * answers. (It used to be a bare user.findMany() with role hardcoded to null,
 * which rendered every human in the install as "No role", owners included.)
 *
 * Note: Membership is deliberately NOT in ORG_SCOPED_MODELS
 * (src/lib/tenant-scope.ts) — a membership row is how a user reaches an org in
 * the first place, so the tenant client cannot scope it for us. The
 * organization_id filter below is therefore explicit and load-bearing.
 */
export async function GET(req: NextRequest) {
  const { actor, error } = await requirePermission("users:view");
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q");
  const status = searchParams.get("status");
  const crossOrg = searchParams.get("scope") === "all";

  if (crossOrg && !isGlobalSuperAdmin(actor)) {
    return NextResponse.json(
      {
        error:
          "Only a super administrator can list people outside this organization. Leave off scope=all to see this organization's members.",
      },
      { status: 403 }
    );
  }

  if (!crossOrg && !actor.organizationId) {
    return NextResponse.json({ data: [], meta: { organization_id: null, scope: "organization" } });
  }

  const userWhere = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { name: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  // Posts are org-scoped, so a members table for THIS org must count this
  // org's posts — a global count would credit a person for work in a tenant
  // the reader cannot see. The cross-org listing has no single org to count
  // against (each row is a different one), so there it is the global total,
  // which is the honest number for a reader who can see every tenant anyway.
  const userSelect = {
    id: true,
    email: true,
    name: true,
    status: true,
    avatar_url: true,
    last_login_at: true,
    inserted_at: true,
    roles: { include: { role: { select: { name: true, active: true } } } },
    _count: {
      select: {
        posts:
          crossOrg || !actor.organizationId
            ? true
            : { where: { organization_id: actor.organizationId } },
      },
    },
  };

  type MemberUser = {
    id: string;
    email: string;
    name: string | null;
    status: string;
    avatar_url: string | null;
    last_login_at: Date | null;
    inserted_at: Date;
    roles: Array<{ role: { name: string; active: boolean } }>;
    _count: { posts: number };
  };

  type MemberRow = {
    role: string;
    inserted_at: Date;
    organization: { id: string; name: string; slug: string };
    user: MemberUser;
  };

  // One query shape for both scopes — the only difference is whether the org
  // filter is applied. Roles are fetched alongside so a row can carry its own
  // display name instead of making every reader re-resolve it against
  // /api/roles (the members table used to need a second request just to render
  // "Editor" instead of "editor").
  const [rows, roleCatalog] = await Promise.all([
    prisma.membership.findMany({
      where: {
        ...(crossOrg ? {} : { organization_id: actor.organizationId! }),
        user: userWhere,
      },
      select: {
        role: true,
        inserted_at: true,
        organization: { select: { id: true, name: true, slug: true } },
        user: { select: userSelect },
      },
      orderBy: { inserted_at: "asc" },
    }) as Promise<MemberRow[]>,
    prisma.role.findMany({
      where: { active: true },
      select: { name: true, display_name: true },
    }),
  ]);

  const displayNames = new Map(roleCatalog.map((r) => [r.name, r.display_name]));

  return NextResponse.json({
    data: rows.map(({ role, inserted_at, organization, user }) => ({
      // A person in several orgs is several rows in the cross-org listing, so
      // the user id alone is not unique here — `membership_id` is.
      membership_id: `${organization.id}:${user.id}`,
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      avatar_url: user.avatar_url,
      /** Effective role in this organization — what permissions flatten from. */
      membership_role: role,
      /** Label for the role above, so a reader needs no second request. */
      membership_role_display_name: displayNames.get(role) ?? role,
      /** Which organization the role above is held in. */
      organization,
      /** Global, cross-org, and deliberately not folded into the role above. */
      super_admin: user.roles.some(
        (ur) => ur.role.active && ur.role.name === GLOBAL_SUPER_ADMIN
      ),
      post_count: user._count.posts,
      last_login_at: user.last_login_at?.toISOString() ?? null,
      joined_at: inserted_at.toISOString(),
      inserted_at: user.inserted_at.toISOString(),
    })),
    meta: {
      organization_id: crossOrg ? null : actor.organizationId,
      scope: crossOrg ? "all" : "organization",
    },
  });
}
