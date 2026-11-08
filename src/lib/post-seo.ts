import type { prisma } from "@/lib/db";
import { stripHtml } from "@/lib/utils";
import type { PublicAuthor, PublicPost, PostRow } from "@/lib/public-post";

/**
 * The resolved per-site `seo` block (G#33, SEO-AEO-GEO-PLAN.md Layer C):
 * everything a consuming site needs to publish correct metadata and JSON-LD
 * without hand-building either. Every consuming site currently does its own
 * — the website's own JSON-LD, for one, still types a named byline as an
 * `Organization` — so this is computed once, here, and meant to be rendered
 * verbatim.
 */
export interface PostSeoBlock {
  title: string;
  description?: string;
  canonical: string;
  robots: string;
  og: {
    title: string;
    description?: string;
    image?: string;
    imageAlt?: string;
    type: string;
    url: string;
  };
  twitter: {
    card: "summary" | "summary_large_image";
    title: string;
    description?: string;
    image?: string;
    imageAlt?: string;
  };
  /**
   * A flat array of independent JSON-LD nodes (each carries its own
   * `@context`), not a single `@graph`-wrapped document — matching how the
   * website's own local builders already shape a standalone node
   * (structured-data.ts `breadcrumbListSchema`'s doc comment, and how
   * `blogPostingWithBreadcrumbsSchema` composes one). A future swap to
   * render this block instead of building locally needs no reshaping.
   */
  json_ld: Record<string, unknown>[];
}

export interface SeoSite {
  /** Base URL, no trailing slash. */
  url: string;
  name: string;
  publisher_name: string | null;
  logo_url: string | null;
}

export interface SeoOrganization {
  name: string;
  logo: string | null;
  same_as: string[];
}

