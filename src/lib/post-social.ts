import type { Prisma } from "@prisma/client";
import type { TenantDb } from "@/lib/tenant-db";
import { partSupportForNetwork } from "@/lib/social/capabilities";
import { joinPartsText, parsePartsText, socialPostParts, type SocialPart } from "@/lib/social/parts";
import {
  DRAFT_NETWORKS as SOCIAL_FORMATS,
  isDraftNetwork as isSocialFormat,
  type DraftNetwork as SocialFormat,
} from "@/lib/social/destinations";

// Social copy for a post: one draft per network (LinkedIn, X, Facebook,
// Instagram, Reddit, Slack — DRAFT_NETWORKS in src/lib/social/destinations.ts),
// stored as a SocialPost whose source_post_id is the post — the same rows the
// AI fan-out writes and the Social queue schedules. The writer editor's
// Social tab and the save_social_draft MCP tool both go through here.
//
// A network's "current" copy is its newest SocialPost for the post that isn't
// archived. Saving edits it in place, unless it has already gone out
// (publishing/published): then a new draft is started, so published copy is
// never rewritten after the fact. Scheduling and publishing stay in the
// Social queue, where approval lives. WHERE a draft goes and the link it
// carries back to the post are src/lib/post-social-delivery.ts: callers run
// syncPostSocialDelivery after a save.
//
// Copy here is TEXT, as the writer types it: on X a line with only `---`
// starts the next tweet of a thread, and on X, LinkedIn and Facebook a
// `--- first comment` line starts the comment posted under the post. Saving
// splits that text into the root (`SocialPost.body`) and its parts
// (`SocialPost.parts`, src/lib/social/parts.ts); reading joins them back, so
// drafts written before parts existed open and save exactly as before.

const LOCKED = new Set(["publishing", "published"]);

export type PostSocialDraft = {
  id: string;
  network: SocialFormat;
  /** The copy as the writer types it: the root, then each part after its
   * separator line. */
  body: string;
  /** The same copy split: what follows the root, in order. */
  parts: SocialPart[];
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  updated_at: string;
  /** False once the copy has gone out; saving then starts a new draft. */
  editable: boolean;
};

type Row = {
  id: string;
  network: string | null;
  body: string;
  parts: Prisma.JsonValue;
  status: string;
  scheduled_at: Date | null;
  published_at: Date | null;
  updated_at: Date;
};

function format(row: Row): PostSocialDraft {
  const split = socialPostParts(row);
  return {
    id: row.id,
    network: row.network as SocialFormat,
    body: joinPartsText(split.body, split.parts),
    parts: split.parts,
    status: row.status,
    scheduled_at: row.scheduled_at?.toISOString() ?? null,
    published_at: row.published_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
    editable: !LOCKED.has(row.status),
  };
}

async function currentRows(db: TenantDb, postId: string): Promise<Map<SocialFormat, Row>> {
  const rows = await db.socialPost.findMany({
    where: { source_post_id: postId, network: { in: [...SOCIAL_FORMATS] }, status: { not: "archived" } },
    orderBy: { updated_at: "desc" },
    select: { id: true, network: true, body: true, parts: true, status: true, scheduled_at: true, published_at: true, updated_at: true },
  });
  const byNetwork = new Map<SocialFormat, Row>();
  for (const row of rows) {
    if (isSocialFormat(row.network ?? "") && !byNetwork.has(row.network as SocialFormat)) {
      byNetwork.set(row.network as SocialFormat, row);
    }
  }
  return byNetwork;
}

/** The post's current copy per network (networks with none are left out). */
export async function listPostSocial(db: TenantDb, postId: string): Promise<PostSocialDraft[]> {
  const rows = await currentRows(db, postId);
  return SOCIAL_FORMATS.flatMap((n) => (rows.has(n) ? [format(rows.get(n)!)] : []));
}

/**
 * Save a network's copy. An empty body removes a draft that was never
 * scheduled or sent (and is a no-op when there is none). Returns the saved
 * draft, or null when it was removed.
 */
export async function savePostSocial(
  db: TenantDb,
  input: { postId: string; network: SocialFormat; body: string; userId: string }
): Promise<PostSocialDraft | null> {
  const current = (await currentRows(db, input.postId)).get(input.network);
  const text = input.body.replace(/\r\n/g, "\n");

  if (!text.trim()) {
    if (current && current.status === "draft") await db.socialPost.delete({ where: { id: current.id } });
    return null;
  }
  // parseSocialSave refuses this at the route already; checked again here so
  // no caller can store an unbounded thread by skipping it.
  const split = parsePartsText(text, partSupportForNetwork(input.network));
  if (!split.ok) throw new Error(split.message);
  const { body, parts } = split;
  const partsJson = parts as unknown as Prisma.InputJsonValue;
  if (current && !LOCKED.has(current.status)) {
    const was = socialPostParts(current);
    if (current.parts !== null && was.body === body && JSON.stringify(was.parts) === JSON.stringify(parts)) {
      return format(current);
    }
    const saved = await db.socialPost.update({ where: { id: current.id }, data: { body, parts: partsJson } });
    return format(saved);
  }
  const created = await db.socialPost.create({
    data: {
      body,
      parts: partsJson,
      status: "draft",
      network: input.network,
      source_post_id: input.postId,
      created_by_id: input.userId,
    },
  });
  return format(created);
}

export const SOCIAL_BODY_MAX = 10_000;

/**
 * Validate a save request body: { network, body }. The body is split into
 * parts here as well, so too many parts (or a second first comment) is a 400
 * before anything is written.
 */
export function parseSocialSave(input: unknown): { network: SocialFormat; body: string } | { error: string } {
  const o = (input ?? {}) as { network?: unknown; body?: unknown };
  if (typeof o.network !== "string" || !isSocialFormat(o.network)) {
    return { error: `network must be one of: ${SOCIAL_FORMATS.join(", ")}` };
  }
  if (typeof o.body !== "string") return { error: "body must be a string (empty removes the draft)" };
  if (o.body.length > SOCIAL_BODY_MAX) return { error: `body is longer than ${SOCIAL_BODY_MAX} characters` };
  const split = parsePartsText(o.body, partSupportForNetwork(o.network));
  if (!split.ok) return { error: split.message };
  return { network: o.network, body: o.body };
}
