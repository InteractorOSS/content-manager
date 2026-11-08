/**
 * The Auth.js callback leg for this app — OIDC profile mapping, sign-in-time
 * provisioning, and the process logger — kept out of src/lib/auth.ts so it can
 * be unit-tested without booting `NextAuth()`.
 *
 * WHY THIS MODULE EXISTS
 *
 * Auth.js only forwards a *client-safe* error type to `pages.error`. Its
 * allow-list is CredentialsSignin / OAuthAccountNotLinked / OAuthCallbackError
 * / AccessDenied / Verification / MissingCSRF / AccountNotLinked /
 * WebAuthnVerificationError. ANYTHING else thrown anywhere on the callback leg
 * — including a Prisma outage inside our own `jwt` callback — is wrapped in
 * `CallbackRouteError`, which is NOT on that list, so `Auth()` flattens it to
 * `/login?error=Configuration`.
 *
 * That is why this goal's black-box diagnosis anchored on "the OIDC provider
 * is misconfigured": our own database failures are indistinguishable from
 * provider misconfiguration, and nothing was written to the process log to
 * tell them apart. Two fixes live here:
 *
 *   1. {@link authorizeSignIn} does the database work in `callbacks.signIn` —
 *      the one callback Auth.js lets return a redirect URL — so a provisioning
 *      or org-resolution failure lands on a code `/login` can explain instead
 *      of the catch-all "Configuration".
 *   2. {@link authLogger} writes one greppable `[cms-auth]` line for whatever
 *      still does throw, so an operator can `journalctl -u interactor-cms |
 *      grep cms-auth` and see the provider, the error type, the `?error=` code
 *      the user was redirected to, and the root-cause message and stack.
 *
 * The type and the code are separate fields on purpose: for a
 * `CallbackRouteError` the log says `type=CallbackRouteError` while the user's
 * address bar says `error=Configuration`, and an operator correlating a
 * support report to a log line needs both halves without knowing the mapping.
 */

import {
  ACCOUNT_SETUP_ERROR_CODE,
  SSO_NO_EMAIL_ERROR_CODE,
} from "@/lib/auth-errors";
import { getCurrentOrganizationId, provisionUser } from "@/lib/rbac";

/** One token in front of every auth line this app writes, so it greps cleanly. */
export const AUTH_LOG_TAG = "[cms-auth]";

/**
 * Auth.js's own `clientErrors` allow-list, mirrored as strings. Everything NOT
 * on it is flattened to "Configuration" before the redirect:
 *
 *     const type = isClientError(error) ? error.type : "Configuration"
 *     — @auth/core/index.js
 *
 * WHY A MIRROR RATHER THAN CALLING `isClientError` HERE. @auth/core does export
 * that helper from its `./errors` subpath, but it is `@internal`: it is in
 * errors.js and NOT in errors.d.ts, so there is no type to import under this
 * repo's strict TypeScript. It is also `error instanceof AuthError`-gated, and
 * this tree carries three copies of @auth/core (the hoisted 0.37.4, plus 0.41.2
 * nested under next-auth and under @auth/prisma-adapter). The errors we are
 * handed come from next-auth's nested copy, so an `instanceof` against a class
 * imported from the hoisted one answers false for every genuinely client-safe
 * error — it would report `code=Configuration` for all of them and quietly
 * destroy the distinction this module exists to draw. Comparing the type
 * STRING is copy-agnostic.
 *
 * Drift is caught in the test instead: auth-callbacks.test.ts reconstructs the
 * set from the @auth/core that next-auth actually loads, using upstream's own
 * `isClientError`, and fails if this list differs.
 */
export const CLIENT_SAFE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "CredentialsSignin",
  "OAuthAccountNotLinked",
  "OAuthCallbackError",
  "AccessDenied",
  "Verification",
  "MissingCSRF",
  "AccountNotLinked",
  "WebAuthnVerificationError",
]);

/**
 * The `?error=` value the user will actually land on for a given Auth.js error
 * type — which is NOT the type itself in the case this goal exists for. A
 * `CallbackRouteError` (anything our own callbacks throw) logs as
 * `type=CallbackRouteError` but redirects to `/login?error=Configuration`, so
 * without this the operator has to know the mapping to tie their grep hit to
 * the URL the user reported.
 */
export function clientErrorCode(type: string | null | undefined): string {
  return typeof type === "string" && CLIENT_SAFE_ERROR_TYPES.has(type)
    ? type
    : "Configuration";
}

/**
 * Write an identifiable failure line to the process log (journald on the box).
 * Deliberately one line of `key=value` pairs: the reason can be long, but the
 * provider, type and code stay scannable.
 */
export function logAuthFailure(fields: {
  /** Where on the auth leg this happened — "signIn", "provisionUser", "jwt", "authjs". */
  stage: string;
  provider?: string | null;
  /** Auth.js's internal error type, or our own code on the paths we control. */
  type?: string | null;
  /** The `?error=` value the user is redirected to. Defaults to `type`. */
  code?: string | null;
  reason?: string | null;
  stack?: string;
}) {
  const { stage, provider, type, code, reason, stack } = fields;
  console.error(
    `${AUTH_LOG_TAG} sign-in failed stage=${stage} provider=${provider || "-"} type=${
      type || "-"
    } code=${code || type || "-"} reason=${reason || "-"}`
  );
  if (stack) console.error(`${AUTH_LOG_TAG} cause:`, stack);
}

