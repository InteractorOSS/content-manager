/**
 * Pure, string-only anchored find/replace engine (introduced for G#15's
 * PATCH /api/cms/posts/[id]/content) — a bounded, blast-radius-limited
 * alternative to rewriting a whole text body. Has no dependency on Post or
 * any other model, so it's reusable anywhere an "edit this passage, not the
 * whole document" write path is needed (e.g. a future anchored edit for
 * FaqRevision's `answer`). Kept separate from any one route so the
 * match-counting and sequencing logic is unit-testable without a database.
 */

export interface AnchoredReplacement {
  find: string;
  replace: string;
  /** How many times `find` must occur; default 1. An ambiguous (>1, unspecified) or absent anchor fails the whole call. */
  expected_occurrences?: number;
}

export interface AnchoredReplaceFailure {
  index: number;
  find: string;
  expected_occurrences: number;
  found_occurrences: number;
}

export type AnchoredReplaceResult =
  | { ok: true; content: string }
  | { ok: false; failure: AnchoredReplaceFailure };

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) return count;
    count++;
    pos = idx + needle.length;
  }
}

/**
 * Apply a sequence of exact-match find/replace edits to `content`, one at a
 * time — each replacement is counted and applied against the result of the
 * ones before it, so a later anchor may target text an earlier replacement
 * just introduced. Every replacement's `find` must occur EXACTLY
 * `expected_occurrences` times (default 1) in the content AT THAT POINT; the
 * first one that doesn't fails the WHOLE call before anything is returned —
 * the caller never sees a partially-applied result, and the actual post row
 * is never touched unless every replacement here already validated clean.
 */
export function applyAnchoredReplacements(
  content: string,
  replacements: AnchoredReplacement[]
): AnchoredReplaceResult {
  let working = content;
  for (let index = 0; index < replacements.length; index++) {
    const { find, replace, expected_occurrences } = replacements[index];
    const expected = expected_occurrences ?? 1;
    const found = countOccurrences(working, find);
    if (found !== expected) {
      return { ok: false, failure: { index, find, expected_occurrences: expected, found_occurrences: found } };
    }
    working = working.split(find).join(replace);
  }
  return { ok: true, content: working };
}
