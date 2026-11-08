import "server-only";
import { prisma } from "@/lib/db";
import { putFileToGithub } from "@/lib/github-sync";
import { serializePostFile, exportFilename } from "@/lib/post-frontmatter";

const PATH_PREFIX = "content/posts/";
const BATCH_SIZE = 20;

/**
 * Outbound half of Phase 2 two-way sync: push every post whose content has
 * changed since it was last written to the connected GitHub repo. Ticks
 * from src/instrumentation.ts, gated by GITHUB_CONTENT_SYNC_ENABLED — a
 * no-op until a connection exists (see /settings/content-sync).
 *
 * Posts flagged sync_conflict are skipped: overwriting GitHub while a
 * conflict is unresolved would silently discard whatever's sitting there
 * unreviewed (see FILE-BASED-CONTENT-PLAN.md Phase 2 "needs merge").
 */
export async function syncDirtyPostsToGithub(): Promise<{ pushed: number; failed: number }> {
  const connection = await prisma.contentSyncConnection.findFirst({
    where: { status: "active" },
    orderBy: { inserted_at: "desc" },
  });
  if (!connection?.credential_id) return { pushed: 0, failed: 0 };

  const candidates = await prisma.post.findMany({
    where: { sync_conflict: false, content: { not: null } },
    include: { category: { select: { slug: true } } },
    orderBy: { updated_at: "asc" },
    take: BATCH_SIZE * 4, // filter dirty in JS below, then cap to BATCH_SIZE
  });
  const dirty = candidates
    .filter((p) => p.content_hash && p.content_hash !== p.last_synced_hash)
    .slice(0, BATCH_SIZE);

  let pushed = 0;
  let failed = 0;
  for (const post of dirty) {
    try {
      const file = serializePostFile(post);
      await putFileToGithub(
        {
          repo: connection.repo,
          branch: connection.branch,
          path: PATH_PREFIX + exportFilename(post.slug),
          externalUserId: connection.external_user_id,
        },
        file,
        `Sync: ${post.title} (${post.slug})`
      );
      await prisma.post.update({
        where: { id: post.id },
        data: { last_synced_hash: post.content_hash },
      });
      pushed++;
    } catch (err) {
      failed++;
      console.error(`[content-sync] failed to push post ${post.slug}:`, err);
    }
  }
  return { pushed, failed };
}
