import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requirePermissionApi } from "@/lib/guard";
import { formatSocialPost } from "@/lib/social/format";
import { charLimitRefusalFor } from "@/lib/social/char-limits-server";
import { checkNetworkRules } from "@/lib/social/network-rules";
import { resolveSocialMediaPayload } from "@/lib/social/media-server";
import { storedMedia, storedMediaOverride, type SocialMediaItem } from "@/lib/social/media";
import { parsePartsPayload, socialPostParts } from "@/lib/social/parts";

type Ctx = { params: Promise<{ id: string }> };

const POST_INCLUDE = {
  campaign: true,
  created_by: { select: { id: true, name: true, email: true } },
  source_post: { select: { id: true, title: true, slug: true } },
  targets: { include: { channel: true } },
} as const;

export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const post = await db.socialPost.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data: formatSocialPost(post) });
}

interface UpdatePayload {
  body?: string;
  /** What follows the root; omit to keep the post's, [] or null to clear. */
  parts?: unknown;
  link?: string | null;
  /** Media library items: [{ media_id, alt? }]. A bare url is refused. */
  media?: unknown;
  /** channel_id -> media for that channel only; null clears the override. */
  media_overrides?: unknown;
  scheduled_at?: string | null;
  campaign_id?: string | null;
  channel_ids?: string[];
  body_overrides?: Record<string, string>;
  status?: "draft" | "scheduled" | "archived";
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const existing = await db.socialPost.findUnique({
    where: { id },
    include: { targets: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // G#27: awaiting_manual is deliberately NOT in this list — nothing is in
  // flight for it (no automated call is running, the way "publishing"
  // means), it's a stable holding state, same as "scheduled". Editing lets
  // a human fix a typo before they paste it, or swap out a broken automated
  // channel on a mixed post before retrying — blocking it here (an earlier
  // pass through this PR did) meant a post stuck at awaiting_manual because
  // of one failed automated target could never be edited to fix that target,
  // even though the failure had nothing to do with the manual one.
  if (["publishing", "published"].includes(existing.status)) {
    return NextResponse.json(
      { error: `Cannot edit a ${existing.status} post` },
      { status: 409 }
    );
  }

  const payload = (await req.json()) as UpdatePayload;

  // Every attachment must be a file in this org's media library (resolved
  // through the tenant-scoped db), checked before anything is written.
  // One lookup covers the post's media and every channel's override.
  const resolvedMedia = await resolveSocialMediaPayload(db, payload);
  if (!resolvedMedia.ok) {
    return NextResponse.json({ error: resolvedMedia.message }, { status: 400 });
  }
  const newMedia = resolvedMedia.media;
  const mediaOverridePatch = resolvedMedia.overrides;

  const parsedParts = parsePartsPayload(payload.parts);
  if (!parsedParts.ok) {
    return NextResponse.json({ error: parsedParts.message }, { status: 400 });
  }
  // What the post's root and parts will be after this write. Old X copy keeps
  // its thread as `---` lines in the body; sending `parts` (as the composer
  // does) writes the split form, and a body-only edit keeps reading it split.
  const current = socialPostParts(existing);
  const finalParts = parsedParts.parts ?? current.parts;
  const finalRoot =
    payload.body !== undefined ? payload.body : parsedParts.parts ? current.body : existing.body;

  let status = existing.status;
  if (payload.status === "scheduled") {
    status = actor.permissions.has("content:publish")
      ? "scheduled"
      : "pending_review";
  } else if (payload.status) {
    status = payload.status;
  }

  // Network rules (G#26): a post being scheduled (whether this call is what
  // triggers it, or it was already scheduled and this edit changes the copy
  // or the channels) must not break a target channel's rules — refuse before
  // touching the DB, same as the create path.
  if (status === "scheduled") {
    const finalChannelIds = payload.channel_ids ?? existing.targets.map((t) => t.channel_id);
    const finalBody = finalRoot;
    const finalMedia = newMedia ?? storedMedia(existing.media);
    // Same merge as the copy overrides: the payload names only the channels
    // it changes.
    const finalMediaOverrides: Record<string, SocialMediaItem[] | null> = {};
    for (const t of existing.targets) {
      finalMediaOverrides[t.channel_id] = storedMediaOverride(t.media_override);
    }
    Object.assign(finalMediaOverrides, mediaOverridePatch);
    const finalOverrides: Record<string, string> = {};
    for (const t of existing.targets) {
      if (t.body_override) finalOverrides[t.channel_id] = t.body_override;
    }
    Object.assign(finalOverrides, payload.body_overrides ?? {});
    const violations = await checkNetworkRules(
      db,
      finalChannelIds,
      finalBody,
      finalOverrides,
      finalMedia,
      finalMediaOverrides,
      finalParts
    );
    if (violations.length > 0) {
      return NextResponse.json(
        { error: "This post breaks network rules for one or more channels", violations },
        { status: 422 }
      );
    }
  }

  // Check the POST-UPDATE state against each network's limit BEFORE anything
  // is written: this route reconciles targets, applies overrides and updates
  // the post in three separate statements, so a refusal discovered halfway
  // through would leave the post half-changed. A partial update is the one
  // outcome a writer can't reason about.
  // Scheduling is checked by the network rules above FIRST, so an over-limit
  // schedule keeps answering with their structured 422 `violations` (the
  // contract the MCP tools describe); this catches every other write, drafts
  // included, with a 400 naming the channel.
  const effectiveChannelIds =
    payload.channel_ids ?? existing.targets.map((t) => t.channel_id);
  const effectiveOverrides: Record<string, string | null | undefined> = {};
  for (const target of existing.targets) {
    effectiveOverrides[target.channel_id] = target.body_override;
  }
  // A payload naming only some channels leaves the rest's copy untouched,
  // which is what the write below does — so the check has to see it that way.
  for (const [channelId, override] of Object.entries(
    payload.body_overrides ?? {}
  )) {
    effectiveOverrides[channelId] = override || null;
  }
  const refusal = await charLimitRefusalFor(
    db,
    effectiveChannelIds,
    finalRoot,
    effectiveOverrides,
    finalParts
  );
  if (refusal) {
    return NextResponse.json({ error: refusal.message }, { status: 400 });
  }

  // Reconcile targets when channel_ids is provided.
  if (payload.channel_ids) {
    const want = new Set(payload.channel_ids);
    const have = new Set(existing.targets.map((t) => t.channel_id));
    const toDelete = existing.targets
      .filter((t) => !want.has(t.channel_id))
      .map((t) => t.id);
    const toCreate = payload.channel_ids.filter((c) => !have.has(c));
    await db.$transaction([
      db.socialPostTarget.deleteMany({ where: { id: { in: toDelete } } }),
      db.socialPostTarget.createMany({
        data: toCreate.map((channelId) => ({
          post_id: id,
          channel_id: channelId,
        })),
      }),
    ]);
  }
  if (payload.body_overrides) {
    for (const [channelId, override] of Object.entries(payload.body_overrides)) {
      await db.socialPostTarget.updateMany({
        where: { post_id: id, channel_id: channelId },
        data: { body_override: override || null },
      });
    }
  }

  for (const [channelId, override] of Object.entries(mediaOverridePatch)) {
    await db.socialPostTarget.updateMany({
      where: { post_id: id, channel_id: channelId },
      data: {
        media_override:
          override === null ? Prisma.DbNull : (override as unknown as Prisma.InputJsonValue),
      },
    });
  }

  const post = await db.socialPost.update({
    where: { id },
    data: {
      ...(payload.body !== undefined || parsedParts.parts ? { body: finalRoot } : {}),
      ...(parsedParts.parts
        ? { parts: parsedParts.parts as unknown as Prisma.InputJsonValue }
        : {}),
      ...(payload.link !== undefined ? { link: payload.link || null } : {}),
      ...(newMedia !== undefined
        ? { media: newMedia as unknown as Prisma.InputJsonValue }
        : {}),
      ...(payload.scheduled_at !== undefined
        ? {
            scheduled_at: payload.scheduled_at
              ? new Date(payload.scheduled_at)
              : null,
          }
        : {}),
      ...(payload.campaign_id !== undefined
        ? { campaign_id: payload.campaign_id || null }
        : {}),
      status,
    },
    include: POST_INCLUDE,
  });
  return NextResponse.json({ data: formatSocialPost(post) });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:delete");
  if (error) return error;

  const { id } = await params;
  const existing = await db.socialPost.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await db.socialPost.delete({ where: { id } });
  return NextResponse.json({ data: { deleted: true } });
}
