import { prisma } from "@/lib/db";
import { isOrganizationRole } from "@/lib/member-roles";
import { createOrganizationWithOwner } from "@/lib/organizations";
import type { TenantDb } from "@/lib/tenant-db";
// A bare `export type {...} from` re-export does NOT bind the name into this
// file's own scope — `hasPermission`'s signature below needs a real import,
// or it silently falls back to resolving the identically-named global DOM
// `PermissionName` type (Web Permissions API) instead of ours.
import type { PermissionName } from "@/lib/permissions";

export type { PermissionName };

export interface Actor {
  user: {
    id: string;
    email: string;
    name: string | null;
    /** The person's chosen byline name — see {@link authorDisplayName}. */
    display_name: string | null;
    status: string;
  };
  /** Currently-active organization (null only if the user has no membership). */
  organizationId: string | null;
  /** The user's role within {@link organizationId}, from their Membership. */
  membershipRole: string | null;
  /**
   * Every org this user belongs to, for the switcher (T5). Ordered by name so
   * the menu is stable across requests. A user with one membership gets a
   * single-entry list, not an empty one.
   */
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
  }>;
  /**
   * Effective role names: the membership role, plus "super_admin" when the
   * user still holds that GLOBAL (cross-org) UserRole.
   *
   * This is a MERGED convenience list for permission flattening and display.
   * Never test it for "is this a global super admin" — a Membership.role of
   * the literal string "super_admin" lands in here too, and would pass a check
   * meant for the user_roles grant. Read {@link isSuperAdmin} instead.
   */
  roles: string[];
  /**
   * The GLOBAL super_admin grant (a user_roles row), on its own key precisely
   * because {@link roles} cannot tell it apart from an org role of the same
   * name. Every privileged gate reads this.
   */
  isSuperAdmin: boolean;
  permissions: Set<string>;
}

// Permissions now flatten from the user's Membership.role for their CURRENT
// org (SMM-CONSOLIDATION-PUNCHLIST T3), not from user_roles. We still load
// user_roles — but only to detect the global super_admin flag, which is
// unioned in regardless of org.
const ACTOR_INCLUDE = {
  roles: { include: { role: true } },
  // The org record rides along so /api/me can render the switcher (name + slug)
  // without a second round trip — loadActor already pays for this user query.
  memberships: { include: { organization: true } },
} as const;

type UserWithRoles = NonNullable<
  Awaited<ReturnType<typeof findUserWithRoles>>
>;

function findUserWithRoles(id: string) {
  return prisma.user.findUnique({ where: { id }, include: ACTOR_INCLUDE });
}

/**
 * Flatten the granted permission names for a set of active role names.
 *
 * Exported because the members admin (`PUT /api/users/[id]/roles`) has to ask
 * the same question about a role the caller is about to be GIVEN — "would this
 * still hold users:manage_roles?" — and answering it from a hardcoded list of
 * role names is exactly how the old self-lockout guard drifted away from the
 * seeded permission matrix.
 */
export async function flattenPermissions(roleNames: string[]): Promise<Set<string>> {
  if (roleNames.length === 0) return new Set();
  const roles = await prisma.role.findMany({
    where: { name: { in: roleNames }, active: true },
    include: { permissions: { include: { permission: true } } },
  });
  return new Set(
    roles.flatMap((r) => r.permissions.map((rp) => rp.permission.name))
  );
}

/**
 * Resolve which org is currently active for this user: the caller's preferred
 * id (from the session / current_organization_id column) when it names a real
 * membership, else the user's sole/first membership. Null if they have none.
 */
function resolveOrganizationId(
  user: UserWithRoles,
  forcedOrgId?: string | null
): string | null {
  const memberships = user.memberships;
  if (memberships.length === 0) return null;

  // `forcedOrgId` is an AUTHORITATIVE override supplied by the credential —
  // today only a personal access token, which names exactly one org and may
  // act on no other. It deliberately beats the stored preference: the token's
  // tenant is a property of the token, not of whatever org its owner happens
  // to be looking at in a browser tab.
  //
  // Everything else resolves from the `current_organization_id` COLUMN, which
  // is what POST /api/organizations/switch writes. Note what is NOT consulted
  // here: session.user.currentOrganizationId. auth.ts's jwt callback stamps
  // that only at initial sign-in and never refreshes it, so it is a
  // sign-in-time snapshot — feeding it in as a preference made switching look
  // inert, because the snapshot outranked the row the switch had just updated.
  const preferred = forcedOrgId ?? user.current_organization_id;
  if (preferred && memberships.some((m) => m.organization_id === preferred)) {
    return preferred;
  }
  // Falling back to the first membership is right for a session (the stored
  // preference named an org the user has since left). For a forced org it is
  // NOT safe on its own — a token bound to an org its owner was removed from
  // would land on another tenant — so actorFromApiTokenValue asserts the
  // returned id equals the token's org and rejects the mismatch.
  return memberships[0].organization_id;
}

