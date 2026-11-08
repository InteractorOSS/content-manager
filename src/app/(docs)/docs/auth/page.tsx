import type { Metadata } from "next";
import { PERMISSIONS, type PermissionName } from "@/lib/permissions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = {
  title: { absolute: "Authentication & Permissions | Interactor CMS Docs" },
  description:
    "How personal access tokens work in the Interactor CMS: minting, scope, permissions, and diagnosing a 403.",
};

// The permissions most relevant to the API/MCP surfaces this docs site
// covers — rendered from the canonical catalog (src/lib/permissions.ts) so
// this table can't drift from what the app actually enforces.
const FEATURED_PERMISSIONS: PermissionName[] = [
  "content:view",
  "content:create",
  "content:edit_any",
  "content:publish",
  "content:approve",
  "categories:manage",
];
const permissionRows = FEATURED_PERMISSIONS.map(
  (name) => PERMISSIONS.find((p) => p.name === name)!
);

export default function DocsAuthPage() {
  return (
    <article className="space-y-10">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-foreground">Authentication & permissions</h1>
        <p className="text-muted-foreground">
          Both the authenticated REST API and the MCP server use the same credential: a personal
          access token (PAT). This page is the one to read before minting one — the model has a
          property that people reliably guess wrong.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">Minting a token</h2>
        <p className="text-sm text-muted-foreground">
          Sign in to the CMS and go to <span className="text-foreground">Settings → API Tokens</span>.
          Every token is prefixed <code className="rounded bg-muted px-1 py-0.5">cms_pat_</code>{" "}
          and shown to you exactly once, in a reveal dialog, at creation time — the CMS never
          displays it again, so copy it somewhere safe immediately. If you lose it, revoke it and
          mint a new one.
        </p>
        <p className="text-sm text-muted-foreground">
          A token can optionally be given an expiry (or set to never expire) and can be revoked at
          any time from the same page, which takes effect immediately.
        </p>
        <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-foreground">
          <strong>PATs are server-side credentials.</strong> Never ship one to a browser, a mobile
          app, or any other client an end user can inspect — use it only from a server, script, or
          MCP client you control.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">One token, one organization</h2>
        <p className="text-sm text-muted-foreground">
          A token is bound to exactly one organization at mint time, and that binding never moves.
          If you belong to more than one organization, you choose which one a token acts on when
          you create it — and you can hold separate tokens for separate organizations. A token can
          never read or write another organization&apos;s content, even one you also belong to.
        </p>
        <p className="text-sm text-muted-foreground">
          The one exception is a Claude connection made with{" "}
          <span className="text-foreground">All my organizations</span>{" "}on the sign-in page. It
          reaches every organization of its accounts, and each request says which one it acts in
          with an <code className="rounded bg-muted px-1">X-CMS-Workspace</code>{" "}header
          (<code className="rounded bg-muted px-1">account/organization/site</code>; see{" "}
          <code className="rounded bg-muted px-1">GET /api/cms/workspaces</code>). A request that
          doesn&apos;t say is refused rather than guessed.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">Optional: scoped to specific sites</h2>
        <p className="text-sm text-muted-foreground">
          If your organization publishes to more than one site (blog, docs, a partner site, …), a
          token can additionally be limited to a subset of them at mint time. A site-scoped token
          only sees posts targeting its sites, and may only create or change posts whose sites are
          all within its scope. Leave this unset to act on every site in the organization.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">A token carries no permissions of its own</h2>
        <p className="text-sm text-muted-foreground">
          This is the property people get wrong. A token is not minted with a fixed set of rights.
          Instead, every request resolves the token&apos;s permissions live, from its owner&apos;s
          current membership role in the bound organization. If that person is later promoted,
          demoted, or removed from the organization, every one of their tokens reflects that
          change immediately — including ones minted long before.
        </p>
        <p className="text-sm text-muted-foreground">
          The practical consequence:{" "}
          <strong className="text-foreground">
            re-minting a token never changes what it can do
          </strong>
          . If a request is refused for a missing permission, the fix is the owner&apos;s role in
          that organization — not a new token.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">Permission vocabulary</h2>
        <p className="text-sm text-muted-foreground">
          A small set of named permissions gate the API. The ones you&apos;ll hit most:
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Permission</TableHead>
                <TableHead>Grants</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {permissionRows.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="font-mono text-xs text-foreground">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3 border-t pt-6">
        <h2 className="text-xl font-semibold text-foreground">Diagnosing a 403</h2>
        <p className="text-sm text-muted-foreground">
          Don&apos;t guess — ask the API. Both surfaces expose an identity check that names the
          bound organization, the token owner, their membership role there, and their full
          resolved permission set:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            REST: <code className="rounded bg-muted px-1 py-0.5">GET /api/me</code> with the same
            bearer token.
          </li>
          <li>
            MCP: call the <code className="rounded bg-muted px-1 py-0.5">whoami</code> tool.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          A refusal almost always resolves to one of two things: the owner&apos;s role in that
          organization lacks the permission, or the token is bound to a different organization (or
          a different site scope) than you assumed.
        </p>
      </section>
    </article>
  );
}
