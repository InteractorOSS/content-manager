import { prisma } from "@/lib/db";
import { publicOrigin } from "@/lib/oauth/protocol";
import { isCanonicalOnSite, SITEMAP_BATCH_SIZE, type FeedPost, type FeedSite, type SitemapPost } from "@/lib/feed";
import { LLMS_BATCH_SIZE, type LlmsPost } from "@/lib/llms";
import { PUBLIC_AUTHOR_SELECT, toPublicAuthor } from "@/lib/public-post";
import { resolvePostSeo, resolveSeoContext, type PostSeoBlock } from "@/lib/post-seo";

/**
 * The CMS's own public blog at `<origin>/blog` — the CMS publishing through
 * itself (see SEO-AEO-GEO-PLAN.md, goal G#36).
 *
 * There is no blog config: the blog IS whichever registered Site's `url` is
 * this deployment's `<origin>/blog` (Settings → Sites). Matching on the URL
 * rather than a slug is deliberate — `Site.slug` is only unique per org, so a
 * slug can't say whose site this is, while a URL on our own origin can only
 * sensibly belong to one. No such site → every /blog route 404s, which is the
 * right answer for a self-hosted deployment that doesn't want a blog.
 *
 * Everything here reads with the raw client on purpose: this is public,
 * unauthenticated, explicitly-global code (like /api/public/*), scoped by the
 * resolved site's organization_id in every query instead.
 */

export const BLOG_PATH = "/blog";
export const BLOG_PAGE_SIZE = 12;

/** Every spelling of the blog URL a Site row could have been saved with. */
export function blogSiteUrlCandidates(origin: string): string[] {
  const base = origin.replace(/\/+$/, "");
  return [`${base}${BLOG_PATH}`, `${base}${BLOG_PATH}/`];
}

export interface BlogSite {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Canonical blog base URL, no trailing slash. */
  url: string;
  organization_id: string;
  organization_name: string;
}

export async function resolveBlogSite(origin = publicOrigin()): Promise<BlogSite | null> {
  const site = await prisma.site.findFirst({
    where: { url: { in: blogSiteUrlCandidates(origin) } },
    // Oldest wins if two orgs ever registered the same URL — stable, and the
    // first registrant is the one that was actually serving it.
    orderBy: { inserted_at: "asc" },
    include: { organization: { select: { name: true } } },
  });
  if (!site) return null;
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    description: site.description,
    url: site.url.replace(/\/+$/, ""),
    organization_id: site.organization_id,
    organization_name: site.organization.name,
  };
}

/**
 * The one definition of "shows on this blog": published, this org, this
 * site, and not scheduled for the future — the same `OR: [{published_at:
 * null}, {published_at: {lte: now}}]` guard `src/lib/feed.ts`, `llms.ts` and
 * `public-post.ts` already apply for every other public surface. Status
 * "published" with a future `published_at` is exactly how a post gets
 * scheduled ahead of time; without this guard the blog would leak it the
 * moment it's saved, not when it's meant to go live.
 */
export function blogPostWhere(site: Pick<BlogSite, "organization_id" | "slug">) {
  return {
    organization_id: site.organization_id,
    status: "published",
    platforms: { has: site.slug },
    OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
  };
}

const LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  meta_description: true,
  featured_image: true,
  featured_image_alt: true,
  author_name: true,
  published_at: true,
  updated_at: true,
  reading_time: true,
  category: { select: { name: true, slug: true } },
} as const;

export async function listBlogPosts(site: BlogSite, page: number) {
  const where = blogPostWhere(site);
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const [posts, total] = await Promise.all([
    prisma.post.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [{ published_at: "desc" }, { inserted_at: "desc" }],
      skip: (safePage - 1) * BLOG_PAGE_SIZE,
      take: BLOG_PAGE_SIZE,
    }),
    prisma.post.count({ where }),
  ]);
  return { posts, total, page: safePage, pages: Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE)) };
}

/**
 * Everything the resolved `seo` block (post-seo.ts, G#33) needs on top of
 * {@link LIST_SELECT} — the /blog post page renders that block directly
 * (G#36) rather than hand-computing its own metadata/JSON-LD.
 */
const SEO_SELECT = {
  seo_title: true,
  canonical_url: true,
  og_image: true,
  og_image_alt: true,
  noindex: true,
  content_updated_at: true,
  meta_keywords: true,
  content_html: true,
  tags: true,
  author: { select: PUBLIC_AUTHOR_SELECT },
} as const;

export async function getBlogPost(site: BlogSite, slug: string) {
  return prisma.post.findFirst({
    where: { ...blogPostWhere(site), slug },
    select: {
      ...LIST_SELECT,
      ...SEO_SELECT,
    },
  });
}

type BlogPostRow = NonNullable<Awaited<ReturnType<typeof getBlogPost>>>;

/** `origin`-relative media URLs (`/uploads/...`) resolved to absolute ones —
 *  required for OG/Twitter/JSON-LD image URLs, which must be absolute. */
function absoluteMediaUrl(url: string | null, origin: string): string | null {
  if (!url) return null;
  return new URL(url, origin).toString();
}

/**
 * The resolved `seo` block (post-seo.ts) for one /blog post — `null` only if
 * the Site this post's own page just resolved by URL somehow no longer
 * resolves by `(organization_id, slug)` (a race with a concurrent delete);
 * callers fall back to basic, locally-built metadata in that case rather than
 * failing the request.
 */
