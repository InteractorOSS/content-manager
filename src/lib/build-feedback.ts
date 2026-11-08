import "server-only";
import { env } from "@/lib/env";

/**
 * Server-side proxy for Interactor Build's embeddable feedback surface
 * (GET/vote/follow on /api/v1/projects/{id}/feedback/embed/*). The embed
 * token is project-scoped and meant to be public (the widget script ships it
 * client-side), but these routes go through our own API so identity (email)
 * comes from the CMS's own session rather than being trusted from the client.
 *
 * Contract taken from product-manager's source (src/lib/schemas/embed.ts,
 * src/app/api/v1/projects/[projectId]/feedback/embed/{items,vote,follow})
 * and confirmed live against this project's own token on 2026-07-12.
 */

export type CombinedItemType = "feedback" | "idea" | "ticket";
export type SortField = "date" | "status" | "votes";
export type SortOrder = "asc" | "desc";
export type ViewerVote = -1 | 0 | 1;

export interface CombinedListItem {
  id: string;
  type: CombinedItemType;
  title: string;
  body: string | null;
  status: string;
  createdAt: string;
  voteCount: number;
  viewerVote: ViewerVote;
  followed: boolean;
  commentCount: number;
}

export interface CombinedListResult {
  items: CombinedListItem[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

export interface ListQuery {
  type?: CombinedItemType;
  status?: string;
  sort?: SortField;
  order?: SortOrder;
  limit?: number;
  cursor?: string;
}

export class BuildFeedbackError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = "BuildFeedbackError";
  }
}

export function buildFeedbackConfigured(): boolean {
  return Boolean(env.BUILD_FEEDBACK_PROJECT_ID && env.BUILD_FEEDBACK_EMBED_TOKEN);
}

function requireConfig() {
  if (!buildFeedbackConfigured()) {
    throw new BuildFeedbackError(503, "Build feedback integration is not configured");
  }
  return {
    base: env.BUILD_FEEDBACK_API_BASE,
    projectId: env.BUILD_FEEDBACK_PROJECT_ID as string,
    token: env.BUILD_FEEDBACK_EMBED_TOKEN as string,
  };
}

async function parseErrorBody(res: Response) {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body?.error?.message;
  } catch {
    return undefined;
  }
}

export async function fetchMyItems(
  email: string,
  query: ListQuery
): Promise<CombinedListResult> {
  const { base, projectId, token } = requireConfig();

  const qs = new URLSearchParams({ email });
  if (query.type) qs.set("type", query.type);
  if (query.status) qs.set("status", query.status);
  if (query.sort) qs.set("sort", query.sort);
  if (query.order) qs.set("order", query.order);
  if (query.limit) qs.set("limit", String(query.limit));
  if (query.cursor) qs.set("cursor", query.cursor);

  const res = await fetch(
    `${base}/api/v1/projects/${projectId}/feedback/embed/items?${qs.toString()}`,
    { headers: { "X-Embed-Token": token }, cache: "no-store" }
  );
  if (!res.ok) {
    throw new BuildFeedbackError(
      res.status,
      (await parseErrorBody(res)) ?? `Build feedback items fetch failed (${res.status})`
    );
  }
  return (await res.json()) as CombinedListResult;
}

async function embedAction(
  path: "vote" | "follow",
  method: "POST" | "DELETE",
  email: string,
  input: { type: CombinedItemType; targetId: string; value?: ViewerVote; follow?: boolean }
): Promise<Record<string, unknown>> {
  const { base, projectId, token } = requireConfig();

  const res = await fetch(`${base}/api/v1/projects/${projectId}/feedback/embed/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Embed-Token": token },
    body: JSON.stringify({ email, ...input }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new BuildFeedbackError(
      res.status,
      (await parseErrorBody(res)) ?? `Build feedback ${path} failed (${res.status})`
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

export const voteItem = (email: string, type: CombinedItemType, targetId: string, value: ViewerVote) =>
  embedAction("vote", "POST", email, { type, targetId, value });

export const followItem = (email: string, type: CombinedItemType, targetId: string) =>
  embedAction("follow", "POST", email, { type, targetId });

export const unfollowItem = (email: string, type: CombinedItemType, targetId: string) =>
  embedAction("follow", "DELETE", email, { type, targetId });
