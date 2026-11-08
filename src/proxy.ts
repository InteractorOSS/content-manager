import { auth, oidcEnabled } from "@/lib/auth";
import {
  SSO_ATTEMPT_COOKIE,
  SSO_ATTEMPT_WINDOW_MS,
  SSO_LOOP_REDIRECT,
  SSO_PATH,
  recordSsoAttempt,
  safeCallbackPath,
  shouldBounceToSso,
} from "@/lib/sso-redirect";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Website-facing form submissions: public for POST only; GET stays admin-gated
// (enforced again by requirePermission inside the route handlers).
const PUBLIC_FORM_POSTS = ["/api/contacts", "/api/newsletter", "/api/waitlist", "/api/feedback"];

type AuthedRequest = NextRequest & { auth: unknown };

export default auth((req: AuthedRequest) => {
  const res = handle(req);
  // A session exists, so the SSO journey finished — retire the loop counter so
  // a later sign-out doesn't start mid-count.
  if (req.auth && req.cookies.has(SSO_ATTEMPT_COOKIE)) {
    res.cookies.delete(SSO_ATTEMPT_COOKIE);
  }
  return res;
});

// Exported for src/proxy.test.ts — pure given an AuthedRequest, so it can be
// unit-tested directly without going through the `auth()` middleware wrapper.
export function handle(req: AuthedRequest): NextResponse {
  const isAuthenticated = !!req.auth;
  const pathname = req.nextUrl.pathname;
  // req.nextUrl.hostname reflects the app's own bind address under the
  // standalone server.js (always "localhost"), not the client-facing
  // hostname — read the actual proxied/raw Host header instead.
  const hostname = (
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    req.nextUrl.hostname
  ).split(":")[0];
  const isInteractorDomain =
    hostname === "interactor.com" || hostname.endsWith(".interactor.com");
  // Same caveat as the hostname above: behind the proxy req.nextUrl.protocol is
  // always "http:", so trusting it would drop Secure off the loop-guard cookie
  // on every production request. Read the forwarded scheme the same way.
  const isHttps = (
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
    req.nextUrl.protocol.replace(":", "")
  ) === "https";

  // Anyone with an Interactor account should just sign in via Account
  // Server's hosted login, not use a separate local password — skip the
  // local login/register/password UI entirely and go straight to SSO.
  // shouldBounceToSso holds back on URLs that carry an ?error= (NextAuth's
  // pages.error is /login, so bouncing those is what made SSO failures
  // silent), an explicit ?sso=off escape, or a deep link like a mailed
  // /password?token= reset URL.
  if (
    shouldBounceToSso({
      pathname,
      searchParams: req.nextUrl.searchParams,
      oidcEnabled,
      isInteractorDomain,
    })
  ) {
    // Carry a same-origin callbackUrl through (the OAuth consent page sends
    // a signed-out member here and needs to come back to it).
    const callbackUrl =
      safeCallbackPath(req.nextUrl.searchParams.get("callbackUrl")) ?? "/dashboard";
    return NextResponse.redirect(
      new URL(`/auth/sso?callbackUrl=${encodeURIComponent(callbackUrl)}`, req.url)
    );
  }

  // Loop guard: /auth/sso being re-entered without a session ever appearing
  // means the round trip is failing somewhere that reports no ?error= of its
  // own. Stop bouncing and say so, rather than spinning silently.
  if (pathname === SSO_PATH && !isAuthenticated) {
    const attempt = recordSsoAttempt(
      req.cookies.get(SSO_ATTEMPT_COOKIE)?.value,
      Date.now()
    );

    if (attempt.tripped) {
      const stop = NextResponse.redirect(new URL(SSO_LOOP_REDIRECT, req.url));
      stop.cookies.delete(SSO_ATTEMPT_COOKIE);
      return stop;
    }

    const proceed = NextResponse.next();
    proceed.cookies.set(SSO_ATTEMPT_COOKIE, attempt.cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
      path: "/",
      maxAge: Math.ceil(SSO_ATTEMPT_WINDOW_MS / 1000),
    });
    return proceed;
  }

  // Allow public auth pages and their API routes
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/password") ||
    pathname.startsWith("/auth/sso") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/register") ||
    pathname.startsWith("/api/password") ||
    pathname.startsWith("/api/public") ||
    // Interactor Core webhooks (signature-verified in the route handler)
    pathname.startsWith("/api/webhooks/interactor") ||
    // GitHub content-sync webhook — signature-verified in the route handler
    // (GitHub's own X-Hub-Signature-256, not a session; see
    // FILE-BASED-CONTENT-PLAN.md Phase 2)
    pathname.startsWith("/api/webhooks/github-content-sync") ||
    // MCP endpoint — PAT-verified in the route handler, which must answer
    // unauthenticated probes itself (401 + WWW-Authenticate challenge, so MCP
    // clients' auth discovery works) rather than the bare 401 below. It also
    // accepts a spec-legal lowercase "bearer" scheme the cms_pat_ shape check
    // beneath would miss.
    pathname.startsWith("/api/mcp") ||
    // OAuth for the MCP connector (src/lib/oauth/). Discovery metadata and
    // the token/register/revoke endpoints are public protocol endpoints that
    // authenticate the client themselves; the consent page and its submit
    // handler check the session on their own, because the page must send a
    // signed-out member to sign-in WITH a callback back to itself — the
    // generic redirect below drops it.
    pathname.startsWith("/.well-known/") ||
    pathname === "/oauth/authorize" ||
    pathname.startsWith("/api/oauth/") ||
    // Interactor Core's hosted-OAuth success redirect for a social channel.
    // This is a BROWSER navigation at the end of a provider handshake, so the
    // bare JSON 401 below would strand the reader on `{"error":...}` with the
    // channel still pending. Same precedent as /oauth/authorize: the handler
    // checks the session itself and sends a signed-out member to sign-in with
    // a callbackUrl back to this exact URL, then does its own org scoping and
    // permission check (src/lib/social/connect-callback.ts).
    pathname.startsWith("/api/social/channels/callback") ||
    // Draft preview links (G#13) — a signed, expiring token in the URL is the
    // route's own auth; it must reach the route handler for a signed-out
    // reviewer, which itself answers a bad/expired/revoked token with a
    // clean 404/410 rather than ever falling through to the post content.
    pathname.startsWith("/preview/") ||
    // Live-sync file endpoints for the Interactor CMS plugin. They never
    // read a session: each handler authenticates a one-post edit key
    // (src/lib/post-edit-keys.ts) and answers anything else with its own 401,
    // which tells the sync tool its session has ended.
    pathname.startsWith("/api/edit/") ||
    // The writer pages (/write, /write/posts). They hold no data: each reads a
    // short-lived key from the URL fragment (or asks /api/edit/session with the
    // CMS sign-in) and calls /api/edit/* with it.
    pathname === "/write" ||
    pathname.startsWith("/write/") ||
    // Public API & MCP docs site (G#23) — unauthenticated and indexable by
    // design; it has no session dependency of its own. Exact-or-child match
    // (not a bare startsWith) so a future unrelated route like /docsync or
    // /docs-internal can't fall through this allowlist by name collision.
    pathname === "/docs" ||
    pathname.startsWith("/docs/") ||
    // The CMS's own public blog (src/app/(blog), SEO-AEO-GEO-PLAN.md G#36) —
    // unauthenticated and indexable like /docs, same exact-or-child match.
    pathname === "/blog" ||
    pathname.startsWith("/blog/") ||
    pathname === "/robots.txt" ||
    // The public front page (src/app/page.tsx): sign-in, blog and docs links.
    // It used to redirect to /dashboard, which sent every signed-out visitor
    // through /login straight into the SSO bounce without ever seeing the site.
    pathname === "/"
  ) {
    return NextResponse.next();
  }

  if (req.method === "POST" && PUBLIC_FORM_POSTS.includes(pathname)) {
    return NextResponse.next();
  }

  // Personal access tokens (see FILE-BASED-CONTENT-PLAN.md Phase 1) carry no
  // session cookie, so they'd otherwise 401/redirect below before ever
  // reaching a route handler. This is a shape check only — real validation
  // (hash lookup, revocation, expiry) happens in requirePermissionApi(),
  // which still 401s a bogus or unknown token. Routes that never call
  // requirePermissionApi ignore the header entirely, so this changes
  // nothing for them.
  if (
    pathname.startsWith("/api/") &&
    req.headers.get("authorization")?.startsWith("Bearer cms_pat_")
  ) {
    return NextResponse.next();
  }

  // API calls get JSON errors, not login-page redirects; the route handlers
  // enforce fine-grained permissions on top of this session gate.
  if (!isAuthenticated && pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Unauthenticated: redirect to /login (no callbackUrl — login always goes to /dashboard)
  if (!isAuthenticated) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
