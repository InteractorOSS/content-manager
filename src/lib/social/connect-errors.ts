/**
 * Plain language for every way connecting a social channel can come back
 * unfinished.
 *
 * The connect flow ends with a full-page redirect from Interactor Core back to
 * `/social/channels?connected=0&reason=<code>`, so the reason arrives as a
 * machine token in a URL. `/social/channels` used to render that token straight
 * into a toast — a reader got the literal words "missing_params", which says
 * nothing about what happened, whether anything was changed, or what to do.
 *
 * Every code maps to three things here (org design guide,
 * /o/interactoross/settings/design-guide): what happened, that the channel was
 * NOT connected, and the one next step. An unrecognised code — an older build's
 * redirect still in flight, or a hand-edited URL — falls back to the generic
 * sentence rather than leaking the token.
 *
 * Pure: no React, no fetch, so both the page and the tests read the same words.
 */

/** Why the connect flow came back without an active channel. */
export type ChannelConnectReason =
  /** Core sent the browser back without the ids needed to finish. */
  | "missing_details"
  /** No channel with that id in any organization this person belongs to. */
  | "channel_not_found"
  /** They are a member of the channel's org, but may not connect channels there. */
  | "no_permission"
  /** Core wouldn't tell us about the account that was just authorized. */
  | "account_unverified"
  /** The authorized account isn't the one this channel was started for. */
  | "account_mismatch"
  /** The network itself turned the connection down, or the reader cancelled. */
  | "provider_refused";

/** What the page should offer alongside the message. */
export type ChannelConnectAction =
  /** Start the connection again; the button reopens the connect dialog. */
  | "retry"
  /** The sentence itself says what to do (ask an admin). */
  | "none";

export interface ChannelConnectFailure {
  message: string;
  action: ChannelConnectAction;
}

const FAILURES: Record<ChannelConnectReason, ChannelConnectFailure> = {
  missing_details: {
    message:
      "Interactor sent you back without saying which account you authorized, so nothing was connected. Start the connection again.",
    action: "retry",
  },
  channel_not_found: {
    message:
      "We couldn't find the channel you started connecting, so nothing was connected. It may have been removed while you were authorizing, or you may be signed in as someone else. Start the connection again.",
    action: "retry",
  },
  no_permission: {
    message:
      "You don't have permission to connect channels in the organization this channel belongs to, so nothing was connected. Ask that organization's owner or an administrator to connect it.",
    action: "none",
  },
  account_unverified: {
    message:
      "We couldn't confirm the account you just authorized with Interactor, so the channel is still waiting and nothing was connected. Start the connection again in a moment.",
    action: "retry",
  },
  account_mismatch: {
    message:
      "The account you authorized isn't the one this channel was started for, so nothing was connected. Start the connection again and pick the right account.",
    action: "retry",
  },
  provider_refused: {
    message:
      "The network didn't approve the connection, so nothing was connected. That happens when you press Cancel on its sign-in page, or when the account you used isn't allowed to connect this app. Start the connection again, signed in to the account you want to post from.",
    action: "retry",
  },
};

const UNKNOWN: ChannelConnectFailure = {
  message:
    "The connection didn't finish, so nothing was connected. Start the connection again.",
  action: "retry",
};

/** Map a `?reason=` token from the connect callback to words and one action. */
export function describeChannelConnectFailure(
  reason: string | null | undefined
): ChannelConnectFailure {
  if (!reason) return UNKNOWN;
  return FAILURES[reason as ChannelConnectReason] ?? UNKNOWN;
}
