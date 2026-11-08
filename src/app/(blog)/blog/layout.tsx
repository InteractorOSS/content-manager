import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveBlogSite } from "@/lib/blog";

// Overrides the root layout's `robots: "noindex, nofollow"` for this subtree —
// like (docs), the blog is meant to be public and indexable. Pages set their
// own titles with `absolute` (see (docs)/docs/layout.tsx for why).
export const metadata: Metadata = {
  robots: "index, follow",
};

// Deliberately no CMS chrome: no sidebar, no session, no useMe(). This layout
// renders the same for every visitor, signed in or not.
export default async function BlogLayout({ children }: { children: React.ReactNode }) {
  const site = await resolveBlogSite();
  if (!site) notFound();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/blog" className="font-semibold text-foreground">
            {site.name}
          </Link>
          <nav className="flex gap-5 text-sm">
            <Link href="/blog" className="text-muted-foreground hover:text-foreground">
              Posts
            </Link>
            <Link href="/docs" className="text-muted-foreground hover:text-foreground">
              Docs
            </Link>
            <a href="/blog/rss.xml" className="text-muted-foreground hover:text-foreground">
              RSS
            </a>
            <a href="/blog/llms.txt" className="text-muted-foreground hover:text-foreground">
              llms.txt
            </a>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-10">{children}</div>
      <footer className="border-t">
        <div className="mx-auto max-w-3xl px-6 py-6 text-xs text-muted-foreground">
          Published with the {site.organization_name} CMS.
        </div>
      </footer>
    </div>
  );
}
