/**
 * Plain language for every way the members admin (`/members`) can fail — BOTH
 * tabs. The invitations tab used to render `ApiError.message` straight to the
 * page, which is how the words below got written in the first place: the
 * guard's "Forbidden" and the client's "HTTP 502" are exactly the two strings
 * it would have shown.
 *
 * The route handlers already answer a *domain* refusal with a sentence a
 * person can act on — "Only the organization's owner can change the owner's
 * role", "That person isn't a member of this organization" (see
 * src/lib/member-roles.ts and the users routes). Those pass straight through.
 *
 * What does NOT pass through is everything underneath them, and that is the
 * reason this module exists rather than the component rendering `error.message`:
 *
 *   - `requirePermission()` answers 401/403 with the bare words "Unauthorized"
 *     and "Forbidden" (src/lib/guard.ts) — system jargon, and on the 403 the
 *     missing permission name is machine text nobody outside the codebase can
 *     read.
 *   - `submissionsRequest()` falls back to the literal string `HTTP 502` when a
 *     failure has no JSON body — a proxy error page, a crashed route. A raw
 *     status code must never reach a user.
 *   - A 500 body is whatever threw. Prisma's own message is a plausible value,
 *     so a 5xx is replaced wholesale rather than trusted.
 *   - `fetch` rejecting (offline, DNS, aborted) is not an ApiError at all and
 *     arrives as "Failed to fetch".
 *
 * Every result also names ONE concrete next action, because a message with no
 * way forward strands the reader on the failure (org design guide).
 *
 * Pure — no React, no fetch — so the mapping is unit-tested directly.
 */

/** What the UI should offer alongside the message. */
export type MemberFailureAction =
  /** Re-run what just failed; the button re-submits or refetches. */
  | "retry"
  /** The row is stale — reload the list so it matches the server. */
  | "refresh"
  /** The session is gone; send them to sign in again. */
  | "signin"
  /** The message itself already says what to do (ask an owner, pick a role). */
  | "none";

export interface MemberFailure {
  message: string;
  action: MemberFailureAction;
}

/**
 * Which operation failed. Both tabs of `/members` map through here, so the key
 * says what the reader was doing — "nothing changed" is only reassuring when it
 * names the thing that didn't change.
 */
export type MemberOperation =
  /** Reading the member list. */
  | "load"
  /** Changing a member: their role, their status, removing them. */
  | "save"
  /** Reading the invitation list. */
  | "invitations_load"
  /** Creating an invitation. */
  | "invite"
  /** Extending a pending invitation's expiry. */
  | "resend"
  /** Revoking a pending invitation. */
  | "revoke";

/**
 * The four sentences every operation needs. Written per operation rather than
 * assembled from fragments: "The invitation wasn't created and nothing was
 * sent" is not "The role didn't save" with a noun swapped, and a reader in the
 * middle of a failure is owed the specific sentence.
 */
interface OperationPhrases {
  /** The request never reached a route handler (offline, DNS, aborted). */
  offline: string;
  /** The session is gone. */
  expired: string;
  /** It failed for a reason the reader can do nothing with (5xx, opaque). */
  failed: string;
  /** They lack the permission, and the route said so in machine words. */
  forbidden: string;
}

const PHRASES: Record<MemberOperation, OperationPhrases> = {
  load: {
    offline: "Can't reach the CMS. Check your connection, then try again.",
    expired: "Your session has ended. Sign in again to see who's in this organization.",
    failed: "The member list didn't load. Try again in a moment.",
    forbidden:
      "You don't have permission to see this organization's members. Ask an administrator for access.",
  },
  save: {
    offline: "Can't reach the CMS, so nothing changed. Check your connection, then try again.",
    expired: "Your session has ended, so nothing changed. Sign in again and reapply the role.",
    failed: "The role didn't save and nothing changed. Try again in a moment.",
    forbidden:
      "You don't have permission to change roles in this organization. Ask an administrator or the organization's owner to make this change.",
  },
  invitations_load: {
    offline: "Can't reach the CMS. Check your connection, then try again.",
    expired: "Your session has ended. Sign in again to see this organization's invitations.",
    failed: "The invitation list didn't load. Try again in a moment.",
    forbidden:
      "You don't have permission to see this organization's invitations. Ask an administrator for access.",
  },
  invite: {
    offline:
      "Can't reach the CMS, so no invitation was created. Check your connection, then try again.",
    expired:
      "Your session has ended, so no invitation was created. Sign in again and invite them.",
    failed: "The invitation wasn't created and nothing was sent. Try again in a moment.",
    forbidden:
      "You don't have permission to invite people to this organization. Ask an administrator or the organization's owner to send this invitation.",
  },
  resend: {
    offline:
      "Can't reach the CMS, so the invitation is unchanged. Check your connection, then try again.",
    expired: "Your session has ended, so the invitation is unchanged. Sign in again and extend it.",
    failed: "The invitation's expiry wasn't extended. Try again in a moment.",
    forbidden:
      "You don't have permission to change this organization's invitations. Ask an administrator or the organization's owner to make this change.",
  },
  revoke: {
    offline:
      "Can't reach the CMS, so the invitation is still active. Check your connection, then try again.",
    expired:
      "Your session has ended, so the invitation is still active. Sign in again and revoke it.",
    failed: "The invitation wasn't revoked and is still active. Try again in a moment.",
    forbidden:
      "You don't have permission to change this organization's invitations. Ask an administrator or the organization's owner to make this change.",
  },
};

/**
 * Messages that carry no meaning for a reader: the guard's bare status words
 * and anything that is only a status line.
 */
const OPAQUE = new Set([
  "Unauthorized",
  "Forbidden",
  "Not Found",
  "Bad Request",
  "Internal Server Error",
]);

function isOpaque(message: string): boolean {
  const trimmed = message.trim();
  return trimmed === "" || OPAQUE.has(trimmed) || /^HTTP \d{3}$/.test(trimmed);
}

/** An ApiError without importing it — `@/lib/api` pulls in the whole client. */
function statusOf(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export function describeMemberFailure(
  error: unknown,
  operation: MemberOperation
): MemberFailure {
  const status = statusOf(error);
  const phrases = PHRASES[operation];

  // No status at all: the request never reached a route handler.
  if (status === null) {
    return { message: phrases.offline, action: "retry" };
  }

  if (status === 401) {
    return { message: phrases.expired, action: "signin" };
  }

  // A 5xx body is whatever threw inside the route — never shown.
  if (status >= 500) {
    return { message: phrases.failed, action: "retry" };
  }

  const message = messageOf(error);

  if (status === 403 && isOpaque(message)) {
    return { message: phrases.forbidden, action: "none" };
  }

  if (isOpaque(message)) {
    return { message: phrases.failed, action: "retry" };
  }

  // A route's own sentence: written for a person, and already ending in what
  // to do. A 404 is the one that also needs the list refreshed — the row on
  // screen names somebody the server no longer has in this organization.
  return { message, action: status === 404 ? "refresh" : "none" };
}
