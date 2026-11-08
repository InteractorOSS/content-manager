import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeAllows } from "@/lib/token-site-scope";
import { orgSiteSlugs } from "@/lib/sites-server";
import { mintBrowseKey } from "@/lib/post-browse-keys";
import { env } from "@/lib/env";

// The open_post_list MCP tool: a short-lived browse key and the URL of the
// writer's post list (/write/posts) for Claude to open in the app's browser
// panel. Clicking a post there opens the editor in the same panel — which a
// link in the chat can't do, since chat links open in the system browser.
export async function POST(req: NextRequest) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { site?: unknown; search?: unknown };
  const site = typeof body.site === "string" && body.site.trim() ? body.site.trim() : null;
  const search = typeof body.search === "string" ? body.search.trim().slice(0, 200) : "";
  const scopes = apiToken?.site_scopes ?? [];

  if (site) {
    const known = await orgSiteSlugs(db, []);
    if (!known.includes(site)) {
      return NextResponse.json({ error: `This organization has no site "${site}". list_sites shows its sites.` }, { status: 400 });
    }
    if (!siteScopeAllows(scopes, [site], "read")) {
      return NextResponse.json(
        { error: `This connection is limited to ${scopes.join(", ")}, so it can't list "${site}".`, token_site_scopes: scopes },
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
  });

  const url = new URL("/write/posts", env.NEXTAUTH_URL);
  if (search) url.searchParams.set("q", search);
  return NextResponse.json({
    data: {
      // The key rides in the fragment, which browsers never send to a server.
      list_url: `${url.toString()}#key=${key}`,
      site,
      expires_at: expiresAt.toISOString(),
    },
  });
}
