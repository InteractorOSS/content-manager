"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WRITING_PLUGIN_COMMANDS, WRITING_PLUGIN_TEAM_SETUP_URL } from "@/lib/writing-plugin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  listApiTokens,
  createApiToken,
  revokeApiToken,
  listTokenSiteOptions,
  ApiError,
} from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import { formatDateTime } from "@/lib/utils";
import type { ApiToken, Site } from "@/types/cms";

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiration" },
];

export function ApiTokensManager() {
  const queryClient = useQueryClient();
  const { me } = useMe();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState("90");
  const [orgId, setOrgId] = useState<string>("");
  const [siteScopes, setSiteScopes] = useState<string[]>([]);
  const [mintedToken, setMintedToken] = useState<ApiToken & { token: string } | null>(
    null
  );

  const organizations = me?.organizations ?? [];
  // The org the token will be minted for: an explicit pick, else the active one.
  const selectedOrgId =
    orgId || organizations.find((o) => o.active)?.id || organizations[0]?.id || "";
  const selectedOrgName =
    organizations.find((o) => o.id === selectedOrgId)?.name ?? "this organization";

  const { data: tokens = [], isLoading } = useQuery<ApiToken[]>({
    queryKey: ["api-tokens"],
    queryFn: () => listApiTokens(),
  });

  // The sites of the org being minted FOR — not the active org's /sites list,
  // which is wrong as soon as a multi-org user picks a different organization.
  const siteOptions = useQuery<Site[]>({
    queryKey: ["token-site-options", selectedOrgId],
    queryFn: () => listTokenSiteOptions(selectedOrgId),
    enabled: createOpen && !!selectedOrgId,
  });
  const sites = siteOptions.data ?? [];
  const chosenSites = sites.filter((s) => siteScopes.includes(s.slug));

  const createMutation = useMutation({
    mutationFn: () =>
      createApiToken({
        name: name.trim(),
        ...(selectedOrgId && { organization_id: selectedOrgId }),
        ...(expiresIn !== "never" && { expires_in_days: Number(expiresIn) }),
        ...(chosenSites.length > 0 && { site_scopes: chosenSites.map((s) => s.slug) }),
      }),
    onSuccess: (created) => {
      setMintedToken(created);
      setName("");
      setExpiresIn("90");
      setOrgId("");
      setSiteScopes([]);
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    // Our own 4xx refusals are written for people (e.g. an unknown site);
    // anything else gets a plain fallback rather than a status code.
    onError: (e) =>
      toast.error(
        e instanceof ApiError && e.status < 500
          ? e.message
          : "Couldn't create the token. Try again."
      ),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeApiToken(id),
    onSuccess: () => {
      toast.success("Token revoked");
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: () => toast.error("Failed to revoke token"),
  });

  function copyMintedToken() {
    if (!mintedToken) return;
    navigator.clipboard.writeText(mintedToken.token);
    toast.success("Copied to clipboard");
  }

  function toggleSite(slug: string, checked: boolean) {
    setSiteScopes((current) =>
      checked ? [...current, slug] : current.filter((s) => s !== slug)
    );
  }

  function tokenState(token: ApiToken): string {
    if (token.revoked_at) return "Revoked";
    if (token.expires_at && new Date(token.expires_at) < new Date()) return "Expired";
    return "Active";
  }

  return (
    <div className="space-y-4">
      <ConnectClaudeCard />

      <div className="rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="font-semibold text-sm">Personal access tokens</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              For desktop/CLI file sync and MCP clients — each token acts on one
              organization, carries your permissions there, and is revocable any time. See the{" "}
              <Link href="/docs" className="underline">
                API & MCP docs
              </Link>{" "}
              for how to use one.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New token
          </Button>
        </div>

        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No tokens yet. Create one to sync posts from a desktop editor.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Sites</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">
                    {token.name}
                    {token.connected_app && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        <Plug className="h-3 w-3" aria-hidden />
                        Connected app
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {token.all_organizations ? (
                      <span title="Each folder or request picks the organization and site it works in">
                        All organizations
                        {token.linked_accounts && token.linked_accounts.length > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            also {token.linked_accounts.join(", ")}
                          </span>
                        )}
                      </span>
                    ) : token.organization ? (
                      token.organization.name
                    ) : (
                      // Pre-binding token with no org to backfill: refused at
                      // request time, so say that rather than leave it blank.
                      <span className="text-destructive" title="Unusable — re-create this token">
                        Not bound
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {token.site_scopes.length > 0 ? (
                      token.site_scopes.join(", ")
                    ) : (
                      <span className="text-muted-foreground">All sites</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {token.connected_app ? "OAuth" : `${token.token_prefix}…`}
                  </TableCell>
                  <TableCell className="text-sm">{tokenState(token)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {token.last_used_at ? formatDateTime(token.last_used_at) : "Never"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {token.expires_at ? formatDateTime(token.expires_at) : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    {!token.revoked_at && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => revokeMutation.mutate(token.id)}
                        disabled={revokeMutation.isPending}
                        title={token.connected_app ? "Disconnect" : "Revoke"}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New personal access token</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g. Obsidian vault"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {/* One token, one organization. Shown whenever there is a choice
                to make; a single-org user gets the only sensible default and
                no decision. */}
            {organizations.length > 1 && (
              <div className="space-y-2">
                <Label>Organization</Label>
                <Select
                  value={selectedOrgId}
                  onValueChange={(value) => {
                    setOrgId(value);
                    // Site slugs belong to one org; carrying a pick across
                    // would name sites the new org may not have.
                    setSiteScopes([]);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name} · {org.role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  This token will only ever act on the organization chosen here, with
                  your role in it. It cannot reach the others.
                </p>
              </div>
            )}
            {/* Optional site scope (G#21). Nothing ticked is the default and
                means every site, so the summary line always states which. */}
            <div className="space-y-2" role="group" aria-labelledby="token-sites-label">
              <Label id="token-sites-label">Sites</Label>
              {siteOptions.isError ? (
                <div role="alert" className="space-y-2 rounded-md border p-3 text-sm">
                  <p>
                    Couldn&apos;t load the sites for {selectedOrgName}. You can still
                    create a token for every site, or try again to limit it.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => siteOptions.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : siteOptions.isPending ? (
                <div className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading sites…
                </div>
              ) : (
                <div className="max-h-60 divide-y overflow-y-auto rounded-md border">
                  {sites.map((site) => (
                    <label
                      key={site.slug}
                      htmlFor={`token-site-${site.slug}`}
                      className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                    >
                      <Checkbox
                        id={`token-site-${site.slug}`}
                        checked={siteScopes.includes(site.slug)}
                        onCheckedChange={(checked) => toggleSite(site.slug, checked === true)}
                      />
                      <span className="flex-1 text-sm">{site.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {site.slug}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {chosenSites.length > 0
                  ? `Limited to ${chosenSites.map((s) => s.name).join(", ")}: it sees posts for ${
                      chosenSites.length === 1 ? "this site" : "these sites"
                    } and can only change posts that target nothing else.`
                  : `No site ticked — the token can reach every site in ${selectedOrgName}.`}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Expiration</Label>
              <Select value={expiresIn} onValueChange={setExpiresIn}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show-once reveal dialog */}
      <Dialog open={!!mintedToken} onOpenChange={(open) => !open && setMintedToken(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Copy your token now</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This is the only time it will be shown. Store it somewhere safe — you&apos;ll
            need to create a new one if you lose it.
          </p>
          {mintedToken?.organization && (
            <p className="text-sm">
              Acts on <strong>{mintedToken.organization.name}</strong> only
              {mintedToken.site_scopes.length > 0 ? (
                <>
                  , limited to <strong>{mintedToken.site_scopes.join(", ")}</strong>
                </>
              ) : (
                ", on every site there"
              )}
              . Label it accordingly wherever you paste it.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={mintedToken?.token ?? ""}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="icon" onClick={copyMintedToken}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setMintedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * How to connect Claude. The primary path is the Interactor CMS plugin:
 * one install gives the CMS connection (OAuth sign-in, no token to paste) and
 * the live-editing workflow. The bare MCP URL is kept, collapsed, for Claude
 * chat's custom connectors and other MCP clients. Either way the connection
 * shows up in the table below as a "Connected app" row, revocable like any
 * token.
 */
function ConnectClaudeCard() {
  // Read after mount: the server render has no window, and the URL must be
  // the origin this CMS is actually served on.
  const [mcpUrl, setMcpUrl] = useState("");
  useEffect(() => setMcpUrl(`${window.location.origin}/api/mcp`), []);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }

  return (
    <div className="rounded-lg border bg-background px-4 py-3 space-y-3">
      <div>
        <h3 className="font-semibold text-sm">Write with Claude</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Install the Interactor CMS plugin in the Claude desktop app (Code tab) or Claude Code.
          Open any post as a file, edit it yourself or ask Claude for changes, and watch a live
          preview update beside the chat. The CMS connection comes with the plugin, so there&apos;s
          no token to copy.
        </p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
        <li>
          In Claude, run these two commands:
          <div className="mt-1.5 space-y-1.5">
            {WRITING_PLUGIN_COMMANDS.map((command) => (
              <div key={command} className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border bg-muted px-3 py-1.5 text-xs text-foreground">
                  {command}
                </code>
                <Button variant="outline" size="sm" onClick={() => copy(command)}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
            ))}
          </div>
        </li>
        <li>
          Sign in when asked and keep <span className="text-foreground">All my organizations</span>{" "}
          selected. Use <span className="text-foreground">Add another account</span>{" "}if you also write under
          another CMS account. If you aren&apos;t asked, run{" "}
          <code className="rounded bg-muted px-1">/mcp</code>{" "}and pick the Interactor CMS.
        </li>
        <li>
          Say <span className="text-foreground">&ldquo;open the post about …&rdquo;</span>{" "}or{" "}
          <span className="text-foreground">&ldquo;start a new post about …&rdquo;</span>.
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">
        Setting this up for a team? Admins can pre-install it for everyone.{" "}
        <a href={WRITING_PLUGIN_TEAM_SETUP_URL} target="_blank" rel="noreferrer" className="underline">
          Team setup
        </a>
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          Other ways to connect (Claude chat, other MCP clients)
        </summary>
        <div className="mt-2 space-y-2">
          <p>
            Connect with the MCP server directly: in Claude chat, open{" "}
            <span className="font-medium text-foreground">Settings → Connectors → Add custom connector</span>{" "}
            and paste this URL. Other MCP clients use the same URL. If you install the plugin in
            Claude Code, don&apos;t add this URL there as well, or the same tools show up twice.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">
              {mcpUrl || "…/api/mcp"}
            </code>
            <Button variant="outline" size="sm" onClick={() => copy(mcpUrl)} disabled={!mcpUrl}>
              <Copy className="h-4 w-4 mr-2" />
              Copy
            </Button>
          </div>
          <p>
            Details are in the{" "}
            <Link href="/docs/mcp" className="underline">
              MCP reference
            </Link>
            .
          </p>
        </div>
      </details>
    </div>
  );
}