export interface SeoPostInput {
  slug: string;
  title: string;
  seo_title: string | null;
  meta_description: string | null;
  excerpt: string | null;
  content_html: string | null;
  featured_image: string | null;
  featured_image_alt: string | null;
  og_image: string | null;
  og_image_alt: string | null;
  canonical_url: string | null;
  noindex: boolean;
  meta_keywords: string | null;
  author_name: string | null;
  author: PublicAuthor | null;
  category: { name: string } | null;
  published_at: Date | null;
  content_updated_at: Date | null;
  updated_at: Date;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

// Backreferenced (`\1`) so a mismatched pair like `<h2>FAQ</h3>` — malformed,
// but not this function's job to reject — never matches at all.
const FAQ_HEADING = /<h([2-3])[^>]*>\s*(?:frequently asked questions|faq)\s*<\/h\1>/i;
const QA_PAIR = /<h[3-4][^>]*>([\s\S]*?)<\/h[3-4]>([\s\S]*?)(?=<h[3-4][^>]*>|$)/gi;

/**
 * A visible FAQ section in the rendered body, if there is one — the source
 * for an FAQPage node. Heuristic on purpose (no HTML parser in the runtime
 * dependency set — see the comment on JSX_ATTR-style scanners elsewhere in
 * this codebase's sibling repo for why that trade is made deliberately):
 * looks for an "FAQ"/"Frequently Asked Questions" H2/H3, then reads every
 * H3/H4 after it as a question and the HTML up to the next one as its
 * answer, stopping at the next heading of the SAME level as the FAQ heading
 * itself (or end of document) — not always the next H2. An H2 boundary alone
 * would, for an H3-level FAQ heading, sweep a later unrelated H3 section (and
 * its real H4 sub-heading) into the FAQPage as spurious Q&A before the next
 * H2 ever arrives. A body with no FAQ heading returns no entries — FAQPage
 * markup on invisible questions is exactly the spam pattern
 * SEO-AEO-GEO-PLAN.md's research summary warns against, so under-triggering
 * here is the safe failure mode.
 */
export function extractFaqSection(contentHtml: string | null): FaqEntry[] {
  if (!contentHtml) return [];
  const heading = FAQ_HEADING.exec(contentHtml);
  if (!heading) return [];

  const rest = contentHtml.slice(heading.index + heading[0].length);
  const nextSectionBoundary = new RegExp(`<h[1-${heading[1]}][^>]*>`, "i").exec(rest);
  const section = nextSectionBoundary ? rest.slice(0, nextSectionBoundary.index) : rest;

  const entries: FaqEntry[] = [];
  for (const match of section.matchAll(QA_PAIR)) {
    const question = stripHtml(match[1]).trim();
    const answer = stripHtml(match[2]).trim();
    if (question && answer) entries.push({ question, answer });
  }
  return entries;
}

function wordCount(html: string | null): number | undefined {
  if (!html) return undefined;
  const words = stripHtml(html).trim().split(/\s+/).filter(Boolean).length;
  return words || undefined;
}

/**
 * Builds the `seo` block for one post on one site. Pure — every fact it
 * needs (post, the resolving Site row, the resolving Organization row) is
 * passed in; callers resolve those however fits their write path.
 */
export function resolvePostSeo(post: SeoPostInput, site: SeoSite, organization: SeoOrganization): PostSeoBlock {
  const title = post.seo_title?.trim() || post.title;
  const description = post.meta_description?.trim() || post.excerpt?.trim() || undefined;
  const canonical = post.canonical_url?.trim() || `${site.url}/${post.slug}`;
  const robots = post.noindex ? "noindex, nofollow" : "index, follow";
  const image = post.og_image?.trim() || post.featured_image?.trim() || undefined;
  const imageAlt = post.og_image_alt?.trim() || post.featured_image_alt?.trim() || undefined;

  const og = {
    title,
    ...(description && { description }),
    ...(image && { image }),
    ...(image && imageAlt && { imageAlt }),
    type: "article",
    url: canonical,
  };
  const twitter: PostSeoBlock["twitter"] = {
    card: image ? "summary_large_image" : "summary",
    title,
    ...(description && { description }),
    ...(image && { image }),
    ...(image && imageAlt && { imageAlt }),
  };

  const publisherName = site.publisher_name?.trim() || site.name;
  const logo = site.logo_url?.trim() || organization.logo?.trim() || undefined;

  // A byline is a human, so a named author is a Person — the website's own
  // local builder still types one as an Organization today, which is exactly
  // the gap SEO-AEO-GEO-PLAN.md's audit calls out. `author.url` (a public
  // /author/<slug> page) is deliberately not built here: the CMS is
  // multi-site and does not own any one site's URL scheme for that page —
  // sameAs (real external profile URLs the author themselves set) is
  // included when they have any, url is left for whichever site renders
  // this block to fill in from its own routing.
  //
  // `post.author_name` — the visible byline — wins over the linked profile's
  // own name: src/lib/rbac.ts's resolveAuthorOverride() supports crediting a
  // post to a name that diverges from author_id's real profile (a guest
  // byline, "Interactor Team", …), and that override is what actually renders
  // on the page. sameAs is only attached when the displayed name still
  // matches the linked profile — a mismatch means the visible byline is an
  // override, and stamping a different name's real social links onto it
  // would misattribute that person's profiles to whoever is actually shown.
  const displayName = post.author_name?.trim();
  const profile = post.author;
  const authorName = displayName || profile?.name || undefined;
  const sameAsProfile = profile && (!displayName || displayName === profile.name) ? profile : null;
  const authorNode: Record<string, unknown> = authorName
    ? {
        "@type": "Person",
        name: authorName,
        ...(sameAsProfile?.same_as.length && { sameAs: sameAsProfile.same_as }),
      }
    : { "@type": "Organization", name: organization.name };

  const postWordCount = wordCount(post.content_html);

  const blogPosting: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    headline: title,
    ...(description && { description }),
    ...(image && { image }),
    author: authorNode,
    publisher: {
      "@type": "Organization",
      name: publisherName,
      ...(organization.same_as.length && { sameAs: organization.same_as }),
      ...(logo && { logo: { "@type": "ImageObject", url: logo } }),
    },
    ...(post.published_at && { datePublished: post.published_at.toISOString() }),
    dateModified: (post.content_updated_at ?? post.updated_at).toISOString(),
    ...(postWordCount !== undefined && { wordCount: postWordCount }),
    ...(post.meta_keywords?.trim() && { keywords: post.meta_keywords.trim() }),
    ...(post.category?.name && { articleSection: post.category.name }),
  };

