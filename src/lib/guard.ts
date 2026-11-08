import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashToken, looksLikeApiToken } from "@/lib/api-tokens";
import { loadActor, type Actor, type PermissionName } from "@/lib/rbac";
import { tenantDb, type TenantDb } from "@/lib/tenant-db";
import { WORKSPACE_HEADER, parseWorkspace, resolveWorkspace } from "@/lib/workspaces";

/**
 * Which credential actually answered — a browser session cookie or a personal
 * access token. Only /api/me reports it (so a token holder can tell whether
 * they are reading their own token's permissions or a session's), but it is
 * resolved here because only the guard knows: requirePermissionApi falls back
 * to the session when a bearer is absent OR unusable, so the presence of an
 * Authorization header proves nothing on its own.
 */
export type AuthVia = "session" | "token";

type GuardResult =
  | {
      actor: Actor;
      db: TenantDb;
      via: AuthVia;
      /** The token that authenticated, when `via` is "token". */
      apiToken?: ApiTokenIdentity;
      error?: never;
    }
  | { actor?: never; db?: never; via?: never; apiToken?: never; error: NextResponse };

/**
 * Route-handler guard: resolves the session to a local actor, checks that it
 * holds every listed permission, and hands back a Prisma client already scoped
 * to the actor's current organization.
 *
 *   const { actor, db, error } = await requirePermission("content:create");
 *   if (error) return error;
 *   const posts = await db.post.findMany(); // auto-scoped to actor's org
 *
 * `db` is a {@link TenantDb} (see src/lib/tenant-db.ts) that injects
 * `organization_id` on writes and filters it on reads for the org-scoped
 * models, so a handler can't leak across tenants by forgetting a `where`.
 * Existing call sites that only read `{ actor, error }` keep compiling — `db`
 * is additive. Reach for the raw `prisma`/`db` export only in explicitly-global
 * code: auth/provisioning, the seed, the public API, the cross-org scheduler,
 * and super_admin surfaces.
 */
export async function requirePermission(
  ...permissions: PermissionName[]
): Promise<GuardResult> {
  const session = await auth();
  if (!session?.user || session.error) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const actor = await loadActor(session.user);
  if (!actor) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length > 0) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", missing_permissions: missing },
        { status: 403 }
      ),
    };
  }

  return { actor, db: tenantDb(actor.organizationId), via: "session" };
}

/** The identifying half of a token — safe to echo back; never the secret. */
export type ApiTokenIdentity = {
  id: string;
  name: string;
  token_prefix: string;
  /** The organization this request acts in: the token's own, or for a
   *  workspace connection the one the request named. */
  organization_id: string;
  /** A workspace connection (reaches every organization of its accounts). */
  all_organizations: boolean;
  /** The workspace this request named, if any. */
  workspace: string | null;
  /** Site slugs this token is scoped to, or empty for all sites in the org. */
  site_scopes: string[];
  expires_at: Date | null;
  /**
   * True for a connection made through the OAuth connector (Claude signing
   * in). Its `expires_at` is the short-lived ACCESS token's, which the client
   * refreshes by itself about hourly; `refresh_expires_at` is when the
   * connection itself lapses if unused. Reporting the former as "when this
   * expires" had Claude warn writers their connection was about to die.
   */
  oauth: boolean;
  refresh_expires_at: Date | null;
};

export type TokenAuth = { actor: Actor; token: ApiTokenIdentity };

/** A live token whose request named a workspace it can't act in. */
export type WorkspaceRefusal = { refused: string };

/**
 * Session guard with NO permission check — resolves the signed-in user to an
 * actor, or 401s.
 *
 * Exists for the organization routes (T5/U1), which cannot use
 * {@link requirePermission}: permissions flatten from the actor's Membership in
 * their CURRENT org, so a user with no membership yet — exactly the self-serve
 * signup case — holds no permissions at all and would be 403'd out of creating
 * their first org. Membership in the *target* org is what authorizes those
 * routes, and each one checks it against `actor.organizations` itself.
 *
 * Deliberately returns no tenant-scoped `db`: an org-scoped client is
 * meaningless before the caller has an org, and the org table is not itself
 * org-scoped. Callers use the raw client via src/lib/organizations.ts.
 */
