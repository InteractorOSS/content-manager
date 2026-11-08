/**
 * The Interactor Core identity a channel's credential lives under.
 *
 * Core scopes every stored third-party credential to an `external_user_id`,
 * and `/execute` picks the credential for the identity it is handed. We used
 * to pass the *connecting person's* user id, which has two failure modes:
 *
 *   - the channel is really owned by the org, not the person, so it dies the
 *     day that person leaves; and
 *   - connect two accounts on the same network under one identity and Core has
 *     two candidate credentials for the same service, with no way to say which
 *     one a publish meant.
 *
 * One Core identity per CHANNEL fixes both: the default credential for
 * `cms-ch-<channelId>` is unambiguous by construction. Punchlist T7 sketches an
 * org-grain `cms-org-<org_id>` instead; that keeps the two-accounts ambiguity,
 * so we deliberately pick channel grain.
 *
 * NOT a migration. `publishTarget` reads `target.channel.external_user_id`
 * straight off the row (src/lib/social/publisher.ts), so channels connected
 * before this — whose identity is still the connecting user's id — keep
 * publishing against exactly the credential they always did. Nothing rewrites
 * those rows, and nothing should: their credential lives under the old
 * identity in Core, and renaming our copy would orphan it.
 */

/** Prefix that marks a Core identity as "one CMS social channel". */
export const CHANNEL_IDENTITY_PREFIX = "cms-ch-";

/** The Core `external_user_id` for a channel, by its own id. */
export function channelExternalUserId(channelId: string): string {
  return `${CHANNEL_IDENTITY_PREFIX}${channelId}`;
}
