/**
 * Plain language for every way publishing one social target can go wrong, and
 * the one decision the publisher needs from a failure: try again, or stop.
 *
 * `SocialPostTarget.error` is read straight into the queue board, so what the
 * publisher writes there IS the sentence a marketer reads. It used to write
 * `` `${err.status}: ${err.message}` `` — a reader got "502: upstream request
 * failed", which names neither the channel, nor whether the rest of the post
 * went out, nor anything to do next. The wording is decided here, once, at the
 * write seam, so the API, the queue board and any later surface all say the
 * same thing (the pattern src/lib/social/connect-errors.ts and
 * src/lib/member-errors.ts already set).
 *
 * Pure — no Prisma, no React, no `server-only` — because the publisher writes
 * these strings and the queue board renders them, and the two must not drift.
 * `capabilities.ts` is pure for the same reason, so reading the character
 * limits from it here keeps this module importable from the browser.
 */

import {
  planLimitProblems,
  PublishPartError,
  PublishStepError,
  type PublishPartItem,
  type PublishStep,
  type PublishStepItem,
} from "@/lib/social/capabilities";
import type { SocialPart } from "@/lib/social/parts";

/** What the publisher does with a failed attempt. */
export interface PublishFailure {
  /** The sentence stored on the target and shown to the reader. */
  message: string;
  /**
   * Whether another attempt could plausibly succeed. A rate limit or a 5xx is
   * worth retrying; a rejected body or a dead credential is not, and burning
   * two more attempts on it only delays the post reaching a terminal status.
   */
  retryable: boolean;
  /** Core's own `Retry-After`, in seconds, when it sent one. */
  retryAfterSeconds?: number;
}

/** A channel, named the way a person recognises it in the queue. */
export function channelLabel(channel: {
  service_name?: string | null;
  service_id?: string | null;
  account_name?: string | null;
}): string {
  const service = channel.service_name || channel.service_id || "this channel";
  return channel.account_name ? `${service} (${channel.account_name})` : service;
}

/**
 * Why a target was not even attempted: its channel is not connected.
 *
 * Calling Core with an expired or revoked credential can only fail, so the
 * publisher skips the call entirely — but the target still has to land
 * `failed` with a reason, or the post never reaches a terminal status.
 */
export function channelNotConnectedFailure(
  channel: {
    service_name?: string | null;
    service_id?: string | null;
    account_name?: string | null;
  },
  status: string
): PublishFailure {
  const name = channelLabel(channel);
  const why =
    status === "expired"
      ? "its connection has expired"
      : status === "revoked"
        ? "its connection was removed at the network"
        : status === "pending"
          ? "it was never finished connecting"
          : "its connection isn't working";
  return {
    message: `Nothing was posted to ${name} because ${why}. Reconnect it on the Channels page, then retry this post.`,
    retryable: false,
  };
}

/**
 * A body no network will take: it is longer than the service's own limit.
 *
 * The limit itself lives on the adapter (`serviceCharLimit`), which both the
 * composer and the publisher read; this is only the wording. `action` is the
 * one thing that legitimately differs between the two places the refusal
 * surfaces: at the write seam nothing has been stored yet, so the reader
 * shortens and saves; on the queue board the post already exists, so they edit
 * it and retry that channel.
 */
