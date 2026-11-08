import { Prisma } from "@prisma/client";
import type { TenantDb } from "@/lib/tenant-db";
import {
  destinationState,
  isDraftNetwork,
  networkForChannel,
  parseDestinationOverride,
  selectedDestinationIds,
  type DestinationState,
  type DraftNetwork,
} from "@/lib/social/destinations";

// Where a post's social copy goes, and the link it carries back.
//
// The copy itself is one draft per network (src/lib/post-social.ts). This
// module decides the two things that turn a draft into something the Social
// queue can publish: its targets (one per chosen destination of that network)
// and its `link` (the post's public URL, so a reader of the social post can
// click through to the article).
//
// Only a draft still at "draft" is touched. Once copy has been submitted,
// scheduled or sent, its targets are what somebody reviewed — changing them
// here would silently change what was approved.

export type PostDestination = {
  id: string;
  network: DraftNetwork;
  service_name: string;
  account_name: string | null;
  state: Exclude<DestinationState, "unavailable">;
  /** A person posts this one by hand from the manual queue. */
  manual: boolean;
  /** Whether this post's copy goes here. */
  selected: boolean;
  /** Whether it would without a per-post choice. */
  is_default: boolean;
};

export type PostDestinations = {
  destinations: PostDestination[];
  /** True when this post chose its own destinations instead of the defaults. */
  overridden: boolean;
  /** The link the social copy carries, or null when the post has no public URL yet. */
  backlink: string | null;
};

type ChannelRow = {
  id: string;
  service_id: string;
  service_name: string;
  account_name: string | null;
  account_id: string | null;
  status: string;
  default_target: boolean;
  delivery_mode: string;
};

type PostRow = {
  id: string;
  slug: string;
  canonical_url: string | null;
  platforms: string[];
  social_destinations: unknown;
};

async function loadPost(db: TenantDb, postId: string): Promise<PostRow | null> {
  return (await db.post.findUnique({
    where: { id: postId },
    select: { id: true, slug: true, canonical_url: true, platforms: true, social_destinations: true },
  })) as PostRow | null;
}

async function loadChannels(db: TenantDb): Promise<ChannelRow[]> {
  return (await db.socialChannel.findMany({
    orderBy: [{ service_name: "asc" }, { account_name: "asc" }],
    select: {
      id: true,
      service_id: true,
      service_name: true,
      account_name: true,
      account_id: true,
      status: true,
      default_target: true,
      delivery_mode: true,
    },
  })) as ChannelRow[];
}

/**
 * The post's public URL: its canonical URL when it has one, otherwise its
 * place on the first of its sites that is registered with a base URL. Null
 * when neither exists — better no link than one that 404s.
 */
export async function postBacklink(db: TenantDb, post: PostRow): Promise<string | null> {
  const canonical = post.canonical_url?.trim();
  if (canonical) return canonical;
  if (post.platforms.length === 0) return null;

  const sites = (await db.site.findMany({
    where: { slug: { in: post.platforms } },
    select: { slug: true, url: true },
  })) as { slug: string; url: string | null }[];
  for (const slug of post.platforms) {
    const url = sites.find((s) => s.slug === slug)?.url?.trim();
    if (url) return `${url.replace(/\/+$/, "")}/${post.slug}`;
  }
  return null;
}

/** Every destination this post could go to, with which ones it does. */
export async function listPostDestinations(db: TenantDb, postId: string): Promise<PostDestinations | null> {
  const post = await loadPost(db, postId);
  if (!post) return null;
  const channels = await loadChannels(db);
  const override = parseDestinationOverride(post.social_destinations);
  const selected = selectedDestinationIds(channels, override);

  const destinations = channels.flatMap((c): PostDestination[] => {
    const network = networkForChannel(c);
    const state = destinationState(c);
    if (!network || state === "unavailable") return [];
    return [
      {
        id: c.id,
        network,
        service_name: c.service_name,
        account_name: c.account_name,
        state,
        manual: c.delivery_mode === "manual",
        selected: selected.has(c.id),
        is_default: c.default_target,
      },
    ];
  });

  return { destinations, overridden: override !== null, backlink: await postBacklink(db, post) };
}

