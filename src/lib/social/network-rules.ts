import { validateAgainstNetworkRules, type NetworkRuleViolation } from "./capabilities";
import { resolveTargetMedia } from "./media";
import type { SocialPart } from "./parts";

interface ChannelLookupDb {
  socialChannel: {
    findMany: (args: {
      where: { id: { in: string[] } };
    }) => Promise<
      {
        id: string;
        service_id: string;
        service_name: string;
        account_id: string | null;
        delivery_mode?: string | null;
      }[]
    >;
  };
}

/**
 * Every network-rule violation the given channels + candidate copy would hit
 * — character limit, missing account id, missing required media, too many
 * images/videos for the network (G#26:
 * capabilities.ts's `validateAgainstNetworkRules`, resolved against the real
 * channel rows). Call before a post moves to "scheduled" (POST/PUT
 * /api/social/posts) and again right before publish (POST .../publish) — a
 * violation caught here is a 422 with a clear reason; caught only by
 * publisher.ts it's a network round-trip that ends in a silently `failed`
 * target with a provider error string nobody asked for.
 */
export async function checkNetworkRules(
  db: ChannelLookupDb,
  channelIds: string[],
  body: string,
  bodyOverrides: Record<string, string> | undefined,
  media: unknown,
  /** Per-channel media that replaces `media` for that channel (punchlist S1);
   * absent or null means the channel publishes the post's media. */
  mediaOverrides?: Record<string, unknown>,
  /** The post's thread replies and first comment, shared by every channel. */
  parts: SocialPart[] = []
): Promise<NetworkRuleViolation[]> {
  if (channelIds.length === 0) return [];
  const channels = await db.socialChannel.findMany({ where: { id: { in: channelIds } } });
  const violations: NetworkRuleViolation[] = [];
  for (const channel of channels) {
    const override = bodyOverrides?.[channel.id];
    const candidateBody = override && override.trim() ? override : body;
    // The same rule the publisher uses, so a channel is checked against the
    // media it would actually send.
    const candidateMedia = resolveTargetMedia(
      { media_override: mediaOverrides?.[channel.id] },
      { media }
    );
    violations.push(
      ...validateAgainstNetworkRules(channel, { body: candidateBody, parts, media: candidateMedia })
    );
  }
  return violations;
}
