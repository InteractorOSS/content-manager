import { NextResponse, type NextRequest } from "next/server";
import { requireActor } from "@/lib/guard";
import { tenantDb } from "@/lib/tenant-db";
import { orgSiteSlugs } from "@/lib/sites-server";
import { parseTokenSiteScopes } from "@/lib/token-site-scope";
import { publicOrigin, withParams } from "@/lib/oauth/protocol";
import { existingConnectionAccounts, issueAuthorizationCode } from "@/lib/oauth/server";
import {
  AUTHORIZE_PARAM_NAMES,
  errorRedirect,
  readAuthorizeParams,
  validateAuthorizeRequest,
} from "@/lib/oauth/authorize";
import {
  LINKED_ACCOUNTS_COOKIE,
  LINKED_ACCOUNTS_TTL_MS,
  accountsWith,
  decodeLinkedAccounts,
  encodeLinkedAccounts,
} from "@/lib/oauth/linked-accounts";
import { oidcEnabled } from "@/lib/auth";

/**
 * The consent form's submit target (/oauth/authorize). Session-only: the
 * signed-in member is who the connection acts as. Every hidden field is
 * re-validated here; the form is a convenience, not a source of truth.
 */
export async function POST(req: NextRequest) {
  // CSRF: the session cookie is SameSite=Lax, which already keeps it off a
  // cross-site POST; checking Origin as well costs nothing.
  const origin = req.headers.get("origin");
  if (origin && origin !== publicOrigin() && origin !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  const { actor, error } = await requireActor();
  if (error) return error;

  const form = await req.formData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : null;
  };
  const validation = await validateAuthorizeRequest(readAuthorizeParams(field));
  if (validation.kind === "fatal") {
    return NextResponse.json({ error: validation.message }, { status: 400 });
  }
  if (validation.kind === "redirect") return NextResponse.redirect(validation.url, 303);

  const { client, redirectUri, codeChallenge, params } = validation;
  const deny = (err: string, desc?: string) =>
    NextResponse.redirect(errorRedirect(redirectUri, params.state, err, desc), 303);

  const decision = field("decision");
  const request = { client_id: client.client_id, code_challenge: codeChallenge };
  const earlier = decodeLinkedAccounts(req.cookies.get(LINKED_ACCOUNTS_COOKIE)?.value, request);
  const secure = publicOrigin().startsWith("https:");

  // "Add another account": remember who has approved so far, sign this
  // browser out of the CMS, and send it to sign in as the next account, back
  // to this same consent page. Interactor's sign-in page always asks who you
  // are, so the next account is the person's choice, not the last session's.
  if (decision === "add_account") {
    const back = new URLSearchParams();
    for (const name of AUTHORIZE_PARAM_NAMES) {
      const v = params[name];
      if (v !== null) back.set(name, v);
    }
    const callback = `/oauth/authorize?${back.toString()}`;
    const res = NextResponse.redirect(
      new URL(
        oidcEnabled ? `/auth/sso?callbackUrl=${encodeURIComponent(callback)}` : `/login?callbackUrl=${encodeURIComponent(callback)}`,
        publicOrigin()
      ),
      303
    );
    res.cookies.set(LINKED_ACCOUNTS_COOKIE, encodeLinkedAccounts(accountsWith(earlier, actor.user.id), request), {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: Math.floor(LINKED_ACCOUNTS_TTL_MS / 1000),
    });
    for (const c of req.cookies.getAll()) {
      // Expire it with the same attributes it was set with: a browser ignores
      // a __Secure- cookie written without Secure, so a bare delete left the
      // old session in place.
      if (/^(__Secure-)?authjs\.session-token(\.\d+)?$/.test(c.name)) {
        res.cookies.set(c.name, "", { maxAge: 0, path: "/", httpOnly: true, sameSite: "lax", secure: secure || c.name.startsWith("__Secure-") });
      }
    }
    return res;
  }

  if (decision !== "allow") return deny("access_denied", "The user declined.");

  // "All my organizations": a workspace connection covering every account
  // that approved during this authorization (src/lib/workspaces.ts).
  // An app that already has a workspace connection only ever adds to it
  // (the page offers nothing else): a one-organization sign-in would replace
  // it in Claude and drop its other accounts.
  const hasWorkspaceConnection = (await existingConnectionAccounts(client.id)).length > 0;
  if (field("reach") === "all" || hasWorkspaceConnection) {
    const accounts = accountsWith(earlier, actor.user.id);
    const code = await issueAuthorizationCode({
      clientDbId: client.id,
      userId: accounts[0],
      organizationId: null,
      allOrganizations: true,
      linkedUserIds: accounts.slice(1),
      siteScopes: [],
      redirectUri,
      codeChallenge,
      scope: params.scope,
    });
    const res = NextResponse.redirect(
      withParams(redirectUri, { code, state: params.state ?? undefined, iss: publicOrigin() }),
      303
    );
    res.cookies.delete(LINKED_ACCOUNTS_COOKIE);
    return res;
  }

  const organizationId = field("organization_id");
  if (!organizationId || !actor.organizations.some((o) => o.id === organizationId)) {
    return deny("access_denied", "Not a member of that organization.");
  }

  const requestedSites = form.getAll("site").filter((v): v is string => typeof v === "string");
  const { scopes, error: scopeError } = parseTokenSiteScopes(
    requestedSites.length > 0 ? requestedSites : undefined,
    await orgSiteSlugs(tenantDb(organizationId))
  );
  if (scopeError) return deny("invalid_request", scopeError);

  const code = await issueAuthorizationCode({
    clientDbId: client.id,
    userId: actor.user.id,
    organizationId,
    siteScopes: scopes ?? [],
    redirectUri,
    codeChallenge,
    scope: params.scope,
  });

  return NextResponse.redirect(
    withParams(redirectUri, { code, state: params.state ?? undefined, iss: publicOrigin() }),
    303
  );
}
