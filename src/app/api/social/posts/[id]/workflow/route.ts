import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { formatSocialPost } from "@/lib/social/format";

type Ctx = { params: Promise<{ id: string }> };

type Action = "submit" | "approve" | "reject";

const POST_INCLUDE = {
  campaign: true,
  created_by: { select: { id: true, name: true, email: true } },
  source_post: { select: { id: true, title: true, slug: true } },
  targets: { include: { channel: true } },
} as const;

// Planable-style approval for social posts, mirroring the blog workflow:
// draft → pending_review → approved (auto-schedules when a time is set) / rejected.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: Action;
    comments?: string;
    reason?: string;
  };

  const post = await db.socialPost.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const forbidden = (m: string) =>
    NextResponse.json({ error: m }, { status: 403 });
  const conflict = (m: string) =>
    NextResponse.json({ error: m }, { status: 409 });

  switch (body.action) {
    case "submit": {
      const own = post.created_by_id === actor.user.id;
      if (!own && !actor.permissions.has("content:edit_any")) {
        return forbidden("You can only submit your own posts for review");
      }
      if (!["draft", "rejected"].includes(post.status)) {
        return conflict(`Cannot submit a post in '${post.status}' state`);
      }
      const updated = await db.socialPost.update({
        where: { id },
        data: { status: "pending_review", rejection_reason: null },
        include: POST_INCLUDE,
      });
      return NextResponse.json({ data: formatSocialPost(updated) });
    }

    case "approve": {
      if (!actor.permissions.has("content:approve")) {
        return forbidden("Missing content:approve permission");
      }
      if (post.status !== "pending_review") {
        return conflict(`Cannot approve a post in '${post.status}' state`);
      }
      const [updated] = await db.$transaction([
        db.socialPost.update({
          where: { id },
          data: {
            // Approved posts with a schedule go straight into the queue.
            status: post.scheduled_at ? "scheduled" : "approved",
            approved_at: new Date(),
            approved_by_id: actor.user.id,
            rejection_reason: null,
          },
          include: POST_INCLUDE,
        }),
        db.socialPostApproval.create({
          data: {
            post_id: id,
            reviewer_id: actor.user.id,
            action: "approved",
            comments: body.comments ?? null,
          },
        }),
      ]);
      return NextResponse.json({ data: formatSocialPost(updated) });
    }

    case "reject": {
      if (!actor.permissions.has("content:reject")) {
        return forbidden("Missing content:reject permission");
      }
      if (post.status !== "pending_review") {
        return conflict(`Cannot reject a post in '${post.status}' state`);
      }
      const reason = body.reason || body.comments || null;
      const [updated] = await db.$transaction([
        db.socialPost.update({
          where: { id },
          data: { status: "rejected", rejection_reason: reason },
          include: POST_INCLUDE,
        }),
        db.socialPostApproval.create({
          data: {
            post_id: id,
            reviewer_id: actor.user.id,
            action: "rejected",
            comments: reason,
          },
        }),
      ]);
      return NextResponse.json({ data: formatSocialPost(updated) });
    }

    default:
      return NextResponse.json(
        { error: "action must be one of submit|approve|reject" },
        { status: 400 }
      );
  }
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const approvals = await db.socialPostApproval.findMany({
    where: { post_id: id },
    include: { reviewer: { select: { id: true, name: true, email: true } } },
    orderBy: { reviewed_at: "desc" },
  });
  return NextResponse.json({
    data: approvals.map((a) => ({
      ...a,
      reviewed_at: a.reviewed_at.toISOString(),
      inserted_at: a.inserted_at.toISOString(),
    })),
  });
}