export async function resolveBlogPostSeo(
  site: BlogSite,
  post: BlogPostRow,
  origin = publicOrigin()
): Promise<PostSeoBlock | null> {
  const context = await resolveSeoContext(prisma, site.organization_id, site.slug);
  if (!context) return null;
  return resolvePostSeo(
    {
      slug: post.slug,
      title: post.title,
      seo_title: post.seo_title,
      meta_description: post.meta_description,
      excerpt: post.excerpt,
      content_html: post.content_html,
      featured_image: absoluteMediaUrl(post.featured_image, origin),
      featured_image_alt: post.featured_image_alt,
      og_image: absoluteMediaUrl(post.og_image, origin),
      og_image_alt: post.og_image_alt,
      canonical_url: post.canonical_url,
      noindex: post.noindex,
      meta_keywords: post.meta_keywords,
      author_name: post.author_name,
      author: toPublicAuthor(post.author),
      category: post.category,
      published_at: post.published_at,
      content_updated_at: post.content_updated_at,
      updated_at: post.updated_at,
    },
    context.site,
    context.organization
  );
}

/**
 * All published posts for `/blog/rss.xml`'s {@link buildRssXml} — the full
 * `FeedPost` shape (content_updated_at, author, image, category), matching
 * what `/api/public/rss.xml` already selects (G#34), so the dogfood blog's
 * own feed gets the same richer `<atom:updated>`/`dc:creator`/`<category>`/
 * `<enclosure>` output rather than a bare title+link+description.
 */
export async function blogFeedData(
  site: BlogSite,
  limit?: number
): Promise<{ site: FeedSite; posts: FeedPost[] }> {
  const posts = await prisma.post.findMany({
    where: blogPostWhere(site),
    select: {
      slug: true,
      title: true,
      excerpt: true,
      published_at: true,
      updated_at: true,
      content_updated_at: true,
      author_name: true,
      featured_image: true,
      featured_image_alt: true,
      author: { select: { name: true, display_name: true } },
      category: { select: { name: true } },
    },
    orderBy: { published_at: "desc" },
    ...(limit ? { take: limit } : {}),
  });
  return { site: { name: site.name, url: site.url }, posts };
}

/**
 * All published posts for `/blog/sitemap.xml`'s {@link buildSitemapXml} —
 * mirrors `loadSitemapData` (feed.ts): cursor-paginated (no single unbounded
 * `findMany`), excludes `noindex` posts and posts syndicated from elsewhere
 * (`isCanonicalOnSite`), matching the same Layer D exclusions the generic
 * `/api/public/sitemap.xml` already applies. Scoped through `blogPostWhere`
 * (this org + this site's platform slug) rather than `loadSitemapData`'s bare
 * `Site.slug` lookup, since the dogfood blog already knows exactly which org
 * it's serving and shouldn't re-derive it from a slug that's only unique
 * per-org.
 */
export async function blogSitemapData(site: BlogSite): Promise<{ site: FeedSite; posts: SitemapPost[] }> {
  const feedSite: FeedSite = { name: site.name, url: site.url };
  const where = { ...blogPostWhere(site), noindex: false };

  const rows: (SitemapPost & { id: string; canonical_url: string | null })[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.post.findMany({
      where,
      select: { id: true, slug: true, updated_at: true, content_updated_at: true, canonical_url: true },
      orderBy: { id: "asc" },
      take: SITEMAP_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    rows.push(...batch);
    if (batch.length < SITEMAP_BATCH_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }

  const posts = rows.filter((row) => isCanonicalOnSite(feedSite, row));
  return { site: feedSite, posts };
}

/**
 * All published posts for `/blog/llms.txt`'s {@link buildLlmsTxt}. Does NOT
 * call `loadLlmsData` (llms.ts) directly — that helper resolves its site by
 * a bare `Site.slug`, which is only unique per-org (same documented
 * limitation as `loadFeedData`), so a second org's site sharing this blog's
 * slug could otherwise leak into this host's own index. `blogPostWhere`
 * scopes by this site's `organization_id` as well, exactly like
 * {@link blogSitemapData} and {@link blogFeedData} above it.
 */
export async function blogLlmsData(site: BlogSite): Promise<{ site: FeedSite; posts: LlmsPost[] }> {
  const feedSite: FeedSite = { name: site.name, url: site.url };

  const posts: LlmsPost[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.post.findMany({
      where: blogPostWhere(site),
      select: { id: true, slug: true, title: true, excerpt: true, meta_description: true },
      orderBy: { id: "asc" },
      take: LLMS_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    posts.push(...batch);
    if (batch.length < LLMS_BATCH_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }

  return { site: feedSite, posts };
}

/**
 * `alternates` for a blog page. Next REPLACES (not merges) a parent's
 * `alternates` when a page sets its own canonical, so the RSS discovery link
 * has to ride along on every page rather than living in the layout.
 */
export function blogAlternates(site: Pick<BlogSite, "url">, canonical: string) {
  return { canonical, types: { "application/rss+xml": `${site.url}/rss.xml` } };
}

/** JSON for a <script type="application/ld+json">, safe against `</script>` in content. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
