import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "../_components/code-block";
import { Badge } from "@/components/ui/badge";
import {
  CMS_TOOL_INPUT_SCHEMAS,
  CMS_TOOLS,
  MCP_SERVER_INFO,
  MCP_SERVER_INSTRUCTIONS,
  type CmsTool,
} from "@/lib/mcp/tools";
import { WRITING_PLUGIN_COMMANDS, WRITING_PLUGIN_TEAM_SETUP_URL } from "@/lib/writing-plugin";

export const metadata: Metadata = {
  title: { absolute: "MCP Reference | Interactor CMS Docs" },
  description:
    "Connect Claude or any MCP client to the Interactor CMS: the Interactor CMS plugin, the custom connector, the claude mcp add snippet, a raw JSON-RPC example, the server instructions, and the full generated tool reference.",
};

const PLUGIN_SNIPPET = `${WRITING_PLUGIN_COMMANDS.join("\n")}
# then sign in when asked (or: /mcp → Interactor CMS → Authenticate)`;

const CLAUDE_SNIPPET = `claude mcp add --transport http cms https://cms.interactor.com/api/mcp
# then, inside Claude Code: /mcp  → select "cms" → Authenticate`;

const CLAUDE_PAT_SNIPPET = `claude mcp add --transport http cms https://cms.interactor.com/api/mcp \\
  --header "Authorization: Bearer cms_pat_..."`;

const RAW_JSONRPC_EXAMPLE = `curl -X POST "https://cms.interactor.com/api/mcp" \\
  -H "Authorization: Bearer cms_pat_..." \\
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`;

function toolAnchor(name: string): string {
  return `tool-${name}`;
}

function ToolCard({ tool }: { tool: CmsTool }) {
  const schemaJson = CMS_TOOL_INPUT_SCHEMAS[tool.name];
  const schema = schemaJson ? JSON.stringify(schemaJson, null, 2) : null;

  return (
    <details id={toolAnchor(tool.name)} className="scroll-mt-20 rounded-lg border p-4 open:pb-5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-foreground">{tool.name}</span>
        {tool.config.annotations?.readOnlyHint && <Badge variant="info">Read-only</Badge>}
        {tool.config.annotations?.destructiveHint && <Badge variant="destructive">Destructive</Badge>}
      </summary>
      <div className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">{tool.config.description}</p>
        {schema && (
          <div className="space-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Input schema
            </h4>
            <CodeBlock>{schema}</CodeBlock>
          </div>
        )}
      </div>
    </details>
  );
}

