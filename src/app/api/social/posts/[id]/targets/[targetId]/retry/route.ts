import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { publishTarget, rollUpPostStatus } from "@/lib/social/publisher";
import { formatSocialPost } from "@/lib/social/format";

type Ctx = { params: Promise<{ id: string; targetId: string }> };

const POST_INCLUDE = {
  campaign: true,
  created_by: { select: { id: true, name: true, email: true } },
  source_post: { select: { id: true, title: true, slug: true } },
  targets: { include: { channel: true } },
} as const;

/**
 * Send this post to ONE channel again, now.
 *
 * The scheduler retries a failed channel on its own, but only while attempts
 * remain; once they are spent — or once the reason was never transient, like a
 * channel that needed reconnecting — a person has to say "try that one again".
 * Without this, the only way back was deleting and re-creating the post.
 *
 * Tenancy: `SocialPostTarget` carries no `organization_id` of its own (it
 * inherits through the post), so the lookup goes through the tenant-scoped
 * `socialPost` and the target is found INSIDE it. A target id from another org
 * therefore never resolves, whatever it is paired with.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:publish");
  if (error) return error;

  const { id, targetId } = await params;
  const post = await db.socialPost.findUnique({
    where: { id },
    include: { targets: true },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const target = post.targets.find((t) => t.id === targetId);
  if (!target) {
    return NextResponse.json(
      { error: "That channel is not one of this post's channels." },
      { status: 404 }
    );
  }
  if (target.status === "published") {
    return NextResponse.json(
      {
        error:
          "This post is already live on that channel. Retrying would post it a second time.",
      },
      { status: 409 }
    );
  }
  if (target.status === "publishing") {
    return NextResponse.json(
      {
        error:
          "This channel is being tried right now. Wait for the current attempt to finish, then retry.",
      },
      { status: 409 }
    );
  }

  // Hand the row back to the publisher, due immediately. The attempt count is
  // reset because a person asking again is a new decision, not a continuation
  // of the automatic attempts that already gave up.
  await db.socialPostTarget.updateMany({
    where: { id: target.id, post_id: post.id },
    data: {
      status: "pending",
      attempt_count: 0,
      error: null,
      next_attempt_at: new Date(),
    },
  });
  await db.socialPost.updateMany({
    where: { id: post.id, status: { notIn: ["publishing", "published"] } },
    data: { status: "publishing" },
  });

  await publishTarget(target.id);
  await rollUpPostStatus(post.id);

  const fresh = await db.socialPost.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  return NextResponse.json({ data: formatSocialPost(fresh) });
}
