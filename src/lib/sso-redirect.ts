/**
 * The SSO-bounce decision used by src/proxy.ts, extracted so it can be
 * unit-tested without booting Next's middleware runtime. Pure — no next/*
 * imports, no cookie jar, just values in and a decision out.
 *
 * Background: on *.interactor.com deployments the middleware sends the local
 * auth pages straight to Interactor SSO. That bounce used to be
 * unconditional, which meant NextAuth's own failure redirect (pages.error is
 * "/login") was swallowed and fed back into SSO — the user saw an endless
 * silent bounce and never a message. Two rules fix that:
 *
 *   1. Never bounce a URL that already carries an `error` param, that asks to
 *      skip SSO explicitly (`?sso=off`), or that is a deliberate deep link
 *      such as a mailed reset URL (`/password?token=...`). That is the escape
 *      hatch out of a broken SSO — without it there is no way into the app at
 *      all, not even for a super_admin who knows their password. Every link
 *      the auth pages draw between one another is built with localAuthHref(),
 *      so the escape stays sticky instead of being dropped on the next click.
 *   2. Count unauthenticated trips through /auth/sso in a short window. If SSO
 *      keeps being re-entered without a session ever being established, stop
 *      and show an explanation instead of looping. This covers failures that
 *      carry no `?error=` at all.
 */

import { SSO_LOOP_ERROR_CODE } from "@/lib/auth-errors";

/** Local auth pages that get handed to Interactor SSO on *.interactor.com. */
export const LOCAL_AUTH_PAGES = ["/login", "/register", "/password"] as const;

/** Headless SSO entry point (src/app/auth/sso/route.ts). */
export const SSO_PATH = "/auth/sso";

/** `?sso=off` on a local auth page opts out of the SSO bounce. */
export const SSO_ESCAPE_PARAM = "sso";

/** The value that spells the opt-out, so links read `?sso=off`. */
export const SSO_ESCAPE_VALUE = "off";

/**
 * The opt-out shipped first as `?password=1`. That name reads like a credential
 * in a URL — to a support engineer skimming a link, and to any log scrubber
 * matching on the word — so `?sso=off` replaced it. Links already pasted into
 * tickets or runbooks keep working.
 */
export const LEGACY_SSO_ESCAPE_PARAM = "password";

/**
 * Params marking a request as a deliberate deep link into a local auth page
 * rather than a first visit. A password-reset URL arrives by email, so no
 * amount of care with in-app links can attach the escape param to it — bounce
 * it and the reset link is simply unusable on an interactor.com host.
 */
const DEEP_LINK_PARAMS = ["token"] as const;

/** Name of the short-lived counter cookie backing the loop guard. */
export const SSO_ATTEMPT_COOKIE = "cms_sso_attempts";

/** Unauthenticated trips through /auth/sso allowed inside the window. */
export const SSO_ATTEMPT_LIMIT = 3;

/** How long the counter lives before it resets, in milliseconds. */
export const SSO_ATTEMPT_WINDOW_MS = 60_000;

/** Where a tripped loop guard sends the user. */
export const SSO_LOOP_REDIRECT = `/login?error=${SSO_LOOP_ERROR_CODE}`;

export function isLocalAuthPage(pathname: string): boolean {
  return LOCAL_AUTH_PAGES.some(
    (page) => pathname === page || pathname.startsWith(`${page}/`)
  );
}

export interface SsoBounceInput {
  pathname: string;
  searchParams: URLSearchParams;
  /** Both Interactor OIDC client env vars are configured (see auth.ts). */
  oidcEnabled: boolean;
  /** Request's client-facing host is interactor.com or a subdomain. */
  isInteractorDomain: boolean;
}

/**
 * Should this request for a local auth page be redirected into Interactor SSO?
 * False keeps the local page — which is how an error message ever gets seen.
 */
export function shouldBounceToSso({
  pathname,
  searchParams,
  oidcEnabled,
  isInteractorDomain,
}: SsoBounceInput): boolean {
  if (!oidcEnabled || !isInteractorDomain) return false;
  if (!isLocalAuthPage(pathname)) return false;
  // An error is being reported — render it instead of bouncing it away.
  if (searchParams.has("error")) return false;
  // The user explicitly asked to skip SSO.
  if (hasSsoEscape(searchParams)) return false;
  // A mailed reset link and friends are already a specific destination.
  if (DEEP_LINK_PARAMS.some((param) => searchParams.has(param))) return false;
  return true;
}

/** Does this URL ask to skip the SSO bounce, under either param name? */
export function hasSsoEscape(searchParams: URLSearchParams): boolean {
  // Any value but "on" counts, so a hand-typed ?sso=0 or bare ?sso still
  // escapes; only an explicit ?sso=on reads as "yes, send me to SSO".
  const value = searchParams.get(SSO_ESCAPE_PARAM);
  if (value !== null && value !== "on") return true;
  return searchParams.has(LEGACY_SSO_ESCAPE_PARAM);
}

/**
 * Build a link from one local auth page to another that will not be bounced
 * straight back into SSO.
 *
 * The pages link to each other constantly — "Forgot password?", "Create one",
 * "Back to sign in" — and on an interactor.com host every one of those plain
 * hrefs is a trapdoor back into the SSO the user is trying to escape. Routing
 * them all through here means the escape survives the next click, and there is
 * one place to change if the param is ever renamed again.
 */
export function localAuthHref(
  pathname: (typeof LOCAL_AUTH_PAGES)[number],
  extraParams?: Record<string, string>
): string {
  const params = new URLSearchParams({
    [SSO_ESCAPE_PARAM]: SSO_ESCAPE_VALUE,
    ...extraParams,
  });
  return `${pathname}?${params.toString()}`;
}

export interface SsoAttemptResult {
  /** Attempt number inside the current window, starting at 1. */
  count: number;
  /** Value to write back to SSO_ATTEMPT_COOKIE. */
  cookieValue: string;
  /** The limit is spent — send the user to SSO_LOOP_REDIRECT instead. */
  tripped: boolean;
}

/** Cookie payload is "<count>.<firstAttemptEpochMs>". */
function parseAttempts(
  raw: string | undefined,
  now: number
): { count: number; firstAt: number } | null {
  if (!raw) return null;
  const [countPart, firstPart] = raw.split(".");
  const count = Number(countPart);
  const firstAt = Number(firstPart);
  if (!Number.isFinite(count) || !Number.isFinite(firstAt)) return null;
  if (count < 1 || firstAt > now) return null;
  // Window elapsed — this is a fresh journey, not a loop.
  if (now - firstAt > SSO_ATTEMPT_WINDOW_MS) return null;
  return { count, firstAt };
}

/**
 * Record one unauthenticated entry into /auth/sso and report whether the loop
 * guard has tripped. Call only when there is no session; a signed-in request
 * should clear the cookie instead (see clearedSsoAttemptCookie usage in
 * proxy.ts).
 */
export function recordSsoAttempt(
  raw: string | undefined,
  now: number
): SsoAttemptResult {
  const previous = parseAttempts(raw, now);
  const firstAt = previous?.firstAt ?? now;
  const count = (previous?.count ?? 0) + 1;
  return {
    count,
    cookieValue: `${count}.${firstAt}`,
    tripped: count > SSO_ATTEMPT_LIMIT,
  };
}

/**
 * A post-sign-in destination is honoured only if it is a path on this origin.
 * "//evil.example" and "/\\evil.example" are protocol-relative to a browser,
 * so they are refused along with anything absolute — an open redirect on the
 * sign-in page would be a phishing gift.
 */
export function safeCallbackPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}
