import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth, oidcEnabled } from "@/lib/auth";
import { loadActor } from "@/lib/rbac";
import { tenantDb } from "@/lib/tenant-db";
import { orgSites } from "@/lib/sites-server";
import {
  AUTHORIZE_PARAM_NAMES,
  readAuthorizeParams,
  validateAuthorizeRequest,
} from "@/lib/oauth/authorize";
import { ConsentForm, ConsentShell } from "./consent-form";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { LINKED_ACCOUNTS_COOKIE, accountsWith, decodeLinkedAccounts } from "@/lib/oauth/linked-accounts";
import { existingConnectionAccounts } from "@/lib/oauth/server";

export const metadata: Metadata = { title: "Connect an app · Interactor CMS" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * OAuth consent page for the MCP connector. Signing in here is the ordinary
 * CMS sign-in (Interactor SSO where configured), after which the member picks
 * which organization — and optionally which sites — the app may act on.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const params = readAuthorizeParams((name) => {
    const v = sp[name];
    return Array.isArray(v) ? v[0] : v;
  });

  const validation = await validateAuthorizeRequest(params);
  if (validation.kind === "fatal") {
    return (
      <ConsentShell>
        <p className="text-sm text-slate-200">{validation.message}</p>
      </ConsentShell>
    );
  }
  if (validation.kind === "redirect") redirect(validation.url);

  const session = await auth();
  if (!session?.user || session.error) {
    const query = new URLSearchParams();
    for (const name of AUTHORIZE_PARAM_NAMES) {
      const v = params[name];
      if (v !== null) query.set(name, v);
    }
    const back = `/oauth/authorize?${query.toString()}`;
    redirect(
      oidcEnabled
        ? `/auth/sso?callbackUrl=${encodeURIComponent(back)}`
        : `/login?callbackUrl=${encodeURIComponent(back)}`
    );
  }

  const actor = await loadActor(session.user);
  if (!actor || actor.organizations.length === 0) {
    return (
      <ConsentShell>
        <p className="text-sm text-slate-200">
          Your account isn&apos;t a member of any organization yet, so there is nothing to connect{" "}
          {validation.client.client_name} to. Ask an admin for an invitation, then try again.
        </p>
      </ConsentShell>
    );
  }

  const organizations = await Promise.all(
    actor.organizations.map(async (org) => ({
      id: org.id,
      name: org.name,
      role: org.role,
      sites: (await orgSites(tenantDb(org.id))).map((s) => ({ slug: s.slug, name: s.name })),
    }))
  );

  // Accounts already added to this connection ("Add another account"), then
  // the one signed in now.
  const earlier = decodeLinkedAccounts((await cookies()).get(LINKED_ACCOUNTS_COOKIE)?.value, {
    client_id: validation.client.client_id,
    code_challenge: validation.codeChallenge,
  });
  // Accounts already on this app's connection from earlier sign-ins: this
  // sign-in adds to them (src/lib/oauth/server.ts, existingConnectionAccounts).
  const kept = await existingConnectionAccounts(validation.client.id);
  const ids = [...kept.filter((id) => id !== actor.user.id && !earlier.includes(id)), ...accountsWith(earlier, actor.user.id)];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  const accounts = ids.flatMap((id) =>
    users
      .filter((u) => u.id === id)
      .map((u) => ({ email: u.email, current: u.id === actor.user.id, kept: kept.includes(id) && u.id !== actor.user.id }))
  );

  return (
    <ConsentShell>
      <ConsentForm
        accounts={accounts}
        clientName={validation.client.client_name}
        redirectHost={new URL(validation.redirectUri).host}
        userEmail={actor.user.email}
        organizations={organizations}
        defaultOrganizationId={actor.organizationId ?? organizations[0].id}
        params={validation.params}
      />
    </ConsentShell>
  );
}
