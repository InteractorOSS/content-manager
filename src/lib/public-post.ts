import type { prisma } from "@/lib/db";
import type { PostSeoBlock } from "@/lib/post-seo";

/**
 * The public-safe subset of a Post row, explicitly picked rather than the
 * full Prisma row minus a denylist (G#31). `src/app/api/public/posts*`
 * used to spread `{...post}` and manually omit a couple of sensitive
 * fields (preview_token_expires_at, updated_by_*) — every OTHER internal
 * column (workflow_status, rejection_reason, approved_by_id,
 * ai_generated_content, ai_style_profile_id, …) rode along by accident.
 * An allowlist makes a new internal-only column safe by default: it has to
 * be added here on purpose before the public API serves it.
 */
export interface PublicPost {
  id: string;
  title: string;
  slug: string;
  content: string | null;
  // The sanitized render of `content` (markdown rendered, html mirrored
  // verbatim) — what an HTML-format post's body must be read from, per this
  // repo's own sanitize-on-write model. The old `{...post}` spread always
  // included it; the allowlist must not silently drop it.
  content_html: string | null;
  content_format: string;
  content_styles: string | null;
  excerpt: string | null;
  status: string;
  type: string;
  featured_image: string | null;
  featured_image_alt: string | null;
  featured_image_metadata: unknown;
  meta_description: string | null;
  meta_keywords: string | null;
  seo_title: string | null;
  canonical_url: string | null;
  og_image: string | null;
  og_image_alt: string | null;
  noindex: boolean;
  // These three are left `undefined` (never `null`) when unset, matching the
  // consuming site's contract (packages/cms-client/src/types.ts on
  // InteractorOSS/website): "undefined means the CMS offered nothing here,
  // use the site's own fallback." JSON.stringify drops an `undefined`
  // property entirely, so an older or indifferent consumer sees the key
  // simply absent, not a `null` it has to also treat as "no value."
  content_updated_at?: string;
  answer_summary?: string;
  redirect_to?: string;
  author_name: string | null;
  // The byline as an entity (G#31, Layer A: E-E-A-T / entity clarity), not
  // just the free-text `author_name` string beside it — null until the
  // credited user has set a public author_slug (see src/lib/author-profile.ts),
  // which is what makes them addressable as a byline page at all.
  author: PublicAuthor | null;
  published_at: string | null;
  reading_time: number | null;
  tags: string[];
  // Distribution targets — the old `{...post}` spread always included this
  // too; a consumer deciding multi-site behaviour client-side needs it.
  platforms: string[];
  category: PublicCategory | null;
  inserted_at: string;
  updated_at: string;
  // Resolved per-site metadata + JSON-LD (G#33, Layer C) — present only when
  // the caller passed a `?platform=` that resolves to a registered Site;
  // absent (never `null`) otherwise, same "CMS offered nothing, use the
  // site's own fallback" contract as the three fields above.
  seo?: PostSeoBlock;
}

export interface PublicAuthor {
  name: string | null;
  slug: string;
  job_title: string | null;
  bio: string | null;
  avatar_url: string | null;
  same_as: string[];
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  sort_order: number;
}

/** Matches the `category: { select: {...} }` shape every public route already requests. */
export const PUBLIC_CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  color: true,
  sort_order: true,
} as const;

/**
 * Matches the `author: { select: {...} }` shape a public post query should
 * request. Deliberately excludes `email` — unlike `authorDisplayName`'s
 * internal-byline precedence (src/lib/rbac.ts), which is allowed to fall back
 * to it for an authenticated CMS caller, this is served to anonymous callers
 * with no such fallback available (see toPublicAuthor).
 */
export const PUBLIC_AUTHOR_SELECT = {
  name: true,
  display_name: true,
  author_slug: true,
  job_title: true,
  bio: true,
  avatar_url: true,
  same_as: true,
} as const;

export interface AuthorRow {
  name: string | null;
  display_name: string | null;
  author_slug: string | null;
  job_title: string | null;
  bio: string | null;
  avatar_url: string | null;
  same_as: string[];
}

/**
 * A post's author is only a public entity once they have a public page to
 * link to. `name` falls back only as far as the SSO-derived `User.name` —
 * never to `email`, which `authorDisplayName`'s own fallback chain would
 * reach next: that's fine for an authenticated CMS caller reading their own
 * or a colleague's byline, but this function's output is served to anonymous
 * public callers, where an unset display_name must not leak a private email.
 */
