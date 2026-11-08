import type { Metadata } from "next";
import Link from "next/link";

// Overrides the root layout's `robots: "noindex, nofollow"` — this subtree is
// the one part of the app meant to be public and indexable. Only a fallback:
// every page under here sets its own `title: { absolute }` (see docs/page.tsx
// for why `absolute` — Next's title-template chaining across this route
// group's boundary doesn't reliably pick the nearest ancestor).
export const metadata: Metadata = {
  title: "API & MCP Documentation | Interactor CMS Docs",
  description:
    "Integrate with the Interactor CMS: the public read API, the authenticated REST API for content management, and an MCP server for LLM clients.",
  robots: "index, follow",
};

// Getting-started pages first, then the reference. Order is the reading order
// for someone arriving from the front page.
const NAV_LINKS = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/setup", label: "Setup" },
  { href: "/docs/claude-desktop", label: "Claude desktop" },
  { href: "/docs/api", label: "API" },
  { href: "/docs/auth", label: "Authentication" },
  { href: "/docs/mcp", label: "MCP" },
];

// Deliberately no CMS chrome: no sidebar, no session, no useMe(). This layout
// must render the same for every visitor, signed in or not.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-semibold text-foreground">
            Interactor CMS <span className="font-normal text-muted-foreground">Docs</span>
          </Link>
          <nav className="flex items-center gap-5 text-sm">
            <Link href="/blog" className="text-muted-foreground hover:text-foreground">
              Blog
            </Link>
            <Link href="/login" className="text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10 md:flex-row">
        <nav aria-label="Docs" className="shrink-0 md:w-44">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm md:sticky md:top-6 md:flex-col md:gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="block py-1 text-muted-foreground hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