export function overCharLimitFailure(opts: {
  channel: {
    service_name?: string | null;
    service_id?: string | null;
    account_name?: string | null;
  };
  /** Length of the text that is actually too long. */
  length: number;
  limit: number;
  /** True when the too-long text is this channel's own copy, not the shared message. */
  custom: boolean;
  action: "save" | "retry";
  /** Which part of a thread is too long ("Tweet 2 of 3", "The first
   * comment"); absent when the post goes out as one text. */
  part?: string | null;
  /** The text is the message with its thread folded in (a network that
   * doesn't thread gets the whole thread as one post). */
  joined?: boolean;
}): PublishFailure {
  const { channel, length, limit, custom, action, part, joined } = opts;
  const name = channelLabel(channel);
  const service = channel.service_name || channel.service_id || "that network";
  const over = count(length - limit);
  if (part) {
    return {
      message: `${part} for ${name} is ${count(length)} long, and ${service} only accepts ${count(limit)}. Shorten it by ${over}, ${
        action === "save" ? "and save again." : "then retry this channel."
      }`,
      retryable: false,
    };
  }
  const subject = custom ? `The custom copy for ${name}` : "Your message";
  const once = joined ? ` once its thread is joined into one post (${service} doesn't post threads)` : "";
  const next =
    action === "save"
      ? custom
        ? `Shorten it by ${over} and save again.`
        : `Shorten the message by ${over}, or write shorter copy just for ${name}, and save again.`
      : custom
        ? `Shorten it by ${over}, then retry this channel.`
        : `Shorten the message by ${over} — or give ${name} its own shorter copy — then retry this channel.`;
  return {
    message: `${subject} is ${count(length)} long${once}, and ${service} only accepts ${count(limit)}. ${next}`,
    retryable: false,
  };
}

/**
 * The first part of what `channel` would send that is over its network's
 * limit, worded for `action` — or null when every part fits. `body` is
 * the root as this channel sends it (its own copy, or the shared message).
 */
export function partsOverLimitFailure(opts: {
  channel: {
    service_id: string;
    service_name?: string | null;
    account_name?: string | null;
  };
  body: string;
  parts: SocialPart[];
  custom: boolean;
  action: "save" | "retry";
}): PublishFailure | null {
  const problem = planLimitProblems(opts.channel.service_id, opts.body, opts.parts)[0];
  if (!problem) return null;
  return overCharLimitFailure({
    channel: opts.channel,
    length: problem.length,
    limit: problem.limit,
    // A thread part is the post's own, whatever the root's copy is.
    custom: opts.custom && !problem.part,
    action: opts.action,
    part: problem.part,
    joined: problem.joined,
  });
}

/**
 * The first channel on a post whose body is over its network's limit, or null
 * when every selected channel would accept what it is being sent.
 *
 * This is the WRITE-SEAM check: it runs before a post is created or updated,
 * so an over-limit body is refused where the person can still fix it, instead
 * of being stored and turning into an opaque provider rejection days later
 * when the scheduler finally sends it. REST, MCP and the composer all reach
 * the same routes, so all three get the same answer.
 */
export function charLimitRefusal(
  channels: {
    id: string;
    service_id: string;
    service_name?: string | null;
    account_name?: string | null;
  }[],
  body: string,
  /** Per-channel copy, keyed by channel id; a blank value means "use the shared body". */
  overrides: Record<string, string | null | undefined> | null | undefined,
  /** The post's thread replies and first comment; a channel's own copy
   * replaces only the root, never these. */
  parts: SocialPart[] = []
): PublishFailure | null {
  for (const channel of channels) {
    const override = overrides?.[channel.id];
    const custom = Boolean(override && override.trim());
    const failure = partsOverLimitFailure({
      channel,
      body: custom ? override! : body,
      parts,
      custom,
      action: "save",
    });
    if (failure) return failure;
  }
  return null;
}

/** No adapter in this build knows how to publish to that network. */
export function unsupportedServiceFailure(channel: {
  service_name?: string | null;
  service_id?: string | null;
  account_name?: string | null;
}): PublishFailure {
  return {
    message: `Nothing was posted to ${channelLabel(channel)} because this version of the CMS can't publish to that network yet. Remove the channel from this post to publish the rest.`,
    retryable: false,
  };
}

/**
 * Turn whatever the publish attempt threw into a sentence and a verdict.
 *
 * `error` is deliberately structural rather than a `status` sniff on a bare
 * Error: anything that is not an {@link https://developer.mozilla.org/en-US/docs/Web/API/fetch fetch}
 * refusal from Core (an adapter that demanded media the post has none of, a
 * network drop) is treated as retryable only when we can tell it is transient.
 */
