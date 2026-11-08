import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "../_components/code-block";
import { WRITING_PLUGIN_COMMANDS, WRITING_PLUGIN_TEAM_SETUP_URL } from "@/lib/writing-plugin";

export const metadata: Metadata = {
  title: { absolute: "Claude Desktop | Interactor CMS Docs" },
  description:
    "Write and edit Interactor CMS posts from the Claude desktop app: install the Interactor CMS plugin in the Code tab, sign in, and open posts beside the chat. Or connect Claude chat as a custom connector.",
};

const MCP_URL = "https://cms.interactor.com/api/mcp";
const code = "rounded bg-muted px-1 py-0.5";
const ui = "text-foreground";

export default function DocsClaudeDesktopPage() {
  return (
    <article className="space-y-10">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-foreground">Claude desktop</h1>
        <p className="text-muted-foreground">
          The Claude desktop app is the easiest way to write for the CMS. Ask Claude to open a
          post and it appears as a formatted page beside the chat: you type on it directly, Claude
          edits the same text, and every change saves to the CMS.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Install the Interactor CMS plugin
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            Open the Claude desktop app and switch to the <span className={ui}>Code</span>{" "}tab.
            Pick the folder you want to write in (a new, empty folder is fine).
          </li>
          <li>Paste these two commands into the chat, one at a time:</li>
        </ol>
        <CodeBlock>{WRITING_PLUGIN_COMMANDS.join("\n")}</CodeBlock>
        <ol start={3} className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            When Claude asks you to sign in, a browser window opens. Sign in with your Interactor
            account and choose <span className={ui}>All my organizations</span>, or one
            organization. Use <span className={ui}>Add another account</span>{" "}if you also write
            under a different account.
          </li>
          <li>
            If the sign-in doesn&apos;t appear, type <code className={code}>/mcp</code>, pick{" "}
            <span className={ui}>Interactor CMS</span>{" "}and choose{" "}
            <span className={ui}>Authenticate</span>.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          Admins can pre-install the plugin for a whole team, so writers only sign in.{" "}
          <a href={WRITING_PLUGIN_TEAM_SETUP_URL} className="underline">Team setup</a>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">Write</h2>
        <p className="text-sm text-muted-foreground">Just ask, in your own words:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>&ldquo;Show me my posts&rdquo; opens your post list in the panel beside the chat.</li>
          <li>&ldquo;Open the post about pricing&rdquo; opens it for editing.</li>
          <li>&ldquo;Start a new post about our launch&rdquo; creates a draft and opens it.</li>
          <li>&ldquo;Tighten the intro&rdquo; or &ldquo;write the LinkedIn copy&rdquo; while a post is open.</li>
          <li>&ldquo;Submit it for review&rdquo; or &ldquo;publish it&rdquo;, if your role allows.</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          The editor&apos;s <span className={ui}>Details</span>{" "}panel holds the featured image,
          URL, category, tags, sites and search description; its{" "}
          <span className={ui}>Social</span>{" "}tab holds the LinkedIn, X and Facebook copy. Paste or
          drop pictures straight into the text. Claude also keeps the post as a Markdown file in
          your folder, in sync both ways (this part needs Node.js 18 or later).
        </p>
        <p className="text-sm text-muted-foreground">
          Deleted posts go to the trash for 30 days; ask Claude to restore one, or open the{" "}
          <span className={ui}>Trash</span>{" "}tab of the post list.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          Or: connect Claude chat
        </h2>
        <p className="text-sm text-muted-foreground">
          In a regular Claude chat (desktop, web or mobile) you can connect the CMS as a connector.
          Claude can then list, create and update posts, but without the editor beside the chat.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Open <span className={ui}>Settings → Connectors</span>{" "}and choose{" "}
            <span className={ui}>Add custom connector</span>.
          </li>
          <li>
            Paste <code className={code}>{MCP_URL}</code>{" "}as the URL. No client ID or secret is
            needed.
          </li>
          <li>
            Click <span className={ui}>Connect</span>{" "}and sign in the same way as above.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          Don&apos;t add this connector in the Code tab as well as the plugin, or every tool shows
          up twice.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">If something is refused</h2>
        <p className="text-sm text-muted-foreground">
          Ask Claude &ldquo;who am I connected as?&rdquo;. It calls{" "}
          <code className={code}>whoami</code>, which names the account, organization, your role
          there and what it lets you do. A refusal is almost always your role in that organization
          (an author can&apos;t publish, for example) or the wrong organization.
        </p>
        <p className="text-sm text-muted-foreground">
          To disconnect Claude, sign in to the CMS, open{" "}
          <span className={ui}>Settings → API Tokens</span>{" "}and revoke its{" "}
          <span className={ui}>Connected app</span>{" "}row. For every tool and
          other MCP clients, see the <Link href="/docs/mcp" className="underline">MCP reference</Link>.
        </p>
      </section>
    </article>
  );
}