async function toActor(
  user: UserWithRoles,
  preferredOrgId?: string | null
): Promise<Actor> {
  const organizationId = resolveOrganizationId(user, preferredOrgId);
  const membershipRole =
    user.memberships.find((m) => m.organization_id === organizationId)?.role ??
    null;

  // super_admin stays a GLOBAL role: held via user_roles, effective in every
  // org, and its full permission set is unioned in on top of the org role.
  const isSuperAdmin = user.roles.some(
    (ur) => ur.role.active && ur.role.name === "super_admin"
  );

  const roles = [
    ...(membershipRole ? [membershipRole] : []),
    ...(isSuperAdmin ? ["super_admin"] : []),
  ].sort();

  const permissions = await flattenPermissions([...new Set(roles)]);

  const organizations = user.memberships
    .map((m) => ({
      id: m.organization_id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      display_name: user.display_name,
      status: user.status,
    },
    organizationId,
    membershipRole,
    organizations,
    roles,
    isSuperAdmin,
    permissions,
  };
}

/**
 * Create or link the local user row for an auth-server identity.
 * Called on sign-in; returns the local user id to store in the session.
 *
 * Both identifiers are typed optional on purpose: they arrive from an OIDC
 * claim set, which is not obliged to carry either, and the guards below are
 * the only thing standing between a blank claim and the cross-account link
 * described in the lookup comment.
 */
export async function provisionUser(input: {
  externalId?: string | null;
  email?: string | null;
  name?: string | null;
}): Promise<string> {
  const externalId = input.externalId?.trim();
  const email = input.email?.trim();

  // SECURITY. This guard was originally written against the belief that an
  // `undefined` filter key becomes an EMPTY `{}` OR branch that matches every
  // row. That is WRONG. Here is what @prisma/client 7.8.0 actually compiles,
  // measured in this repo by capturing SQL through a stub driver adapter (no
  // database required) and pinned by src/lib/prisma-or-undefined.test.ts:
  //
  //   OR: [{ external_id: "x" }, { email: undefined }]
  //     -> WHERE "users"."external_id" = $1          (undefined branch DROPPED)
  //   OR: [{ external_id: undefined }, { email: undefined }]
  //     -> WHERE 1=0                                 (matches nothing at all)
  //   OR: [{ external_id: "x" }, { email: "" }]
  //     -> WHERE "external_id" = $1 OR "email" = $2   with $2 = ''
  //
  // So `undefined` is merely a useless query, never a match-all. Do NOT delete
  // this guard on the strength of that — the real cross-account link is the
  // EMPTY STRING on the third line. `User.email` and `User.external_id` are
  // both unique columns that happily store `""`, so the moment one identity
  // with a blank claim gets past here we persist a row keyed on `""`; the
  // NEXT identity with the same blank claim then matches that row through the
  // OR and we hand person B person A's CMS account. `?.trim()` above turns
  // whitespace-only claims into exactly that empty string, which is why both
  // values must be non-empty — not merely defined — before we query or write.
  if (!email) {
    throw new Error(
      "provisionUser: sign-in identity carried no email address — refusing to look up a local user"
    );
  }
  if (!externalId) {
    throw new Error(
      "provisionUser: sign-in identity carried no external id — refusing to look up a local user"
    );
  }

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ external_id: externalId }, { email }],
    },
  });

  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        external_id: existing.external_id ?? externalId,
        name: input.name || existing.name,
        last_login_at: new Date(),
      },
    });
    await applyPendingInvitation(updated.id, updated.email);
    await ensureOwnOrganization(updated.id, updated.email, updated.name);
    return updated.id;
  }

  const created = await prisma.user.create({
    data: {
      email,
      name: input.name || null,
      external_id: externalId,
      last_login_at: new Date(),
    },
  });
  await applyPendingInvitation(created.id, created.email);
  await ensureOwnOrganization(created.id, created.email, created.name);
  return created.id;
}