export function describePublishError(
  err: unknown,
  channel: {
    service_name?: string | null;
    service_id?: string | null;
    account_name?: string | null;
  }
): PublishFailure {
  const name = channelLabel(channel);
  if (err instanceof PublishStepError) return describeStepFailure(err, name);
  if (err instanceof PublishPartError) return describePartFailure(err, name);
  const core = asCoreError(err);

  if (core) {
    if (core.status === 401 || core.status === 403) {
      return {
        message: `${name} turned the post down because its connection is no longer authorized. Reconnect it on the Channels page, then retry this post.`,
        retryable: false,
      };
    }
    if (core.status === 429) {
      return {
        message: `${name} is rate-limiting us, so the post hasn't gone out yet. It will be tried again automatically.`,
        retryable: true,
        retryAfterSeconds: core.retryAfterSeconds,
      };
    }
    if (core.status >= 500) {
      return {
        message: `${name} couldn't be reached just now. The post hasn't gone out yet and will be tried again automatically.`,
        retryable: true,
        retryAfterSeconds: core.retryAfterSeconds,
      };
    }
    if (core.status === 408 || core.status === 425) {
      return {
        message: `The post to ${name} timed out before it went through. It will be tried again automatically.`,
        retryable: true,
        retryAfterSeconds: core.retryAfterSeconds,
      };
    }
    return {
      message: `${name} rejected this post: ${trimDetail(providerWords(core.message))} Edit the post and retry this channel.`,
      retryable: false,
    };
  }

  // Not a refusal Core described — a dropped connection, an adapter throwing
  // on a post it can't build a call from, a bug. Retry once: a transient
  // network fault is the common case and the attempt cap bounds the cost.
  return {
    message: `The post to ${name} didn't go through: ${trimDetail(messageOf(err))} It will be tried again automatically.`,
    retryable: true,
  };
}

/**
 * Media the network won't take on one post (too many, or a video where it
 * takes photos only). The write routes refuse this before saving; the
 * publisher repeats the check for rows stored before a rule existed, and
 * sends nothing. `problem` is `mediaLimitProblem`'s sentence.
 */
export function mediaRulesFailure(
  channel: {
    service_name?: string | null;
    service_id?: string | null;
    account_name?: string | null;
  },
  problem: string
): PublishFailure {
  return {
    message: `Nothing was posted to ${channelLabel(channel)}. ${problem} Change the images or video for this channel, then retry it.`,
    retryable: false,
  };
}

/** What each step was doing, as the end of "…while ___". */
const STEP_DOING: Record<PublishStep, (what: string) => string> = {
  read_media: (what) => `reading ${what} from your media library`,
  start_upload: (what) => `starting the upload of ${what}`,
  upload_media: (what) => `uploading ${what}`,
  create_container: (what) => `preparing ${what}`,
  create_carousel: () => "putting the carousel together",
};

/** "image 2 of 3 (team.png)", "the video", "that file". */
function describeItem(item: PublishStepItem | null): string {
  if (!item) return "that file";
  const which = item.total > 1 ? `${item.type} ${item.index} of ${item.total}` : `the ${item.type}`;
  return item.name ? `${which} (${item.name})` : which;
}

/**
 * One sentence per step of a media publish (read the file, start the upload,
 * upload it, prepare a container, assemble a carousel), so the queue board
 * says which file and which step instead of only "rejected this post". Every
 * step runs before the post is created, so each one can promise nothing went
 * out — the reader needs that to know retrying won't post twice.
 */
