import { prisma } from "@/lib/db";
import { loadActor, type Actor } from "@/lib/rbac";
import { tenantDb } from "@/lib/tenant-db";
import { orgSiteSlugs, orgSites } from "@/lib/sites-server";

// Workspace connections. A connection made with "All my organizations" on the
// consent page (ApiToken.all_organizations) is not bound to one organization:
// every request names the WORKSPACE it acts in, as
//
//     <account email>/<organization slug>[/<site slug>]
//
// e.g. "writer@example.com/acme/acme-site". The Interactor CMS
// plugin keeps one per folder, so one sign-in covers every account,
// organization and site a writer has, and each folder works in its own.
//
// The account part may be left out when only one of the connection's
// accounts belongs to that organization. The site part narrows the request
// exactly like a token's site scope (src/lib/token-site-scope.ts): posts on
// other sites can be read only if they are shared with it, never changed.
//
// Nothing here widens what a person can do: each request acts as that
// account, with its live role in that organization, and an organization none
// of the connection's accounts belongs to is simply not reachable.

export const WORKSPACE_HEADER = "x-cms-workspace";

export type WorkspaceRef = { account: string | null; organization: string; site: string | null };

/** Parse "account/org[/site]" or "org[/site]". Null when malformed. */
export function parseWorkspace(raw: string | null | undefined): WorkspaceRef | null {
  const value = raw?.trim();
  if (!value) return null;
  const parts = value.split("/").map((p) => p.trim());
  if (parts.some((p) => !p) || parts.length > 3) return null;
  if (parts[0].includes("@")) {
    if (parts.length < 2) return null;
    return { account: parts[0].toLowerCase(), organization: parts[1], site: parts[2] ?? null };
  }
  if (parts.length > 2) return null;
  return { account: null, organization: parts[0], site: parts[1] ?? null };
}

export function formatWorkspace(account: string, organizationSlug: string, site?: string | null): string {
  return [account, organizationSlug, site].filter(Boolean).join("/");
}

/** The accounts a connection acts for: its owner, then any linked ones. */
export async function connectionAccounts(token: { id: string; user_id: string }) {
  const linked = await prisma.apiTokenAccount.findMany({
    where: { api_token_id: token.id },
    select: { user_id: true },
    orderBy: { inserted_at: "asc" },
  });
  const ids = [token.user_id, ...linked.map((l) => l.user_id).filter((id) => id !== token.user_id)];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  return ids.flatMap((id) => users.filter((u) => u.id === id));
}

export type WorkspaceListing = {
  workspace: string;
  account: string;
  organization: { id: string; slug: string; name: string };
  role: string;
  site: { slug: string; name: string; url: string | null } | null;
};

/**
 * Everything a connection can reach: one entry per account × organization ×
 * site (and one for the organization as a whole). Site-scoped connections
 * list only their sites.
 */
export async function listWorkspaces(token: {
  id: string;
  user_id: string;
  all_organizations: boolean;
  organization_id: string | null;
  site_scopes: string[];
}): Promise<WorkspaceListing[]> {
  const accounts = token.all_organizations
    ? await connectionAccounts(token)
    : await prisma.user.findMany({ where: { id: token.user_id }, select: { id: true, email: true } });
  const out: WorkspaceListing[] = [];
  for (const account of accounts) {
    const memberships = await prisma.membership.findMany({
      where: {
        user_id: account.id,
        ...(token.all_organizations ? {} : { organization_id: token.organization_id ?? "__none__" }),
      },
      include: { organization: { select: { id: true, slug: true, name: true } } },
      orderBy: { organization: { name: "asc" } },
    });
    for (const m of memberships) {
      const org = m.organization;
      const sites = (await orgSites(tenantDb(org.id))).filter(
        (s) => token.site_scopes.length === 0 || token.site_scopes.includes(s.slug)
      );
      if (token.site_scopes.length === 0) {
        out.push({ workspace: formatWorkspace(account.email, org.slug), account: account.email, organization: org, role: m.role, site: null });
      }
      for (const s of sites) {
        out.push({
          workspace: formatWorkspace(account.email, org.slug, s.slug),
          account: account.email,
          organization: org,
          role: m.role,
          site: { slug: s.slug, name: s.name, url: s.url ?? null },
        });
      }
    }
  }
  return out;
}

export type ResolvedWorkspace =
  | { kind: "ok"; actor: Actor; organizationId: string; site: string | null }
  | { kind: "refused"; message: string };

/**
 * Resolve the workspace a request on a workspace connection names to the
 * account acting and the organization it acts in. With no workspace, a
 * connection whose accounts belong to exactly one organization uses it;
 * otherwise the request is refused with the list to choose from, never
 * guessed.
 */
export async function resolveWorkspace(
  token: { id: string; user_id: string },
  raw: string | null
): Promise<ResolvedWorkspace> {
  const accounts = await connectionAccounts(token);
  const memberships = await prisma.membership.findMany({
    where: { user_id: { in: accounts.map((a) => a.id) } },
    include: { organization: { select: { id: true, slug: true, name: true } } },
  });
  const choices = memberships.map((m) => {
    const email = accounts.find((a) => a.id === m.user_id)!.email;
    return { userId: m.user_id, email, org: m.organization };
  });
  const list = () =>
    choices.map((c) => `${formatWorkspace(c.email, c.org.slug)} (${c.org.name})`).join(", ") || "none";

  let pick: (typeof choices)[number] | undefined;
  let site: string | null = null;
  if (!raw) {
    if (choices.length === 1) pick = choices[0];
    else {
      return {
        kind: "refused",
        message: `This connection reaches several organizations, so say which one: pass workspace as "<account>/<organization>/<site>" (list_workspaces shows them). It can act in: ${list()}.`,
      };
    }
  } else {
    const ref = parseWorkspace(raw);
    if (!ref) {
      return { kind: "refused", message: `"${raw}" isn't a workspace. Use "<account>/<organization>/<site>", e.g. one list_workspaces returns.` };
    }
    const orgMatch = (c: (typeof choices)[number]) => c.org.slug === ref.organization || c.org.id === ref.organization;
    const matches = choices.filter((c) => orgMatch(c) && (!ref.account || c.email.toLowerCase() === ref.account));
    if (matches.length === 0) {
      return {
        kind: "refused",
        message: `This connection can't reach "${raw}"${ref.account && !accounts.some((a) => a.email.toLowerCase() === ref.account) ? ` (${ref.account} isn't one of its accounts; add it by reconnecting and choosing "Add another account")` : ""}. It can act in: ${list()}.`,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "refused",
        message: `More than one of this connection's accounts belongs to "${ref.organization}". Name the account: ${matches.map((m) => formatWorkspace(m.email, m.org.slug)).join(" or ")}.`,
      };
    }
    pick = matches[0];
    site = ref.site;
  }

  const actor = await loadActor({ id: pick.userId }, { forceOrganizationId: pick.org.id });
  if (!actor || actor.organizationId !== pick.org.id) {
    return { kind: "refused", message: `${pick.email} is no longer a member of ${pick.org.name}.` };
  }
  if (site && !(await orgSiteSlugs(tenantDb(pick.org.id), [])).includes(site)) {
    return { kind: "refused", message: `${pick.org.name} has no site "${site}". list_workspaces shows its sites.` };
  }
  return { kind: "ok", actor, organizationId: pick.org.id, site };
}
