import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost } from "@/lib/rbac";
import { mintPreviewToken, previewUrl } from "@/lib/preview-link";

type Ctx = { params: Promise<{ id: string }> };

// Mints (or refreshes) the post's single active preview link, gated the same
// way editing the post itself is (content:edit + ownership) — minting a link
// hands out read access to unpublished content, so it deserves the same bar
// as changing that content.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, post)) {
    return NextResponse.json(
      { error: "You can only create a preview link for your own posts" },
      { status: 403 }
    );
  }

  const { token, expiresAt } = mintPreviewToken(id);
  await db.post.update({ where: { id }, data: { preview_token_expires_at: expiresAt } });

  return NextResponse.json({ data: { url: previewUrl(token), expires_at: expiresAt.toISOString() } });
}

// Revokes the post's active preview link (if any) — every previously issued
// token for this post stops resolving immediately, since resolvePreviewLink
// requires an exact match against preview_token_expires_at.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, post)) {
    return NextResponse.json(
      { error: "You can only revoke a preview link for your own posts" },
      { status: 403 }
    );
  }

  await db.post.update({ where: { id }, data: { preview_token_expires_at: null } });
  return new NextResponse(null, { status: 204 });
}