/**
 * Self-serve signup (SMM-CONSOLIDATION-PUNCHLIST U1): give a user with no
 * membership an organization of their own, owned by them.
 *
 * Runs AFTER {@link applyPendingInvitation} on purpose, and only when the user
 * still has zero memberships. That ordering is what preserves invitation-only
 * joining of an EXISTING org: an invited user gets their Membership from the
 * invitation and is skipped here, so they join the inviting org rather than
 * landing in a private org of their own. Only someone nobody invited — the
 * self-serve case — reaches the create.
 *
 * The zero-membership test also rescues a user whose invitation expired before
 * they signed in: previously they got a session with no org, no permissions and
 * no way forward.
 */
async function ensureOwnOrganization(
  userId: string,
  email: string,
  name: string | null
) {
  const existing = await prisma.membership.count({ where: { user_id: userId } });
  if (existing > 0) return;

  const label = name?.trim() || email.split("@")[0] || "My";
  await createOrganizationWithOwner(userId, `${label}'s Organization`);
}

/**
 * If a pending, unexpired invitation exists for this email, grant its role
 * and mark it accepted. This is how invited teammates get their initial
 * role on first sign-in (accounts themselves live on the auth server).
 *
 * Invitations are org-scoped (T3): applying one creates/ensures the user's
 * Membership in the invitation's organization with the invited role — that
 * Membership is now what permissions flatten from.
 *
 * SECURITY: it deliberately writes NO user_roles row. It used to upsert a
 * global grant for the invited role as well, justified only by the old
 * users-admin table rendering role names off user_roles — which it no longer
 * does (GET /api/users reads Membership.role). That upsert was a live
 * escalation path: an invitation naming "super_admin" minted the real,
 * cross-org grant at first sign-in, one tab over from the PUT that refuses it.
 * POST /api/invitations now refuses such a role up front, and this write is
 * gone so no future caller can reopen the hole from the other end. The global
 * grant has exactly one writer: PUT /api/users/[id]/roles, super_admin only.
 */
async function applyPendingInvitation(userId: string, email: string) {
  const invitation = await prisma.invitation.findFirst({
    where: { email, status: "pending", expires_at: { gt: new Date() } },
    orderBy: { inserted_at: "desc" },
  });
  if (!invitation) return;

  // A row that predates the POST /api/invitations gate can still name the
  // global role. Applying it would write a Membership.role of "super_admin",
  // which flattens to every permission inside that org while looking, to every
  // gate and every reader, like the cross-org grant it is not. Leave such an
  // invitation pending and grant nothing: the person signs in with an org of
  // their own (ensureOwnOrganization) and an admin can re-issue a real
  // organization role, rather than the CMS quietly picking one for them.
  if (!isOrganizationRole(invitation.role_name)) return;

  await prisma.$transaction([
    ...(invitation.organization_id
      ? [
          prisma.membership.upsert({
            where: {
              organization_id_user_id: {
                organization_id: invitation.organization_id,
                user_id: userId,
              },
            },
            update: { role: invitation.role_name },
            create: {
              organization_id: invitation.organization_id,
              user_id: userId,
              role: invitation.role_name,
            },
          }),
        ]
      : []),
    prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", accepted_at: new Date() },
    }),
  ]);
}

/**
 * Load the actor (user + roles + flattened permissions) for a session user.
 * Falls back to email/external-id lookup for sessions issued before the
 * local users table existed, provisioning a row if needed.
 */
export async function loadActor(
  sessionUser: {
    id?: string;
    email?: string | null;
    name?: string | null;
  },
  /**
   * Credential-supplied org that MUST be used, overriding the user's stored
   * preference — today only a PAT's bound organization. Omit it for a browser
   * session, which resolves from `User.current_organization_id` so the org
   * switcher takes effect on the very next request.
   */
  options?: { forceOrganizationId?: string | null }
): Promise<Actor | null> {
  let user = sessionUser.id ? await findUserWithRoles(sessionUser.id) : null;

  if (!user && sessionUser.email) {
    const fallback = await prisma.user.findFirst({
      where: {
        OR: [
          ...(sessionUser.id ? [{ external_id: sessionUser.id }] : []),
          { email: sessionUser.email },
        ],
      },
      select: { id: true },
    });
    const id =
      fallback?.id ??
      (sessionUser.id
        ? await provisionUser({
            externalId: sessionUser.id,
            email: sessionUser.email,
            name: sessionUser.name,
          })
        : null);
    if (id) user = await findUserWithRoles(id);
  }

  if (!user || user.status !== "active") return null;
  return toActor(user, options?.forceOrganizationId);
}