/**
 * Record this post's own choice of destinations (`null` goes back to the
 * channels' defaults), then bring its drafts in line. Ids that aren't this
 * organization's channels are dropped rather than stored.
 */
export async function setPostDestinations(
  db: TenantDb,
  postId: string,
  channelIds: string[] | null
): Promise<PostDestinations | null> {
  let stored: string[] | null = null;
  if (channelIds) {
    const known = new Set((await loadChannels(db)).map((c) => c.id));
    stored = [...new Set(channelIds)].filter((id) => known.has(id));
  }
  const current = (await db.post.findUnique({
    where: { id: postId },
    select: { updated_at: true },
  })) as { updated_at: Date } | null;
  if (!current) return null;
  await db.post.update({
    where: { id: postId },
    data: {
      // Prisma needs its own null marker for a JSON column; undefined would
      // leave the old override in place.
      social_destinations: stored === null ? Prisma.DbNull : stored,
      // `updated_at` is the post's edit version: the writer editor sends it
      // as If-Match and treats a change as "someone else edited this". Where
      // the social copy goes is not an edit to the post, so the version must
      // not move — @updatedAt would otherwise bump it on every tick of a box.
      updated_at: current.updated_at,
    },
  });
  await syncPostSocialDelivery(db, postId);
  return listPostDestinations(db, postId);
}

/**
 * Make every still-editable draft of the post match its destinations and
 * carry the backlink. Safe to call any time; a draft that already matches is
 * left alone.
 */
export async function syncPostSocialDelivery(db: TenantDb, postId: string): Promise<void> {
  const post = await loadPost(db, postId);
  if (!post) return;
  const channels = await loadChannels(db);
  const selected = selectedDestinationIds(channels, parseDestinationOverride(post.social_destinations));
  const backlink = await postBacklink(db, post);

  const drafts = (await db.socialPost.findMany({
    where: { source_post_id: postId, status: "draft" },
    select: { id: true, network: true, link: true, targets: { select: { id: true, channel_id: true, status: true } } },
  })) as {
    id: string;
    network: string | null;
    link: string | null;
    targets: { id: string; channel_id: string; status: string }[];
  }[];

  for (const draft of drafts) {
    if (!draft.network || !isDraftNetwork(draft.network)) continue;

    const wanted = channels
      .filter((c) => selected.has(c.id) && networkForChannel(c) === draft.network)
      .map((c) => c.id);
    const have = new Set(draft.targets.map((t) => t.channel_id));
    const toAdd = wanted.filter((id) => !have.has(id));
    // Only a target that has never been attempted is ours to remove.
    const toRemove = draft.targets.filter((t) => !wanted.includes(t.channel_id) && t.status === "pending");

    if (toRemove.length > 0) {
      await db.socialPostTarget.deleteMany({ where: { id: { in: toRemove.map((t) => t.id) } } });
    }
    if (toAdd.length > 0) {
      await db.socialPostTarget.createMany({
        data: toAdd.map((channel_id) => ({ post_id: draft.id, channel_id })),
      });
    }
    if (backlink && draft.link !== backlink) {
      await db.socialPost.update({ where: { id: draft.id }, data: { link: backlink } });
    }
  }
}

/** Validate a destinations save: `{ channel_ids: string[] | null }`. */
export function parseDestinationsSave(input: unknown): { channelIds: string[] | null } | { error: string } {
  const value = (input ?? {}) as { channel_ids?: unknown };
  if (value.channel_ids === null) return { channelIds: null };
  if (!Array.isArray(value.channel_ids) || value.channel_ids.some((id) => typeof id !== "string")) {
    return { error: "channel_ids must be a list of channel ids, or null to use the channels' defaults" };
  }
  if (value.channel_ids.length > 200) return { error: "channel_ids is longer than 200 entries" };
  return { channelIds: value.channel_ids as string[] };
}
