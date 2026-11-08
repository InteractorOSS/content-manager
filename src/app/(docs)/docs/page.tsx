import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "./_components/code-block";

export const metadata: Metadata = {
  // `absolute` bypasses ancestor title templating entirely — Next's template
  // chaining across a route-group boundary is unreliable (confirmed by hand:
  // a plain string here also picked up the ROOT layout's "| Interactor CMS"
  // template despite the closer (docs) layout defining its own title).
  title: { absolute: "Overview | Interactor CMS Docs" },
  description:
    "What the Interactor CMS is, its three integration surfaces, and a 5-minute quickstart for each.",
};

export default function DocsOverviewPage() {
  return (
    <article className="space-y-10">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-foreground">Interactor CMS API & MCP docs</h1>
        <p className="text-muted-foreground">
          Interactor CMS is a headless content management system: posts, categories, tags, media
          and FAQs, managed through a REST API and an MCP server, and rendered wherever you like.
          This site documents everything an outside integration needs — no access to this
          codebase required.
        </p>
      </div>

      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold text-foreground">New here?</h2>
        <p className="text-sm text-muted-foreground">
          Start with <Link href="/docs/setup" className="underline">Setup</Link> (sign in, set up
          your organization and sites, invite your team), then{" "}
          <Link href="/docs/claude-desktop" className="underline">Claude desktop</Link> to write
          posts from Claude. The rest of these docs are for developers integrating with the API.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">Three ways in</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Public read API</strong> — unauthenticated GET
            endpoints for published content: posts, FAQs, RSS/sitemap feeds. Use this to render
            content on a website or app.
          </li>
          <li>
            <strong className="text-foreground">Authenticated REST API</strong> — create, update
            and manage content, gated by a personal access token. Use this to publish or automate
            content management from your own scripts or services. See{" "}
            <Link href="/docs/api" className="underline">
              REST API reference
            </Link>
            .
          </li>
          <li>
            <strong className="text-foreground">MCP server</strong> — the same content-management
            surface, exposed as tools for an LLM client (Claude Code, Claude Desktop, or any MCP
            client). See <Link href="/docs/mcp" className="underline">MCP reference</Link>.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Read <Link href="/docs/auth" className="underline">Authentication & permissions</Link>{" "}
          before using either authenticated surface — the token model has one property people
          reliably guess wrong.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground">5-minute quickstart</h2>

        <div className="space-y-2">
          <h3 className="font-medium text-foreground">1. Fetch the public posts feed</h3>
          <p className="text-sm text-muted-foreground">No credential needed.</p>
          <CodeBlock>{'curl "https://cms.interactor.com/api/public/posts"'}</CodeBlock>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium text-foreground">2. Mint a token and create a draft post</h3>
          <p className="text-sm text-muted-foreground">
            Sign in to the CMS and mint a personal access token from{" "}
            <span className="text-foreground">Settings → API Tokens</span>. Then:
          </p>
          <CodeBlock>{`curl -X POST "https://cms.interactor.com/api/cms/posts" \\
  -H "Authorization: Bearer cms_pat_..." \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Hello from the API","content":"Body text.","status":"draft"}'`}</CodeBlock>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium text-foreground">3. Connect Claude or another MCP client</h3>
          <p className="text-sm text-muted-foreground">
            In Claude, add <code className="rounded bg-muted px-1 py-0.5">https://cms.interactor.com/api/mcp</code>{" "}
            as a custom connector (Settings → Connectors) and sign in — no token needed. For
            Claude Code with a token:
          </p>
          <CodeBlock>{`claude mcp add --transport http cms https://cms.interactor.com/api/mcp \\
  --header "Authorization: Bearer cms_pat_..."`}</CodeBlock>
          <p className="text-sm text-muted-foreground">
            Then call the <code className="rounded bg-muted px-1 py-0.5">whoami</code> tool first
            — it confirms which organization and permissions the token acts with before you write
            anything. See <Link href="/docs/mcp" className="underline">MCP reference</Link>.
          </p>
        </div>
      </section>

      <section className="space-y-2 border-t pt-6">
        <h2 className="text-xl font-semibold text-foreground">Machine-readable</h2>
        <p className="text-sm text-muted-foreground">
          The full REST surface is also published as an OpenAPI 3.1 document, generated
          server-side from the same endpoint definitions as{" "}
          <Link href="/docs/api" className="underline">
            the reference on this site
          </Link>
          :
        </p>
        <CodeBlock>{"GET https://cms.interactor.com/api/public/openapi.json"}</CodeBlock>
      </section>
    </article>
  );
}