/**
 * The user's currently-active organization id, for stamping into the session
 * token at sign-in so {@link loadActor} resolves the org without an extra
 * query. Prefers current_organization_id when it names a real membership,
 * else the sole/first membership. Null if the user has no membership.
 */
export async function getCurrentOrganizationId(
  userId: string
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      current_organization_id: true,
      memberships: {
        select: { organization_id: true },
        orderBy: { inserted_at: "asc" },
      },
    },
  });
  if (!user || user.memberships.length === 0) return null;
  const preferred = user.current_organization_id;
  if (preferred && user.memberships.some((m) => m.organization_id === preferred)) {
    return preferred;
  }
  return user.memberships[0].organization_id;
}

export function hasPermission(actor: Actor, permission: PermissionName): boolean {
  return actor.permissions.has(permission);
}

/**
 * Whether `userId` is a member of `organizationId`. User is deliberately not
 * an org-scoped model (one person can belong to several organizations), so
 * requirePermission()'s tenant-scoped `db` can't filter a `prisma.user.*`
 * call by org for us — /api/users/[id] and its roles sub-route used to skip
 * this check entirely, letting anyone with users:edit/users:delete/
 * users:manage_roles in their OWN org (trivially true for the owner of even
 * a brand-new self-serve org) read, edit, delete, or reassign the roles of
 * ANY user account on the platform by id, across every tenant.
 */
export async function isOrgMember(
  organizationId: string | null,
  userId: string
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findUnique({
    where: { organization_id_user_id: { organization_id: organizationId, user_id: userId } },
    select: { user_id: true },
  });
  return !!membership;
}

/** Edit is allowed on any post with content:edit_any, or on own posts with content:edit. */
export function canEditPost(
  actor: Actor,
  post: { author_id: string | null }
): boolean {
  if (actor.permissions.has("content:edit_any")) return true;
  return (
    actor.permissions.has("content:edit") && post.author_id === actor.user.id
  );
}

/**
 * The name a byline shows for a person — the ONE place that decides it, so
 * every write path (CMS create, file sync, AI generate, crediting another
 * member) produces the same string.
 *
 * `display_name` wins because it is the only one the person chose: `name` is
 * rewritten from the SSO profile on every sign-in, and when that profile
 * carries no real name it is the preferred_username or the email local-part
 * (how a post came to be bylined "jsmith"). The email is the last resort so a
 * byline is never blank.
 */
export function authorDisplayName(user: {
  display_name?: string | null;
  name?: string | null;
  email: string;
}): string {
  return user.display_name?.trim() || user.name?.trim() || user.email;
}

/**
 * Human-readable refusal for canEditPost()'s own-posts-only case — names the
 * actual author and the permission that would lift the block, rather than the
 * dead-end "You can only edit your own posts" a caller (especially an LLM
 * over MCP, which has no other way to learn the rule) cannot act on.
 */
export function editPostRefusalMessage(post: { author_name: string | null }): string {
  const author = post.author_name?.trim() || "another user";
  return `You can only edit your own posts. This post is authored by ${author}; ask someone with content:edit_any to make this change.`;
}

/**
 * Reassigning a post's authorship (author_id, or an author_name that diverges
 * from the post's current one) is a content:edit_any action — the same bar as
 * editing someone else's post outright. Reusing edit_any (rather than adding
 * a narrower content:set_author) keeps the permission matrix flat: nothing in
 * this app's role set has ever needed "can rewrite bylines" without also
 * having "can edit anyone's post."
 */
export function canSetAuthor(actor: Actor): boolean {
  return hasPermission(actor, "content:edit_any");
}

/**
 * Resolve an explicit author override to a real, active member of the
 * actor's organization. author_id must name a live Membership — never a
 * free-text id — so the returned name/email always come from the User row
 * itself, never from client-supplied text. A deactivated user keeps their
 * Membership row (see loadActor's own `status !== "active"` gate) but is
 * refused here too — crediting a post to an account that can no longer sign
 * in leaves nobody able to answer for it.
 */
