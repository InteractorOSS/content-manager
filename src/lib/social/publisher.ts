import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { MediaFileMissingError, readMediaFile } from "@/lib/media-storage";
import {
  getAdapter,
  PublishStepError,
  publishWithAdapter,
  stepItem,
  type PublishContext,
  type PublishedPart,
} from "@/lib/social/capabilities";
import { channelExecute } from "@/lib/social/core-execute";
import {
  channelNotConnectedFailure,
  describePublishError,
  mediaRulesFailure,
  partsOverLimitFailure,
  unsupportedServiceFailure,
} from "@/lib/social/publish-errors";
import { canMarkPosted, deriveRolledUpStatus, isManualChannel } from "@/lib/social/manual";
import {
  matchLibraryMedia,
  mediaLimitProblem,
  mediaTypeFromMime,
  resolveTargetMedia,
  type SocialMediaItem,
} from "@/lib/social/media";
import { socialPostParts } from "@/lib/social/parts";

/**
 * Publishing a social post, and the reconciler that guarantees it finishes.
 *
 * THE INVARIANT: every post that enters `"publishing"` reaches a terminal
 * status (`published` / `partially_published` / `failed`) within a bounded
 * time. Before this, a single transient error from Core broke it forever — a
 * failed target went back to `"pending"`, the roll-up refuses to call a post
 * done while any target is still `"pending"`, and the only reconciler looked
 * exclusively at `"scheduled"` posts. Nothing in the app ever selected a post
 * sitting at `"publishing"` again, and both manual escapes (Publish now, and
 * editing the post) are closed on exactly that status.
 *
 * So the retry the attempt counter had always described was never performed.
 * Two things restore the invariant, and they are halves of one mechanism:
 *
 *  1. WRITE SEAM — {@link publishTarget} records WHEN the next attempt is due
 *     (`next_attempt_at`), rather than leaving a pending row with no owner.
 *  2. RECONCILER — {@link publishDuePosts} re-picks posts parked at
 *     `"publishing"` whose targets have come due, and sweeps targets left
 *     mid-flight by a crashed process back into the queue.
 *
 * Every parked row therefore has exactly one owner that drives it terminal.
 */

const MAX_ATTEMPTS = 3;

/**
 * Backoff between attempts when Core doesn't name one, indexed by the number
 * of attempts already made. Short enough that a blip clears within a couple
 * of scheduler ticks, long enough not to hammer a network that just refused.
 */
const RETRY_BACKOFF_SECONDS = [60, 300];

/** Never wait longer than this, however long Core's `Retry-After` asks for. */
const MAX_BACKOFF_SECONDS = 3600;

/**
 * How long one in-flight attempt may hold a target before the sweep assumes
 * the process running it died. Publishing through Core is one HTTP call per
 * media upload plus one for the post (a few more for an Instagram carousel),
 * so ten minutes is far past any real attempt while still bounding how long a
 * post can sit mid-flight after a crash.
 */
const PUBLISH_LEASE_MS = 10 * 60_000;

/**
 * How long a recorded upload (`SocialPostTarget.media_uploads`) may be reused
 * by a later attempt. The networks keep an unattached upload for about a day
 * (X media ids, Instagram containers); half that leaves margin, and still
 * spans the whole retry schedule and any lease a crashed attempt held.
 */
const UPLOAD_REUSE_MS = 12 * 60 * 60_000;

/** How many posts one tick will work through, per queue. */
const TICK_BATCH = 20;

interface RecordedUpload {
  id: string;
  at: string;
}

type RecordedPart = PublishedPart & { at: string };

/** `SocialPostTarget.published_parts` as stored: a part per plan position,
 * null where nothing is recorded. Anything malformed counts as not posted. */
function storedPublishedParts(raw: unknown): (RecordedPart | null)[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const o = p as Partial<RecordedPart> | null;
    return o && typeof o.kind === "string" && (typeof o.id === "string" || o.id === null)
      ? (o as RecordedPart)
      : null;
  });
}

/**
 * The publish context for one attempt at one target: media bytes come from
 * the library's storage, and every upload — and every part of the post — is
 * recorded on the row as soon as it lands, so the next attempt reuses the
 * upload and skips the part. Each write is conditional on the row still being
 * ours (`publishing`), like every other write an attempt makes.
 */
