import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { publishPost } from "@/lib/social/publisher";
import { formatSocialPost } from "@/lib/social/format";
import { checkNetworkRules } from "@/lib/social/network-rules";
import { socialPostParts } from "@/lib/social/parts";

type Ctx = { params: Promise<{ id: string }> };

/** Publish now (bypasses the schedule; still requires content:publish). */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:publish");
  if (error) return error;

  const { id } = await params;
  const post = await db.socialPost.findUnique({
    where: { id },
    include: { targets: true },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (post.targets.length === 0) {
    return NextResponse.json(
      { error: "Post has no target channels" },
      { status: 422 }
    );
  }
  // G#27: awaiting_manual is deliberately NOT blocked here — publishPost
  // only re-attempts targets with status pending/publishing (never
  // awaiting_manual, see publisher.ts's publishTarget), so calling publish
  // now on a post that's rolled up to awaiting_manual is harmless and is
  // exactly how a mixed post recovers: retry the failed automated target
  // without disturbing the manual one still waiting on a human.
  if (post.status === "published") {
    return NextResponse.json(
      { error: "This post has already been published to every channel." },
      { status: 409 }
    );
  }
  // "publishing" used to be refused outright, which made it a dead end: a post
  // parked there by a failed attempt could be neither published nor edited. It
  // is only a real conflict while an attempt is genuinely in flight; otherwise
  // re-entering publishPost is exactly what the post needs.
  if (
    post.status === "publishing" &&
    post.targets.some((t) => t.status === "publishing")
  ) {
    return NextResponse.json(
      {
        error:
          "This post is being sent to its channels right now. Wait for the current attempt to finish, then try again.",
      },
      { status: 409 }
    );
  }

  // Network rules (G#26): catch a violation as a clear 422 instead of a
  // network round-trip that publisher.ts can only report as a failed target.
  const pending = post.targets.filter((t) => t.status !== "published");
  const overrides: Record<string, string> = {};
  // Stored overrides as they are: checkNetworkRules reads them through
  // resolveTargetMedia, the rule publishTarget uses.
  const mediaOverrides: Record<string, unknown> = {};
  for (const t of pending) {
    if (t.body_override) overrides[t.channel_id] = t.body_override;
    mediaOverrides[t.channel_id] = t.media_override;
  }
  const thread = socialPostParts(post);
  const violations = await checkNetworkRules(
    db,
    pending.map((t) => t.channel_id),
    thread.body,
    overrides,
    post.media,
    mediaOverrides,
    thread.parts
  );
  if (violations.length > 0) {
    return NextResponse.json(
      { error: "This post breaks network rules for one or more channels", violations },
      { status: 422 }
    );
  }

  await publishPost(id);

  const fresh = await db.socialPost.findUnique({
    where: { id },
    include: {
      campaign: true,
      created_by: { select: { id: true, name: true, email: true } },
      targets: { include: { channel: true } },
    },
  });
  return NextResponse.json({ data: formatSocialPost(fresh) });
}
