import matter from "gray-matter";
import { z } from "zod";
import { contentTypeSchema } from "@/lib/content-types";

// Shared by export (serialize) and import (parse) — see
// FILE-BASED-CONTENT-PLAN.md "Frontmatter spec (v1)".

// `contentTypeSchema` lives in content-types.ts (client-safe, no gray-matter)
// and is re-exported here so file-facing callers can keep importing it from
// the frontmatter module alongside everything else they need.
export { contentTypeSchema, CONTENT_TYPE_MAX_LENGTH } from "@/lib/content-types";

/**
 * Bounds on the free-form `metadata` bag below. A `.md` file is untrusted
 * input, so "any extra key is preserved" must not read as "any payload is
 * accepted" — without these an import could write unbounded JSON into the row.
 */
export const METADATA_MAX_KEYS = 50;
export const METADATA_MAX_KEY_LENGTH = 64;
export const METADATA_MAX_BYTES = 16 * 1024;

/** Frontmatter keys this CMS maps onto real Post columns. Everything else a
 *  file carries is preserved verbatim in `metadata` (see {@link splitFrontmatter}).
 *  `content_updated_at` (G#31) is deliberately absent: it is a computed
 *  "was this substantively edited" fact, the same class of field as
 *  `updated_at`/`inserted_at` (also absent), not something a file states. */
export const KNOWN_FRONTMATTER_KEYS = [
  "id",
  "content_hash",
  "title",
  "slug",
  "status",
  "type",
  "excerpt",
  "category",
  "tags",
  "platforms",
  "featured_image",
  "featured_image_alt",
  "meta_description",
  "meta_keywords",
  "seo_title",
  "canonical_url",
  "og_image",
  "og_image_alt",
  "noindex",
  "answer_summary",
  "redirect_to",
  "content_format",
  "published_at",
] as const;

