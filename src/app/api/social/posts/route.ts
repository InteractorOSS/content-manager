import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requirePermissionApi } from "@/lib/guard";
import { formatSocialPost } from "@/lib/social/format";
import { charLimitRefusalFor } from "@/lib/social/char-limits-server";
import { checkNetworkRules } from "@/lib/social/network-rules";
import { resolveSocialMediaPayload } from "@/lib/social/media-server";
import { parsePartsPayload } from "@/lib/social/parts";

const POST_INCLUDE = {
  campaign: true,
  created_by: { select: { id: true, name: true, email: true } },
  source_post: { select: { id: true, title: true, slug: true } },
  targets: { include: { channel: true } },
} as const;

export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const channelId = sp.get("channel_id");
  const campaignId = sp.get("campaign_id");
  const from = sp.get("from");
  const to = sp.get("to");

  const posts = await db.socialPost.findMany({
    where: {
      ...(status ? { status: { in: status.split(",") } } : {}),
      ...(campaignId ? { campaign_id: campaignId } : {}),
      ...(channelId ? { targets: { some: { channel_id: channelId } } } : {}),
      ...(from || to
        ? {
            scheduled_at: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    include: POST_INCLUDE,
    orderBy: [{ scheduled_at: "asc" }, { inserted_at: "desc" }],
    take: 500,
  });
  return NextResponse.json({ data: posts.map(formatSocialPost) });
}

interface PostPayload {
  body?: string;
  /** What follows the root: [{ kind: "thread" | "first_comment", body }]. */
  parts?: unknown;
  link?: string | null;
  /** Media library items: [{ media_id, alt? }]. A bare url is refused. */
  media?: unknown;
  /** channel_id -> media for that channel only (null = use `media`). */
  media_overrides?: unknown;
  scheduled_at?: string | null;
  campaign_id?: string | null;
  channel_ids?: string[];
  body_overrides?: Record<string, string>; // channel_id -> custom copy
  status?: "draft" | "scheduled";
}

export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const payload = (await req.json()) as PostPayload;
  const channelIds = payload.channel_ids ?? [];
  if (!payload.body?.trim() && !payload.link) {
    return NextResponse.json(
      { error: "Post body or link is required" },
      { status: 422 }
    );
  }

  // Every attachment must be a file in this org's media library, resolved
  // through the tenant-scoped db — before anything else reads the media.
  // One lookup covers the post's media and every channel's override.
  const resolvedMedia = await resolveSocialMediaPayload(db, payload);
  if (!resolvedMedia.ok) {
    return NextResponse.json({ error: resolvedMedia.message }, { status: 400 });
  }
  const postMedia = resolvedMedia.media ?? [];
  const mediaOverrides = resolvedMedia.overrides;

  const parsedParts = parsePartsPayload(payload.parts);
  if (!parsedParts.ok) {
    return NextResponse.json({ error: parsedParts.message }, { status: 400 });
  }
  const parts = parsedParts.parts ?? [];

  const wantsSchedule = payload.status === "scheduled";
  if (wantsSchedule && channelIds.length === 0) {
    return NextResponse.json(
      { error: "Select at least one channel to schedule" },
      { status: 422 }
    );
  }
  if (wantsSchedule && !payload.scheduled_at) {
    return NextResponse.json(
      { error: "scheduled_at is required to schedule" },
      { status: 422 }
    );
  }

  // Network rules (G#26): refuse a schedule request that would fail on the
  // provider — over the char limit, or a channel missing what it requires.
  if (wantsSchedule) {
    const violations = await checkNetworkRules(
      db,
      channelIds,
      payload.body ?? "",
      payload.body_overrides,
      postMedia,
      mediaOverrides,
      parts
    );
    if (violations.length > 0) {
      return NextResponse.json(
        { error: "This post breaks network rules for one or more channels", violations },
        { status: 422 }
      );
    }
  }

  // A body no selected network will accept is refused HERE, where the writer
  // can still fix it. Stored, it only surfaces days later as an opaque
  // provider rejection inside publishTarget. The composer shows the same
  // limits, but REST, MCP and any fan-out caller never see that counter.
  // Scheduling is checked by the network rules above FIRST, so an over-limit
  // schedule keeps answering with their structured 422 `violations` (the
  // contract the MCP tools describe); this catches every other write, drafts
  // included, with a 400 naming the channel.
  const refusal = await charLimitRefusalFor(
    db,
    channelIds,
    payload.body ?? "",
    payload.body_overrides,
    parts
  );
  if (refusal) {
    return NextResponse.json({ error: refusal.message }, { status: 400 });
  }

  // Scheduling publishes content — respect the approval workflow: authors
  // without content:publish submit for review instead.
  let status = "draft";
  if (wantsSchedule) {
    status = actor.permissions.has("content:publish")
      ? "scheduled"
      : "pending_review";
  }

  const post = await db.socialPost.create({
    data: {
      body: payload.body ?? "",
      link: payload.link || null,
      media: postMedia as unknown as Prisma.InputJsonValue,
      parts: parts as unknown as Prisma.InputJsonValue,
      status,
      scheduled_at: payload.scheduled_at ? new Date(payload.scheduled_at) : null,
      campaign_id: payload.campaign_id || null,
      created_by_id: actor.user.id,
      targets: {
        create: channelIds.map((channelId) => ({
          channel_id: channelId,
          body_override: payload.body_overrides?.[channelId] || null,
          ...(mediaOverrides[channelId]
            ? {
                media_override: mediaOverrides[channelId] as unknown as Prisma.InputJsonValue,
              }
            : {}),
        })),
      },
    },
    include: POST_INCLUDE,
  });

  return NextResponse.json({ data: formatSocialPost(post) }, { status: 201 });
}
