import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { formatTarget } from "@/lib/social/format";
import { canMarkPosted, markManualTargetPosted } from "@/lib/social/publisher";

type Ctx = { params: Promise<{ targetId: string }> };

interface MarkPostedPayload {
  external_url?: string;
  external_post_id?: string;
}

/**
 * A human finishes the manual-delivery loop: they pasted a target's copy
 * onto the real platform themselves and are recording what they got back
 * (the permalink, if the platform gave them one). Same gate as "Publish
 * now" — content:publish — since this IS how a manual-mode target actually
 * gets published.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:publish");
  if (error) return error;

  const { targetId } = await params;

  // SocialPostTarget has no organization_id of its own — verify tenancy
  // through its parent post (tenant-scoped `db.socialPost`) before touching
  // it, same reasoning as GET /api/social/manual.
  const post = await db.socialPost.findFirst({
    where: { targets: { some: { id: targetId } } },
    include: { targets: { where: { id: targetId }, include: { channel: true } } },
  });
  const target = post?.targets[0];
  if (!post || !target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (target.channel.delivery_mode !== "manual") {
    return NextResponse.json(
      { error: "This target's channel is not manual delivery" },
      { status: 422 }
    );
  }
  if (!canMarkPosted(target)) {
    return NextResponse.json(
      { error: `Target is '${target.status}', not awaiting manual posting` },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as MarkPostedPayload;
  const updated = await markManualTargetPosted(targetId, {
    externalUrl: body.external_url?.trim() || null,
    externalPostId: body.external_post_id?.trim() || null,
  });

  return NextResponse.json({ data: formatTarget(updated) });
}