// `.passthrough()` is the whole point: zod's default STRIPS unknown keys, so
// before G#19 a file carrying `verify_every_days: 90` imported with that key
// silently gone — no error, data just dropped. Unknown keys now survive the
// parse and `splitFrontmatter` routes them to `metadata`.
export const postFrontmatterSchema = z
  .object({
    id: z.string().optional(),
    content_hash: z.string().optional(),
    title: z.string().min(1, "title is required"),
    slug: z.string().optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    type: contentTypeSchema.optional(),
    excerpt: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    platforms: z.array(z.string()).optional(),
    featured_image: z.string().optional(),
    featured_image_alt: z.string().optional(),
    meta_description: z.string().optional(),
    meta_keywords: z.string().optional(),
    seo_title: z.string().optional(),
    canonical_url: z.string().optional(),
    og_image: z.string().optional(),
    og_image_alt: z.string().optional(),
    noindex: z.boolean().optional(),
    answer_summary: z.string().optional(),
    redirect_to: z.string().optional(),
    content_format: z.enum(["markdown", "html"]).optional(),
    published_at: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

/** The known-column half of a parsed file. */
export type PostFrontmatter = {
  [K in (typeof KNOWN_FRONTMATTER_KEYS)[number]]?: z.infer<typeof postFrontmatterSchema>[K];
} & { title: string };

/** The preserved-unknown half — arbitrary per-content-type keys. */
export type PostMetadata = Record<string, unknown>;

export interface ParsedPostFile {
  frontmatter: PostFrontmatter;
  metadata: PostMetadata;
  body: string;
}

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

/**
 * Enforce the bounds above on a metadata bag, throwing rather than silently
 * truncating — a dropped key is exactly the failure mode G#19 exists to fix,
 * so failing loudly beats a quiet partial write.
 */
export function assertMetadataWithinBounds(metadata: PostMetadata): void {
  const keys = Object.keys(metadata);
  if (keys.length > METADATA_MAX_KEYS) {
    throw new MetadataValidationError(
      `metadata has ${keys.length} keys; at most ${METADATA_MAX_KEYS} are allowed`
    );
  }
  const overlong = keys.find((k) => k.length > METADATA_MAX_KEY_LENGTH);
  if (overlong) {
    throw new MetadataValidationError(
      `metadata key "${overlong.slice(0, METADATA_MAX_KEY_LENGTH)}…" exceeds ${METADATA_MAX_KEY_LENGTH} characters`
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(metadata) ?? "", "utf8");
  if (bytes > METADATA_MAX_BYTES) {
    throw new MetadataValidationError(
      `metadata is ${bytes} bytes; at most ${METADATA_MAX_BYTES} are allowed`
    );
  }
}

/** Split a passthrough-parsed frontmatter object into known columns + preserved unknowns. */
export function splitFrontmatter(parsed: Record<string, unknown>): {
  frontmatter: PostFrontmatter;
  metadata: PostMetadata;
} {
  const known = new Set<string>(KNOWN_FRONTMATTER_KEYS);
  const frontmatter: Record<string, unknown> = {};
  const metadata: PostMetadata = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (known.has(key)) frontmatter[key] = value;
    else metadata[key] = value;
  }
  return { frontmatter: frontmatter as PostFrontmatter, metadata };
}

export class FrontmatterValidationError extends Error {
  constructor(public issues: z.ZodIssue[]) {
    super(issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    this.name = "FrontmatterValidationError";
  }
}

/**
 * Parse a `.md` file's raw text into validated known frontmatter, the
 * preserved `metadata` bag of everything else it carried, and the body.
 */
export function parsePostFile(raw: string): ParsedPostFile {
  const { data, content } = matter(raw);
  const result = postFrontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new FrontmatterValidationError(result.error.issues);
  }
  const { frontmatter, metadata } = splitFrontmatter(result.data);
  assertMetadataWithinBounds(metadata);
  return { frontmatter, metadata, body: content.trim() };
}

export interface ExportablePost {
  id: string;
  content_hash: string | null;
  title: string;
  slug: string;
  status: string;
  type: string;
  excerpt: string | null;
  category: { slug: string } | null;
  tags: string[];
  platforms: string[];
  featured_image: string | null;
  featured_image_alt: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  seo_title: string | null;
  canonical_url: string | null;
  og_image: string | null;
  og_image_alt: string | null;
  noindex: boolean;
  answer_summary: string | null;
  redirect_to: string | null;
  content_format: string;
  published_at: Date | null;
  content: string | null;
  /**
   * Preserved per-content-type keys, re-emitted into frontmatter on export.
   * Typed `unknown` because it arrives straight from a Prisma `Json?` column,
   * which is a JsonValue — a scalar or array is representable there even
   * though only objects are ever written. {@link isMetadataObject} narrows it.
   */
  metadata?: unknown;
}

/** A Json column value is only usable as a metadata bag if it's a plain object. */
export function isMetadataObject(value: unknown): value is PostMetadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialize a post to `.md` file text (frontmatter + body) for export. */
export function serializePostFile(post: ExportablePost): string {
  const frontmatter: Record<string, unknown> = {
    id: post.id,
    ...(post.content_hash && { content_hash: post.content_hash }),
    title: post.title,
    slug: post.slug,
    status: post.status,
    type: post.type,
    content_format: post.content_format,
  };
  if (post.excerpt) frontmatter.excerpt = post.excerpt;
  if (post.category) frontmatter.category = post.category.slug;
  if (post.tags.length > 0) frontmatter.tags = post.tags;
  if (post.platforms.length > 0) frontmatter.platforms = post.platforms;
  if (post.featured_image) frontmatter.featured_image = post.featured_image;
  if (post.featured_image_alt) frontmatter.featured_image_alt = post.featured_image_alt;
  if (post.meta_description) frontmatter.meta_description = post.meta_description;
  if (post.meta_keywords) frontmatter.meta_keywords = post.meta_keywords;
  if (post.seo_title) frontmatter.seo_title = post.seo_title;
  if (post.canonical_url) frontmatter.canonical_url = post.canonical_url;
  if (post.og_image) frontmatter.og_image = post.og_image;
  if (post.og_image_alt) frontmatter.og_image_alt = post.og_image_alt;
  if (post.noindex) frontmatter.noindex = post.noindex;
  if (post.answer_summary) frontmatter.answer_summary = post.answer_summary;
  if (post.redirect_to) frontmatter.redirect_to = post.redirect_to;
  if (post.published_at) frontmatter.published_at = post.published_at.toISOString();

  // Re-emit preserved keys so export → edit → import is lossless. Sorted for a
  // deterministic file: an export that reshuffled keys run-to-run would show up
  // as a spurious diff in the git-sync mirror.
  if (isMetadataObject(post.metadata)) {
    for (const key of Object.keys(post.metadata).sort()) {
      frontmatter[key] = post.metadata[key];
    }
  }

  return matter.stringify(post.content ?? "", frontmatter);
}

export function exportFilename(slug: string): string {
  return `${slug}.md`;
}
