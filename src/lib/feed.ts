/**
 * RSS feed + sitemap XML for a site's published posts (`GET /api/public/rss.xml`
 * and `GET /api/public/sitemap.xml`, both `?platform=<slug>`).
 *
 * `Site.url` is what makes these possible — before it existed there was no
 * base URL to build a `<link>`/`<loc>` from. Item links are `${site.url}/${post.slug}`;
 * this app doesn't know the consuming site's own routing (e.g. whether posts
 * live under `/blog/`), so `site.url` is expected to already be the post-root,
 * not just a domain (e.g. `https://example.com/blog`, not `https://example.com`).
 */

import { prisma } from "@/lib/db";

/** RSS stays capped — a feed reader wants recent items, not a full archive
 *  (SEO-AEO-GEO-PLAN.md Layer D only asks the SITEMAP's cap to go away). */
export const FEED_MAX_ITEMS = 50;

/**
 * The sitemap has no item cap (G#34, Layer D) — but reading every published
 * post in one unbounded `findMany` would still be one giant round trip for a
 * large org. This is the page size of the internal cursor loop
 * {@link loadSitemapData} runs instead, not something a caller ever sees or
 * controls: the sitemap protocol expects one complete document per request,
 * so pagination here is a read-side implementation detail, not an API.
 * Exported only so the pagination boundary itself is unit-testable without a
 * test hard-coding this number a second time.
 */
export const SITEMAP_BATCH_SIZE = 500;

/**
 * `Site.slug` is only unique per-org (@@unique([organization_id, slug])), so
 * a bare slug can't disambiguate which org's site to use if two orgs ever
 * register the same one. This mirrors the pre-existing limitation of
 * `GET /api/public/posts?platform=` itself, which matches posts by slug
 * with no org disambiguation either — not a new gap introduced here.
 */
export async function loadFeedData(
  platform: string
): Promise<{ site: FeedSite; posts: FeedPost[] } | null> {
  const site = await prisma.site.findFirst({ where: { slug: platform } });
  if (!site) return null;

  const posts = await prisma.post.findMany({
    where: {
      status: "published",
      platforms: { has: platform },
      OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
    },
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
    take: FEED_MAX_ITEMS,
  });

  return { site: { name: site.name, url: site.url }, posts };
}

export interface FeedPost {
  slug: string;
  title: string;
  excerpt: string | null;
  published_at: Date | null;
  updated_at: Date;
  content_updated_at?: Date | null;
  author_name?: string | null;
  featured_image?: string | null;
  featured_image_alt?: string | null;
  author?: { name: string | null; display_name: string | null } | null;
  category?: { name: string } | null;
}

export interface FeedSite {
  name: string;
  url: string;
}

/** Raw row shape read off `Post` for the sitemap loop — see {@link loadSitemapData}. */
interface SitemapRow {
  id: string;
  slug: string;
  updated_at: Date;
  content_updated_at: Date | null;
  canonical_url: string | null;
}

/**
 * The minimal shape `buildSitemapXml` needs to compute `lastmod` itself
 * (`content_updated_at ?? updated_at` — same fallback post-seo.ts's
 * `dateModified` uses). Deliberately NOT `{slug, lastmod}` pre-resolved:
 * `FeedPost` (this module's other, richer post shape) already carries
 * `slug`, `updated_at` and an optional `content_updated_at`, so it satisfies
 * this interface structurally with no extra mapping — the CMS's own dogfood
 * blog (`src/app/(blog)/blog/sitemap.xml/route.ts`, G#36) already calls
 * `buildSitemapXml` with `FeedPost[]` from `blogFeedData`, and this shape
 * keeps that call site working unchanged rather than forcing every consumer
 * of this function to pre-flatten its posts into a second, sitemap-only type.
 */
