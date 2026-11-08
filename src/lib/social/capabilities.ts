import { isManualChannel } from "@/lib/social/manual";
import { mediaLimitProblem, type MediaLimits } from "@/lib/social/media";
import type { PartSupport, SocialPart, SocialPartKind } from "@/lib/social/parts";

/**
 * Per-service publish adapters: map a generic social post onto the concrete
 * SKB capability + arguments for each service. Publishing itself always goes
 * through Interactor Core `/execute`, so adding a network here is the only
 * app-side change once the service exists in the Service Knowledge Base.
 */

/** One image/video a post carries, as stored on it (see `SocialMediaItem`). */
export interface PublishMedia {
  media_id?: string;
  url: string;
  type?: string;
  alt?: string;
}

export interface PublishInput {
  body: string;
  link?: string | null;
  media?: PublishMedia[];
  /** Provider-side account id, e.g. Facebook page-id or Slack channel id. */
  accountId?: string | null;
  /**
   * What `uploadMedia` returned for each of `media`, in the same order (X
   * media ids, LinkedIn image URNs, Facebook unpublished photo ids). Filled
   * in by {@link publishWithAdapter} before `buildPublish` runs; absent for a
   * post without media or a network that doesn't upload.
   */
  uploadedMedia?: string[];
  /**
   * What follows the root post: thread replies, then a first comment
   * (src/lib/social/parts.ts). {@link publishWithAdapter} decides, through
   * {@link publishPlan}, which go out as their own posts on this network and
   * which are joined into the root's text.
   */
  parts?: SocialPart[];
}

export interface PublishCall {
  capabilityName: string;
  args: Record<string, unknown>;
  /** Extract the provider post id from the execute result. `headers` are the
   * provider's response headers (lowercase names; empty when Core relayed
   * none) — LinkedIn answers a create with the id only in `x-restli-id`. */
  extractPostId?: (
    data: Record<string, unknown>,
    headers: Record<string, string>
  ) => string | undefined;
  /** Build a permalink from the provider post id, when derivable. */
  externalUrl?: (postId: string, input: PublishInput) => string | undefined;
}

/** A provider response with its headers (lowercase names). */
export interface ExecuteResponse {
  data: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Bytes to send as a provider request's body (an image, a video chunk). */
export interface UploadBody {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Executes one capability against Interactor Core and returns the provider
 * response body. Called as a plain function it is what every adapter has
 * always used. The two optional variants are the same call against the same
 * credential, for adapters that need more than the body: `withHeaders` also
 * returns the response headers, `upload` sends raw bytes as the request body.
 * The publisher and account discovery always supply both (see
 * `src/lib/social/core-execute.ts`); they are optional only so a test can
 * still hand an adapter a bare function. Read them through
 * {@link executeWithHeaders} / {@link executeUpload} rather than directly.
 */
export interface ExecuteFn {
  (capabilityName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  withHeaders?: (
    capabilityName: string,
    args: Record<string, unknown>
  ) => Promise<ExecuteResponse>;
  upload?: (
    capabilityName: string,
    args: Record<string, unknown>,
    body: UploadBody
  ) => Promise<ExecuteResponse>;
}

/** Run a capability and keep its response headers. Against a bare execute
 * function (no headers to give) the headers come back empty. */
export async function executeWithHeaders(
  execute: ExecuteFn,
  capabilityName: string,
  args: Record<string, unknown>
): Promise<ExecuteResponse> {
  if (execute.withHeaders) return execute.withHeaders(capabilityName, args);
  return { data: await execute(capabilityName, args), headers: {} };
}

/** Run a capability whose request body is `body`'s bytes. */
export async function executeUpload(
  execute: ExecuteFn,
  capabilityName: string,
  args: Record<string, unknown>,
  body: UploadBody
): Promise<ExecuteResponse> {
  if (!execute.upload) {
    throw new Error(`Uploading files is not available for "${capabilityName}" here`);
  }
  return execute.upload(capabilityName, args, body);
}

/**
 * What publishing needs beyond Core: the media's bytes, and a record of the
 * uploads already made for this target. The publisher supplies one per
 * attempt (`src/lib/social/publisher.ts`); a test can build its own.
 */
export interface PublishContext {
  /** One media item's bytes, read from the org's media library storage. */
  readMedia(item: PublishMedia): Promise<UploadBody>;
  /**
   * Run `upload` at most once per `key` for this target: an id an earlier
   * attempt already recorded under `key` comes back without calling it again.
   * That is what keeps a retry (or an attempt resumed after a crash inside
   * the publish lease) from uploading every image a second time.
   */
  once(key: string, upload: () => Promise<string>): Promise<string>;
  /**
   * The parts an earlier attempt already published, by their place in the
   * plan (0 = the root). A recorded part is never posted again: the attempt
   * resumes after the last one. Absent = nothing published yet.
   */
  published?: (PublishedPart | null | undefined)[];
  /**
   * Record one part the moment the network accepts it, before the next is
   * sent, so a failure (or a crash) after it never posts it a second time.
   */
  recordPart?(index: number, part: PublishedPart): Promise<void>;
}

/** One part of a post as the network created it. */
export interface PublishedPart {
  kind: "root" | SocialPartKind;
  /** The provider's id. Null only for a root the network created without
   * telling us its id (nothing can then be attached to it). */
  id: string | null;
  url?: string | null;
}

/**
 * The publishing step that failed, for the wording in publish-errors.ts. The
 * final call that creates the post is not a step: a failure there is the
 * ordinary "the network rejected this post".
 */
export type PublishStep =
  | "read_media"
  | "start_upload"
  | "upload_media"
  | "create_container"
  | "create_carousel";

/** Which part of a multi-part post failed (a reply in a thread, the first comment). */
export interface PublishPartItem {
  kind: SocialPartKind;
  /** 1-based place among the posts of the thread (the root is 1); for a
   * first comment, how many posts precede it. */
  index: number;
  /** How many posts the thread has, the root included. */
  total: number;
  /** What one post is called on this network ("tweet", "post"). */
  noun: string;
}

/**
 * A failure while posting a part AFTER the root went out. The root (and any
 * part before this one) is live and recorded, so the wording has to say so
 * and that a retry continues from here; `cause` still decides whether to
 * retry, unless `final` says another attempt cannot get past it.
 */
export class PublishPartError extends Error {
  readonly part: PublishPartItem;
  readonly cause: unknown;
  readonly final: boolean;
  constructor(part: PublishPartItem, cause: unknown, opts: { final?: boolean } = {}) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PublishPartError";
    this.part = part;
    this.cause = cause;
    this.final = opts.final ?? false;
  }
}

/** Which of the post's media a failed step was working on. */
export interface PublishStepItem {
  /** 1-based position in the media the target publishes. */
  index: number;
  total: number;
  type: "image" | "video";
  /** The file's name in the library, for the reader to recognise it. */
  name: string | null;
}

/**
 * A failure inside one step of a multi-call publish. Carries the step and the
 * item so the stored sentence can say "X didn't accept image 2 of 3", while
 * `cause` (Core's error, a storage error) still decides whether to retry.
 */
export class PublishStepError extends Error {
  readonly step: PublishStep;
  readonly item: PublishStepItem | null;
  readonly cause: unknown;
  constructor(step: PublishStep, item: PublishStepItem | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PublishStepError";
    this.step = step;
    this.item = item;
    this.cause = cause;
  }
}

/** Run `run` as `step`, so whatever it throws names the step and the item.
 * A failure already attributed to a (finer) step passes through unchanged. */
export async function publishStep<T>(
  step: PublishStep,
  item: PublishStepItem | null,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof PublishStepError)) throw new PublishStepError(step, item, err);
    // A step inside an adapter's upload doesn't know which item it is on;
    // the enclosing step does.
    throw err.item || !item ? err : new PublishStepError(err.step, item, err.cause);
  }
}

