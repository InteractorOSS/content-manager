import { ApiError } from "@/lib/api";

// A 409 from a post write route can mean either a slug collision or a stale
// expected_content_hash (someone else edited this post since it was
// loaded) — only the latter carries current_hash, which is how we tell them
// apart without a second error code. Shared by every UI surface that writes
// a post with a hash guard (the editor's save/publish/submit, restoring a
// revision, resolving a sync conflict) so they all explain a lost race the
// same way.
export function postSaveConflictMessage(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { current_hash?: unknown; last_editor?: { name?: string | null } | null } | undefined;
  if (!body || !("current_hash" in body)) return null;
  const editorName = body.last_editor?.name;
  return editorName
    ? `This post was edited by ${editorName} since you loaded it — reload to see their changes before saving again.`
    : "This post was edited since you loaded it — reload to see the latest version before saving again.";
}
