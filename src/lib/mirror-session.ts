import { NextRequest, NextResponse } from "next/server";
import { mirrorKeyFromRequest, type BrowseKeyAuth } from "@/lib/post-browse-keys";
import { siteScopeAllows, siteScopeRefusalMessage, siteScopeWhere } from "@/lib/token-site-scope";
import { loadPostById, type EditPost } from "@/lib/edit-session";
import type { PermissionName } from "@/lib/rbac";

// The shared checks of the plugin's folder mirror (/api/edit/mirror/*,
// scripts/mirror.mjs in the plugin). One mirror key covers one workspace:
// its organization, its site (null = every site) and the minting token's
// site scope. Every post it reads or saves is checked against all three, the
// same way /api/edit/open checks a post before minting an edit key for it.

export function mirrorEnded(): NextResponse {
  return NextResponse.json(
    { error: "This mirror has ended or its key is invalid. Ask Claude to start the mirror again." },
    { status: 401 }
  );
}

/** The key's workspace as a Prisma filter: its site and its site scope. */
export function mirrorPostWhere(key: BrowseKeyAuth["key"]): Record<string, unknown>[] {
  const where: Record<string, unknown>[] = [siteScopeWhere({ site_scopes: key.site_scopes })];
  if (key.site) where.push({ platforms: { has: key.site } });
  return where;
}

export async function authorizeMirror(
  req: NextRequest,
  permission: PermissionName
): Promise<{ auth: BrowseKeyAuth; error?: never } | { error: NextResponse }> {
  const auth = await mirrorKeyFromRequest(req);
  if (!auth) return { error: mirrorEnded() };
  if (!auth.actor.permissions.has(permission)) {
    return { error: NextResponse.json({ error: "Forbidden", missing_permissions: [permission] }, { status: 403 }) };
  }
  return { auth };
}

/**
 * Load one post of the key's workspace. A post that isn't on the key's site,
 * or outside the token's scope, is answered as 404 "not in this workspace",
 * so the mirror treats it like a post that left the folder.
 */
export async function loadMirrorPost(
  auth: BrowseKeyAuth,
  id: string,
  action: "read" | "change"
): Promise<{ post: EditPost; error?: never } | { error: NextResponse }> {
  const post = id ? await loadPostById(auth.db, id) : null;
  if (!post) return { error: NextResponse.json({ error: "This post no longer exists." }, { status: 404 }) };
  if (auth.key.site && !post.platforms.includes(auth.key.site)) {
    return { error: NextResponse.json({ error: `This post isn't on ${auth.key.site} any more.` }, { status: 404 }) };
  }
  if (!siteScopeAllows(auth.key.site_scopes, post.platforms, action)) {
    const status = action === "read" ? 404 : 403;
    return {
      error: NextResponse.json({ error: siteScopeRefusalMessage(auth.key.site_scopes, post.platforms, action) }, { status }),
    };
  }
  return { post };
}