/** `media[index]`, described for a step failure. */
export function stepItem(media: PublishMedia[], index: number): PublishStepItem {
  return {
    index: index + 1,
    total: media.length,
    type: isVideo(media[index]) ? "video" : "image",
    name: mediaFileName(media[index].url),
  };
}

function isVideo(item: PublishMedia): boolean {
  return !!item.type && (item.type === "video" || item.type.startsWith("video/"));
}

/**
 * A library file's name from its stored url: the last path segment, without
 * the `<timestamp>_` prefix the S3 key scheme adds. Null when there is none.
 */
export function mediaFileName(url: string): string | null {
  const path = url.split(/[?#]/)[0];
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A malformed escape: show the segment as stored.
  }
  return decoded.replace(/^\d{10,}_/, "") || null;
}

/** The key one upload is recorded under: the network, the account it was
 * made for (a LinkedIn image belongs to its author), the step and the file. */
function uploadKey(serviceId: string, step: string, accountId: string | null | undefined, item: PublishMedia) {
  return `${serviceId}:${step}:${accountId ?? ""}:${item.media_id ?? item.url}`;
}

/**
 * Publish `input` with `adapter`, parts and all, in the one order the
 * publisher and the adapter tests share: the root post (see
 * {@link publishRoot}), then each thread reply as a reply to the one before
 * it, then the first comment. Every part is recorded through
 * `context.recordPart` as soon as it lands, and a part `context.published`
 * already holds is skipped, so a retry after a failure at tweet 2 picks up at
 * tweet 2 and never posts the root again. Returns the root's id and URL.
 */
export async function publishWithAdapter(
  adapter: ServiceAdapter,
  input: PublishInput,
  execute: ExecuteFn,
  context: PublishContext
): Promise<{ externalId?: string; externalUrl?: string }> {
  const plan = publishPlan(adapter, input.body, input.parts ?? []);
  const steps: { kind: PublishedPart["kind"]; body: string }[] = [
    ...plan.posts.map((body, i) => ({ kind: i === 0 ? ("root" as const) : ("thread" as const), body })),
    ...(plan.comment !== null ? [{ kind: "first_comment" as const, body: plan.comment }] : []),
  ];
  const done = context.published ?? [];

  let root = done[0] ?? null;
  if (!root) {
    const created = await publishRoot(adapter, { ...input, body: plan.posts[0] }, execute, context);
    root = { kind: "root", id: created.externalId ?? null, url: created.externalUrl ?? null };
    await context.recordPart?.(0, root);
  }

  const noun = adapter.partNoun ?? "post";
  let previous = root.id;
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    const prior = done[i];
    if (prior?.id) {
      if (step.kind === "thread") previous = prior.id;
      continue;
    }
    const kind = step.kind as SocialPartKind;
    const item: PublishPartItem = {
      kind,
      index: kind === "thread" ? i + 1 : plan.posts.length,
      total: plan.posts.length,
      noun,
    };
    const publishPart = adapter.publishPart;
    if (!publishPart || !root.id || !previous) {
      // Nothing to attach it to: another attempt would get the same answer.
      throw new PublishPartError(
        item,
        new Error(`${adapter.displayName} didn't tell us the id of the post it created, so nothing can be attached to it`),
        { final: true }
      );
    }
    const parentId = kind === "thread" || adapter.firstCommentOn === "last" ? previous : root.id;
    let posted: { id: string; url?: string | null };
    try {
      posted = await publishPart(
        { kind, body: step.body, parentId, rootId: root.id },
        execute,
        input
      );
    } catch (err) {
      throw new PublishPartError(item, err);
    }
    await context.recordPart?.(i, { kind, id: posted.id, url: posted.url ?? null });
    if (kind === "thread") previous = posted.id;
  }
  return { externalId: root.id ?? undefined, externalUrl: root.url ?? undefined };
}

/**
 * The root post alone: the adapter's own multi-step flow when it has one,
 * else each media item through `uploadMedia` (once per item, recorded) and
 * then the single call `buildPublish` describes.
 */
