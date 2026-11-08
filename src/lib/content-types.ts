import { z } from "zod";
import type { ContentType } from "@/types/cms";

/**
 * A content type is a free-form token, NOT a fixed enum (G#19). The database
 * column has always been a plain `String`, and both `/api/cms/posts` and the
 * MCP `create_post` tool already accepted any string — the enum that used to
 * live in post-frontmatter.ts was the odd one out, silently rejecting files
 * carrying a type this CMS didn't ship with.
 *
 * Bounded and charset-limited because it arrives from untrusted `.md` files
 * (import route, GitHub webhook) and ends up in a database column and in URLs.
 *
 * Deliberately defined HERE rather than in post-frontmatter.ts: the post
 * editor is a client component, and post-frontmatter.ts imports gray-matter,
 * which has no business in the browser bundle.
 */
export const CONTENT_TYPE_MAX_LENGTH = 64;
export const contentTypeSchema = z
  .string()
  .min(1)
  .max(CONTENT_TYPE_MAX_LENGTH, `type must be at most ${CONTENT_TYPE_MAX_LENGTH} characters`)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "type must be lowercase alphanumeric words separated by '-'");

/**
 * The content types every organization starts with (G#19). These are SEEDS,
 * not a closed set and not rows that must exist: an org that has registered
 * nothing still sees these in the editor, and an org that registers its own
 * gets both. They exist so a fresh CMS isn't an empty dropdown.
 */
export const BUILT_IN_CONTENT_TYPES: ContentType[] = [
  { id: "builtin:blog", slug: "blog", name: "Blog", description: null, sort_order: 0 },
  { id: "builtin:news", slug: "news", name: "News", description: null, sort_order: 1 },
  {
    id: "builtin:announcement",
    slug: "announcement",
    name: "Announcement",
    description: null,
    sort_order: 2,
  },
  { id: "builtin:article", slug: "article", name: "Article", description: null, sort_order: 3 },
];

/**
 * Merge an org's registered types with the built-in seeds, and fold in any
 * types already in USE that nobody registered — a post imported from a file
 * carrying `type: changelog` must be selectable in the editor even though the
 * org never created that row, or re-saving the post would silently retype it.
 *
 * A registered row wins over a seed of the same slug (an org may rename
 * "Blog" to "Journal"), and over an in-use slug.
 */
export function mergeContentTypes(
  registered: ContentType[],
  slugsInUse: string[] = []
): ContentType[] {
  const bySlug = new Map<string, ContentType>();
  for (const t of BUILT_IN_CONTENT_TYPES) bySlug.set(t.slug, t);
  for (const slug of slugsInUse) {
    if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        id: `in-use:${slug}`,
        slug,
        name: titleCaseSlug(slug),
        description: null,
        sort_order: 900,
      });
    }
  }
  // Registered rows override, so this loop runs last.
  for (const t of registered) bySlug.set(t.slug, t);

  return [...bySlug.values()].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
  );
}

/** "release-note" → "Release Note", for a type in use but never registered. */
export function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