function targetPublishContext(
  targetId: string,
  stored: unknown,
  published: (RecordedPart | null)[]
): PublishContext {
  const uploads: Record<string, RecordedUpload> =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? { ...(stored as Record<string, RecordedUpload>) }
      : {};
  const parts = [...published];
  return {
    published,
    recordPart: async (index, part) => {
      while (parts.length < index) parts.push(null);
      parts[index] = { ...part, at: new Date().toISOString() };
      await prisma.socialPostTarget.updateMany({
        where: { id: targetId, status: "publishing" },
        data: {
          published_parts: parts as unknown as Prisma.InputJsonArray,
          // The root is the post's address: written the moment it exists, so
          // a target whose thread then fails still links to what went out.
          ...(index === 0 ? { external_post_id: part.id, external_url: part.url ?? null } : {}),
        },
      });
    },
    readMedia: (item) => readMediaFile(item.url),
    once: async (key, upload) => {
      const prior = uploads[key];
      if (
        typeof prior?.id === "string" &&
        Date.now() - Date.parse(prior.at) < UPLOAD_REUSE_MS
      ) {
        return prior.id;
      }
      const id = await upload();
      uploads[key] = { id, at: new Date().toISOString() };
      await prisma.socialPostTarget.updateMany({
        where: { id: targetId, status: "publishing" },
        data: { media_uploads: uploads as unknown as Prisma.InputJsonObject },
      });
      return id;
    },
  };
}

/**
 * A target's media as the org's own library has it now: each item looked up by
 * `media_id` in the post's organization (an item saved before the picker, with
 * only a url, by that url — `matchLibraryMedia`), and the url the publisher
 * reads or hands to a network replaced by the row's own `file_path`. The JSON
 * on the post is never trusted for where the bytes are: a row imported with an
 * arbitrary address there would otherwise be fetched by this server and posted
 * to a public network. `missing` is the first item with no row in this org —
 * deleted, or another org's id — and nothing at all is read for that target.
 */
