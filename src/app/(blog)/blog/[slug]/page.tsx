import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { blogAlternates, getBlogPost, jsonLdScript, resolveBlogPostSeo, resolveBlogSite } from "@/lib/blog";
import type { PostSeoBlock } from "@/lib/post-seo";
import { formatBlogDate } from "../format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * Metadata built straight from the resolved `seo` block (post-seo.ts, G#33) —
 * title/description/canonical/robots/OG/Twitter all come from the one place
 * that already handles `seo_title`/`canonical_url`/`noindex`/`og_image`
 * fallbacks correctly, rather than this route re-deriving a subset of them
 * (G#36, Layer G). `og.image`/`twitter.image` are already absolute
 * (`resolveBlogPostSeo` resolves them against this origin before they ever
 * reach `resolvePostSeo`), so no `new URL(..., origin)` join is needed here.
 */
function seoImages(seo: PostSeoBlock) {
  return seo.og.image
    ? [{ url: seo.og.image, width: 1200, height: 630, alt: seo.og.imageAlt ?? seo.title }]
    : undefined;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const site = await resolveBlogSite();
  if (!site) return {};
  const post = await getBlogPost(site, (await params).slug);
  if (!post) return {};
  const seo = await resolveBlogPostSeo(site, post);

  // Only possible if the Site this page just resolved by URL stopped
  // resolving by (organization_id, slug) between the two lookups (a race
  // with a concurrent delete) — fall back to the post's own fields rather
  // than serving no metadata at all.
  if (!seo) {
    return {
      title: { absolute: `${post.title} | ${site.name}` },
      description: post.meta_description || post.excerpt || undefined,
    };
  }

  const images = seoImages(seo);

  return {
    title: { absolute: `${seo.title} | ${site.name}` },
    description: seo.description,
    robots: seo.robots,
    ...(post.meta_keywords && { keywords: post.meta_keywords }),
    ...(post.author_name && { authors: [{ name: post.author_name }] }),
    alternates: blogAlternates(site, seo.canonical),
    openGraph: {
      type: "article",
      url: seo.og.url,
      title: seo.og.title,
      description: seo.og.description,
      siteName: site.name,
      images,
      ...(post.published_at && { publishedTime: post.published_at.toISOString() }),
      modifiedTime: (post.content_updated_at ?? post.updated_at).toISOString(),
      ...(post.author_name && { authors: [post.author_name] }),
      ...(post.category && { section: post.category.name }),
      tags: post.tags,
    },
    twitter: {
      card: seo.twitter.card,
      title: seo.twitter.title,
      description: seo.twitter.description,
      images,
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const site = await resolveBlogSite();
  if (!site) notFound();
  const post = await getBlogPost(site, (await params).slug);
  if (!post) notFound();
  const seo = await resolveBlogPostSeo(site, post);

  return (
    <main>
      {seo?.json_ld.map((node, i) => (
        // Independent nodes (each carries its own @context), one <script>
        // per node — post-seo.ts's own doc comment on `json_ld` is explicit
        // that this is NOT a single @graph-wrapped document.
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(node) }} />
      ))}
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/blog" className="hover:underline">
          ← {site.name}
        </Link>
      </nav>

      <article className="mt-6">
        <header>
          {post.category && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {post.category.name}
            </p>
          )}
          <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight text-foreground sm:text-4xl">
            {post.title}
          </h1>
          <p className="mt-4 text-sm text-muted-foreground">
            {post.author_name && (
              <>
                By <span className="font-medium text-foreground">{post.author_name}</span>
              </>
            )}
            {post.published_at && (
              <>
                {post.author_name && " · "}
                <time dateTime={post.published_at.toISOString()}>{formatBlogDate(post.published_at)}</time>
              </>
            )}
            {post.reading_time ? ` · ${post.reading_time} min read` : null}
          </p>
        </header>

        {post.featured_image && (
          <img
            src={post.featured_image}
            alt={post.featured_image_alt ?? ""}
            width={1200}
            height={630}
            className="mt-8 aspect-[1200/630] w-full rounded-lg border object-cover"
          />
        )}

        {/* content_html is sanitized server-side on every write (src/lib/sanitize.ts). */}
        <div className="prose-blog mt-10" dangerouslySetInnerHTML={{ __html: post.content_html ?? "" }} />

        {post.tags.length > 0 && (
          <ul className="mt-12 flex flex-wrap gap-2" aria-label="Tags">
            {post.tags.map((tag) => (
              <li key={tag} className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                {tag}
              </li>
            ))}
          </ul>
        )}
      </article>
    </main>
  );
}
