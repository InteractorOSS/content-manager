import { NextRequest, NextResponse } from "next/server";
import { browseKeyFromRequest } from "@/lib/post-browse-keys";
import { siteScopeAllows, siteScopeRefusalMessage } from "@/lib/token-site-scope";
import { restoreFromTrash } from "@/lib/post-trash";

// Restore a post from the trash in the writer's post list (browse key). It
// comes back as a draft. Same rules as /api/cms/posts/trash/[id]/restore.
export async function POST(req: NextRequest) {
  const auth = await browseKeyFromRequest(req);
  if (!auth) {
    return NextResponse.json(
      { error: "This list has expired or its link is invalid. Ask Claude to show your posts again." },
      { status: 401 }
    );
  }
  if (!auth.actor.permissions.has("content:create")) {
    return NextResponse.json(
      { error: "Your role in this organization can't restore posts.", missing_permissions: ["content:create"] },
      { status: 403 }
    );
  }
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const entry = await auth.db.deletedPost.findFirst({ where: { id }, select: { platforms: true } });
  if (!entry) return NextResponse.json({ error: "That post isn't in the trash any more." }, { status: 404 });
  if (!siteScopeAllows(auth.key.site_scopes, entry.platforms, "change")) {
    return NextResponse.json({ error: siteScopeRefusalMessage(auth.key.site_scopes, entry.platforms, "change") }, { status: 403 });
  }
  const post = await restoreFromTrash(auth.db, id, auth.actor);
  if (!post) return NextResponse.json({ error: "That post isn't in the trash any more." }, { status: 404 });
  return NextResponse.json({ data: post }, { status: 201 });
}