/** Logger wired into the NextAuth config so Auth.js's own throws are recorded. */
export const authLogger = {
  error(error: Error) {
    // Auth.js wraps the original throw as `cause.err` and stamps the provider
    // id into `cause.provider` (see CallbackRouteError) — that inner message
    // is the only thing that says what actually broke.
    const cause = (error.cause ?? {}) as { provider?: string; err?: unknown };
    const inner = cause.err instanceof Error ? cause.err : undefined;
    const type = (error as Error & { type?: string }).type ?? error.name;
    logAuthFailure({
      stage: "authjs",
      provider: cause.provider,
      type,
      // For a CallbackRouteError these two diverge: type=CallbackRouteError,
      // code=Configuration. The code is the half that matches the URL the user
      // is looking at when they report the problem.
      code: clientErrorCode(type),
      reason: inner?.message ?? error.message,
      stack: inner?.stack ?? error.stack,
    });
  },
  warn(code: string) {
    console.warn(`${AUTH_LOG_TAG} warn code=${code}`);
  },
};

/** What sign-in resolved out of the database, for the jwt callback to store. */
export interface ResolvedSignIn {
  localUserId: string;
  currentOrganizationId: string | null;
}

/**
 * The Auth.js `user` object plus the slot {@link authorizeSignIn} parks its
 * database work in.
 *
 * Auth.js hands the SAME user object to `callbacks.signIn` and then to
 * `callbacks.jwt` when no database Adapter is configured (this app uses the
 * JWT session strategy with no adapter), so this is the seam that lets the
 * database work live on the one callback that can redirect on failure while
 * the jwt callback stays pure.
 */
export interface SignInUser {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  cmsIdentity?: ResolvedSignIn;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** The shape the OIDC provider hands on to the rest of the sign-in. */
export interface InteractorProfileUser {
  id: string;
  name: string;
  /**
   * Null, never `undefined`, when the id_token/userinfo carried no email
   * claim. The previous `profile.email as string` cast let `undefined` travel
   * all the way into `provisionUser()`; {@link authorizeSignIn} now rejects a
   * null email with a code `/login` can explain, before any database work.
   */
  email: string | null;
}

/** Map an Interactor id_token/userinfo claim set onto an Auth.js user. */
export function mapInteractorProfile(
  profile: Record<string, unknown>
): InteractorProfileUser {
  const email = trimmed(profile.email);
  return {
    id: trimmed(profile.sub) ?? "",
    // A real name before a handle: preferred_username (and the email
    // local-part below) is how a byline ends up reading "jsmith". Those are
    // only fallbacks — the person's own User.display_name overrides all of it.
    name:
      trimmed(profile.name) ??
      trimmed(
        [trimmed(profile.given_name), trimmed(profile.family_name)].filter(Boolean).join(" ")
      ) ??
      trimmed(profile.preferred_username) ??
      email?.split("@")[0] ??
      "",
    email: email ?? null,
  };
}

/**
 * Where a sign-in failure sends the user. `/login` translates the code into
 * plain language (src/lib/auth-errors.ts), and the `?error=` param is also
 * what stops src/lib/sso-redirect.ts bouncing them straight back into SSO.
 */
export function signInFailureUrl(code: string): string {
  return `/login?error=${encodeURIComponent(code)}`;
}

/**
 * `callbacks.signIn`: validate the incoming identity, then link it to a local
 * user row and resolve its active org — the two pieces of database work that
 * used to sit in `callbacks.jwt`, where any failure could only throw and so
 * became `?error=Configuration`.
 *
 * Returns `true` to let the sign-in continue, or a `/login?error=...` URL that
 * Auth.js redirects to instead.
 */
export async function authorizeSignIn(params: {
  user: SignInUser;
  provider?: string | null;
}): Promise<true | string> {
  const { user, provider } = params;

  const email = trimmed(user.email);
  if (!email) {
    logAuthFailure({
      stage: "signIn",
      provider,
      // On the paths we control the redirect carries the code we name here, so
      // type and code agree — unlike the Auth.js path in authLogger above.
      type: SSO_NO_EMAIL_ERROR_CODE,
      code: SSO_NO_EMAIL_ERROR_CODE,
      reason:
        "the identity provider returned no email claim, so there is nothing to match a CMS account on",
    });
    return signInFailureUrl(SSO_NO_EMAIL_ERROR_CODE);
  }

  try {
    const localUserId = await provisionUser({
      externalId: user.id,
      email,
      name: user.name ?? "",
    });
    // Resolve the active org once here (after provisioning has applied any
    // pending invitation) so loadActor doesn't re-query it per request.
    const currentOrganizationId = await getCurrentOrganizationId(localUserId);
    user.cmsIdentity = { localUserId, currentOrganizationId };
  } catch (error) {
    logAuthFailure({
      stage: "provisionUser",
      provider,
      type: ACCOUNT_SETUP_ERROR_CODE,
      code: ACCOUNT_SETUP_ERROR_CODE,
      reason: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return signInFailureUrl(ACCOUNT_SETUP_ERROR_CODE);
  }

  return true;
}
