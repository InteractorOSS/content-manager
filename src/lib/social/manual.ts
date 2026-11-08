/**
 * Manual delivery mode (G#27): a SocialChannel with no API access at all —
 * e.g. a personal Facebook profile, which Meta's Graph API only lets you
 * post to via a Page, never on a person's behalf. A manual channel skips
 * Interactor Core entirely: publisher.ts routes its targets to
 * "awaiting_manual" instead of calling executeServiceAction, a human posts
 * the copy themselves on the real platform, and mark_social_post_posted
 * (MCP) / POST /api/social/manual/[targetId]/mark-posted records what they
 * got back. These are the pure decision points, unit-tested in isolation
 * from Prisma and Interactor Core — general on purpose: any service_id can
 * be manual, not just Facebook.
 */

export type DeliveryMode = "automated" | "manual";

export function isManualChannel(channel: { delivery_mode?: string | null }): boolean {
  return channel.delivery_mode === "manual";
}

/** A target can be marked posted only while it is actually waiting on a human. */
export function canMarkPosted(target: { status: string }): boolean {
  return target.status === "awaiting_manual";
}

interface RollupTarget {
  status: string;
}

/**
 * The post-level status implied by its targets' current statuses, or null
 * when nothing should change yet (some target is still pending/publishing —
 * automated work still in flight, so the post stays wherever publishPost put
 * it). Once nothing is in flight:
 *
 *   - any target still awaiting_manual ⇒ "awaiting_manual" (a human still has
 *     something to post; re-derive once they mark it posted)
 *   - otherwise, same published/partially_published/failed rollup
 *     rollUpPostStatus always used, now reachable even when every target
 *     that isn't pending/publishing is awaiting_manual (previously "done"
 *     only counted published+failed+skipped, so an all-manual post could
 *     never resolve out of "publishing").
 */
export function deriveRolledUpStatus(targets: RollupTarget[]): string | null {
  if (targets.length === 0) return null;

  const inFlight = targets.some((t) => t.status === "pending" || t.status === "publishing");
  if (inFlight) return null;

  const awaitingManualCount = targets.filter((t) => t.status === "awaiting_manual").length;
  if (awaitingManualCount > 0) return "awaiting_manual";

  const publishedCount = targets.filter((t) => t.status === "published").length;
  const failedCount = targets.filter((t) => t.status === "failed").length;
  if (failedCount === 0) return "published";
  if (publishedCount > 0) return "partially_published";
  return "failed";
}
