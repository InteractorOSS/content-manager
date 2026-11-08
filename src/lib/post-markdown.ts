/**
 * Clean markdown + frontmatter for one post (G#34, SEO-AEO-GEO-PLAN.md Layer
 * D: `GET /api/public/posts/slug/[slug].md`). Deliberately a SEPARATE
 * serializer from `post-frontmatter.ts`'s `serializePostFile` — that one
 * round-trips the FULL internal export shape (`content_hash`, the arbitrary
 * per-content-type `metadata` bag, …) back through `import_post`, which is
 * exactly the kind of accidental-exposure surface G#31's public-API allowlist
 * (`toPublicPost`) exists to prevent. This module is built from that SAME
 * public allowlist instead: every field it can put in frontmatter is already
 * visible via `GET /api/public/posts/slug/{slug}` — nothing new leaks through
 * this door.
 */

import matter from "gray-matter";
import TurndownService from "turndown";

let turndownService: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  }
  return turndownService;
}

/**
 * Renders a post's body as clean markdown. Markdown-format posts pass
 * `content` through verbatim — it already IS the clean source. HTML-format
 * posts convert the SANITIZED `content_html` render with Turndown, not the
 * raw `content` column: for an HTML post, `content` is whatever the author
 * originally pasted (Word, Google Docs, a page builder's export, …) before
 * sanitize-on-write cleaned it up, and is not what should be shown as "clean"
 * to anything, human or machine.
 */
export function toCleanMarkdown(post: {
  content: string | null;
  content_html: string | null;
  content_format: string;
}): string {
  if (post.content_format === "markdown") return post.content ?? "";
  return post.content_html ? getTurndown().turndown(post.content_html) : "";
}

export interface PublicMarkdownPost {
  title: string;
  slug: string;
  excerpt: string | null;
  seo_title: string | null;
  meta_description: string | null;
  answer_summary?: string;
  canonical_url: string | null;
  noindex: boolean;
  published_at: string | null;
  content_updated_at?: string;
  author: { name: string | null; slug: string } | null;
  category: { name: string; slug: string } | null;
  tags: string[];
  content: string | null;
  content_html: string | null;
  content_format: string;
}

/**
 * `.md` file text (YAML frontmatter + body) for one post, for the public
 * per-post markdown endpoint. `title` prefers `seo_title` — the same
 * precedence `resolvePostSeo` uses (post-seo.ts) — since that's the title an
 * SEO-aware caller of this file actually wants, not necessarily the editorial
 * `title` a human sees in the CMS list view.
 */
export function buildPublicMarkdown(post: PublicMarkdownPost): string {
  const frontmatter: Record<string, unknown> = {
    title: post.seo_title?.trim() || post.title,
    slug: post.slug,
  };
  const description = post.meta_description?.trim() || post.excerpt?.trim();
  if (description) frontmatter.description = description;
  if (post.answer_summary) frontmatter.answer_summary = post.answer_summary;
  if (post.canonical_url) frontmatter.canonical_url = post.canonical_url;
  if (post.noindex) frontmatter.noindex = true;
  if (post.published_at) frontmatter.published_at = post.published_at;
  if (post.content_updated_at) frontmatter.updated_at = post.content_updated_at;
  if (post.author) frontmatter.author = post.author.name ?? post.author.slug;
  if (post.category) frontmatter.category = post.category.name;
  if (post.tags.length > 0) frontmatter.tags = post.tags;

  return matter.stringify(toCleanMarkdown(post), frontmatter);
}