export async function requireActor(): Promise<
  { actor: Actor; error?: never } | { actor?: never; error: NextResponse }
> {
  const session = await auth();
  if (!session?.user || session.error) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const actor = await loadActor(session.user);
  if (!actor) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { actor };
}

/**
 * Resolve a personal access token from the Authorization header to its
 * owning actor — non-browser auth for desktop/CLI file sync (see
 * FILE-BASED-CONTENT-PLAN.md Phase 1). Returns null if there's no bearer
 * token, it doesn't look like one of ours, or it doesn't match a live
 * (unrevoked, unexpired) token.
 */
async function actorFromApiToken(req: NextRequest): Promise<TokenAuth | WorkspaceRefusal | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return actorFromApiTokenValue(header.slice("Bearer ".length).trim(), req.headers.get(WORKSPACE_HEADER));
}

async function liveToken(raw: string) {
  if (!looksLikeApiToken(raw)) return null;
  const token = await prisma.apiToken.findUnique({ where: { token_hash: hashToken(raw) } });
  if (!token || token.revoked_at || (token.expires_at && token.expires_at < new Date())) return null;
  return token;
}

/** The live token row behind a request's bearer, if any (no org resolution). */
export async function apiTokenRowFromRequest(req: NextRequest) {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return liveToken(header.slice("Bearer ".length).trim());
}

/**
 * Is this a live token, and whose? For the MCP endpoint, which only needs to
 * know the caller is authenticated before handing the request to a tool; each
 * tool then resolves the organization through the route it delegates to.
 */
export async function verifyApiTokenValue(raw: string): Promise<{ tokenId: string; userId: string } | null> {
  const token = await liveToken(raw);
  if (!token || (!token.organization_id && !token.all_organizations)) return null;
  return { tokenId: token.id, userId: token.user_id };
}

/**
 * Resolve a raw `cms_pat_...` token value to its owning actor and the token's
 * own identity — the shared core of PAT auth, also used by the MCP endpoint's
 * per-request verification (`/api/mcp`), which holds the bare token rather
 * than a NextRequest. Returns null for anything that isn't a live token.
 *
 * TENANCY. A token names one organization and may only ever act on that one.
 * The owner can belong to several — an employer, a personal blog, a family
 * project — and a bearer token carries no session to say which is meant, so
 * the org is read from the token row rather than inferred from the user. Two
 * refusals enforce it, and both return null (an unauthenticated 401) rather
 * than quietly picking another org:
 *
 *   1. An unbound token (organization_id NULL — only possible for a row the
 *      binding migration could not backfill, i.e. an owner with no membership
 *      at all) is dead, not a wildcard.
 *   2. A token whose owner is no longer a member of the bound org is dead too.
 *      loadActor() falls back to another membership when the preferred org
 *      isn't one — helpful for a browser session, catastrophic here, since it
 *      would silently move a revoked-from-Acme token onto the owner's personal
 *      org. The equality check below is what stops that fallback.
 *
 * Permissions therefore flatten from the owner's membership role IN THE BOUND
 * ORG: the same person can be an admin through one token and an author
 * through another, which is the point.
 */
