import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, authorDisplayName } from "@/lib/rbac";
import { stripHtml } from "@/lib/utils";
import { pruneOldRevisions, revisionSnapshotData } from "@/lib/post-revisions";
import { postConflictBody, resolveExpectedContentHash } from "@/lib/post-conflict";

type Ctx = { params: Promise<{ id: string; revisionId: string }> };

function readingTime(html: string): number {
  const words = stripHtml(html).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function formatPost(post: {
  inserted_at: Date;
  updated_at: Date;
  published_at: Date | null;
  [key: string]: unknown;
}) {
  return {
    ...post,
    inserted_at: post.inserted_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
    published_at: post.published_at?.toISOString() ?? null,
  };
}

/**
 * Restore a post to an earlier revision. The current state is itself
 * snapshotted first (source="restore") so a restore is always undoable too,
 * then the post's content fields are overwritten with the target revision's.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id, revisionId } = await params;
  const body = await req.json().catch(() => ({})) as { expected_content_hash?: string | null };
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, post)) {
    return NextResponse.json(
      { error: "You can only edit your own posts" },
      { status: 403 }
    );
  }

  // Optional, same contract as PUT /api/cms/posts/[id]: a caller who loaded
  // the post before choosing to restore an older revision can pass the hash
  // it saw, so a fresher edit landing in between isn't silently blown away —
  // restoring is as much a content-clobbering write as any other.
  const expectedContentHash = resolveExpectedContentHash(body, req.headers.get("if-match"));
  if (expectedContentHash !== undefined && expectedContentHash !== post.content_hash) {
    return NextResponse.json(postConflictBody(post), { status: 409 });
  }

  const target = await db.postRevision.findFirst({ where: { id: revisionId, post_id: id } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const writeData = {
    title: target.title,
    content: target.content,
    content_format: target.content_format,
    content_html: target.content_html,
    excerpt: target.excerpt,
    content_hash: target.content_hash,
    reading_time: target.content_html ? readingTime(target.content_html) : null,
    updated_by_id: actor.user.id,
    updated_by_name: authorDisplayName(actor.user),
  };
  const includeCategory = { include: { category: { select: { id: true, name: true, slug: true } } } };

  // No expected_content_hash means no CAS is needed, so a plain unique-id
  // update() is atomic and race-free on its own, and it returns the row
  // exactly as the database now has it. WITH a hash, updateMany is the only
  // way to condition the write, so its response is built from the data just
  // written rather than a second, independent findUnique that could observe
  // a concurrent write in the gap between commit and that re-read.
  let raced = false;
  let restored: Record<string, unknown> | null = null;
  await db.$transaction(async (tx) => {
    if (expectedContentHash === undefined) {
      restored = await tx.post.update({ where: { id }, data: writeData, ...includeCategory });
    } else {
      const updateResult = await tx.post.updateMany({
        where: { id, content_hash: expectedContentHash },
        data: writeData,
      });
      if (updateResult.count === 0) {
        raced = true;
        return;
      }
    }
    await tx.postRevision.create({
      data: revisionSnapshotData(id, post, actor.user.id, "restore"),
    });
  });

  if (raced) {
    const current = await db.post.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(postConflictBody(current), { status: 409 });
  }

  void pruneOldRevisions(db, id).catch(() => {});

  if (!restored) {
    const category = post.category_id
      ? await db.category.findUnique({ where: { id: post.category_id }, select: { id: true, name: true, slug: true } })
      : null;
    restored = { ...post, ...writeData, updated_at: new Date(), category };
  }
  return NextResponse.json({ data: formatPost(restored as Parameters<typeof formatPost>[0]) });
}
