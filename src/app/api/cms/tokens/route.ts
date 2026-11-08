import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { generateRawToken, hashToken, displayPrefix } from "@/lib/api-tokens";
import { tenantDb } from "@/lib/tenant-db";
import { orgSiteSlugs } from "@/lib/sites-server";
import { parseTokenSiteScopes } from "@/lib/token-site-scope";

function formatToken(token: {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  inserted_at: Date;
  organization_id: string | null;
  all_organizations?: boolean;
  linked_accounts?: { user: { email: string } }[];
  site_scopes: string[];
  organization?: { id: string; name: string; slug: string } | null;
  refresh_expires_at?: Date | null;
  oauth_client?: { client_name: string } | null;
}) {
  // A connector connection's access token expires hourly and renews itself;
  // what the member cares about is when the CONNECTION lapses, which is the
  // refresh token's (sliding) expiry.
  const expiresAt = token.oauth_client ? token.refresh_expires_at ?? null : token.expires_at;
  return {
    id: token.id,
    name: token.name,
    token_prefix: token.token_prefix,
    last_used_at: token.last_used_at?.toISOString() ?? null,
    expires_at: expiresAt?.toISOString() ?? null,
    revoked_at: token.revoked_at?.toISOString() ?? null,
    inserted_at: token.inserted_at.toISOString(),
    // Which tenant this token acts on. Null only for a pre-binding row whose
    // owner had no membership to backfill from — the guard refuses those, so
    // the UI renders it as unusable rather than as "any organization".
    organization_id: token.organization_id,
    organization: token.organization ?? null,
    // A workspace connection (src/lib/workspaces.ts): every organization of
    // its accounts, the owner's plus any linked on the consent page.
    all_organizations: token.all_organizations ?? false,
    linked_accounts: (token.linked_accounts ?? []).map((a) => a.user.email),
    // Site slugs this token is scoped to, or empty for all sites in the org.
    site_scopes: token.site_scopes ?? [],
    // Set when this row is an app connected through OAuth (e.g. Claude)
    // rather than a hand-minted token; revoking it disconnects the app.
    connected_app: token.oauth_client ? { name: token.oauth_client.client_name } : null,
  };
}

// Personal access tokens are self-service — any signed-in user manages
// their own, scoped to whatever permissions their roles already grant.
export async function GET() {
  const { actor, error } = await requirePermission();
  if (error) return error;

  const tokens = await prisma.apiToken.findMany({
    where: { user_id: actor.user.id },
    orderBy: { inserted_at: "desc" },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
      oauth_client: { select: { client_name: true } },
      linked_accounts: { select: { user: { select: { email: true } } } },
    },
  });
  return NextResponse.json({ data: tokens.map(formatToken) });
}

export async function POST(req: NextRequest) {
  const { actor, error } = await requirePermission();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "A token name is required" }, { status: 400 });
  }

  // A token acts on exactly one organization, chosen here and fixed for life:
  // the bearer carries no session later to say which of the owner's orgs it
  // meant. Default to the session's active org so a single-org user notices
  // nothing; validate any explicit choice against this user's own memberships
  // so a token can never be minted against a tenant they don't belong to.
  const memberships = await prisma.membership.findMany({
    where: { user_id: actor.user.id },
    select: { organization_id: true },
    orderBy: { inserted_at: "asc" },
  });
  if (memberships.length === 0) {
    return NextResponse.json(
      { error: "You must belong to an organization before creating a token" },
      { status: 400 }
    );
  }

  const requestedOrgId =
    typeof body.organization_id === "string" ? body.organization_id.trim() : "";
  const organizationId =
    requestedOrgId || actor.organizationId || memberships[0].organization_id;

  if (!memberships.some((m) => m.organization_id === organizationId)) {
    return NextResponse.json(
      { error: "You are not a member of that organization" },
      { status: 403 }
    );
  }

  // Optional site scope (G#21), fixed for life like the org. Validated against
  // the sites THIS org has (registered + built-in) and refused outright on any
  // unknown slug rather than narrowed — see parseTokenSiteScopes. Empty means
  // every site in the org.
  const { scopes: site_scopes, error: scopeError } = parseTokenSiteScopes(
    body.site_scopes,
    await orgSiteSlugs(tenantDb(organizationId))
  );
  if (scopeError) {
    return NextResponse.json({ error: scopeError }, { status: 400 });
  }

  const expiresInDays = Number(body.expires_in_days);
  const expires_at =
    Number.isFinite(expiresInDays) && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const rawToken = generateRawToken();
  const token = await prisma.apiToken.create({
    data: {
      user_id: actor.user.id,
      organization_id: organizationId,
      name,
      token_prefix: displayPrefix(rawToken),
      token_hash: hashToken(rawToken),
      expires_at,
      site_scopes,
    },
    include: { organization: { select: { id: true, name: true, slug: true } } },
  });

  // The raw token is returned exactly once — only token_hash is persisted.
  return NextResponse.json(
    { data: { ...formatToken(token), token: rawToken } },
    { status: 201 }
  );
}