function describeStepFailure(err: PublishStepError, name: string): PublishFailure {
  const what = describeItem(err.item);
  const doing = STEP_DOING[err.step](what);
  const thing = err.item?.type ?? "file";

  if (err.step === "read_media") {
    if (isMissingFile(err.cause)) {
      return {
        message: `Nothing was posted to ${name}: ${what} is no longer in your media library. Pick the file again or remove it from this post, then retry this channel.`,
        retryable: false,
      };
    }
    if (errorNamed(err.cause, "MediaFileRefusedError")) {
      return {
        message: `Nothing was posted to ${name}: ${what} isn't stored in this CMS's media storage, so it can't be sent. Upload the file to the media library, pick it for this post again, then retry this channel.`,
        retryable: false,
      };
    }
    if (errorNamed(err.cause, "MediaStorageNotConfiguredError")) {
      return {
        message: `Nothing was posted to ${name}: media storage isn't set up on this server, so ${what} couldn't be read. Ask an administrator to configure it, then retry this channel.`,
        retryable: false,
      };
    }
    return {
      message: `Nothing has been posted to ${name} yet: we couldn't read ${what} from your media library just now. It will be tried again automatically.`,
      retryable: true,
    };
  }

  const core = asCoreError(err.cause);
  if (!core) {
    return {
      message: `The post to ${name} didn't go through while ${doing}: ${trimDetail(messageOf(err.cause))} Nothing has been posted yet; it will be tried again automatically.`,
      retryable: true,
    };
  }
  if (core.status === 401 || core.status === 403) {
    return {
      message: `${name} turned down ${what} because its connection is no longer authorized, so nothing was posted. Reconnect it on the Channels page, then retry this post.`,
      retryable: false,
    };
  }
  if (core.status === 429) {
    return {
      message: `${name} is rate-limiting us while ${doing}, so nothing has been posted yet. It will be tried again automatically.`,
      retryable: true,
      retryAfterSeconds: core.retryAfterSeconds,
    };
  }
  if (core.status >= 500 || core.status === 408 || core.status === 425) {
    return {
      message: `${name} couldn't be reached while ${doing}, so nothing has been posted yet. It will be tried again automatically.`,
      retryable: true,
      retryAfterSeconds: core.retryAfterSeconds,
    };
  }

  const detail = trimDetail(providerWords(core.message));
  const replace = `Replace that ${thing} or remove it from this channel, then retry this channel.`;
  const refused: Record<PublishStep, string> = {
    read_media: "", // handled above
    start_upload: `${name} wouldn't start the upload of ${what}: ${detail} Nothing was posted. ${replace}`,
    upload_media: `${name} didn't accept ${what}: ${detail} Nothing was posted. ${replace}`,
    create_container: `${name} couldn't use ${what}: ${detail} Nothing was posted. ${replace}`,
    create_carousel: `${name} couldn't put the carousel together: ${detail} Nothing was posted. Check that each item is an image or video the network accepts, then retry this channel.`,
  };
  return { message: refused[err.step], retryable: false };
}

/** "tweet 2", "the first comment". */
function partName(part: PublishPartItem): string {
  return part.kind === "first_comment" ? "the first comment" : `${part.noun} ${part.index}`;
}

/**
 * A part after the root failed. The root and every part before this one are
 * already live (and recorded), so unlike every other failure this one must
 * NOT promise that nothing went out: it says what is live, which part didn't
 * go, and that a retry starts from that part rather than posting again.
 */
function describePartFailure(err: PublishPartError, name: string): PublishFailure {
  const part = err.part;
  const which = partName(part);
  const Which = which.charAt(0).toUpperCase() + which.slice(1);
  const live =
    part.kind === "first_comment"
      ? part.total > 1
        ? `The thread is live on ${name}, but ${which} didn't go out`
        : `The post is live on ${name}, but ${which} didn't go out`
      : part.index === 2
        ? `The first ${part.noun} is live on ${name}, but ${which} of ${part.total} didn't go out`
        : `The first ${part.index - 1} ${part.noun}s are live on ${name}, but ${which} of ${part.total} didn't go out`;
  const resume = `a retry continues from ${which} without posting what is already live`;

  const core = asCoreError(err.cause);
  if (err.final) {
    return {
      message: `${live}: ${trimDetail(messageOf(err.cause))} Post ${which} on ${name} yourself, or retry this channel to try again.`,
      retryable: false,
    };
  }
  if (!core) {
    return {
      message: `${live}: ${trimDetail(messageOf(err.cause))} It will be tried again automatically; ${resume}.`,
      retryable: true,
    };
  }
  if (core.status === 401 || core.status === 403) {
    return {
      message: `${live} because the connection is no longer authorized. Reconnect it on the Channels page, then retry this channel; ${resume}.`,
      retryable: false,
    };
  }
  if (core.status === 429 || core.status >= 500 || core.status === 408 || core.status === 425) {
    return {
      message: `${live} yet: the network couldn't take it just now. It will be tried again automatically; ${resume}.`,
      retryable: true,
      retryAfterSeconds: core.retryAfterSeconds,
    };
  }
  return {
    message: `${live}: ${trimDetail(providerWords(core.message))} ${Which} needs changing: edit it, then retry this channel; ${resume}.`,
    retryable: false,
  };
}

