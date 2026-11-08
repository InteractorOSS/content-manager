import {
  SOCIAL_MEDIA_ALT_MAX,
  SOCIAL_MEDIA_MAX_ITEMS,
  mediaTypeFromMime,
  type SocialMediaItem,
} from "@/lib/social/media";

/**
 * The media check at the social write seam (POST/PUT /api/social/posts, and
 * so the MCP compose/schedule tools that delegate to them).
 *
 * Every item must name a Media row in the caller's org. Rows are read through
 * the tenant-scoped client, so another org's id is simply not found: a
 * guessed id refuses exactly like a deleted one. The stored item is rebuilt
 * from the row — the caller's `url`/`type` are ignored — which is what makes
 * an arbitrary web address impossible to attach: the publisher hands these
 * URLs to a provider to fetch, and only files this org uploaded may go.
 *
 * The post's `media` and every channel's override are checked in shape first
 * and then resolved with ONE `findMany`, so the route learns everything that
 * is wrong before it writes anything, and a ten-channel post costs one query.
 *
 * Split from `media.ts` for the reason `char-limits-server.ts` is split from
 * the adapters: the rules stay importable by the composer, the query lives
 * out here.
 */

interface MediaLookupDb {
  media: {
    findMany: (args: {
      where: { id: { in: string[] } };
    }) => Promise<{ id: string; file_path: string; mime_type: string; alt_text: string | null }[]>;
  };
}

export type MediaPayloadResolution =
  | {
      ok: true;
      /** The post's media, or undefined when the payload left it out (PUT:
       * keep what is stored). */
      media: SocialMediaItem[] | undefined;
      /** channel_id -> its own media; null clears the override. */
      overrides: Record<string, SocialMediaItem[] | null>;
    }
  | { ok: false; message: string };

const NOT_A_LIST =
  "The post's images weren't sent as a list. Pick them again from the media library and save.";
const NO_MEDIA_ID =
  "Images and videos have to come from your media library — a web address can't be attached directly. Upload the file to the media library, then pick it for this post.";
const TOO_MANY = `A post can carry at most ${SOCIAL_MEDIA_MAX_ITEMS} images or videos (per channel, too). Remove some and save again.`;
const ALT_TOO_LONG = `Alt text can be at most ${SOCIAL_MEDIA_ALT_MAX} characters. Shorten it and save again — a sentence or two describing the image is plenty.`;
const NOT_FOUND =
  "One of the attached files isn't in this organization's media library (it may have been deleted). Remove it, pick it again from the library, and save.";
const NOT_VISUAL =
  "Only images and videos can go on a social post. Remove the other file and save again.";

interface WantedItem {
  id: string;
  alt?: string;
}

/** Shape-check one list without touching the database. */
function parseList(items: unknown): { ok: true; wanted: WantedItem[] } | { ok: false; message: string } {
  if (items === null || items === undefined) return { ok: true, wanted: [] };
  if (!Array.isArray(items)) return { ok: false, message: NOT_A_LIST };
  if (items.length > SOCIAL_MEDIA_MAX_ITEMS) return { ok: false, message: TOO_MANY };
  const wanted: WantedItem[] = [];
  for (const item of items) {
    const id =
      item && typeof item === "object" && typeof (item as { media_id?: unknown }).media_id === "string"
        ? (item as { media_id: string }).media_id.trim()
        : "";
    if (!id) return { ok: false, message: NO_MEDIA_ID };
    const rawAlt = (item as { alt?: unknown }).alt;
    const alt = typeof rawAlt === "string" && rawAlt.trim() ? rawAlt.trim() : undefined;
    if (alt && alt.length > SOCIAL_MEDIA_ALT_MAX) return { ok: false, message: ALT_TOO_LONG };
    wanted.push({ id, alt });
  }
  return { ok: true, wanted };
}

/**
 * Resolve a write's `media` and `media_overrides` (whatever the caller sent)
 * to stored media, or refuse with a sentence for the person who sent it.
 * Overrides: `{ [channel_id]: items | null }` — null clears a channel's
 * override (it goes back to the post's media); an empty list is a real
 * override meaning "no media on this channel".
 */
export async function resolveSocialMediaPayload(
  db: MediaLookupDb,
  payload: { media?: unknown; media_overrides?: unknown }
): Promise<MediaPayloadResolution> {
  const post = payload.media === undefined ? null : parseList(payload.media);
  if (post && !post.ok) return post;

  const rawOverrides = payload.media_overrides;
  if (
    rawOverrides !== null &&
    rawOverrides !== undefined &&
    (typeof rawOverrides !== "object" || Array.isArray(rawOverrides))
  ) {
    return { ok: false, message: NOT_A_LIST };
  }
  const overrideWanted: Record<string, WantedItem[] | null> = {};
  for (const [channelId, items] of Object.entries((rawOverrides ?? {}) as Record<string, unknown>)) {
    if (items === null) {
      overrideWanted[channelId] = null;
      continue;
    }
    const parsed = parseList(items);
    if (!parsed.ok) return parsed;
    overrideWanted[channelId] = parsed.wanted;
  }

  const ids = new Set<string>();
  for (const w of post?.wanted ?? []) ids.add(w.id);
  for (const list of Object.values(overrideWanted)) for (const w of list ?? []) ids.add(w.id);

  const rows = ids.size ? await db.media.findMany({ where: { id: { in: Array.from(ids) } } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const build = (wanted: WantedItem[]): { ok: true; media: SocialMediaItem[] } | { ok: false; message: string } => {
    const media: SocialMediaItem[] = [];
    for (const w of wanted) {
      const row = byId.get(w.id);
      if (!row) return { ok: false, message: NOT_FOUND };
      const type = mediaTypeFromMime(row.mime_type);
      if (!type) return { ok: false, message: NOT_VISUAL };
      const alt = w.alt ?? (row.alt_text?.trim() || undefined);
      media.push({ media_id: row.id, url: row.file_path, type, ...(alt ? { alt } : {}) });
    }
    return { ok: true, media };
  };

  let media: SocialMediaItem[] | undefined;
  if (post) {
    const built = build(post.wanted);
    if (!built.ok) return built;
    media = built.media;
  }
  const overrides: Record<string, SocialMediaItem[] | null> = {};
  for (const [channelId, wanted] of Object.entries(overrideWanted)) {
    if (wanted === null) {
      overrides[channelId] = null;
      continue;
    }
    const built = build(wanted);
    if (!built.ok) return built;
    overrides[channelId] = built.media;
  }
  return { ok: true, media, overrides };
}