  // Site → post, two levels, not the three ("site → category → post")
  // SEO-AEO-GEO-PLAN.md sketches: the website's own post-breadcrumbs.ts
  // deliberately skips a category rung ("a category crumb would resolve to
  // the same page as the Blog crumb above it" — its category filter is a
  // query param, not a route) and the CMS has no way to know whether any
  // OTHER consuming site's category listing is a real, distinct URL either.
  // Two levels are correct for every site; a third the CMS cannot verify is
  // not.
  const breadcrumbList: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: site.name, item: site.url },
      { "@type": "ListItem", position: 2, name: title, item: canonical },
    ],
  };

  const faqEntries = extractFaqSection(post.content_html);
  const faqPage: Record<string, unknown> | null =
    faqEntries.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqEntries.map((entry) => ({
            "@type": "Question",
            name: entry.question,
            acceptedAnswer: { "@type": "Answer", text: entry.answer },
          })),
        }
      : null;

  return {
    title,
    ...(description && { description }),
    canonical,
    robots,
    og,
    twitter,
    json_ld: [blogPosting, breadcrumbList, ...(faqPage ? [faqPage] : [])],
  };
}

type PublicPrismaClient = typeof prisma;

/**
 * Cache type for {@link attachSeo}'s optional last argument. Caches the
 * in-flight PROMISE, not just its resolved value: a list route's posts all
 * resolve concurrently (`Promise.all`), so caching only the settled value
 * would let every post for the same org's first tick race past a
 * still-empty cache and each issue its own lookup.
 */
export type SeoContextCache = Map<string, Promise<{ site: SeoSite; organization: SeoOrganization } | null>>;

const SITE_SELECT = { url: true, name: true, publisher_name: true, logo_url: true } as const;
const ORG_SELECT = { name: true, logo: true, same_as: true } as const;

/**
 * Resolves the Site + Organization context `resolvePostSeo` needs, for one
 * `(organization_id, platform)` pair. `null` when the platform names no
 * registered Site for that org — the caller falls back to serving the post
 * with no `seo` block, same as passing no `?platform=` at all, rather than
 * guessing at a site that was never registered (G#18).
 */
export async function resolveSeoContext(
  db: PublicPrismaClient,
  organizationId: string,
  platform: string
): Promise<{ site: SeoSite; organization: SeoOrganization } | null> {
  const [site, organization] = await Promise.all([
    db.site.findFirst({ where: { organization_id: organizationId, slug: platform }, select: SITE_SELECT }),
    db.organization.findUnique({ where: { id: organizationId }, select: ORG_SELECT }),
  ]);
  if (!site || !organization) return null;
  return {
    site: { url: site.url.replace(/\/+$/, ""), name: site.name, publisher_name: site.publisher_name, logo_url: site.logo_url },
    organization: { name: organization.name, logo: organization.logo, same_as: organization.same_as },
  };
}

/**
 * Attaches a resolved `seo` block to an already-public-shaped post, caching
 * the Site+Organization lookup per `(organization_id, platform)` so a
 * multi-post list response resolves it once per distinct org rather than
 * once per post — in practice, almost always once per request, since a
 * self-hosted deployment answers for one effective org (see the doc comment
 * on `resolvePostBySlugOrHistory`).
 */
export async function attachSeo(
  db: PublicPrismaClient,
  post: PostRow,
  publicPost: PublicPost,
  platform: string | null,
  cache: SeoContextCache = new Map()
): Promise<PublicPost> {
  if (!platform) return publicPost;
  const key = `${post.organization_id}:${platform}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = resolveSeoContext(db, post.organization_id, platform);
    cache.set(key, pending);
  }
  const context = await pending;
  if (!context) return publicPost;
  // `post.author` is the raw DB row (AuthorRow — author_slug, not slug);
  // `publicPost.author` is already the transformed public entity
  // resolvePostSeo expects. Building the seo input off the raw row plus the
  // already-public author avoids a second, divergent transform of the same
  // field here.
  const seoInput: SeoPostInput = { ...post, author: publicPost.author };
  return { ...publicPost, seo: resolvePostSeo(seoInput, context.site, context.organization) };
}