/** A media-storage error (media-storage.ts), recognised by name so this
 * module stays server-free. */
function errorNamed(err: unknown, name: string): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === name;
}

/** A media file that is gone from storage, or from the org's library. */
function isMissingFile(err: unknown): boolean {
  return errorNamed(err, "MediaFileMissingError");
}

/**
 * The reader-facing form of a stored `SocialPostTarget.error`.
 *
 * New rows already hold a sentence from this module. Rows written before it —
 * and they are in every existing database — hold `"502: ..."`, which is
 * exactly the raw status code the design guide says never to show. Recognise
 * that old shape and replace it rather than rendering it.
 */
export function describeStoredTargetError(
  error: string | null | undefined
): string | null {
  if (!error) return null;
  const raw = error.trim();
  if (!raw) return null;
  if (/^\d{3}:/.test(raw)) {
    return "This channel refused the post the last time we tried. Retry it to see the current result.";
  }
  return raw;
}

/**
 * The sentence to show when an action on the queue board is refused.
 *
 * Our own social routes answer with a written-out reason, so that is what the
 * reader should see. `src/lib/social-api.ts` falls back to `HTTP <status>`
 * when the body isn't ours to read — a code, not a sentence — so that shape is
 * swapped for `fallback` instead of being shown.
 */
export function describeSocialActionFailure(
  err: unknown,
  fallback: string
): string {
  const message = messageOf(err).trim();
  if (!message || /^HTTP \d{3}$/.test(message)) return fallback;
  return message;
}

// --- helpers ---------------------------------------------------------------

interface CoreErrorShape {
  status: number;
  message: string;
  retryAfterSeconds?: number;
}

/** An InteractorError, recognised by shape so this module stays server-free. */
function asCoreError(err: unknown): CoreErrorShape | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as {
    name?: unknown;
    status?: unknown;
    message?: unknown;
    retryAfterSeconds?: unknown;
  };
  if (candidate.name !== "InteractorError") return null;
  if (typeof candidate.status !== "number") return null;
  return {
    status: candidate.status,
    message: typeof candidate.message === "string" ? candidate.message : "",
    retryAfterSeconds:
      typeof candidate.retryAfterSeconds === "number"
        ? candidate.retryAfterSeconds
        : undefined,
  };
}

/** "280 characters" / "1 character", with thousands separators. */
function count(n: number): string {
  return `${n.toLocaleString("en-US")} character${n === 1 ? "" : "s"}`;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "the network didn't say why";
}

/**
 * Core wraps a provider refusal as "The provider refused the request (HTTP
 * 403): <the provider's words>" (`service_executor/provider_error.ex`). The
 * provider's words are what a marketer can act on; the wrapper is a status
 * code, which the design guide keeps off the page.
 */
function providerWords(message: string): string {
  return message.replace(/^The provider refused the request \(HTTP \d+\):?\s*/, "");
}

/** One clause, ended cleanly, short enough to sit inside a sentence. */
function trimDetail(detail: string): string {
  const cleaned = detail.trim().replace(/\s+/g, " ");
  if (!cleaned) return "the network didn't say why.";
  const capped =
    cleaned.length > 160 ? `${cleaned.slice(0, 157).trimEnd()}…` : cleaned;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}
