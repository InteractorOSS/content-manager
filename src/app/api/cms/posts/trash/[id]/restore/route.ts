import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { restoreFromTrash } from "@/lib/post-trash";

type Ctx = { params: Promise<{ id: string }> };

// Restore a deleted post from the trash. It comes back as a draft, whatever
// it was before, so restoring never republishes anything by itself.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const { id } = await params;
  const entry = await db.deletedPost.findFirst({ where: { id }, select: { platforms: true } });
  if (!entry) return NextResponse.json({ error: "That post isn't in the trash (it may have been restored already, or emptied after 30 days)." }, { status: 404 });
  const outOfScope = siteScopeRefusal(apiToken, entry.platforms, "change");
  if (outOfScope) return outOfScope;

  const post = await restoreFromTrash(db, id, actor);
  if (!post) return NextResponse.json({ error: "That post isn't in the trash." }, { status: 404 });
  return NextResponse.json({ data: { ...post, status: "draft" } }, { status: 201 });
}
