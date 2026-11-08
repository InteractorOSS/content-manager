import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import {
  listPostDestinations,
  parseDestinationsSave,
  setPostDestinations,
} from "@/lib/post-social-delivery";

type Ctx = { params: Promise<{ id: string }> };

// Where a post's social copy goes (src/lib/post-social-delivery.ts): the
// places it can be posted to, which of them this post uses, and the link the
// copy carries back to the post. The CMS post editor's Social section reads
// and writes this; the writer editor uses the same thing through
// /api/edit/social/destinations.
export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;
  const { id } = await params;
  const post = await db.post.findUnique({ where: { id }, select: { id: true, platforms: true } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;
  return NextResponse.json({ data: await listPostDestinations(db, id) });
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
  const parsed = parseDestinationsSave(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json({ data: await setPostDestinations(db, id, parsed.channelIds) });
}