async function libraryMedia(
  organizationId: string,
  media: SocialMediaItem[]
): Promise<{ media: SocialMediaItem[]; missing?: undefined } | { missing: number }> {
  if (media.length === 0) return { media };
  const ids = media.flatMap((m) => (m.media_id ? [m.media_id] : []));
  const urls = media.flatMap((m) => (m.media_id ? [] : [m.url]));
  const rows = await prisma.media.findMany({
    where: {
      organization_id: organizationId,
      OR: [{ id: { in: ids } }, { file_path: { in: urls } }],
    },
    select: { id: true, file_path: true, mime_type: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const matched = matchLibraryMedia(media, rows);
  const resolved: SocialMediaItem[] = [];
  for (let i = 0; i < matched.length; i++) {
    const row = matched[i].media_id ? byId.get(matched[i].media_id) : undefined;
    if (!row) return { missing: i };
    resolved.push({
      ...matched[i],
      url: row.file_path,
      type: mediaTypeFromMime(row.mime_type) ?? matched[i].type,
    });
  }
  return { media: resolved };
}

function backoffMs(attemptsMade: number, retryAfterSeconds?: number): number {
  const seconds =
    retryAfterSeconds ??
    RETRY_BACKOFF_SECONDS[
      Math.min(attemptsMade - 1, RETRY_BACKOFF_SECONDS.length - 1)
    ] ??
    RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1];
  return Math.min(Math.max(seconds, 0), MAX_BACKOFF_SECONDS) * 1000;
}

/**
 * Publish one target (post × channel) through Interactor Core.
 *
 * Claiming is conditional on the row still being `"pending"`, so two ticks (or
 * a tick racing a human pressing Retry) can never post the same copy twice:
 * the loser's claim matches no row and it returns having done nothing.
 */
export async function publishTarget(targetId: string): Promise<void> {
  const target = await prisma.socialPostTarget.findUnique({
    where: { id: targetId },
    include: { post: true, channel: true },
  });
  if (!target || target.status === "published") return;

  // G#27: a manual-mode channel has no API access at all — never call
  // Interactor Core for it. Hand it to the awaiting_manual queue instead; a
  // human posts the copy themselves and records it via
  // markManualTargetPosted (mark_social_post_posted, MCP).
  if (isManualChannel(target.channel)) {
    if (target.status !== "awaiting_manual") {
      await prisma.socialPostTarget.update({
        where: { id: target.id },
        data: { status: "awaiting_manual", error: null },
      });
    }
    return;
  }

  // A channel that isn't connected can only produce a failure at Core, and a
  // failure there reads as "the network is down" rather than "reconnect this
  // channel". Refuse locally, with the sentence that actually helps.
  if (target.channel.status !== "active") {
    const failure = channelNotConnectedFailure(
      target.channel,
      target.channel.status
    );
    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: { status: "failed", error: failure.message, next_attempt_at: null },
    });
    return;
  }

  const adapter = getAdapter(target.channel.service_id);
  if (!adapter) {
    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: {
        status: "failed",
        error: unsupportedServiceFailure(target.channel).message,
        next_attempt_at: null,
      },
    });
    return;
  }

  // A body over the network's limit can only come back as a provider
  // rejection, and a rejection at Core reads as "the network refused this"
  // rather than "this is 1,200 characters too long". `POST`/`PUT
  // /api/social/posts` refuse it at the write seam now, so this is here for
  // the rows stored BEFORE that check existed — and for any later door into
  // the table that forgets it. Same wording either way, and no attempt is
  // burned: nothing was sent. Every part is measured the way this network
  // gets it (a tweet of a thread on its own, a thread LinkedIn gets as one
  // post as that one post) — the old X stopgap sent a whole thread as one
  // tweet, which X could only refuse.
  const thread = socialPostParts(target.post);
  const body = target.body_override || thread.body;
  const overLimit = partsOverLimitFailure({
    channel: target.channel,
    body,
    parts: thread.parts,
    custom: Boolean(target.body_override),
    action: "retry",
  });
  if (overLimit) {
    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: { status: "failed", error: overLimit.message, next_attempt_at: null },
    });
    return;
  }

  // A retry of a thread whose root already went out resumes after the last
  // part recorded; the root's media is attached to the live post, so it is
  // neither checked nor read again.
  const published = storedPublishedParts(target.published_parts);
  const rootLive = Boolean(published[0]);

  // Same for media the network won't take (a video where it takes photos
  // only, an eleventh photo): refused at the write seam since those rules
  // existed, repeated here for rows stored before, and nothing is sent.
  const stored = rootLive ? [] : resolveTargetMedia(target, target.post);
  const mediaProblem = mediaLimitProblem(adapter.mediaLimits, adapter.displayName, stored);
  if (mediaProblem) {
    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: {
        status: "failed",
        error: mediaRulesFailure(target.channel, mediaProblem).message,
        next_attempt_at: null,
      },
    });
    return;
  }

  // Every item must still be a file in this org's library; where its bytes
  // live comes from that row, never from the stored JSON. Nothing is sent,
  // and no attempt burned, when one is gone.
  const library = await libraryMedia(target.post.organization_id, stored);
  if (library.missing !== undefined) {
    const item = stored[library.missing];
    const failure = describePublishError(
      new PublishStepError("read_media", stepItem(stored, library.missing), new MediaFileMissingError(item.url)),
      target.channel
    );
    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: { status: "failed", error: failure.message, next_attempt_at: null },
    });
    return;
  }
  const media = library.media;

  // Claim: only a pending row is ours to publish. `next_attempt_at` becomes
  // the lease deadline the stale sweep reads if this process dies mid-call.
  const claimed = await prisma.socialPostTarget.updateMany({
    where: { id: target.id, status: "pending" },
    data: {
      status: "publishing",
      attempt_count: { increment: 1 },
      next_attempt_at: new Date(Date.now() + PUBLISH_LEASE_MS),
    },
  });
  if (claimed.count === 0) return;

  // `media` is the target's own override when it has one (even an empty one:
  // "no images here"), else the post's.
  const input = {
    body,
    link: target.post.link,
    media,
    parts: thread.parts,
    accountId: target.channel.account_id,
  };
  // Runs as the channel's own credential_id, not the identity's default.
  const execute = channelExecute(target.channel);

  try {
    const { externalId, externalUrl } = await publishWithAdapter(
      adapter,
      input,
      execute,
      targetPublishContext(target.id, target.media_uploads, published)
    );

    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: {
        status: "published",
        // The root's id and URL (each part's own are in published_parts).
        external_post_id: externalId ?? null,
        external_url: externalUrl ?? null,
        error: null,
        next_attempt_at: null,
        published_at: new Date(),
        // Attached to the post now; nothing left to reuse.
        media_uploads: Prisma.DbNull,
      },
    });
  } catch (err) {
    const failure = describePublishError(err, target.channel);
    const attemptsMade = target.attempt_count + 1;
    const giveUp = !failure.retryable || attemptsMade >= MAX_ATTEMPTS;
    // The raw cause keeps its home in the process log: the stored message is
    // written for a marketer, and an operator still needs the original.
    console.error(
      `[social-publisher] target ${target.id} attempt ${attemptsMade}/${MAX_ATTEMPTS} failed:`,
      err
    );
    await prisma.socialPostTarget.update({
      where: { id: target.id },
      data: {
        status: giveUp ? "failed" : "pending",
        error: failure.message,
        next_attempt_at: giveUp
          ? null
          : new Date(
              Date.now() + backoffMs(attemptsMade, failure.retryAfterSeconds)
            ),
      },
    });
  }
}

