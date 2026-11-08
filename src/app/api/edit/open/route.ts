import { NextRequest, NextResponse } from "next/server";
import { browseKeyFromRequest } from "@/lib/post-browse-keys";
import { mintEditKey } from "@/lib/post-edit-keys";
import { siteScopeAllows, siteScopeRefusalMessage } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";

// Open a post from the writer's post list: trade the list's browse key for a
// one-post edit key. Source "list", so it replaces only an earlier session
// opened from the list, never the one Claude's sync holds for the same post.
export async function POST(req: NextRequest) {
  const auth = await browseKeyFromRequest(req);
  if (!auth) {
    return NextResponse.json(
      { error: "This list has expired or its link is invalid. Ask Claude to show your posts again." },
      { status: 401 }
    );
  }
  const body = (await req.json().catch(() => null)) as { post_id?: unknown } | null;
  const postId = typeof body?.post_id === "string" ? body.post_id : "";
  if (!postId) return NextResponse.json({ error: "post_id is required" }, { status: 400 });

  const post = await auth.db.post.findUnique({ where: { id: postId } });
  if (!post) return NextResponse.json({ error: "This post no longer exists." }, { status: 404 });
  if (auth.key.site && !post.platforms.includes(auth.key.site)) {
    return NextResponse.json({ error: `This post isn't on ${auth.key.site}, the site this list shows.` }, { status: 403 });
  }
  if (!siteScopeAllows(auth.key.site_scopes, post.platforms, "change")) {
    return NextResponse.json(
      { error: siteScopeRefusalMessage(auth.key.site_scopes, post.platforms, "change") },
      { status: 403 }
    );
  }
  if (!auth.actor.permissions.has("content:edit")) {
    return NextResponse.json(
      { error: "Your role in this organization can read posts but not edit them.", missing_permissions: ["content:edit"] },
      { status: 403 }
    );
  }
  if (!canEditPost(auth.actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  const { key } = await mintEditKey({
    postId: post.id,
    userId: auth.actor.user.id,
    organizationId: auth.key.organization_id,
    apiTokenId: auth.key.api_token_id,
    siteScopes: auth.key.site_scopes,
    source: "list",
  });
  return NextResponse.json({ data: { edit_key: key } });
}