export interface SitemapPost {
  slug: string;
  updated_at: Date;
  content_updated_at?: Date | null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function postUrl(site: FeedSite, post: { slug: string }): string {
  return `${site.url.replace(/\/+$/, "")}/${post.slug}`;
}

/**
 * A post is only worth listing under a given SITE's URL if that URL is its
 * canonical one there. `canonical_url` unset means "self-canonical" (the
 * default resolvePostSeo() also assumes — see post-seo.ts); set-and-matching
 * is a post that names itself as its own canonical explicitly, also fine;
 * set-and-DIFFERENT means this platform carries a syndicated COPY whose
 * canonical source is elsewhere, and a sitemap listing it as this site's own
 * URL would tell search engines to index a page it has itself disclaimed.
 *
 * Exact string comparison is deliberate and simple, not URL-normalizing
 * (trailing slash, http/https, …): `canonical_url` is free text an author
 * types, and post-seo.ts's own `canonical` field is built the identical way
 * (`${site.url}/${slug}`) — a self-canonical post's stored value, if any,
 * should match byte-for-byte. A near-miss (a typo'd canonical, or one built
 * against a slightly different site.url) is the SAME failure mode a
 * mismatched canonical already causes for rendering; this function doesn't
 * try to be smarter about it than the rest of the pipeline.
 */
export function isCanonicalOnSite(site: FeedSite, row: { slug: string; canonical_url: string | null }): boolean {
  if (!row.canonical_url) return true;
  return row.canonical_url.trim() === postUrl(site, row);
}

/**
 * Every published post's sitemap entry for one site — no page cap (G#34,
 * Layer D: "drop the 50 cap"). Reads the table in {@link SITEMAP_BATCH_SIZE}
 * cursor-paginated chunks rather than one unbounded `findMany`, so a large
 * org's sitemap doesn't turn into a single giant round trip; the caller still
 * gets back one complete list, matching the sitemap protocol's expectation of
 * one full document per site.
 *
 * Excludes `noindex` posts (Layer D) and posts whose `canonical_url` points
 * elsewhere (syndicated copies — {@link isCanonicalOnSite}). Neither
 * exclusion touches `/api/public/rss.xml` or `/api/public/llms.txt`: the plan
 * calls this out for the sitemap specifically, and a feed reader or an LLM
 * index isn't a search-engine indexing signal the way a sitemap is.
 */
export async function loadSitemapData(
  platform: string
): Promise<{ site: FeedSite; posts: SitemapPost[] } | null> {
  const siteRow = await prisma.site.findFirst({ where: { slug: platform } });
  if (!siteRow) return null;
  const site: FeedSite = { name: siteRow.name, url: siteRow.url };

  const rows: SitemapRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.post.findMany({
      where: {
        status: "published",
        platforms: { has: platform },
        OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
        noindex: false,
      },
      select: { id: true, slug: true, updated_at: true, content_updated_at: true, canonical_url: true },
      orderBy: { id: "asc" },
      take: SITEMAP_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    rows.push(...batch);
    if (batch.length < SITEMAP_BATCH_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }

  const posts: SitemapPost[] = rows.filter((row) => isCanonicalOnSite(site, row));

  return { site, posts };
}

export function buildRssXml(site: FeedSite, posts: FeedPost[]): string {
  const items = posts
    .map((post) => {
      const link = postUrl(site, post);
      const pubDate = (post.published_at ?? post.updated_at).toUTCString();
      // The visible byline wins over the linked profile's own name — same
      // precedence post-seo.ts documents for its JSON-LD `author` node
      // (`resolveAuthorOverride` lets a post be credited to a name that
      // diverges from `author_id`'s real profile).
      const authorName =
        post.author_name?.trim() || post.author?.display_name?.trim() || post.author?.name?.trim() || null;
      const image = post.featured_image?.trim();
      const updated = (post.content_updated_at ?? post.updated_at).toISOString();

      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <atom:updated>${updated}</atom:updated>${
        post.excerpt ? `\n      <description>${escapeXml(post.excerpt)}</description>` : ""
      }${authorName ? `\n      <dc:creator>${escapeXml(authorName)}</dc:creator>` : ""}${
        post.category?.name ? `\n      <category>${escapeXml(post.category.name)}</category>` : ""
      }${
        image
          ? `\n      <enclosure url="${escapeXml(image)}" length="0" type="${guessImageMimeType(image)}"/>`
          : ""
      }
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(site.name)}</title>
    <link>${escapeXml(site.url)}</link>
    <description>${escapeXml(site.name)}</description>
${items}
  </channel>
</rss>
`;
}

/**
 * `<enclosure>` requires a `type`, and the featured image's URL is all this
 * module has to guess one from — no HEAD request is made (that would be one
 * extra outbound fetch per item, per feed request). Defaults to JPEG, the
 * commonest case, when the extension doesn't say otherwise.
 */
function guessImageMimeType(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    default:
      return "image/jpeg";
  }
}

export function buildSitemapXml(site: FeedSite, posts: SitemapPost[]): string {
  const urls = posts
    .map((post) => {
      // "Honest dates" (SEO-AEO-GEO-PLAN.md §2.3): lastmod is the SUBSTANTIVE
      // update date, not whatever `updated_at` last happened to be touched by
      // (a tag edit, a status change, …) — same fallback post-seo.ts's
      // `dateModified` uses (`content_updated_at ?? updated_at`). Deliberately
      // does NOT fall further back to `published_at`: that would resurrect the
      // exact "fake freshness" gap this goal exists to close (a lastmod that
      // never moves after publish, per the plan's own audit).
      const lastmod = (post.content_updated_at ?? post.updated_at).toISOString();
      return `  <url>
    <loc>${escapeXml(postUrl(site, post))}</loc>
    <lastmod>${lastmod}</lastmod>
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
