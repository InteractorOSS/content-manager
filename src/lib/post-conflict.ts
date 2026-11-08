/**
 * Shared 409 body shape for every post write path that checks
 * expected_content_hash against Post.content_hash (PUT /api/cms/posts/[id],
 * resolve-conflict, applyPostImport) — one conflict shape instead of each
 * path inventing its own, so a caller only has to learn it once.
 */
export interface ConflictablePost {
  content_hash: string | null;
  updated_at: Date;
  updated_by_id: string | null;
  updated_by_name: string | null;
}

// The public API has no `select` allowlist — it spreads the row minus
// preview_token_expires_at (see omitPreviewToken). updated_by_id/name name an
// internal CMS user, not the post's public byline (that's author_name) — an
// anonymous reader must never learn which staff member last touched a post.
export function omitLastEditor<T extends { updated_by_id?: unknown; updated_by_name?: unknown }>(
  post: T
): Omit<T, "updated_by_id" | "updated_by_name"> {
  const { updated_by_id: _omitId, updated_by_name: _omitName, ...rest } = post;
  return rest;
}

/**
 * Resolve the hash a write is conditioned on, from either an
 * `expected_content_hash` body field or a fallback `If-Match` header —
 * shared so PUT /api/cms/posts/[id] and resolve-conflict can't drift out of
 * parity on which forms of the check a caller may use (they already did
 * once: If-Match support existed on PUT but not resolve-conflict).
 *
 * `undefined` means "no check requested" (absent field, absent header, or a
 * bare `If-Match: *`, which RFC 7232 defines as matching any current
 * representation — since existence is already confirmed by the caller
 * before this runs, that's equivalent to skipping the check here).
 */
export function resolveExpectedContentHash(
  data: unknown,
  ifMatchHeader: string | null
): string | null | undefined {
  // `data` is whatever req.json() parsed — syntactically valid JSON that
  // isn't an object (null, a number, a bare string, a boolean) makes the
  // `in` operator below throw, not just a parse failure the caller's own
  // `.catch()` already guards against.
  if (typeof data === "object" && data !== null && "expected_content_hash" in data) {
    return data.expected_content_hash === null ? null : String(data.expected_content_hash);
  }
  if (ifMatchHeader === null || ifMatchHeader === "*") return undefined;
  // Strip a leading weak-validator marker (RFC 7232 W/"...") before the
  // surrounding quotes — content_hash has no weak/strong distinction of its
  // own, so a weak tag is compared the same as a strong one.
  return ifMatchHeader.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export function postConflictBody(post: ConflictablePost) {
  return {
    error: "This post was edited since you loaded it — re-fetch, re-apply your change, and retry",
    current_hash: post.content_hash,
    updated_at: post.updated_at.toISOString(),
    last_editor: post.updated_by_id
      ? { id: post.updated_by_id, name: post.updated_by_name }
      : null,
  };
}