export async function resolveOrgAuthor(
  db: Pick<TenantDb, "membership">,
  authorId: string,
  organizationId: string | null
): Promise<{ id: string; name: string | null; display_name: string | null; email: string } | null> {
  if (!organizationId) return null;
  const membership = await db.membership.findUnique({
    where: { organization_id_user_id: { organization_id: organizationId, user_id: authorId } },
    select: { user: { select: { id: true, name: true, display_name: true, email: true, status: true } } },
  });
  if (!membership || membership.user.status !== "active") return null;
  const { id, name, display_name, email } = membership.user;
  return { id, name, display_name, email };
}

// authorName is always defined (it's the resolved-or-unchanged value either
// way) — authorNameTouched, NOT `authorName !== undefined`, is what a caller
// must check before writing it. Only authorId signals "changed" via its own
// presence, since it's genuinely absent when untouched.
export type AuthorOverrideOutcome =
  | { ok: true; authorId?: string; authorNameTouched: boolean; authorName: string | null }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Resolve an author_id/author_name override from a create/update payload
 * against the post's current authorship (`null`/the actor's own identity,
 * on create — see the two route call sites). Shared by POST and PUT
 * /api/cms/posts so the rules live in one place — a prior version
 * duplicated this per-route and one path missed a fix the other got. Rules
 * that hold regardless of route:
 *
 *   - A no-op is never gated: `author_id` or `author_name` equal to the
 *     current value needs no permission — a read-modify-write client that
 *     round-trips these fields (the post editor's Author input always
 *     submits author_name; a GET→PUT client may echo back author_id)
 *     must not be refused for a value it never meant to change. Blank/
 *     whitespace `author_id` is treated the same as absent (there's no
 *     "clear the author_id" concept — a post always has one).
 *   - `null` and `undefined` both mean "absent" (`!= null` catches both) —
 *     a client that represents "no value" as JSON `null` must not have
 *     `String(null)` coerced into the literal author id/name `"null"`.
 *   - `author_id`, when it actually changes, is the sole source of
 *     `author_name` — an `author_name` sent in the same payload is
 *     ignored rather than letting free text diverge from the resolved
 *     identity. When `author_id` is present but UNCHANGED (a round-tripped
 *     no-op), an `author_name` in the same payload is still considered —
 *     it must not be silently dropped just because author_id was also
 *     present.
 *   - Blank `author_name` is a real value (clearing the byline to null),
 *     not automatically a no-op — it's a no-op only when it doesn't
 *     actually change anything, same as any other value. On create,
 *     `current.author_name` should be passed as `null` (nothing to clear
 *     yet), which is what makes the post editor's always-blank create-form
 *     submission a no-op without a special case. `alsoUnchangedIfNamed`
 *     covers the other create-time no-op: a caller who (redundantly) names
 *     themselves their own real default isn't attempting an override either
 *     — pass the actor's own default display name there (compared
 *     case-insensitively) so that doesn't require content:edit_any. PUT
 *     has no equivalent case (its `current.author_name` is already the
 *     real value being compared against) and should leave it unset.
 */
export async function resolveAuthorOverride(
  db: Pick<TenantDb, "membership">,
  actor: Actor,
  data: Record<string, unknown>,
  current: { author_id: string | null; author_name: string | null },
  alsoUnchangedIfNamed?: string
): Promise<AuthorOverrideOutcome> {
  const requestedAuthorId = data.author_id != null ? String(data.author_id).trim() : "";
  if (requestedAuthorId && requestedAuthorId !== current.author_id) {
    if (!canSetAuthor(actor)) {
      return { ok: false, status: 403, error: "Crediting a post to another user requires content:edit_any" };
    }
    const author = await resolveOrgAuthor(db, requestedAuthorId, actor.organizationId);
    if (!author) {
      return { ok: false, status: 400, error: "author_id must be a member of your organization" };
    }
    return {
      ok: true,
      authorId: author.id,
      authorNameTouched: true,
      authorName: authorDisplayName(author),
    };
  }

  if (data.author_name != null) {
    const nextAuthorName = String(data.author_name).trim() || null;
    const matchesSelf =
      nextAuthorName !== null &&
      alsoUnchangedIfNamed !== undefined &&
      nextAuthorName.toLowerCase() === alsoUnchangedIfNamed.toLowerCase();
    if (nextAuthorName !== current.author_name && !matchesSelf) {
      if (!canSetAuthor(actor)) {
        return { ok: false, status: 403, error: "Setting a post's author name requires content:edit_any" };
      }
      return { ok: true, authorNameTouched: true, authorName: nextAuthorName };
    }
  }

  return { ok: true, authorNameTouched: false, authorName: current.author_name };
}
