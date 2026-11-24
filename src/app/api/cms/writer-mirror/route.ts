import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeAllows } from "@/lib/token-site-scope";
import { orgSiteSlugs } from "@/lib/sites-server";
import { mintBrowseKey } from "@/lib/post-browse-keys";
import { formatWorkspace, parseWorkspace, WORKSPACE_HEADER } from "@/lib/workspaces";
import { env } from "@/lib/env";

// The open_mirror MCP tool: a mirror key for the Interactor CMS plugin's
// local posts folder (scripts/mirror.mjs), covering one workspace — this
// organization, one site (the workspace's, or body.site; none = every site
// in scope), within the connection's own site scope. It reads and saves
// posts' files through /api/edit/mirror/* only; it can't create, delete or
// change a post's status. 8 hours, dies with the connection, and replaces the
// caller's earlier mirror key for the same site only.
export async function POST(req: NextRequest) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { site?: unknown };
  const fromBody = typeof body.site === "string" && body.site.trim() ? body.site.trim() : null;
  const site = fromBody ?? parseWorkspace(req.headers.get(WORKSPACE_HEADER))?.site ?? null;
  const scopes = apiToken?.site_scopes ?? [];

  if (site) {
    if (!(await orgSiteSlugs(db, [])).includes(site)) {
      return NextResponse.json({ error: `This organization has no site "${site}". list_sites shows its sites.` }, { status: 400 });
    }
    if (!siteScopeAllows(scopes, [site], "read")) {
      return NextResponse.json(
        { error: `This connection is limited to ${scopes.join(", ")}, so it can't mirror "${site}".`, token_site_scopes: scopes },
        { status: 403 }
      );
    }
  }

  const { key, expiresAt } = await mintBrowseKey({
    userId: actor.user.id,
    organizationId: actor.organizationId!,
    apiTokenId: apiToken?.id ?? null,
    siteScopes: scopes,
    site,
    purpose: "mirror",
  });

  const org = actor.organizations.find((o) => o.id === actor.organizationId);
  return NextResponse.json({
    data: {
      workspace: formatWorkspace(actor.user.email, org?.slug ?? "", site),
      mirror_key: key,
      mirror_url: new URL("/api/edit/mirror", env.NEXTAUTH_URL).toString(),
      site,
      can_edit: actor.permissions.has("content:edit"),
      expires_at: expiresAt.toISOString(),
    },
  });
}
