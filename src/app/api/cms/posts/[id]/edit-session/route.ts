import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import { livePreviewUrl, mintPreviewToken, previewUrl } from "@/lib/preview-link";
import { exportFilename } from "@/lib/post-frontmatter";
import { mintEditKey } from "@/lib/post-edit-keys";
import { mintBrowseKey } from "@/lib/post-browse-keys";
import { orgSiteSlugs } from "@/lib/sites-server";
import { siteScopeAllows } from "@/lib/token-site-scope";
import { env } from "@/lib/env";

type Ctx = { params: Promise<{ id: string }> };

// Open a post for live editing (the `open_for_editing` MCP tool): mints a
// one-post edit key for the local sync tool and returns the live preview link.
// Gated exactly like editing the post, since the key can change it.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  // Reuse a live preview link — minting replaces it, which would break a link
  // already sent to a reviewer.
  let preview = livePreviewUrl(post);
  if (!preview) {
    const { token, expiresAt } = mintPreviewToken(id);
    await db.post.update({ where: { id }, data: { preview_token_expires_at: expiresAt } });
    preview = previewUrl(token);
  }

  const { key, expiresAt } = await mintEditKey({
    postId: id,
    userId: actor.user.id,
    organizationId: post.organization_id,
    apiTokenId: apiToken?.id ?? null,
    siteScopes: apiToken?.site_scopes ?? [],
  });

  // A list key for the editor's "All posts" link, so the writer can move to
  // another post without going back to the chat. Narrowed to `site` (the
  // folder's bound site) when that names one of the org's sites this
  // connection can read; otherwise every site in scope. Doesn't replace a
  // list the writer already has open.
  const body = (await req.json().catch(() => ({}))) as { site?: unknown };
  const scopes = apiToken?.site_scopes ?? [];
  let listSite = typeof body.site === "string" && body.site.trim() ? body.site.trim() : null;
  if (listSite && (!(await orgSiteSlugs(db, [])).includes(listSite) || !siteScopeAllows(scopes, [listSite], "read"))) {
    listSite = null;
  }
  const list = await mintBrowseKey({
    userId: actor.user.id,
    organizationId: post.organization_id,
    apiTokenId: apiToken?.id ?? null,
    siteScopes: scopes,
    site: listSite,
    replacePrevious: false,
  });

  return NextResponse.json({
    data: {
      post: { id: post.id, slug: post.slug, title: post.title },
      filename: exportFilename(post.slug),
      preview_url: preview,
      edit_key: key,
      edit_key_expires_at: expiresAt.toISOString(),
      file_url: new URL("/api/edit/file", env.NEXTAUTH_URL).toString(),
      // The writer editor: the post, formatted and typed on directly. The key
      // rides in the fragment, which browsers never send to a server.
      // The list key after it backs the editor's "All posts" link.
      editor_url: `${new URL("/write", env.NEXTAUTH_URL).toString()}#key=${key}&list=${list.key}`,
    },
  });
}
