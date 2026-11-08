import type { TenantDb } from "@/lib/tenant-db";
import { isManualChannel } from "@/lib/social/manual";
import { charLimitRefusal, type PublishFailure } from "@/lib/social/publish-errors";
import type { SocialPart } from "@/lib/social/parts";

/**
 * The character-limit check at the write seam, for a post about to be saved.
 *
 * Split from `publish-errors.ts` for the reason `sites-server.ts` is split
 * from `sites.ts`: the rule itself has to stay importable by the composer (a
 * client component reads the same limits for its counter), so the Prisma query
 * that loads the channel rows lives out here instead.
 *
 * `overrides` is the EFFECTIVE per-channel copy — on update that means the
 * payload merged over what each target already holds, because a payload that
 * mentions only one channel leaves the others' custom copy in place.
 *
 * Channels are looked up through the tenant-scoped client, so an id from
 * another org simply isn't found and is not checked; whether an unknown
 * channel id is itself an error is a separate question this doesn't answer.
 *
 * `parts` (thread replies, a first comment) are measured too, each the way
 * the channel would send it — see `publishPlan`.
 *
 * Manual channels (G#27) are skipped: a human pastes that copy, nothing calls
 * a provider API, and `validateAgainstNetworkRules` exempts them for the
 * same reason.
 */
export async function charLimitRefusalFor(
  db: TenantDb,
  channelIds: string[],
  body: string,
  overrides: Record<string, string | null | undefined> | null | undefined,
  parts: SocialPart[] = []
): Promise<PublishFailure | null> {
  if (channelIds.length === 0) return null;
  const channels = await db.socialChannel.findMany({
    where: { id: { in: channelIds } },
    select: {
      id: true,
      service_id: true,
      service_name: true,
      account_name: true,
      delivery_mode: true,
    },
  });
  // Keep the caller's order, so which channel a refusal names doesn't depend
  // on how the database happened to return the rows.
  const byId = new Map(channels.map((c) => [c.id, c]));
  const ordered = channelIds
    .map((id) => byId.get(id))
    .filter((c): c is (typeof channels)[number] => Boolean(c))
    .filter((c) => !isManualChannel(c));
  return charLimitRefusal(ordered, body, overrides, parts);
}
