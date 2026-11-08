import type { NextRequest } from "next/server";
import type { AuthVia } from "@/lib/guard";

/**
 * Who/what produced a revision. `restore` is itself a write path (restoring
 * a revision snapshots the pre-restore state before applying the target),
 * so a restore is always undoable too. `writing` is a live-editing session
 * (the Interactor CMS plugin), which snapshots once per session/pause
 * rather than per save; `checkpoint` is an explicit, labelled snapshot.
 */
export type PostRevisionSource = "cms_ui" | "api" | "mcp" | "import" | "restore" | "writing" | "checkpoint";

/**
 * A live-editing session saves every second or so, so it snapshots only on
 * its first save and on the first save after this long without one. The
 * pre-write snapshot then marks the end of the previous burst of work.
 */
export const WRITING_CHECKPOINT_GAP_MS = 10 * 60 * 1000;

/** Whether a live-editing session's save should snapshot the post first. */
export function writingSaveCheckpoints(lastWriteAt: Date | null, now: Date): boolean {
  return !lastWriteAt || now.getTime() - lastWriteAt.getTime() >= WRITING_CHECKPOINT_GAP_MS;
}

/** Header set only by src/lib/mcp/delegate.ts, never reachable from outside the process. */
export const MCP_DELEGATE_HEADER = "x-cms-mcp-delegate";

/** cms_ui for a browser session, mcp for an MCP-delegated call, api for a bare PAT request. */
export function resolveRevisionSource(req: NextRequest, via: AuthVia): PostRevisionSource {
  if (via === "session") return "cms_ui";
  return req.headers.get(MCP_DELEGATE_HEADER) ? "mcp" : "api";
}

/** The subset of Post fields a revision snapshots. */
export interface PostContentSnapshot {
  title: string;
  content: string | null;
  content_format: string;
  content_html: string | null;
  excerpt: string | null;
  content_hash: string | null;
}

/**
 * True when a prospective update actually touches a snapshotted field.
 * `data` fields are `undefined` when absent from the request (untouched);
 * only fields the caller sent AND that differ from `existing` count as a
 * change — matches the FaqRevision `answerChanged` gate (src/app/api/cms/faqs/[id]/route.ts).
 */
export function postContentChanged(
  data: { title?: unknown; content?: unknown; content_format?: unknown; excerpt?: unknown },
  existing: PostContentSnapshot
): boolean {
  if (data.title !== undefined && String(data.title) !== existing.title) return true;
  if (data.content !== undefined && (String(data.content) || null) !== existing.content) return true;
  if (data.content_format !== undefined && String(data.content_format) !== existing.content_format) {
    return true;
  }
  if (data.excerpt !== undefined && (String(data.excerpt) || null) !== existing.excerpt) return true;
  return false;
}

/** Build the create payload for a pre-write snapshot of `existing`. */
export function revisionSnapshotData(
  postId: string,
  existing: PostContentSnapshot,
  editedById: string | null,
  source: PostRevisionSource
) {
  return {
    post_id: postId,
    title: existing.title,
    content: existing.content,
    content_format: existing.content_format,
    content_html: existing.content_html,
    excerpt: existing.excerpt,
    content_hash: existing.content_hash,
    edited_by_id: editedById,
    source,
  };
}

/**
 * Retention: thin by age rather than cap by count. A flat "newest 100" meant a
 * busy afternoon could push out a post's whole history. Instead:
 *
 *   - everything from the last day is kept;
 *   - from a day to a week old, the newest revision in each hour;
 *   - older than a week, the newest revision in each day;
 *   - labelled checkpoints are kept regardless of age;
 *   - and a hard ceiling of the newest RETENTION_CEILING survivors bounds the
 *     storage cost (content/content_html are large columns) on a post that is
 *     edited heavily for years.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const RETENTION_CEILING = 500;

type RetainableRevision = { id: string; inserted_at: Date; label: string | null };

/** The ids to delete under the retention policy above. Pure. */
export function revisionsToPrune(revisions: RetainableRevision[], now: Date): string[] {
  const newestFirst = [...revisions].sort((a, b) => b.inserted_at.getTime() - a.inserted_at.getTime());
  const seenBuckets = new Set<string>();
  const kept: string[] = [];
  const pruned: string[] = [];

  for (const rev of newestFirst) {
    const age = now.getTime() - rev.inserted_at.getTime();
    let keep: boolean;
    if (rev.label || age < DAY_MS) {
      keep = true;
    } else {
      const bucket = age < 7 * DAY_MS
        ? `h${Math.floor(rev.inserted_at.getTime() / HOUR_MS)}`
        : `d${Math.floor(rev.inserted_at.getTime() / DAY_MS)}`;
      keep = !seenBuckets.has(bucket);
      seenBuckets.add(bucket);
    }
    (keep && kept.length < RETENTION_CEILING ? kept : pruned).push(rev.id);
  }
  return pruned;
}

interface RevisionPruneClient {
  postRevision: {
    findMany(args: {
      where: { post_id: string };
      select: { id: true; inserted_at: true; label: true };
    }): Promise<RetainableRevision[]>;
    deleteMany(args: { where: { post_id: string; id: { in: string[] } } }): Promise<unknown>;
  };
}

/**
 * Apply the retention policy to one post. Best-effort and NOT part of the
 * write transaction — a revision briefly over the policy is harmless, whereas
 * blocking the save on a cleanup query is not. Call sites fire this without
 * awaiting (`void pruneOldRevisions(...).catch(...)`).
 */
export async function pruneOldRevisions(
  db: RevisionPruneClient,
  postId: string,
  now: Date = new Date()
): Promise<void> {
  const revisions = await db.postRevision.findMany({
    where: { post_id: postId },
    select: { id: true, inserted_at: true, label: true },
  });
  const doomed = revisionsToPrune(revisions, now);
  if (doomed.length === 0) return;
  await db.postRevision.deleteMany({ where: { post_id: postId, id: { in: doomed } } });
}
