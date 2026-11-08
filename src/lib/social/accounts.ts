import "server-only";
import { getAdapter, type DiscoveredAccount } from "@/lib/social/capabilities";
import { channelExecute, type ExecutingChannel } from "@/lib/social/core-execute";

/**
 * The accounts a connected channel's credential can publish to — the Pages a
 * Facebook user manages, the channels of a Slack workspace, the LinkedIn
 * member plus every organization they administer, the Instagram business
 * accounts linked to the sign-in's Pages.
 *
 * `null` means the question does not apply: the service has no way to list
 * its accounts (a subreddit is typed, not owned), so the caller should keep
 * its free-text field rather than show an empty picker. An array — possibly
 * empty — means the provider was asked, as the channel's own `credential_id`.
 */
export async function discoverChannelAccounts(
  channel: ExecutingChannel
): Promise<DiscoveredAccount[] | null> {
  const adapter = getAdapter(channel.service_id);
  if (!adapter?.discoverAccounts) return null;
  return adapter.discoverAccounts(channelExecute(channel));
}
