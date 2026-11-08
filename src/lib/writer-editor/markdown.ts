import DiffMatchPatch from "diff-match-patch";

// Keeping a writer's Markdown stable through a formatted editor.
//
// A formatted editor parses Markdown into a document and writes Markdown back
// out, and the writing-back is never byte-identical to what came in: bullets,
// dividers, table padding, blank lines. Measured on the 25 published posts,
// only 2 survived an untouched open-and-save unchanged. Every such rewrite
// would reach the CMS as an edit nobody made, bloat the revision history and
// the git mirror, and could clash with Claude editing the same file.
//
// Two layers keep that from happening:
//   1. The serializer is told to write in the posts' own house style
//      (STRINGIFY_STYLE: "-" bullets, "---" dividers). That removes those
//      differences, but not table padding, blank lines or <url> autolinks.
//   2. Nothing the editor serializes is ever saved wholesale. On load we keep
//      the ORIGINAL text and the editor's rendering of it (the BASELINE); on
//      save, the writer's changes are diffed baseline → current and those
//      patches are applied to the original (applyEditsToOriginal). Untouched
//      paragraphs keep their exact original bytes, and a post that is opened
//      but not edited is never written at all.

/** remark-stringify options matching how the CMS's posts are written. */
export const STRINGIFY_STYLE = {
  bullet: "-",
  rule: "-",
  emphasis: "_",
  strong: "*",
} as const;

export type EditResult = { text: string; clean: boolean };

/**
 * Apply the edits that turned `baseline` into `current` to `original`.
 * `clean` is false when some patch couldn't be placed; the caller then falls
 * back to `current` (the editor's own Markdown) rather than lose an edit.
 */
export function applyEditsToOriginal(original: string, baseline: string, current: string): EditResult {
  if (current === baseline) return { text: original, clean: true };
  // Some posts were written with Windows line endings; the editor always
  // emits "\n". Patching CRLF text with LF context left mixed endings like
  // "## Heading\n\r\n", so work in LF and restore the post's own style.
  const crlf = original.includes("\r\n");
  const result = applyEditsLF(lf(original), lf(baseline), lf(current));
  return crlf ? { ...result, text: result.text.replace(/\n/g, "\r\n") } : result;
}

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function applyEditsLF(original: string, baseline: string, current: string): EditResult {
  if (current === baseline) return { text: original, clean: true };
  if (original === baseline) return { text: current, clean: true };
  const dmp = new DiffMatchPatch();
  // Locate each edit by its surrounding text, not its offset: the editor
  // re-pads tables and shifts blank lines, so an edit below a table can sit
  // hundreds of characters away from where it is in the original. With the
  // default distance penalty those patches failed and the whole re-serialized
  // post was saved instead, table padding and all.
  dmp.Match_Distance = 100_000;
  const diffs = dmp.diff_main(baseline, current);
  dmp.diff_cleanupSemantic(diffs);
  const patches = dmp.patch_make(baseline, diffs);
  // The editor always ends its Markdown with a newline; many posts are stored
  // without one. Content added at the very end was then anchored on a newline
  // the original doesn't have, and landed one newline short: an image added
  // after the last paragraph became "paragraph.\n![alt](url)", which Markdown
  // reads as part of that paragraph. Patch against the original with the
  // newline, and drop it again unless something was added after the post's
  // last line.
  const padded = original !== "" && !original.endsWith("\n") && baseline.endsWith("\n");
  const [patched, applied] = dmp.patch_apply(patches, padded ? `${original}\n` : original);
  if (!applied.every(Boolean)) return { text: current, clean: false };
  const text = padded && !appendsAtEnd(diffs, baseline) && patched.endsWith("\n") ? patched.slice(0, -1) : patched;
  return { text, clean: true };
}

/** True when the diff adds a new line of visible text after the baseline's
 *  last line (not words typed onto the end of that line). */
function appendsAtEnd(diffs: DiffMatchPatch.Diff[], baseline: string): boolean {
  const contentEnd = baseline.trimEnd().length;
  let offset = 0;
  for (const [op, chunk] of diffs) {
    if (op === DiffMatchPatch.DIFF_INSERT) {
      if (offset >= contentEnd && chunk.trim() && chunk.trimEnd().includes("\n")) return true;
    } else {
      offset += chunk.length;
    }
  }
  return false;
}

/**
 * Three-way merge for when the post changed elsewhere (Claude editing the
 * file, someone in the CMS) while the writer has unsaved edits: apply the
 * writer's edits (base → mine) onto the new version (theirs). `clean` is
 * false when the two touched the same text, which the page shows as a
 * conflict rather than guessing.
 */
export function mergeEdits(base: string, mine: string, theirs: string): EditResult {
  if (mine === base) return { text: theirs, clean: true };
  if (theirs === base) return { text: mine, clean: true };
  const crlf = theirs.includes("\r\n");
  const result = mergeEditsLF(lf(base), lf(mine), lf(theirs));
  return crlf ? { ...result, text: result.text.replace(/\n/g, "\r\n") } : result;
}

function mergeEditsLF(base: string, mine: string, theirs: string): EditResult {
  if (mine === base) return { text: theirs, clean: true };
  if (theirs === base) return { text: mine, clean: true };
  const dmp = new DiffMatchPatch();
  dmp.Match_Distance = 100_000;
  dmp.Match_Threshold = 0.3;
  const diffs = dmp.diff_main(base, mine);
  dmp.diff_cleanupSemantic(diffs);
  const patches = dmp.patch_make(base, diffs);
  const [text, applied] = dmp.patch_apply(patches, theirs);
  return { text, clean: applied.every(Boolean) };
}