async function publishRoot(
  adapter: ServiceAdapter,
  input: PublishInput,
  execute: ExecuteFn,
  context: PublishContext
): Promise<{ externalId?: string; externalUrl?: string }> {
  if (adapter.customPublish) return adapter.customPublish(input, execute, context);
  if (!adapter.buildPublish) {
    throw new Error(`Adapter for "${adapter.serviceId}" defines no publish strategy`);
  }

  const media = input.media ?? [];
  let prepared = input;
  if (adapter.uploadMedia && media.length > 0) {
    const upload = adapter.uploadMedia;
    const uploadedMedia: string[] = [];
    // One at a time, in order: the order is the order the network shows them.
    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      const described = stepItem(media, i);
      uploadedMedia.push(
        await context.once(uploadKey(adapter.serviceId, "upload", input.accountId, item), async () => {
          const body = await publishStep("read_media", described, () => context.readMedia(item));
          return publishStep("upload_media", described, () => upload(item, body, execute, input));
        })
      );
    }
    prepared = { ...input, uploadedMedia };
  }

  const call = adapter.buildPublish(prepared);
  const { data, headers } = await executeWithHeaders(execute, call.capabilityName, call.args);
  const externalId = call.extractPostId?.(data, headers);
  return {
    externalId,
    externalUrl: externalId && call.externalUrl ? call.externalUrl(externalId, prepared) : undefined,
  };
}

