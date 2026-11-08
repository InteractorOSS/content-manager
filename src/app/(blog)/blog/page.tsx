import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { blogAlternates, listBlogPosts, resolveBlogSite } from "@/lib/blog";
import { formatBlogDate } from "./format";

// Reads the database per request: posts publish from the CMS at any time, and
// a build-time prerender would need a database the build doesn't have.
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const site = await resolveBlogSite();
  if (!site) return {};
  const page = Number((await searchParams).page ?? "1");
  const description = site.description ?? `Posts from ${site.organization_name}.`;
  return {
    title: { absolute: page > 1 ? `${site.name} — page ${page}` : site.name },
    description,
    alternates: blogAlternates(site, page > 1 ? `${site.url}?page=${page}` : site.url),
    openGraph: { type: "website", title: site.name, description, url: site.url, siteName: site.name },
  };
}

export default async function BlogIndexPage({ searchParams }: Props) {
  const site = await resolveBlogSite();
  if (!site) notFound();
  const { posts, page, pages } = await listBlogPosts(site, Number((await searchParams).page ?? "1"));

  return (
    <main>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{site.name}</h1>
      {site.description && <p className="mt-2 text-muted-foreground">{site.description}</p>}

      {posts.length === 0 ? (
        <p className="mt-10 text-muted-foreground">No posts yet.</p>
      ) : (
        <ul className="mt-10 space-y-10">
          {posts.map((post) => (
            <li key={post.id}>
              <article className="grid gap-5 sm:grid-cols-[200px_1fr]">
                {post.featured_image ? (
                  <Link href={`/blog/${post.slug}`} tabIndex={-1} aria-hidden>
                    <img
                      src={post.featured_image}
                      alt=""
                      loading="lazy"
                      width={1200}
                      height={630}
                      className="aspect-[1200/630] w-full rounded-md border object-cover"
                    />
                  </Link>
                ) : (
                  <div className="hidden sm:block" />
                )}
                <div>
                  {post.category && (
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {post.category.name}
                    </p>
                  )}
                  <h2 className="mt-1 text-xl font-semibold leading-snug">
                    <Link href={`/blog/${post.slug}`} className="hover:underline">
                      {post.title}
                    </Link>
                  </h2>
                  {(post.excerpt || post.meta_description) && (
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                      {post.excerpt || post.meta_description}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {[
                      post.author_name,
                      post.published_at && formatBlogDate(post.published_at),
                      post.reading_time && `${post.reading_time} min read`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav className="mt-12 flex justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link href={page === 2 ? "/blog" : `/blog?page=${page - 1}`} className="hover:underline">
              ← Newer posts
            </Link>
          ) : (
            <span />
          )}
          {page < pages && (
            <Link href={`/blog?page=${page + 1}`} className="hover:underline">
              Older posts →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
