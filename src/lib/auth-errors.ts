/**
 * Plain-language messages for the `?error=` codes NextAuth (Auth.js v5) can
 * put on `pages.error` — which for this app is `/login` (see src/lib/auth.ts).
 *
 * Deliberately pure: no React, no next/* imports, so it unit-tests under the
 * repo's node-environment vitest and can be read from a route handler,
 * middleware, or a client component alike.
 *
 * House style (org design guide): say what happened, reassure that the user's
 * work is safe, and name the next action. Never surface the raw code or an
 * HTTP status — those go in the URL and the server logs, not the page.
 */

export interface AuthErrorMessage {
  /** Short headline for the alert. */
  title: string;
  /** One or two sentences: what happened, and that nothing was lost. */
  detail: string;
  /** The concrete next step the user can take right now. */
  action: string;
}

/** Codes the CMS itself emits, on top of the Auth.js set. */
export const SSO_LOOP_ERROR_CODE = "SsoUnavailable";

/**
 * The identity provider authenticated the user but sent no email claim, so
 * there is nothing to match a CMS account on (src/lib/auth-callbacks.ts).
 */
export const SSO_NO_EMAIL_ERROR_CODE = "SsoAccountHasNoEmail";

/**
 * Sign-in itself succeeded, but linking the identity to a local user row or
 * resolving their organization failed — typically the database being
 * unreachable. Without this code the same failure surfaced as the catch-all
 * "Configuration", which reads as "the provider is misconfigured" and sent
 * this bug's original diagnosis down the wrong path.
 */
export const ACCOUNT_SETUP_ERROR_CODE = "AccountSetupIncomplete";

const RETRY_OR_PASSWORD =
  "Try Interactor SSO again, or sign in with your email and password below.";

const MESSAGES: Record<string, AuthErrorMessage> = {
  // Auth.js's catch-all: anything thrown server-side that isn't on its
  // client-safe list lands here, including plain "this action must be a POST".
  // So word it as "we couldn't finish", not "the server is misconfigured".
  Configuration: {
    title: "We couldn't complete sign-in",
    detail:
      "Something went wrong while we were setting up your session. Nothing was changed on your account.",
    action: `${RETRY_OR_PASSWORD} If it keeps happening, contact a CMS administrator.`,
  },
  OAuthSignin: {
    title: "We couldn't start Interactor SSO",
    detail:
      "We weren't able to hand you over to Interactor to sign in. Your account is untouched.",
    action: RETRY_OR_PASSWORD,
  },
  OAuthCallback: {
    title: "Interactor sign-in didn't finish",
    detail:
      "You signed in with Interactor, but we couldn't finish the handover back to the CMS. Nothing was changed on your account.",
    action: `${RETRY_OR_PASSWORD} If it keeps happening, contact a CMS administrator.`,
  },
  // Distinct from `OAuthCallback` above: this is Auth.js's own client-safe
  // type (its `clientErrors` list spells it with the suffix), raised when the
  // callback itself is malformed — Interactor answered with an `error=` param,
  // or the state/PKCE cookie didn't match the one we sent.
  OAuthCallbackError: {
    title: "Interactor sign-in didn't finish",
    detail:
      "The hand-back from Interactor didn't check out, which usually means the sign-in was left open too long or was started in another tab. Nothing was changed on your account.",
    action: `Start again from this page. ${RETRY_OR_PASSWORD}`,
  },
  OAuthAccountNotLinked: {
    title: "That Interactor account isn't linked to this CMS account",
    detail:
      "A CMS account already uses this email address, but it was set up with a different sign-in method.",
    action:
      "Sign in with the email and password you used originally, or ask an administrator to link your Interactor account.",
  },
  AccessDenied: {
    title: "You don't have access to the CMS",
    detail:
      "Your Interactor account signed in successfully, but it isn't allowed into this CMS yet.",
    action:
      "Ask a CMS administrator to invite you or grant your account access, then sign in again.",
  },
  Verification: {
    title: "That sign-in link has expired",
    detail:
      "Sign-in links are single-use and time-limited, and this one is no longer valid. Your account is untouched.",
    action: "Request a new link, or sign in with your email and password below.",
  },
  CredentialsSignin: {
    title: "That email and password didn't match",
    detail: "We couldn't find an account with those details.",
    action:
      "Check your email address and password and try again, or use \"Forgot password?\" to reset it.",
  },
  SessionRequired: {
    title: "Please sign in to continue",
    detail: "That page is only available once you're signed in.",
    action: "Sign in below and we'll take you to your dashboard.",
  },
  MissingCSRF: {
    title: "Your sign-in attempt expired",
    detail:
      "The sign-in form sat open long enough for its security check to time out. Nothing was submitted.",
    action: "Start again from this page — Interactor SSO or email and password both work.",
  },
  RefreshAccessTokenError: {
    title: "Your session expired",
    detail:
      "We couldn't renew your session, so we signed you out. Any work you saved is safe.",
    action: "Sign in again to pick up where you left off.",
  },
  // CMS-local: Interactor authenticated the user but sent no email claim.
  [SSO_NO_EMAIL_ERROR_CODE]: {
    title: "Your Interactor account has no email address",
    detail:
      "You signed in with Interactor, but it didn't share an email address with us — and that is what we match your CMS account on. Nothing was changed on your account.",
    action:
      "Add an email address to your Interactor account and try again, or sign in with your email and password below. If your Interactor account is managed for you and you can't add one, contact a CMS administrator.",
  },
  // CMS-local: sign-in worked, the account setup behind it did not.
  [ACCOUNT_SETUP_ERROR_CODE]: {
    title: "We signed you in, but couldn't finish setting up your account",
    detail:
      "Interactor confirmed who you are, but we couldn't link that to your CMS account just now. Nothing was changed on your account.",
    action:
      "Try again in a minute. If it keeps happening, contact a CMS administrator — this one needs looking at on our side.",
  },
  // CMS-local: the middleware's SSO loop guard tripped (src/lib/sso-redirect.ts).
  [SSO_LOOP_ERROR_CODE]: {
    title: "Interactor SSO isn't completing right now",
    detail:
      "We sent you to Interactor to sign in a few times and never got a signed-in session back, so we stopped rather than keep bouncing you. Your account is untouched.",
    action:
      "Sign in with your email and password below, or try Interactor SSO once more. If neither works, contact a CMS administrator.",
  },
};

const FALLBACK: AuthErrorMessage = {
  title: "We couldn't sign you in",
  detail:
    "Something went wrong on the way into the CMS. Nothing was changed on your account.",
  action: `${RETRY_OR_PASSWORD} If it keeps happening, contact a CMS administrator.`,
};

/** Every code with a message of its own — used by the tests to stay exhaustive. */
export const AUTH_ERROR_CODES = Object.keys(MESSAGES);

/**
 * Translate a `?error=` value into something a person can act on.
 * Returns `null` when there is no error to show, so callers can render nothing.
 */
export function describeAuthError(
  code: string | null | undefined
): AuthErrorMessage | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  return MESSAGES[trimmed] ?? FALLBACK;
}
