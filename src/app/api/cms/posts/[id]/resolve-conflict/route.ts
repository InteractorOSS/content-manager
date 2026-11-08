import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage, authorDisplayName } from "@/lib/rbac";
import { postConflictBody, resolveExpectedContentHash } from "@/lib/post-conflict";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Resolve a Phase 2 sync_conflict by keeping the CMS version: clears the
 * flag and nulls last_synced_hash so the next outbound sweep re-pushes this
 * post's current content to GitHub, overwriting whatever's sitting there.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { expected_content_hash?: string | null };
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;
  if (!canEditPost(actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  // Optional — mirrors PUT /api/cms/posts/[id]: a caller who loaded the post
  // before deciding to keep the CMS version can pass the hash it saw (via the
  // body field or an If-Match header), so a fresher edit landing in between
  // isn't silently overridden by this resolve.
  const expectedContentHash = resolveExpectedContentHash(body, req.headers.get("if-match"));
  if (expectedContentHash !== undefined && expectedContentHash !== post.content_hash) {
    return NextResponse.json(postConflictBody(post), { status: 409 });
  }

  const writeData = {
    sync_conflict: false,
    last_synced_hash: null,
    updated_by_id: actor.user.id,
    updated_by_name: authorDisplayName(actor.user),
  };

  // No expected_content_hash means no CAS is needed, so a plain unique-id
  // update() is atomic and race-free on its own, and it returns the row
  // exactly as the database now has it. WITH a hash, condition the write
  // itself on content_hash (not just the read above) so a request racing in
  // between the check and this write can't slip through — mirrors the PUT
  // route's updateMany guard, and its response is built the same way (from
  // the data just written, not a second independent findUnique that could
  // observe a concurrent write in the gap).
  let updated: { updated_at: Date } & Record<string, unknown>;
  if (expectedContentHash === undefined) {
    updated = await db.post.update({ where: { id }, data: writeData });
  } else {
    const updateResult = await db.post.updateMany({
      where: { id, content_hash: expectedContentHash },
      data: writeData,
    });
    if (updateResult.count === 0) {
      const current = await db.post.findUnique({ where: { id } });
      if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(postConflictBody(current), { status: 409 });
    }
    updated = { ...post, ...writeData, updated_at: new Date() };
  }

  return NextResponse.json({
    data: { ...updated, updated_at: updated.updated_at.toISOString() },
  });
}
