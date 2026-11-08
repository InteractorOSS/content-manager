/**
 * A social post as ordered parts: the root post (`SocialPost.body`), then the
 * replies of an X thread, then at most one "first comment" posted under it.
 *
 * Before this, an X thread was one body with `---` lines between the tweets
 * (the AI fan-out's stopgap), and the publisher sent that body as ONE tweet —
 * over X's limit, so it could only ever be refused. Parts are stored on
 * `SocialPost.parts`; how each network publishes them is the adapter's
 * business (`publishPlan` in capabilities.ts).
 *
 * Pure and client-safe: the composer, the editor's Social tab, the write
 * routes and the publisher all read the same rules.
 */

export const SOCIAL_PART_KINDS = ["thread", "first_comment"] as const;
export type SocialPartKind = (typeof SOCIAL_PART_KINDS)[number];

export interface SocialPart {
  kind: SocialPartKind;
  body: string;
}

/** How many parts may follow the root. X itself allows 25 tweets a thread. */
export const MAX_SOCIAL_PARTS = 24;
/** Longest single part, far past any network's limit; a bound on stored JSON. */
export const SOCIAL_PART_MAX = 10_000;

/** A line with only `---` on it separates tweets. */
const THREAD_LINE = /^\s*---\s*$/;
/** `--- first comment` (any case, optional trailing dashes) starts the first comment. */
const FIRST_COMMENT_LINE = /^\s*---\s*first comment\s*-*\s*$/i;

/** What a network can do with parts beyond the root. */
export interface PartSupport {
  /** Thread parts are posted as a reply chain (X). */
  threads: boolean;
  /** A first comment is posted under the root (X, LinkedIn, Facebook). */
  firstComment: boolean;
}

/**
 * Parts in their one canonical order: thread parts as given, then at most one
 * first comment (the first one given). Blank parts are dropped.
 */
export function normalizeParts(parts: SocialPart[]): SocialPart[] {
  const thread = parts.filter((p) => p.kind === "thread" && p.body.trim());
  const comment = parts.find((p) => p.kind === "first_comment" && p.body.trim());
  return [...thread, ...(comment ? [comment] : [])].map((p) => ({ kind: p.kind, body: p.body.trim() }));
}

/** `SocialPost.parts` as stored, read defensively (anything malformed is skipped). */
export function storedParts(raw: unknown): SocialPart[] {
  if (!Array.isArray(raw)) return [];
  return normalizeParts(
    raw.flatMap((p): SocialPart[] => {
      const o = p as { kind?: unknown; body?: unknown } | null;
      return o &&
        typeof o.body === "string" &&
        (SOCIAL_PART_KINDS as readonly unknown[]).includes(o.kind)
        ? [{ kind: o.kind as SocialPartKind, body: o.body }]
        : [];
    })
  );
}

/**
 * A `parts` field from a write request. `undefined` = not sent (keep what is
 * stored); otherwise an array of `{ kind, body }`, normalized. `null` clears.
 */
export function parsePartsPayload(
  raw: unknown
): { ok: true; parts: SocialPart[] | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, parts: undefined };
  if (raw === null) return { ok: true, parts: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, message: "parts must be a list of { kind, body }, where kind is thread or first_comment." };
  }
  const parts: SocialPart[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i] as { kind?: unknown; body?: unknown } | null;
    if (!o || !(SOCIAL_PART_KINDS as readonly unknown[]).includes(o.kind)) {
      return { ok: false, message: `Part ${i + 1} needs a kind of thread or first_comment.` };
    }
    if (typeof o.body !== "string") {
      return { ok: false, message: `Part ${i + 1} needs a body.` };
    }
    if (o.body.length > SOCIAL_PART_MAX) {
      return { ok: false, message: `Part ${i + 1} is longer than ${SOCIAL_PART_MAX.toLocaleString("en-US")} characters.` };
    }
    parts.push({ kind: o.kind as SocialPartKind, body: o.body });
  }
  if (parts.filter((p) => p.kind === "first_comment").length > 1) {
    return { ok: false, message: "A post can have only one first comment." };
  }
  const commentAt = parts.findIndex((p) => p.kind === "first_comment");
  if (commentAt !== -1 && commentAt !== parts.length - 1) {
    return { ok: false, message: "The first comment must be the last part." };
  }
  const normalized = normalizeParts(parts);
  if (normalized.length > MAX_SOCIAL_PARTS) {
    return { ok: false, message: `A post can carry at most ${MAX_SOCIAL_PARTS} parts after the first.` };
  }
  return { ok: true, parts: normalized };
}

