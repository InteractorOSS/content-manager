import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { trashPosts } from "@/lib/post-trash";
import { siteScopeBatchRefusal, siteScopeOf } from "@/lib/token-site-scope";
import { notifyIndexNowForPost } from "@/lib/indexnow";

export async function DELETE(req: NextRequest) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:delete");
  if (error) return error;

  const body = await req.json() as { ids?: string[]; slugs?: string[] };

  const where = body.ids?.length
    ? { id: { in: body.ids } }
    : body.slugs?.length
      ? { slug: { in: body.slugs } }
      : null;
  if (!where) return new NextResponse(null, { status: 204 });

  // The matched rows are needed anyway: they are what goes to the trash.
  const matched = await db.post.findMany({ where });

  // A site-scoped token (G#21) refuses the WHOLE batch if any matched post
  // targets a site outside its scope — deleting only the in-scope ones would
  // be a silent partial success the caller can't tell apart from a full one.
  if (siteScopeOf(apiToken).length > 0) {
    const outOfScope = siteScopeBatchRefusal(
      apiToken,
      matched,
      "Nothing was deleted. Narrow the request to posts within your scope, or use a token that covers their sites."
    );
    if (outOfScope) return outOfScope;
  }

  // To the trash (src/lib/post-trash.ts): restorable for TRASH_RETENTION_DAYS.
  await trashPosts(db, matched, actor);
  // Only posts that were actually LIVE are worth telling IndexNow about.
  // Grouped by platform set rather than one notifyIndexNowForPost call per
  // post: most posts in one bulk-delete share the same platforms, and a
  // per-post call independently re-resolves the same site rows and fires an
  // independent, un-awaited outbound ping — a batch of hundreds of published
  // posts would otherwise mean hundreds of redundant DB round trips plus
  // hundreds of concurrent HTTPS calls in the same tick.
  const publishedByPlatforms = new Map<string, { platforms: string[]; slugs: string[] }>();
  for (const post of matched) {
    if (post.status !== "published") continue;
    const key = [...post.platforms].sort().join(",");
    const group = publishedByPlatforms.get(key);
    if (group) group.slugs.push(post.slug);
    else publishedByPlatforms.set(key, { platforms: post.platforms, slugs: [post.slug] });
  }
  for (const { platforms, slugs } of publishedByPlatforms.values()) {
    void notifyIndexNowForPost(db, { platforms }, slugs);
  }
  return new NextResponse(null, { status: 204 });
}
