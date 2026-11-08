/**
 * The media a social post carries, and the rules every network's media is
 * checked by.
 *
 * Client-safe (no `server-only`): the composer reads the same rules the
 * write routes enforce, the precedent `capabilities.ts`'s `charLimit` set.
 *
 * An item always names a row in the org's media library (`media_id`). The
 * url, type and alt are copied from that row when the post is saved
 * (`resolveSocialMediaPayload`, media-server.ts), so a caller can't attach a
 * web address the org never uploaded, and the publisher has everything it
 * needs without a second lookup.
 */

export type SocialMediaType = "image" | "video";

export interface SocialMediaItem {
  media_id: string;
  url: string;
  type: SocialMediaType;
  alt?: string;
}

/** "image" / "video" from a Media row's mime type; null for anything a
 * network can't show (a PDF). */
export function mediaTypeFromMime(mime: string | null | undefined): SocialMediaType | null {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/**
 * How many images/videos one post may carry on a network. Declared on each
 * publish adapter (`ServiceAdapter.mediaLimits`, capabilities.ts) next to its
 * `charLimit`; an adapter without it doesn't publish media natively (Slack,
 * Reddit text posts), so nothing is refused.
 * `mixed: false` means a video goes alone (no images beside it).
 */
export interface MediaLimits {
  maxImages: number;
  maxVideos: number;
  maxItems: number;
  mixed: boolean;
  /** How the network describes the whole set, e.g. "a carousel of 2 to 10". */
  summary: string;
}

/**
 * The most items any one list (`media`, or one channel's override) may hold
 * on a write — LinkedIn's 20, the largest network limit. Bounds what the write
 * routes look up; the per-network limits are stricter.
 */
export const SOCIAL_MEDIA_MAX_ITEMS = 20;
/** Longest alt text a social media item may carry. Refused, never truncated. */
export const SOCIAL_MEDIA_ALT_MAX = 1000;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What `media` holds, in words: "5 images", "1 video and 2 images". */
export function describeMediaSet(media: { type?: string }[]): string {
  const videos = media.filter((m) => m.type === "video").length;
  const images = media.length - videos;
  if (videos && images) return `${plural(videos, "video")} and ${plural(images, "image")}`;
  if (videos) return plural(videos, "video");
  return plural(images, "image");
}

/**
 * Why `media` breaks `limits`, or null when it fits. Written for the person
 * composing: names the network's rule and what this post has, so the fix is
 * obvious. Called by `validateAgainstNetworkRules` with the adapter's limits.
 */
export function mediaLimitProblem(
  limits: MediaLimits | null | undefined,
  networkName: string,
  media: { type?: string }[]
): string | null {
  if (!limits || media.length === 0) return null;
  const videos = media.filter((m) => m.type === "video").length;
  const images = media.length - videos;
  const over =
    media.length > limits.maxItems ||
    images > limits.maxImages ||
    videos > limits.maxVideos ||
    (!limits.mixed && videos > 0 && images > 0);
  if (!over) return null;
  return `${networkName} takes ${limits.summary}; this post has ${describeMediaSet(media)}.`;
}

/** A stored `media` / `media_override` JSON value, read back as items. */
export function storedMedia(value: unknown): SocialMediaItem[] {
  return Array.isArray(value) ? (value as SocialMediaItem[]) : [];
}

/** A stored `media_override`: null (none) stays null, so `??` can fall back. */
export function storedMediaOverride(value: unknown): SocialMediaItem[] | null {
  return Array.isArray(value) ? (value as SocialMediaItem[]) : null;
}

/**
 * The media one target actually publishes: its own override when it has one
 * (even an empty list — "no media on this channel"), else the post's. The one
 * rule the publisher, the network-rule checks and the manual queue all read,
 * so no path picks a target's media its own way.
 */
export function resolveTargetMedia(
  target: { media_override?: unknown },
  post: { media?: unknown }
): SocialMediaItem[] {
  return storedMediaOverride(target.media_override) ?? storedMedia(post.media);
}

/**
 * Give items saved before the library picker (a url, no `media_id`) their
 * library id where a usable row has the same url. One that matches nothing
 * stays without an id: the composer flags it for re-picking rather than
 * sending it, since the write routes refuse anything that isn't a library file.
 */
export function matchLibraryMedia<T extends { media_id?: string; url: string; type?: string }>(
  items: T[],
  library: { id: string; file_path: string; mime_type: string | null }[]
): T[] {
  if (items.every((m) => m.media_id)) return items;
  const byUrl = new Map<string, { id: string; type: SocialMediaType }>();
  for (const row of library) {
    const type = mediaTypeFromMime(row.mime_type);
    if (type && !byUrl.has(row.file_path)) byUrl.set(row.file_path, { id: row.id, type });
  }
  return items.map((m) => {
    if (m.media_id) return m;
    const row = byUrl.get(m.url);
    return row ? { ...m, media_id: row.id, type: row.type } : m;
  });
}
