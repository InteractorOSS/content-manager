import { getAdapter } from "@/lib/social/capabilities";
import { isManualChannel } from "@/lib/social/manual";

/**
 * Destinations: the places a post's social copy can go.
 *
 * One OAuth connection can post to several places — three Facebook Pages,
 * five Slack channels, two subreddits. Each place is one SocialChannel row;
 * the rows of one connection share `external_user_id` (their Core identity)
 * and `credential_id`. This module is the vocabulary for that: which network
 * a destination belongs to, whether it can be posted to right now, and which
 * destinations a given post goes to.
 *
 * Client-safe (no `server-only`, no Prisma): the channels page, the writer's
 * Social tab and the server all read the same rules.
 */

/**
 * The networks a post can carry copy for. Wider than the AI fan-out's three
 * (`SOCIAL_NETWORKS` in social-networks.ts, pinned to the prompts that exist):
 * a person can write Reddit or Slack copy by hand even though no prompt
 * generates it.
 */
export const DRAFT_NETWORKS = [
  "linkedin",
  "twitter",
  "facebook",
  "instagram",
  "reddit",
  "slack",
] as const;
export type DraftNetwork = (typeof DRAFT_NETWORKS)[number];

export function isDraftNetwork(value: string): value is DraftNetwork {
  return (DRAFT_NETWORKS as readonly string[]).includes(value);
}

/** The SocialChannel.service_id each network's copy is published through. */
const NETWORK_SERVICE: Record<DraftNetwork, string> = {
  linkedin: "linkedin",
  twitter: "twitter",
  facebook: "facebook-graph-api",
  instagram: "instagram",
  reddit: "reddit",
  slack: "slack",
};

export const DRAFT_NETWORK_LABELS: Record<DraftNetwork, string> = {
  linkedin: "LinkedIn",
  twitter: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  reddit: "Reddit",
  slack: "Slack",
};

/**
 * What the Social tab's counter warns at. Tighter than the adapters' hard
 * limits on purpose for the feed networks (a post that fills LinkedIn's 3000
 * characters reads badly); for X it is per tweet.
 */
export const DRAFT_LIMITS: Record<DraftNetwork, number> = {
  linkedin: 2800,
  twitter: 280,
  facebook: 1500,
  instagram: 2200,
  reddit: 10000,
  slack: 4000,
};

export function serviceForNetwork(network: DraftNetwork): string {
  return NETWORK_SERVICE[network];
}

export function networkForService(serviceId: string): DraftNetwork | null {
  const hit = DRAFT_NETWORKS.find((n) => NETWORK_SERVICE[n] === serviceId);
  return hit ?? null;
}

/**
 * The network a channel's copy is written for.
 *
 * An automated channel is its service. A manual channel has no service — its
 * `service_id` is a slug of whatever the person typed ("Facebook (personal
 * profile)" → `facebook-personal-profile`) — so the network is read out of
 * that name. One that names no network we write copy for belongs to none, and
 * is not offered as a place for a post's copy.
 */
export function networkForChannel(channel: {
  service_id: string;
  service_name?: string | null;
  delivery_mode?: string | null;
}): DraftNetwork | null {
  if (!isManualChannel(channel)) return networkForService(channel.service_id);
  const words = `${channel.service_id} ${channel.service_name ?? ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (words.includes("linkedin")) return "linkedin";
  if (words.includes("twitter") || words.includes("x")) return "twitter";
  if (words.includes("facebook") || words.includes("fb")) return "facebook";
  if (words.includes("instagram") || words.includes("ig")) return "instagram";
  if (words.includes("reddit")) return "reddit";
  if (words.includes("slack")) return "slack";
  return null;
}

/** The fields of a SocialChannel row these rules read. */
export interface DestinationChannel {
  id: string;
  service_id: string;
  status: string;
  account_id: string | null;
  default_target: boolean;
  delivery_mode?: string | null;
}

/**
 * Whether copy can go to a destination right now.
 *
 *  - `ready`: connected and it names where to post.
 *  - `trouble`: the connection needs attention (the network expired or refused
 *    its token) but still exists. Shown greyed out — the choice is kept, and
 *    it starts working again when the channel is reconnected.
 *  - `unavailable`: not something to offer at all — never finished connecting,
 *    was revoked at the network, or is a connection with no page/channel
 *    chosen yet.
 */
export type DestinationState = "ready" | "trouble" | "unavailable";

export function destinationState(channel: DestinationChannel): DestinationState {
  if (channel.status === "pending" || channel.status === "revoked") return "unavailable";
  if (!isManualChannel(channel)) {
    const adapter = getAdapter(channel.service_id);
    if (adapter?.requiresAccountId && !channel.account_id) return "unavailable";
  }
  return channel.status === "active" ? "ready" : "trouble";
}

/**
 * The destination ids a post goes to: its own choice when it made one,
 * otherwise every destination marked as a default. An override naming a
 * destination that no longer exists simply drops it.
 */
export function selectedDestinationIds(
  channels: DestinationChannel[],
  override: readonly string[] | null
): Set<string> {
  const offered = channels.filter((c) => destinationState(c) !== "unavailable");
  if (override) {
    const wanted = new Set(override);
    return new Set(offered.filter((c) => wanted.has(c.id)).map((c) => c.id));
  }
  return new Set(offered.filter((c) => c.default_target).map((c) => c.id));
}

/** A stored `Post.social_destinations` value as a list of ids, or null. */
export function parseDestinationOverride(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}