/** The string id a provider answered with, at `data[key]`, if any. */
function stringAt(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** `body` with the backlink on its own line at the end, when there is one. */
function withLink(input: PublishInput): string {
  return input.link ? `${input.body}\n${input.link}` : input.body;
}

export interface ServiceAdapter {
  serviceId: string;
  displayName: string;
  /** Max characters for the post body (approximate provider limit). */
  charLimit?: number;
  /** Whether accountId is required to publish (e.g. Facebook page-id). */
  requiresAccountId?: boolean;
  /** Whether at least one media attachment is required to publish (e.g. Instagram). */
  requiresMedia?: boolean;
  /**
   * How many images/videos one post may carry, and whether a video may sit
   * beside images. Absent = the network takes no native media here, so none
   * is refused. The one media table, read by `validateAgainstNetworkRules`
   * (server and composer alike) and reported by `networkRules()`.
   */
  mediaLimits?: MediaLimits;
  buildPublish?: (input: PublishInput) => PublishCall;
  /**
   * Upload one of the post's media natively and return the provider's
   * reference to it (X media id, LinkedIn image URN, Facebook unpublished
   * photo id). {@link publishWithAdapter} runs it for each item, in order,
   * before `buildPublish`, which finds the results in `input.uploadedMedia`.
   * Absent = the network takes no native media and `buildPublish` ignores it.
   */
  uploadMedia?: (
    item: PublishMedia,
    body: UploadBody,
    execute: ExecuteFn,
    input: PublishInput
  ) => Promise<string>;
  /**
   * Thread parts go out as a reply chain (X). Without this a thread is
   * joined into the root's text: nothing the writer wrote is dropped.
   */
  threads?: boolean;
  /** What one post of a thread is called here, for the reader ("tweet"). */
  partNoun?: string;
  /**
   * The longest first comment the network takes. Present = the adapter posts
   * a first comment under the root (`publishPart`); absent = the comment is
   * joined into the root's text instead.
   */
  firstCommentCharLimit?: number;
  /** What a first comment answers: the root (a comment on a LinkedIn or
   * Facebook post), or the last post of the thread (X, where a comment is a
   * reply and answering the root would fork the thread). Default root. */
  firstCommentOn?: "root" | "last";
  /**
   * Post one part after the root: a thread reply to `parentId`, or the first
   * comment on it. Returns the provider's id for the part (and its URL when
   * one can be built); throws when the network refused it.
   */
  publishPart?: (
    part: { kind: SocialPartKind; body: string; parentId: string; rootId: string },
    execute: ExecuteFn,
    input: PublishInput
  ) => Promise<{ id: string; url?: string | null }>;
  /** Multi-step publish flows (e.g. Instagram container → publish). Takes
   * precedence over uploadMedia/buildPublish. */
  customPublish?: (
    input: PublishInput,
    execute: ExecuteFn,
    context: PublishContext
  ) => Promise<{ externalId?: string; externalUrl?: string }>;
  /** OAuth scopes to request at connect time. */
  connectScopes?: string[];
  /**
   * What the Account ID field holds for this service, in the reader's words
   * ("Subreddit", "Facebook Page"). Shown as the field's label.
   */
  accountLabel?: string;
  /**
   * Ask the provider which accounts the connected credential can publish to
   * (the Pages a Facebook user manages, the one LinkedIn member a credential
   * is). Lets the connect flow fill `account_id` in — nobody should have to
   * find a Page id or type `urn:li:person:…` by hand. A service that declares
   * this does not need the id before connecting; see `needsAccountIdUpfront`.
   */
  discoverAccounts?: (execute: ExecuteFn) => Promise<DiscoveredAccount[]>;
  /**
   * What to tell the reader when discovery found nothing. For most networks
   * that is not an error but a missing link on the network's side (an
   * Instagram account not linked to a Page, no Page shared at sign-in), so
   * this says what to fix and where. The picker has a generic fallback.
   */
  noAccountsHelp?: string;
}

/** One account a connected credential can publish to. */
export interface DiscoveredAccount {
  /** The value stored as the channel's `account_id`. */
  id: string;
  name: string;
  /** A second line for the picker when the name alone is ambiguous: "Your
   * profile" against "Company page", the Page an Instagram account is linked
   * to. Display only, never stored. */
  detail?: string;
}

const facebook: ServiceAdapter = {
  serviceId: "facebook-graph-api",
  displayName: "Facebook Page",
  charLimit: 63206,
  // Photos only: a Page post attaches photos uploaded unpublished
  // (`attached_media`), and Graph has no such attachment for a video, which
  // is a separate /videos upload this adapter doesn't make. Refusing a video
  // at the write seam beats posting the copy without it.
  mediaLimits: {
    maxImages: 10,
    maxVideos: 0,
    maxItems: 10,
    mixed: false,
    summary: "up to 10 photos (no video)",
  },
  requiresAccountId: true,
  accountLabel: "Facebook Page",
  // pages_show_list is what lets list_pages see any Page at all;
  // business_management is what lets it see a Page owned through a Meta
  // Business portfolio — which is how most companies hold theirs. Without it
  // Graph answers /me/accounts with an empty list, not an error.
  connectScopes: [
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "business_management",
  ],
  discoverAccounts: async (execute) => {
    const res = await execute("list_pages", { fields: "id,name" });
    return namedRows(res.data, "id", "name");
  },
  // Each photo goes up unpublished, then one feed post attaches them all, so
  // one photo and ten take the same path and the post has one id and URL.
  uploadMedia: async (item, body, execute, input) => {
    const { data } = await executeUpload(
      execute,
      "upload_page_photo",
      {
        "page-id": input.accountId,
        published: false,
        ...(item.alt ? { alt_text_custom: item.alt } : {}),
      },
      body
    );
    const id = stringAt(data, "id");
    if (!id) throw new Error("Facebook did not return the uploaded photo");
    return id;
  },
  buildPublish: (input) => ({
    capabilityName: "publish_page_post",
    args: {
      "page-id": input.accountId,
      ...(input.uploadedMedia?.length
        ? {
            // Graph lets `link` replace the attachments with a link preview,
            // so with photos the backlink goes in the text.
            message: withLink(input),
            attached_media: input.uploadedMedia.map((id) => ({ media_fbid: id })),
          }
        : {
            message: input.body,
            ...(input.link ? { link: input.link } : {}),
          }),
      published: true,
    },
    extractPostId: (data) =>
      typeof data.id === "string" ? data.id : undefined,
    externalUrl: (postId) => `https://www.facebook.com/${postId}`,
  }),
  // A comment on the Page post, made as the Page (Graph `/{post-id}/comments`).
  firstCommentCharLimit: 8000,
  publishPart: async (part, execute) => {
    const id = stringAt(
      await execute("create_comment", { "object-id": part.rootId, message: part.body }),
      "id"
    );
    if (!id) throw new Error("Facebook did not return the new comment");
    return { id };
  },
};

const slack: ServiceAdapter = {
  serviceId: "slack",
  displayName: "Slack",
  charLimit: 40000,
  requiresAccountId: true, // channel id
  accountLabel: "Slack channel",
  discoverAccounts: async (execute) => {
    const res = await execute("conversations_list", {
      types: "public_channel",
      exclude_archived: true,
      limit: 200,
    });
    return namedRows(res.channels, "id", "name").map((c) => ({
      ...c,
      name: `#${c.name}`,
    }));
  },
  buildPublish: (input) => ({
    capabilityName: "chat_postMessage",
    args: {
      channel: input.accountId,
      text: input.link ? `${input.body}\n${input.link}` : input.body,
    },
    extractPostId: (data) => (typeof data.ts === "string" ? data.ts : undefined),
  }),
};

const twitter: ServiceAdapter = {
  serviceId: "twitter",
  displayName: "X (Twitter)",
  charLimit: 280,
  mediaLimits: {
    maxImages: 4,
    maxVideos: 1,
    maxItems: 4,
    mixed: false,
    summary: "up to 4 images, or 1 video on its own",
  },
  requiresAccountId: false,
  // media.write is what lets the credential call the v2 media upload.
  connectScopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  uploadMedia: async (item, body, execute) => {
    const { data } = await executeUpload(
      execute,
      "upload_media",
      { media_category: isVideo(item) ? "tweet_video" : "tweet_image" },
      body
    );
    // v2 answers {data: {id, media_key}}; the v1.1 endpoint {media_id_string}.
    const id =
      stringAt(data.data as Record<string, unknown> | undefined, "id") ??
      stringAt(data, "media_id_string");
    if (!id) throw new Error("X did not return a media id for the upload");
    return id;
  },
  buildPublish: (input) => ({
    capabilityName: "create_post",
    args: {
      text: withLink(input),
      ...(input.uploadedMedia?.length ? { media: { media_ids: input.uploadedMedia } } : {}),
    },
    // X API v2 wraps the created post as {data: {id, text}}.
    extractPostId: (data) => {
      const inner = data.data as { id?: unknown } | undefined;
      return typeof inner?.id === "string" ? inner.id : undefined;
    },
    externalUrl: (postId) => `https://x.com/i/web/status/${postId}`,
  }),
  // A thread is a reply chain: each tweet answers the one before it. The
  // first comment is a reply too, to the thread's last tweet.
  threads: true,
  partNoun: "tweet",
  firstCommentCharLimit: 280,
  firstCommentOn: "last",
  publishPart: async (part, execute) => {
    const { data } = await executeWithHeaders(execute, "create_post", {
      text: part.body,
      reply: { in_reply_to_tweet_id: part.parentId },
    });
    const id = stringAt(data.data as Record<string, unknown> | undefined, "id");
    if (!id) throw new Error("X did not return the new reply");
    return { id, url: `https://x.com/i/web/status/${id}` };
  },
};

const linkedin: ServiceAdapter = {
  serviceId: "linkedin",
  displayName: "LinkedIn",
  charLimit: 3000,
  // Images only: /rest/posts takes one image (`media`) or a multiImage set,
  // uploaded through the Images API. A video is a different, multi-part
  // upload this adapter doesn't make, so it is refused at the write seam
  // rather than the copy going out without it.
  mediaLimits: {
    maxImages: 20,
    maxVideos: 0,
    maxItems: 20,
    mixed: false,
    summary: "up to 20 images (no video)",
  },
  // account_id holds the author URN: the member (urn:li:person:{sub from
  // /v2/userinfo}) or an organization they administer
  // (urn:li:organization:{id}).
  requiresAccountId: true,
  // w_organization_social posts as an organization; r_organization_admin is
  // what lets list_admin_organizations see which ones the member administers.
  connectScopes: [
    "openid",
    "profile",
    "email",
    "w_member_social",
    "w_organization_social",
    "r_organization_admin",
  ],
  accountLabel: "LinkedIn profile or page",
  noAccountsHelp:
    "LinkedIn didn't tell us who this sign-in belongs to. Reconnect LinkedIn and allow everything it asks for.",
  // A member credential posts as the member, and as every organization page
  // they are an approved administrator of.
  discoverAccounts: async (execute) => {
    const me = await execute("get_me", {});
    if (typeof me.sub !== "string" || !me.sub) return [];
    const member: DiscoveredAccount = {
      id: `urn:li:person:${me.sub}`,
      name: typeof me.name === "string" && me.name ? me.name : "LinkedIn member",
      detail: "Your profile",
    };
    let organizations: DiscoveredAccount[] = [];
    try {
      organizations = linkedinAdminOrganizations(
        await execute("list_admin_organizations", {
          q: "roleAssignee",
          role: "ADMINISTRATOR",
          state: "APPROVED",
          // Without the projection each organization comes back as a bare URN.
          projection: "(elements*(organization~(localizedName),role,state))",
        })
      );
    } catch (err) {
      // The member can still post as themselves. A connection made before
      // the organization scopes were requested is refused here until it is
      // reconnected, and that must not empty the picker.
      console.warn(
        "[social-accounts] LinkedIn organizations unavailable:",
        err instanceof Error ? err.message : err
      );
    }
    return [member, ...organizations];
  },
  // An image is registered for its author (initializeUpload), then its bytes
  // are PUT to the upload URL LinkedIn hands back. The image URN is only
  // usable once the PUT has landed, so the two are one recorded upload.
  uploadMedia: async (_item, body, execute, input) => {
    const { uploadUrl, image } = await publishStep("start_upload", null, async () => {
      const value = (await execute("initialize_image_upload", {
        initializeUploadRequest: { owner: input.accountId },
      })).value as Record<string, unknown> | undefined;
      const started = { uploadUrl: stringAt(value, "uploadUrl"), image: stringAt(value, "image") };
      if (!started.uploadUrl || !started.image) {
        throw new Error("LinkedIn did not return an upload address for the image");
      }
      return started as { uploadUrl: string; image: string };
    });
    await executeUpload(execute, "upload_image", { upload_url: uploadUrl }, body);
    return image;
  },
  buildPublish: (input) => {
    const images = input.uploadedMedia ?? [];
    const media = input.media ?? [];
    const altText = (i: number) => (media[i]?.alt ? { altText: media[i].alt } : {});
    return {
      capabilityName: "create_rest_post",
      args: {
        author: input.accountId,
        // /rest/posts has no link field beside images, and an article card
        // needs a title the social copy doesn't have, so the backlink is part
        // of the text, as on every other network here.
        commentary: linkedinLittleText(withLink(input)),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(images.length === 1
          ? { content: { media: { id: images[0], ...altText(0) } } }
          : images.length > 1
            ? { content: { multiImage: { images: images.map((id, i) => ({ id, ...altText(i) })) } } }
            : {}),
      },
      // A created post answers 201 with an empty body and the new URN in
      // `x-restli-id`; the body id is the fallback for a relay that drops it.
      extractPostId: (data, headers) => headers["x-restli-id"] || stringAt(data, "id"),
      externalUrl: (postId) => `https://www.linkedin.com/feed/update/${postId}`,
    };
  },
  // A comment on the new post (`/rest/socialActions/{urn}/comments`), made by
  // the post's own author: the member, or the organization page.
  firstCommentCharLimit: 1250,
  publishPart: async (part, execute, input) => {
    const { data, headers } = await executeWithHeaders(execute, "create_comment", {
      "post-urn": part.rootId,
      actor: input.accountId,
      object: part.rootId,
      message: { text: part.body },
    });
    const id = headers["x-restli-id"] || stringAt(data, "$URN") || stringAt(data, "id");
    if (!id) throw new Error("LinkedIn did not return the new comment");
    return { id };
  },
};

/**
 * Copy as LinkedIn's "little text" format, which /rest/posts commentary is
 * written in. Its reserved characters must be backslash-escaped, or LinkedIn
 * cuts the post off at the first one (an unescaped "(" is the usual way a
 * post loses its second half). A `#word` stays a hashtag, in the format's own
 * `{hashtag|\#|word}` markup.
 */
export function linkedinLittleText(text: string): string {
  const escape = (s: string) => s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/(^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index! + m[1].length;
    out += escape(text.slice(last, start)) + `{hashtag|\\#|${escape(m[2])}}`;
    last = start + 1 + m[2].length;
  }
  return out + escape(text.slice(last));
}

const instagram: ServiceAdapter = {
  serviceId: "instagram",
  displayName: "Instagram",
  charLimit: 2200,
  // One image or video, or a carousel of 2 to 10 (videos allowed in it).
  // The "at least one" half is `requiresMedia`.
  mediaLimits: {
    maxImages: 10,
    maxVideos: 10,
    maxItems: 10,
    mixed: true,
    summary: "1 image or video, or a carousel of 2 to 10",
  },
  requiresAccountId: true, // Instagram Business/Creator account id
  requiresMedia: true,
  // An Instagram professional account is reached through the Facebook Page it
  // is linked to, so the Page scopes are what let list_pages find it,
  // business_management included: without it a Page held in a Meta Business
  // portfolio comes back as an empty list (see the Facebook adapter).
  connectScopes: [
    "instagram_basic",
    "instagram_content_publish",
    "pages_show_list",
    "pages_read_engagement",
    "business_management",
  ],
  accountLabel: "Instagram business account",
  noAccountsHelp:
    "None of the Facebook Pages this sign-in can reach has an Instagram business account linked to it. Link your Instagram account to a Page in Instagram's settings, then reconnect and share that Page when Facebook asks.",
  // List the Pages and keep the ones with an Instagram account linked,
  // named by its username.
  discoverAccounts: async (execute) => {
    const res = await execute("list_pages", {
      fields: "id,name,instagram_business_account{id,username}",
    });
    if (!Array.isArray(res.data)) return [];
    // Two Pages can be linked to the same Instagram account; offer it once.
    const seen = new Set<string>();
    return res.data.flatMap((row): DiscoveredAccount[] => {
      const page = row as {
        name?: unknown;
        instagram_business_account?: { id?: unknown; username?: unknown } | null;
      } | null;
      const ig = page?.instagram_business_account;
      if (typeof ig?.id !== "string" || !ig.id || seen.has(ig.id)) return [];
      seen.add(ig.id);
      const pageName = typeof page?.name === "string" && page.name ? page.name : null;
      const username = typeof ig.username === "string" && ig.username ? ig.username : null;
      return [
        {
          id: ig.id,
          name: username
            ? `@${username}`
            : pageName
              ? `Instagram account linked to ${pageName}`
              : "Instagram business account",
          ...(pageName ? { detail: `Linked to the Page ${pageName}` } : {}),
        },
      ];
    });
  },
  // Graph fetches each file from its library URL itself, so nothing is
  // uploaded from here: one container per item, then publish. Two or more
  // items are a carousel: a child container per item (is_carousel_item), one
  // CAROUSEL container naming them in order, then publish that.
  customPublish: async (input, execute, context) => {
    const media = input.media ?? [];
    if (media.length === 0) {
      throw new Error("Instagram requires at least one image or video attachment");
    }
    const igUser = input.accountId;
    const caption = withLink(input);
    const container = async (args: Record<string, unknown>) => {
      const id = stringAt(await execute("create_media_container", { "ig-user-id": igUser, ...args }), "id");
      if (!id) throw new Error("Instagram did not return a media container id");
      return id;
    };
    const itemArgs = (item: PublishMedia) =>
      isVideo(item)
        ? { video_url: item.url }
        : { image_url: item.url, ...(item.alt ? { alt_text: item.alt } : {}) };

    let creationId: string;
    if (media.length === 1) {
      const item = media[0];
      creationId = await publishStep("create_container", stepItem(media, 0), () =>
        container({
          ...itemArgs(item),
          ...(isVideo(item) ? { media_type: "REELS" } : {}),
          caption,
        })
      );
    } else {
      const children: string[] = [];
      for (let i = 0; i < media.length; i++) {
        const item = media[i];
        children.push(
          await context.once(uploadKey("instagram", "carousel_item", igUser, item), () =>
            publishStep("create_container", stepItem(media, i), () =>
              container({
                ...itemArgs(item),
                ...(isVideo(item) ? { media_type: "VIDEO" } : {}),
                is_carousel_item: true,
              })
            )
          )
        );
      }
      creationId = await publishStep("create_carousel", null, () =>
        container({ media_type: "CAROUSEL", children: children.join(","), caption })
      );
    }
    const published = await execute("publish_media", {
      "ig-user-id": igUser,
      creation_id: creationId,
    });
    const externalId = stringAt(published, "id");
    if (!externalId) return {};
    // A published media id is not a URL (Instagram's are shortcodes), so ask
    // for the permalink. The post is already out: a failure here only costs
    // the link, never the post.
    let externalUrl: string | undefined;
    try {
      externalUrl = stringAt(
        await execute("get_media", { "ig-media-id": externalId, fields: "permalink" }),
        "permalink"
      );
    } catch (err) {
      console.warn(
        "[social-publisher] Instagram permalink unavailable:",
        err instanceof Error ? err.message : err
      );
    }
    return { externalId, externalUrl };
  },
};

/** Reddit caps a post title at 300 characters. */
const REDDIT_TITLE_LIMIT = 300;

/**
 * A Reddit post needs a title and the CMS's social copy has none, so the
 * first line of the copy is the title and the rest is the body. Copy that is
 * a single line is all title.
 */
export function splitRedditTitle(body: string): { title: string; text: string } {
  const trimmed = body.trim();
  const newline = trimmed.indexOf("\n");
  const firstLine = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
  if (firstLine.length <= REDDIT_TITLE_LIMIT) return { title: firstLine, text: rest };
  // Too long for a title: cut at a word, and keep the full first line in the
  // body so nothing the writer wrote is lost.
  const cut = firstLine.slice(0, REDDIT_TITLE_LIMIT - 1);
  const atWord = cut.lastIndexOf(" ");
  const title = `${(atWord > 0 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
  return { title, text: rest ? `${firstLine}\n\n${rest}` : firstLine };
}

const reddit: ServiceAdapter = {
  serviceId: "reddit",
  displayName: "Reddit",
  charLimit: 40000,
  // account_id holds the subreddit, without the r/ prefix. A profile is
  // `u_<username>`.
  requiresAccountId: true,
  accountLabel: "subreddit",
  connectScopes: ["identity", "submit", "read"],
  // Reddit answers a refused submission (subreddit rules, karma, rate limit)
  // with HTTP 200 and the reasons in json.errors, so the response has to be
  // read before the post can be called published.
  customPublish: async (input, execute) => {
    const { title, text } = splitRedditTitle(input.body);
    const sr = (input.accountId ?? "").replace(/^\/?r\//, "");
    // Always a text post. A Reddit link post has no body, so sending the
    // backlink as the post's URL would throw the copy away; the link goes at
    // the end of the text instead.
    const res = await execute("submit_post", {
      sr,
      title,
      kind: "self",
      text: [text, input.link].filter(Boolean).join("\n\n"),
    });
    const json = (res.json ?? {}) as {
      errors?: unknown;
      data?: { id?: unknown; name?: unknown; url?: unknown };
    };
    const errors = Array.isArray(json.errors) ? json.errors : [];
    if (errors.length > 0) {
      // Each error is [CODE, "human sentence", field].
      const first = errors[0];
      const reason =
        Array.isArray(first) && typeof first[1] === "string" ? first[1] : "the post was refused";
      throw new Error(`Reddit did not accept the post: ${reason}`);
    }
    const externalId =
      typeof json.data?.name === "string"
        ? json.data.name
        : typeof json.data?.id === "string"
          ? json.data.id
          : undefined;
    if (!externalId) throw new Error("Reddit did not return the new post");
    return {
      externalId,
      externalUrl: typeof json.data?.url === "string" ? json.data.url : undefined,
    };
  },
};

/**
 * The organizations in a LinkedIn `organizationAcls?q=roleAssignee` answer, as
 * author URNs. Each element names its organization as a URN and, when the
 * request projected it (`organization~`), carries its name. A bare numeric id
 * is accepted too; a row with no recognisable organization is skipped.
 */
function linkedinAdminOrganizations(res: Record<string, unknown>): DiscoveredAccount[] {
  if (!Array.isArray(res.elements)) return [];
  const seen = new Set<string>();
  return res.elements.flatMap((row): DiscoveredAccount[] => {
    const r = row as Record<string, unknown> | null;
    const raw = r?.organization ?? r?.organizationTarget;
    const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    const orgId = /^urn:li:organization:\d+$/.test(value)
      ? value.slice("urn:li:organization:".length)
      : /^\d+$/.test(value)
        ? value
        : null;
    if (!orgId || seen.has(orgId)) return [];
    seen.add(orgId);
    const expanded = (r?.["organization~"] ?? r?.["organizationTarget~"]) as
      | { localizedName?: unknown }
      | undefined;
    const name =
      typeof expanded?.localizedName === "string" && expanded.localizedName
        ? expanded.localizedName
        : typeof r?.localizedName === "string" && r.localizedName
          ? r.localizedName
          : `Organization ${orgId}`;
    return [{ id: `urn:li:organization:${orgId}`, name, detail: "Company page" }];
  });
}

/** Rows of `{[idKey], [nameKey]}` out of a provider list, skipping malformed ones. */
function namedRows(rows: unknown, idKey: string, nameKey: string): DiscoveredAccount[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown> | null;
    const id = r?.[idKey];
    const name = r?.[nameKey];
    return typeof id === "string" && id
      ? [{ id, name: typeof name === "string" && name ? name : id }]
      : [];
  });
}

export const SERVICE_ADAPTERS: Record<string, ServiceAdapter> = {
  [facebook.serviceId]: facebook,
  [slack.serviceId]: slack,
  [twitter.serviceId]: twitter,
  [linkedin.serviceId]: linkedin,
  [instagram.serviceId]: instagram,
  [reddit.serviceId]: reddit,
};

export function getAdapter(serviceId: string): ServiceAdapter | undefined {
  return SERVICE_ADAPTERS[serviceId];
}

/**
 * Body limit assumed for a service with no adapter entry (a channel connected
 * against a service this build has no adapter for). Deliberately conservative:
 * short enough that a body over it is almost certainly a mistake, long enough
 * not to refuse ordinary copy.
 */
export const DEFAULT_CHAR_LIMIT = 5000;

/**
 * The one character limit for a service. The adapters above are the source of
 * truth; the composer used to carry its own copy of the same five numbers,
 * which could drift from the numbers publishing actually enforces. This module
 * imports nothing (no `server-only`, no Prisma), exactly so the browser can
 * read the same table the publisher does — the precedent `content-types.ts`
 * sets for a registry both sides need.
 */
export function serviceCharLimit(serviceId: string): number {
  return SERVICE_ADAPTERS[serviceId]?.charLimit ?? DEFAULT_CHAR_LIMIT;
}

/**
 * What one target actually sends, given the root and its parts: `posts` (the
 * root, then each reply of a thread) and the first comment, if any. A network
 * that doesn't thread gets the thread joined into the root's text, and one
 * with no first comment gets the comment joined on the end: nothing the
 * writer wrote is dropped on the way out. A service with no adapter (a manual
 * channel, a person pasting the copy) gets everything as one text.
 *
 * The ONE place that decision is made: the publisher sends this, and the
 * write seam, the network rules and the composer's counters measure it.
 */
export interface PublishPlan {
  posts: string[];
  comment: string | null;
  /** The thread (or comment) was folded into the root's text. */
  joined: boolean;
}

export function publishPlan(
  service: ServiceAdapter | string | null | undefined,
  body: string,
  parts: SocialPart[]
): PublishPlan {
  const adapter = typeof service === "string" ? getAdapter(service) : service ?? undefined;
  const thread = parts.filter((p) => p.kind === "thread").map((p) => p.body);
  const comment = parts.find((p) => p.kind === "first_comment")?.body ?? null;
  const threads = !!adapter?.threads;
  const comments = !!adapter?.firstCommentCharLimit;
  const posts = threads ? [body, ...thread] : [[body, ...thread].filter(Boolean).join("\n\n")];
  if (comment !== null && !comments) {
    posts[0] = [posts[0], comment].filter(Boolean).join("\n\n");
  }
  return {
    posts,
    comment: comments ? comment : null,
    joined: (!threads && thread.length > 0) || (comment !== null && !comments),
  };
}

/** Which kinds of part a service publishes as parts of their own. */
export function partSupport(service: ServiceAdapter | string | null | undefined): PartSupport {
  const adapter = typeof service === "string" ? getAdapter(service) : service ?? undefined;
  return { threads: !!adapter?.threads, firstComment: !!adapter?.firstCommentCharLimit };
}

/**
 * The same for a draft network (src/lib/social/destinations.ts): what the
 * editor's Social tab may parse out of copy written for it. A network whose
 * services differ is only as capable as all of them.
 */
export function partSupportForNetwork(network: string): PartSupport {
  const services = serviceIdsForNetwork(network);
  if (services.length === 0) return { threads: false, firstComment: false };
  const each = services.map((s) => partSupport(s));
  return {
    threads: each.every((p) => p.threads),
    firstComment: each.every((p) => p.firstComment),
  };
}

/** One part of a plan over its network's limit. */
export interface PartLimitProblem {
  /** "Tweet 2 of 3", "The first comment"; null when the post is one text. */
  part: string | null;
  length: number;
  limit: number;
  /** The text is the root with its thread or comment folded in. */
  joined: boolean;
}

/**
 * Every part of what `serviceId` would send that is over its limit, in the
 * order they would go out. Empty = every part fits.
 */
export function planLimitProblems(
  serviceId: string,
  body: string,
  parts: SocialPart[]
): PartLimitProblem[] {
  const adapter = getAdapter(serviceId);
  const plan = publishPlan(adapter, body, parts);
  const limit = serviceCharLimit(serviceId);
  const noun = adapter?.partNoun ?? "post";
  const problems: PartLimitProblem[] = [];
  plan.posts.forEach((text, i) => {
    if (text.length <= limit) return;
    const part =
      plan.posts.length === 1
        ? null
        : i === 0
          ? `The first ${noun} of the thread`
          : `${capitalize(noun)} ${i + 1} of ${plan.posts.length}`;
    problems.push({ part, length: text.length, limit, joined: plan.joined });
  });
  const commentLimit = adapter?.firstCommentCharLimit;
  if (plan.comment !== null && commentLimit && plan.comment.length > commentLimit) {
    problems.push({ part: "The first comment", length: plan.comment.length, limit: commentLimit, joined: false });
  }
  return problems;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Whether the connect dialog must collect the account id BEFORE the OAuth
 * round trip. A service that can discover its accounts fills the id in after
 * connecting; one that cannot (a subreddit is a choice, not something the
 * credential owns) still needs it typed.
 */
export function needsAccountIdUpfront(adapter: ServiceAdapter): boolean {
  return !!adapter.requiresAccountId && !adapter.discoverAccounts;
}

/** Services this app can publish to today (SKB coverage + adapter). */
export function supportedServiceIds(): string[] {
  return Object.keys(SERVICE_ADAPTERS);
}

// ---------------------------------------------------------------------------
// Network rules (G#26): per-service publish constraints, enforced BEFORE a
// post is scheduled or published — not just documented. get_social_network_rules
// (MCP) and GET /api/social/services report the same rules read-only; the
// compose/schedule routes call validateAgainstNetworkRules to refuse a post
// that would fail on the provider (or already fails inside publishTarget's
// try/catch, but only after the network call and marked as a failed target).
// ---------------------------------------------------------------------------

export interface NetworkRuleViolation {
  code:
    | "unsupported_service"
    | "char_limit"
    | "missing_account_id"
    | "missing_media"
    | "media_limit";
  channel_id: string;
  message: string;
}

export interface PublishCandidate {
  body: string;
  /** What follows the root (thread replies, a first comment). */
  parts?: SocialPart[];
  media?: { url: string; type?: string; alt?: string }[];
}

interface RuleCheckedChannel {
  id: string;
  service_id: string;
  service_name: string;
  account_id: string | null;
  /** G#27: manual channels never touch Interactor Core or a SERVICE_ADAPTERS
   * entry, so the adapter-derived rules below (which exist to predict what
   * WOULD fail on the provider's API) don't apply to them at all. */
  delivery_mode?: string | null;
}

/** Every violation of `channel`'s network rules that `candidate` (the post
 * body a target would actually publish — body_override or the post's body)
 * would hit. Empty array means the target is safe to schedule/publish.
 * Manual-mode channels (G#27) always return no violations — there is no
 * adapter to check against because there is no automated publish path;
 * a human posts the copy themselves after reading it from the
 * awaiting_manual queue. */
export function validateAgainstNetworkRules(
  channel: RuleCheckedChannel,
  candidate: PublishCandidate
): NetworkRuleViolation[] {
  if (isManualChannel(channel)) return [];

  const adapter = getAdapter(channel.service_id);
  if (!adapter) {
    return [
      {
        code: "unsupported_service",
        channel_id: channel.id,
        message: `No publish adapter for service "${channel.service_id}"`,
      },
    ];
  }

  // "Acme (Facebook Page)" names the channel and its network; a channel
  // named exactly like its network isn't named twice.
  const label =
    channel.service_name === adapter.displayName
      ? adapter.displayName
      : `${channel.service_name} (${adapter.displayName})`;
  const violations: NetworkRuleViolation[] = [];
  // Every part the network would get, measured as it would be sent: a tweet
  // of a thread against X's limit, a thread LinkedIn gets as one post as
  // that one post, the first comment against the comment limit.
  for (const problem of planLimitProblems(channel.service_id, candidate.body, candidate.parts ?? [])) {
    violations.push({
      code: "char_limit",
      channel_id: channel.id,
      message: problem.part
        ? `${label} allows ${problem.limit} characters; ${problem.part.charAt(0).toLowerCase()}${problem.part.slice(1)} is ${problem.length}`
        : `${label} allows ${problem.limit} characters; this post is ${problem.length}${
            problem.joined ? " with its thread joined into one post" : ""
          }`,
    });
  }
  if (adapter.requiresAccountId && !channel.account_id) {
    violations.push({
      code: "missing_account_id",
      channel_id: channel.id,
      message: `${label} has no connected account id — reconnect the channel`,
    });
  }
  if (adapter.requiresMedia && (candidate.media ?? []).length === 0) {
    violations.push({
      code: "missing_media",
      channel_id: channel.id,
      message: `${label} requires at least one image or video attachment`,
    });
  }
  // How many images/videos, and whether a video may sit beside images — the
  // adapter's own `mediaLimits`, which the composer checks through this
  // same function.
  const mediaProblem = mediaLimitProblem(
    adapter.mediaLimits,
    label,
    candidate.media ?? []
  );
  if (mediaProblem) {
    violations.push({ code: "media_limit", channel_id: channel.id, message: mediaProblem });
  }
  return violations;
}

/** The network rules every supported service publishes under — what
 * get_social_network_rules (MCP) and GET /api/social/services report. */
export function networkRules() {
  return Object.values(SERVICE_ADAPTERS).map((a) => ({
    service_id: a.serviceId,
    display_name: a.displayName,
    char_limit: a.charLimit ?? null,
    requires_account_id: a.requiresAccountId ?? false,
    requires_media: a.requiresMedia ?? false,
    media_limits: a.mediaLimits ?? null,
    account_label: a.accountLabel ?? null,
    discovers_accounts: !!a.discoverAccounts,
    // A thread goes out as a reply chain; elsewhere it is joined into one post.
    threads: !!a.threads,
    first_comment_char_limit: a.firstCommentCharLimit ?? null,
  }));
}

/** Maps an AI fan-out network (src/lib/social-networks.ts's linkedin | twitter
 * | facebook) to the SocialChannel.service_id(s) it corresponds to — used to
 * auto-attach SocialPostTarget rows to AI-generated copy (G#26 decision: the
 * AI fan-out previously created SocialPost rows with zero targets, so a
 * generated draft could never be scheduled without a human manually adding
 * channels first). Facebook is the one many-shaped case today (only the
 * Graph Page adapter exists), so it's a 1:1 map, but stays an array in case a
 * network ever fans out to more than one service (e.g. Threads alongside
 * Facebook). */
const NETWORK_SERVICE_IDS: Record<string, string[]> = {
  linkedin: ["linkedin"],
  twitter: ["twitter"],
  facebook: ["facebook-graph-api"],
};

export function serviceIdsForNetwork(network: string): string[] {
  return NETWORK_SERVICE_IDS[network] ?? [];
}
