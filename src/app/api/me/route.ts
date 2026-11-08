import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";

// Current actor: local user, roles, and flattened permissions.
// The UI uses this to gate actions (publish buttons, admin nav, etc.).
//
// Dual-auth on purpose (browser session OR `Authorization: Bearer cms_pat_…`):
// this is the only endpoint that tells a caller what it is allowed to do, and
// non-browser callers are exactly the ones that cannot otherwise find out. An
// ApiToken row carries no permission scopes — an owner, an organization, a
// hash and an expiry — so a token's permissions are its owner's live
// permissions IN THE ORG IT IS BOUND TO, resolved per request. Read back over
// a PAT, this endpoint distinguishes the explanations for a 403 that otherwise
// look identical from outside: the owner's role in that org genuinely lacks
// the permission, versus the caller holding a token for a different account —
// or, now that tokens name a tenant, for a different organization entirely.
// ("The token was minted without that permission" is not a state that can
// exist, and guessing at it sends people off to re-mint tokens for nothing.)
//
// The permissions that matter flatten from the owner's Membership role in the
// ACTIVE organization — plus the global super_admin UserRole if held — so the
// org is reported by name, not just id: someone who belongs to an employer, a
// personal blog and a family project needs to see which of the three a token
// is speaking for. `organizations` lists the rest, which is also what the
// token-minting UI offers as targets. `roles` is a MERGED display list (the
// membership role plus "super_admin" when the global grant is held) and cannot
// tell the two apart — `is_super_admin` is the global grant on its own key, and
// is what UI gating on it must read.
export async function GET(req: NextRequest) {
  const { actor, via, apiToken, error } = await requirePermissionApi(req);
  if (error) return error;

  const memberships = await prisma.membership.findMany({
    where: { user_id: actor.user.id },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { inserted_at: "asc" },
  });
  const active = memberships.find(
    (m) => m.organization.id === actor.organizationId
  );

  return NextResponse.json({
    data: {
      user: actor.user,
      // organization_id / membership_role predate the switcher and are kept
      // exactly as they were — existing UI gating reads them.
      organization_id: actor.organizationId,
      organization: active?.organization ?? null,
      membership_role: actor.membershipRole,
      roles: actor.roles,
      // The GLOBAL grant, on its own key. `roles` is a merged list and cannot
      // tell it apart from a Membership.role that happens to read
      // "super_admin", so UI that gates on the global grant reads this.
      is_super_admin: actor.isSuperAdmin,
      permissions: [...actor.permissions].sort(),
      // Every org this user belongs to. The active one is whichever the
      // credential selected — for a token, the org it is bound to.
      organizations: memberships.map((m) => ({
        ...m.organization,
        role: m.role,
        active: m.organization.id === actor.organizationId,
      })),
      // Truthful about which credential answered: a malformed, revoked, or
      // no-longer-a-member bearer falls back to the session, so "I sent a
      // token" is not the same as "the token is what you are looking at".
      auth_method: via,
      // Which token, so a caller juggling one per organization can tell them
      // apart without the secret. Absent on the session path.
      //
      // A connection made by signing Claude in (OAuth) is reported by its
      // real lifetime: its access token expires about hourly by design and
      // the client refreshes it unprompted, so that timestamp is not "when
      // this stops working". Surfacing it as expires_at had Claude tell a
      // writer to reconnect within minutes.
      token: apiToken
        ? {
            id: apiToken.id,
            name: apiToken.name,
            token_prefix: apiToken.token_prefix,
            kind: apiToken.oauth ? "connection" : "personal_access_token",
            expires_at: (apiToken.oauth ? apiToken.refresh_expires_at : apiToken.expires_at)?.toISOString() ?? null,
            ...(apiToken.oauth && {
              refreshes_automatically: true,
              note: "A Claude sign-in connection: it renews itself and stays valid until expires_at (extended with each use) unless disconnected under API Tokens. No action is needed; never ask the user to reconnect because of time.",
            }),
            site_scopes: apiToken.site_scopes,
            // A workspace connection reaches every organization of its
            // accounts; this request acted in the one `workspace` named.
            all_organizations: apiToken.all_organizations,
            workspace: apiToken.workspace,
          }
        : null,
    },
  });
}
