import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpen, LogIn, Newspaper } from "lucide-react";
import { auth } from "@/lib/auth";
import { listBlogPosts, resolveBlogSite } from "@/lib/blog";
import { formatBlogDate } from "./(blog)/blog/format";

// The public front door at `/`. It used to redirect straight to /dashboard,
// which (signed out) meant /login → the SSO bounce → auth.interactor.com, so a
// visitor never saw what this site is or reached the blog and docs from it.
// Like (docs) and (blog) it has no CMS chrome and is public and indexable.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Interactor CMS" },
  description:
    "Interactor CMS: write, review and publish posts, and manage them from Claude. Sign in, read the blog, or read the docs.",
  robots: "index, follow",
};

const LATEST_COUNT = 3;

async function latestPosts() {
  // The blog is optional (no registered <origin>/blog site → none), and a
  // database hiccup must not take the front page down with it.
  try {
    const site = await resolveBlogSite();
    if (!site) return null;
    const { posts } = await listBlogPosts(site, 1);
    return { site, posts: posts.slice(0, LATEST_COUNT) };
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const [session, blog] = await Promise.all([auth().catch(() => null), latestPosts()]);
  const signedIn = !!session?.user;

  const cards = [
    signedIn
      ? {
          href: "/dashboard",
          icon: LogIn,
          title: "Open the CMS",
          body: "You're signed in. Go to your dashboard to write, review and publish.",
        }
      : {
          href: "/login",
          icon: LogIn,
          title: "Sign in",
          body: "Sign in with your Interactor account to write, review and publish posts.",
        },
    ...(blog
      ? [
          {
            href: "/blog",
            icon: Newspaper,
            title: "Blog",
            body: blog.site.description ?? "Posts published with this CMS.",
          },
        ]
      : []),
    {
      href: "/docs",
      icon: BookOpen,
      title: "Docs",
      body: "Set up your organization, connect Claude, and use the REST API and MCP server.",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-semibold text-foreground">
            Interactor CMS
          </Link>
          <nav className="flex items-center gap-5 text-sm">
            {blog && (
              <Link href="/blog" className="text-muted-foreground hover:text-foreground">
                Blog
              </Link>
            )}
            <Link href="/docs" className="text-muted-foreground hover:text-foreground">
              Docs
            </Link>
            <Link
              href={signedIn ? "/dashboard" : "/login"}
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
            >
              {signedIn ? "Dashboard" : "Sign in"}
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16">
        <section className="max-w-2xl space-y-4">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Write, review and publish, from the CMS or from Claude
          </h1>
          <p className="text-lg text-muted-foreground">
            Interactor CMS holds your posts, FAQs and media, runs them through review, and
            publishes them to every site your organization runs. Writers can open a post from
            Claude and edit it beside the chat.
          </p>
        </section>

        <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ href, icon: Icon, title, body }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-lg border p-5 transition-colors hover:bg-muted/50"
            >
              <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
              <h2 className="mt-3 flex items-center gap-1 font-semibold text-foreground">
                {title}
                <ArrowRight
                  className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden
                />
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </Link>
          ))}
        </section>

        {blog && blog.posts.length > 0 && (
          <section className="mt-16">
            <div className="flex items-baseline justify-between border-b pb-2">
              <h2 className="text-xl font-semibold text-foreground">Latest from the blog</h2>
              <Link href="/blog" className="text-sm text-muted-foreground hover:text-foreground">
                All posts →
              </Link>
            </div>
            <ul className="mt-6 grid gap-6 sm:grid-cols-3">
              {blog.posts.map((post) => (
                <li key={post.id}>
                  <Link href={`/blog/${post.slug}`} className="group block">
                    {post.featured_image && (
                      <img
                        src={post.featured_image}
                        alt=""
                        loading="lazy"
                        width={1200}
                        height={630}
                        className="aspect-[1200/630] w-full rounded-md border object-cover"
                      />
                    )}
                    <h3 className="mt-3 font-medium leading-snug text-foreground group-hover:underline">
                      {post.title}
                    </h3>
                    {post.published_at && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatBlogDate(post.published_at)}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
