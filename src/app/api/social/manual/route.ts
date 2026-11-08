import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { formatManualQueueItem } from "@/lib/social/format";

/**
 * The manual-delivery queue (G#27): every SocialPostTarget still
 * awaiting_manual — a human needs to paste the copy onto the real platform
 * themselves (delivery_mode "manual" channels, e.g. a personal Facebook
 * profile that Meta's API can't post to on someone's behalf) and come back
 * to mark it posted via POST /api/social/manual/[targetId]/mark-posted.
 *
 * SocialPostTarget carries no organization_id of its own (it inherits
 * tenancy through its parent post — see tenant-db.ts), so this queries
 * through the tenant-scoped `db.socialPost` and narrows each post's
 * `targets` relation to just the awaiting_manual one(s), rather than
 * querying db.socialPostTarget directly (which tenant-db does NOT scope).
 */
export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const posts = await db.socialPost.findMany({
    where: { targets: { some: { status: "awaiting_manual" } } },
    include: {
      campaign: true,
      source_post: { select: { id: true, title: true, slug: true } },
      targets: {
        where: { status: "awaiting_manual" },
        include: { channel: true },
        orderBy: { updated_at: "asc" },
      },
    },
    orderBy: { updated_at: "asc" },
  });

  const items = posts.flatMap((post) =>
    post.targets.map((target) => formatManualQueueItem(post, target))
  );
  return NextResponse.json({ data: items });
}