export function toPublicAuthor(author: AuthorRow | null): PublicAuthor | null {
  if (!author || !author.author_slug) return null;
  return {
    name: author.display_name?.trim() || author.name?.trim() || null,
    slug: author.author_slug,
    job_title: author.job_title,
    bio: author.bio,
    avatar_url: author.avatar_url,
    same_as: author.same_as,
  };
}

export interface PostRow {
  id: string;
  organization_id: string;
  title: string;
  slug: string;
  content: string | null;
  content_html: string | null;
  content_format: string;
  content_styles: string | null;
  excerpt: string | null;
  status: string;
  type: string;
  featured_image: string | null;
  featured_image_alt: string | null;
  featured_image_metadata: unknown;
  meta_description: string | null;
  meta_keywords: string | null;
  seo_title: string | null;
  canonical_url: string | null;
  og_image: string | null;
  og_image_alt: string | null;
  noindex: boolean;
  content_updated_at: Date | null;
  answer_summary: string | null;
  redirect_to: string | null;
  author_name: string | null;
  author: AuthorRow | null;
  published_at: Date | null;
  reading_time: number | null;
  tags: string[];
  platforms: string[];
  category: PublicCategory | null;
  inserted_at: Date;
  updated_at: Date;
}

export function toPublicPost(post: PostRow): PublicPost {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    content: post.content,
    content_html: post.content_html,
    content_format: post.content_format,
    content_styles: post.content_styles,
    excerpt: post.excerpt,
    status: post.status,
    type: post.type,
    featured_image: post.featured_image,
    featured_image_alt: post.featured_image_alt,
    featured_image_metadata: post.featured_image_metadata,
    meta_description: post.meta_description,
    meta_keywords: post.meta_keywords,
    seo_title: post.seo_title,
    canonical_url: post.canonical_url,
    og_image: post.og_image,
    og_image_alt: post.og_image_alt,
    noindex: post.noindex,
    content_updated_at: post.content_updated_at?.toISOString() ?? undefined,
    answer_summary: post.answer_summary ?? undefined,
    redirect_to: post.redirect_to ?? undefined,
    author_name: post.author_name,
    author: toPublicAuthor(post.author),
    published_at: post.published_at?.toISOString() ?? null,
    reading_time: post.reading_time,
    tags: post.tags,
    platforms: post.platforms,
    category: post.category,
    inserted_at: post.inserted_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
  };
}

type PublicPrismaClient = typeof prisma;

export type SlugLookupResult =
  | { kind: "post"; post: PostRow }
  | { kind: "redirect"; redirect_slug: string }
  | { kind: "not_found" };

/**
 * The public by-slug lookup, with the slug-history fallback (G#31): a slug
 * that matches no live post is checked against `PostSlugHistory` before
 * answering 404, so a stale inbound link can be told "this moved" instead of
 * looking dead. Scoped by `platform` exactly like the direct lookup — a
 * post's redirect target is only worth announcing to a site the post (still)
 * targets.
 *
 * Deliberately org-agnostic, matching the direct lookup this wraps: neither
 * `Post.slug` nor `PostSlugHistory.old_slug` is unique across the whole
 * deployment, only per organization, but this route has never taken an
 * organization from the caller (see the route's own history) — a self-hosted
 * deployment answering for one effective org is the assumption already in
 * place, not a new one introduced here.
 */
export async function resolvePostBySlugOrHistory(
  db: PublicPrismaClient,
  slug: string,
  platform: string | null
): Promise<SlugLookupResult> {
  const post = await db.post.findFirst({
    where: {
      slug,
      status: "published",
      OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
      ...(platform && { platforms: { has: platform } }),
    },
    include: { category: { select: PUBLIC_CATEGORY_SELECT }, author: { select: PUBLIC_AUTHOR_SELECT } },
  });
  if (post) return { kind: "post", post };

  const history = await db.postSlugHistory.findFirst({
    where: { old_slug: slug },
    include: { post: { select: { slug: true, status: true, platforms: true } } },
  });
  const target = history?.post;
  if (
    target &&
    target.status === "published" &&
    target.slug !== slug &&
    (!platform || target.platforms.includes(platform))
  ) {
    return { kind: "redirect", redirect_slug: target.slug };
  }
  return { kind: "not_found" };
}