/** Publish every non-published target of a post, then roll up post status. */
export async function publishPost(postId: string): Promise<void> {
  await prisma.socialPost.update({
    where: { id: postId },
    data: { status: "publishing" },
  });

  const targets = await prisma.socialPostTarget.findMany({
    where: { post_id: postId, status: { in: ["pending", "publishing"] } },
    select: { id: true },
  });
  for (const t of targets) {
    await publishTarget(t.id);
  }
  await rollUpPostStatus(postId);
}

export async function rollUpPostStatus(postId: string): Promise<void> {
  const targets = await prisma.socialPostTarget.findMany({
    where: { post_id: postId },
    select: { status: true },
  });
  // A post told to publish with every channel removed has nothing to publish
  // to. It used to be left at whatever status it held — which, coming from
  // publishPost, is "publishing" forever. Nothing to send is a failure.
  if (targets.length === 0) {
    await prisma.socialPost.updateMany({
      where: { id: postId, status: "publishing" },
      data: { status: "failed" },
    });
    return;
  }

  // G#27: deriveRolledUpStatus (src/lib/social/manual.ts) is the same
  // published/partially_published/failed rollup this always used, extended
  // so a post is no longer stuck in "publishing" forever once every
  // not-yet-settled target is awaiting_manual (a human still has to post it)
  // rather than pending/publishing (automated work actually in flight).
  const status = deriveRolledUpStatus(targets);
  if (status) {
    // published_at means "when this post actually finished going out" — only
    // stamp it for a genuinely terminal, delivered rollup. "awaiting_manual"
    // is NOT terminal (a human still has something to do) even though some
    // targets may already show published=true, so leave it alone there —
    // otherwise every re-roll while a manual target is outstanding (e.g.
    // another target on the same post settling) would re-stamp "now" onto a
    // post that hasn't actually finished.
    const isDelivered = status === "published" || status === "partially_published";
    await prisma.socialPost.update({
      where: { id: postId },
      data: {
        status,
        published_at: isDelivered ? new Date() : null,
      },
    });
  }
}

/**
 * Hand back targets whose in-flight attempt never reported a result.
 *
 * A process killed between the claim and the write leaves a row at
 * `"publishing"` with nobody to finish it, and the roll-up will not call the
 * post done while it sits there. Once the lease is up the row goes back to
 * `"pending"` (or `"failed"`, if that attempt was its last), so the post still
 * lands terminal. Duplicate-post risk is real but bounded and deliberate: the
 * lease is far longer than any attempt that is genuinely still running.
 *
 * This has to rescue rows the OLD code stranded, not just prevent new ones:
 * every target written before `next_attempt_at` existed carries null there, and
 * a post left at `"publishing"` by a crash back then is exactly what this goal
 * exists to unstick. For those the fallback signal is `updated_at`, which is
 * sound HERE and nowhere else in this module — a row parked at `"publishing"`
 * has had no write since the attempt claimed it, precisely because the attempt
 * never came back.
 */