export async function actorFromApiTokenValue(
  raw: string,
  workspace: string | null = null
): Promise<TokenAuth | WorkspaceRefusal | null> {
  const token = await liveToken(raw);
  if (!token) return null;

  const identity = (organizationId: string, siteScopes: string[]): ApiTokenIdentity => ({
    id: token.id,
    name: token.name,
    token_prefix: token.token_prefix,
    organization_id: organizationId,
    all_organizations: token.all_organizations,
    workspace: workspace?.trim() || null,
    site_scopes: siteScopes,
    expires_at: token.expires_at,
    oauth: token.oauth_client_id != null,
    refresh_expires_at: token.refresh_expires_at ?? null,
  });

  // A workspace connection (src/lib/workspaces.ts): the request names the
  // account and organization it acts in. Each is checked against the
  // connection's own accounts and their live memberships; nothing is guessed.
  if (token.all_organizations) {
    const resolved = await resolveWorkspace(token, workspace?.trim() || null);
    if (resolved.kind === "refused") return { refused: resolved.message };
    const scopes = narrowScopes(token.site_scopes || [], resolved.site);
    if (!scopes) return { refused: `This connection is limited to ${token.site_scopes.join(", ")}, not "${resolved.site}".` };
    touch(token.id);
    return { actor: resolved.actor, token: identity(resolved.organizationId, scopes) };
  }

  if (!token.organization_id) return null;
  const bound = token.organization_id;

  const actor = await loadActor(
    { id: token.user_id },
    // Authoritative, not a preference: the token's org must win over the
    // owner's current_organization_id, which is only a browser-session choice.
    { forceOrganizationId: token.organization_id }
  );
  if (!actor) return null;
  if (actor.organizationId !== bound) return null;

  // A one-organization token still honours a workspace that names its own
  // organization (narrowing to the site), and refuses one that names another,
  // rather than quietly acting in the wrong place.
  let scopes = token.site_scopes || [];
  const ref = parseWorkspace(workspace);
  if (workspace?.trim()) {
    const org = actor.organizations.find((o) => o.id === bound);
    const sameAccount = !ref?.account || ref.account === actor.user.email.toLowerCase();
    if (!ref || !sameAccount || (ref.organization !== org?.slug && ref.organization !== bound)) {
      return {
        refused: `This connection is for ${actor.user.email} in ${org?.name ?? "one organization"} only, not "${workspace}". Reconnect and choose "All my organizations" to work in several.`,
      };
    }
    const narrowed = narrowScopes(scopes, ref.site);
    if (!narrowed) return { refused: `This connection is limited to ${scopes.join(", ")}, not "${ref.site}".` };
    scopes = narrowed;
  }

  touch(token.id);
  return { actor, token: identity(bound, scopes) };
}

/** A token's site scope narrowed to one site; null when that site is outside it. */
function narrowScopes(scopes: string[], site: string | null): string[] | null {
  if (!site) return scopes;
  if (scopes.length > 0 && !scopes.includes(site)) return null;
  return [site];
}

/** Best-effort — never block the request on this write. */
function touch(tokenId: string) {
  prisma.apiToken.update({ where: { id: tokenId }, data: { last_used_at: new Date() } }).catch(() => {});
}

/**
 * Route-handler guard for endpoints that must also accept a personal access
 * token (export/import, and anything else meant for desktop/CLI use) —
 * tries the Authorization header first, then falls back to the browser
 * session. Same permission semantics as requirePermission().
 */
export async function requirePermissionApi(
  req: NextRequest,
  ...permissions: PermissionName[]
): Promise<GuardResult> {
  const tokenAuth = await actorFromApiToken(req);
  if (!tokenAuth) {
    return requirePermission(...permissions);
  }
  if ("refused" in tokenAuth) {
    return {
      error: NextResponse.json({ error: tokenAuth.refused, workspace_required: true }, { status: 400 }),
    };
  }

  const { actor, token } = tokenAuth;
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length > 0) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", missing_permissions: missing },
        { status: 403 }
      ),
    };
  }

  // Scoped to the TOKEN's org, which actorFromApiTokenValue has already proved
  // is a live membership of the owner's — so every read and write this request
  // makes is confined to the tenant the token names.
  return {
    actor,
    db: tenantDb(token.organization_id),
    via: "token",
    apiToken: token,
  };
}