/**
 * Copy written as text, split into the root and its parts: a line with only
 * `---` starts the next tweet of a thread, and a `--- first comment` line
 * starts the first comment. A network that can't use a kind keeps that line
 * as ordinary text, so a LinkedIn writer's `---` divider stays a divider.
 */
export function splitPartsText(
  text: string,
  support: PartSupport
): { body: string; parts: SocialPart[] } {
  const chunks: { kind: SocialPartKind | "root"; lines: string[] }[] = [{ kind: "root", lines: [] }];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (support.firstComment && FIRST_COMMENT_LINE.test(line)) {
      chunks.push({ kind: "first_comment", lines: [] });
    } else if (support.threads && THREAD_LINE.test(line) && chunks[chunks.length - 1].kind !== "first_comment") {
      chunks.push({ kind: "thread", lines: [] });
    } else {
      chunks[chunks.length - 1].lines.push(line);
    }
  }
  const [root, ...rest] = chunks;
  return {
    body: root.lines.join("\n").trim(),
    parts: normalizeParts(
      rest.map((c) => ({ kind: c.kind as SocialPartKind, body: c.lines.join("\n") }))
    ),
  };
}

/**
 * {@link splitPartsText} for copy from a write request: the same split, but
 * refused rather than silently trimmed when the text names a second first
 * comment or more parts than {@link MAX_SOCIAL_PARTS}. The text-save path
 * (post-social.ts: `/api/cms/posts/[id]/social`, `/api/edit/social`, MCP
 * `save_social_draft`) runs it before any write: the same bound
 * {@link parsePartsPayload} puts on a structured `parts` field.
 */
export function parsePartsText(
  text: string,
  support: PartSupport
): { ok: true; body: string; parts: SocialPart[] } | { ok: false; message: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (support.firstComment && lines.filter((l) => FIRST_COMMENT_LINE.test(l)).length > 1) {
    return {
      ok: false,
      message: "This copy has more than one '--- first comment' line. A post can have only one first comment.",
    };
  }
  const split = splitPartsText(text, support);
  if (split.parts.length > MAX_SOCIAL_PARTS) {
    return {
      ok: false,
      message:
        `This copy splits into ${split.parts.length + 1} parts, and a post can carry at most ${MAX_SOCIAL_PARTS + 1} ` +
        `(the first plus ${MAX_SOCIAL_PARTS} more). Remove some '---' lines or split it into two posts.`,
    };
  }
  return { ok: true, ...split };
}

/** The inverse of {@link splitPartsText}: the root and its parts as one text. */
export function joinPartsText(body: string, parts: SocialPart[]): string {
  let text = body;
  for (const part of parts) {
    text += part.kind === "thread" ? `\n---\n${part.body}` : `\n--- first comment\n${part.body}`;
  }
  return text;
}

/**
 * A stored post's root and parts. The `parts` column wins once it has been
 * written (even as an empty list). Copy written for X before it existed (the
 * AI fan-out and the editor's Social tab stored a thread as `---` lines in
 * `body`) is split on those lines, so an old draft publishes as the thread it
 * was meant to be instead of one over-long tweet. Only X copy: a `---` line in
 * copy for any other network was never a separator.
 */
export function socialPostParts(post: {
  body: string;
  parts?: unknown;
  network?: string | null;
}): { body: string; parts: SocialPart[] } {
  if (post.parts !== null && post.parts !== undefined) {
    return { body: post.body, parts: storedParts(post.parts) };
  }
  if (post.network === "twitter") {
    return splitPartsText(post.body, { threads: true, firstComment: false });
  }
  return { body: post.body, parts: [] };
}