export async function sweepStalledTargets(now = new Date()): Promise<number> {
  const leaseExpiredBefore = new Date(now.getTime() - PUBLISH_LEASE_MS);
  const stalled = await prisma.socialPostTarget.findMany({
    where: {
      status: "publishing",
      OR: [
        // Claimed by this code: the claim itself wrote the lease deadline.
        { next_attempt_at: { lte: now } },
        // Claimed before that column existed — date the lease from the row's
        // last write instead, so an old stranded row is still rescued.
        { next_attempt_at: null, updated_at: { lt: leaseExpiredBefore } },
      ],
    },
    select: { id: true, attempt_count: true, channel: { select: { service_name: true, account_name: true } } },
    take: TICK_BATCH * 5,
  });
  for (const target of stalled) {
    const exhausted = target.attempt_count >= MAX_ATTEMPTS;
    await prisma.socialPostTarget.updateMany({
      // Still conditional: the owning attempt may have finished in between.
      where: { id: target.id, status: "publishing" },
      data: exhausted
        ? {
            status: "failed",
            error: `We lost track of the attempt to post to ${target.channel.service_name}${
              target.channel.account_name ? ` (${target.channel.account_name})` : ""
            } and it has now used all its tries. Retry this channel when you're ready.`,
            next_attempt_at: null,
          }
        : { status: "pending", next_attempt_at: now },
    });
  }
  return stalled.length;
}

/**
 * Record what a human got back after posting a manual-mode target's copy on
 * the real platform themselves (POST /api/social/manual/[targetId]/mark-posted,
 * mark_social_post_posted MCP tool). Callers must already have verified the
 * target belongs to their organization (via `db.socialPost`, the tenant-scoped
 * parent) and is actually awaiting_manual (see canMarkPosted) before calling
 * this — mirrors publishPost/publishTarget's own trust boundary: tenancy is
 * checked by the route with the scoped `db`, the actual mutation runs here
 * against the raw, global `prisma` keyed by id.
 */
export async function markManualTargetPosted(
  targetId: string,
  input: { externalUrl?: string | null; externalPostId?: string | null }
) {
  const updated = await prisma.socialPostTarget.update({
    where: { id: targetId },
    data: {
      status: "published",
      published_at: new Date(),
      external_url: input.externalUrl ?? null,
      external_post_id: input.externalPostId ?? null,
      error: null,
    },
    include: { channel: true },
  });
  await rollUpPostStatus(updated.post_id);
  return updated;
}

// Re-exported so callers that already import from publisher.ts don't also
// need a separate import from manual.ts just to gate the mark-posted action.
export { canMarkPosted };

/**
 * Scheduler tick. Three jobs, in order:
 *
 *   1. sweep targets stranded mid-flight (above);
 *   2. publish posts whose scheduled time has come;
 *   3. re-enter posts already at `"publishing"` whose retries are due.
 *
 * (3) is what makes the attempt counter mean something. Claims stay
 * conditional at both grains — post status for (2), target status inside
 * {@link publishTarget} for (3) — so concurrent ticks, or a tick racing the
 * in-process timer, cannot publish the same copy twice.
 *
 * Returns how many posts this tick worked on.
 */
export async function publishDuePosts(): Promise<number> {
  const now = new Date();
  await sweepStalledTargets(now);

  const due = await prisma.socialPost.findMany({
    where: {
      status: "scheduled",
      scheduled_at: { lte: now },
    },
    select: { id: true },
    orderBy: { scheduled_at: "asc" },
    take: TICK_BATCH,
  });
  for (const post of due) {
    // Claim atomically so concurrent ticks don't double-publish.
    const claimed = await prisma.socialPost.updateMany({
      where: { id: post.id, status: "scheduled" },
      data: { status: "publishing" },
    });
    if (claimed.count === 0) continue;
    await publishPost(post.id);
  }

  const retrying = await prisma.socialPost.findMany({
    where: {
      status: "publishing",
      OR: [
        // A retry has come due.
        {
          targets: {
            some: {
              status: "pending",
              OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }],
            },
          },
        },
        // Every target is already terminal but the roll-up never ran — the
        // process died between the last target's write and the roll-up. There
        // is nothing to publish here, only a status to finish.
        { targets: { none: { status: { in: ["pending", "publishing"] } } } },
      ],
    },
    select: { id: true },
    orderBy: { updated_at: "asc" },
    take: TICK_BATCH,
  });
  for (const post of retrying) {
    await publishPost(post.id);
  }

  return due.length + retrying.length;
}
