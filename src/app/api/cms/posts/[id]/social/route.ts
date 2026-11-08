import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import { listPostSocial, parseSocialSave, savePostSocial } from "@/lib/post-social";
import { syncPostSocialDelivery } from "@/lib/post-social-delivery";

type Ctx = { params: Promise<{ id: string }> };

// A post's social copy, one draft per network (src/lib/post-social.ts). Backs
// the list_social_drafts / save_social_draft MCP tools. Scheduling and
// publishing stay in the Social queue.
export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;
  const { id } = await params;
  const post = await db.post.findUnique({ where: { id }, select: { id: true, platforms: true } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;
  return NextResponse.json({ data: await listPostSocial(db, id) });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
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
  const parsed = parseSocialSave(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const saved = await savePostSocial(db, { postId: id, ...parsed, userId: actor.user.id });
  // Attach the post's destinations and its backlink to the draft just saved.
  await syncPostSocialDelivery(db, id);
  return NextResponse.json({ data: saved, removed: saved === null });
}