export default function DocsMcpPage() {
  return (
    <article className="space-y-10">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-foreground">MCP reference</h1>
        <p className="text-muted-foreground">
          Interactor CMS runs a remote MCP server (Streamable HTTP, stateless) so any MCP client —
          Claude (web, desktop, mobile), Claude Code, or one you built — can manage content
          directly. Claude signs in with OAuth, so there is no token to copy; any other client can
          use the same personal access token as the REST API (see{" "}
          <Link href="/docs/auth" className="underline">
            Authentication & permissions
          </Link>
          ).
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Write with Claude (recommended)
        </h2>
        <p className="text-sm text-muted-foreground">
          The <span className="text-foreground">Interactor CMS</span>{" "}plugin for Claude Code and
          the Claude desktop app&apos;s Code tab is one install: it brings this MCP server (signed in
          with OAuth) plus a live-editing workflow. A writer says &ldquo;open the post about
          &hellip;&rdquo; and gets the post as a local Markdown file, kept in two-way sync with the
          CMS, and a preview beside the chat that updates on every save. Changes Claude makes for
          them go into the same file.
        </p>
        <CodeBlock>{PLUGIN_SNIPPET}</CodeBlock>
        <p className="text-sm text-muted-foreground">
          The file sync needs Node.js 18 or later. Without it, the plugin still opens the live
          preview and edits through the MCP tools. Under the hood it uses{" "}
          <a href={`#${toolAnchor("open_for_editing")}`} className="underline">
            open_for_editing
          </a>
          , which hands the plugin a one-post edit key: it reaches only that post, expires in 8
          hours, and ends when the connection is revoked.
        </p>
        <p className="text-sm text-muted-foreground">
          Admins can pre-configure the plugin for a whole team (Claude Team/Enterprise managed
          settings, or a managed-settings file), so writers skip the install commands and only sign
          in once.{" "}
          <a href={WRITING_PLUGIN_TEAM_SETUP_URL} className="underline">
            Team setup
          </a>
          .
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Connect from Claude chat
        </h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            In Claude, open <span className="text-foreground">Settings → Connectors</span> and choose{" "}
            <span className="text-foreground">Add custom connector</span>.
          </li>
          <li>
            Paste <code className="rounded bg-muted px-1 py-0.5">https://cms.interactor.com/api/mcp</code>{" "}
            as the URL and add it — no client ID or secret needed.
          </li>
          <li>
            Click <span className="text-foreground">Connect</span>, sign in with your Interactor
            account, and choose <span className="text-foreground">All my organizations</span>{" "}
            (or one organization, optionally limited to some sites). Use{" "}
            <span className="text-foreground">Add another account</span>{" "}to include other CMS
            accounts you write under.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          With All my organizations, one connection reaches every organization and site of its
          accounts, and each tool call names where it acts with a{" "}
          <code className="rounded bg-muted px-1">workspace</code>{" "}(
          <code className="rounded bg-muted px-1">account/organization/site</code>, listed by{" "}
          <code className="rounded bg-muted px-1">list_workspaces</code>). It appears under
          Settings → API Tokens as a <span className="text-foreground">Connected app</span>, where
          you can disconnect it.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Connect from Claude Code without the plugin
        </h2>
        <p className="text-sm text-muted-foreground">
          Only the MCP tools, without the live-editing workflow. Don&apos;t add both this and the
          plugin, or the same tools show up twice.
        </p>
        <CodeBlock>{CLAUDE_SNIPPET}</CodeBlock>
        <p className="text-sm text-muted-foreground">
          Or skip the browser sign-in with a personal access token:
        </p>
        <CodeBlock>{CLAUDE_PAT_SNIPPET}</CodeBlock>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Connect from any other MCP client
        </h2>
        <p className="text-sm text-muted-foreground">
          The server speaks plain JSON-RPC 2.0 over Streamable HTTP — no Claude-specific
          transport. A <code className="rounded bg-muted px-1 py-0.5">tools/list</code> call:
        </p>
        <CodeBlock>{RAW_JSONRPC_EXAMPLE}</CodeBlock>
      </section>

      <section className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
        <h2 className="text-sm font-semibold text-foreground">Call whoami before writing</h2>
        <p className="text-sm text-muted-foreground">
          A token acts on exactly one organization, and you may hold separate tokens for separate
          organizations. Calling <code className="rounded bg-muted px-1 py-0.5">whoami</code> first
          confirms which one — and what the token may do there — before any tool creates, updates,
          or deletes anything. Writing through the wrong token produces no error, just content in
          the wrong tenant.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">Server instructions</h2>
        <p className="text-sm text-muted-foreground">
          Sent to every connecting client as part of the MCP handshake ({MCP_SERVER_INFO.name} v
          {MCP_SERVER_INFO.version}):
        </p>
        <CodeBlock>{MCP_SERVER_INSTRUCTIONS}</CodeBlock>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Tools ({CMS_TOOLS.length})
        </h2>
        <p className="text-sm text-muted-foreground">
          Generated directly from the live tool registry — a tool added to the server appears here
          with no second edit.
        </p>
        <nav className="rounded-lg border p-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
            {CMS_TOOLS.map((tool) => (
              <a key={tool.name} href={`#${toolAnchor(tool.name)}`} className="underline">
                {tool.name}
              </a>
            ))}
          </div>
        </nav>
        <div className="space-y-3">
          {CMS_TOOLS.map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </div>
      </section>
    </article>
  );
}
