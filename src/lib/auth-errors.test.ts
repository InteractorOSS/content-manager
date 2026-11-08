import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SETUP_ERROR_CODE,
  AUTH_ERROR_CODES,
  SSO_LOOP_ERROR_CODE,
  SSO_NO_EMAIL_ERROR_CODE,
  describeAuthError,
} from "./auth-errors";

describe("describeAuthError", () => {
  it("returns nothing when there is no error to show", () => {
    expect(describeAuthError(null)).toBeNull();
    expect(describeAuthError(undefined)).toBeNull();
    expect(describeAuthError("")).toBeNull();
    expect(describeAuthError("   ")).toBeNull();
  });

  it("covers every code the CMS can emit", () => {
    // The set NextAuth/Auth.js can put on pages.error for this app, plus our
    // own loop-guard code. A new code added to the map must stay covered here.
    expect(new Set(AUTH_ERROR_CODES)).toEqual(
      new Set([
        "Configuration",
        "OAuthSignin",
        "OAuthCallback",
        // Auth.js's own client-safe spelling, raised when the hand-back from
        // Interactor is malformed (state/PKCE mismatch, provider `error=`).
        "OAuthCallbackError",
        "OAuthAccountNotLinked",
        "AccessDenied",
        "Verification",
        "CredentialsSignin",
        "SessionRequired",
        "MissingCSRF",
        "RefreshAccessTokenError",
        SSO_LOOP_ERROR_CODE,
        SSO_NO_EMAIL_ERROR_CODE,
        ACCOUNT_SETUP_ERROR_CODE,
      ])
    );
  });

  it("gives every code a title, a detail and a next action", () => {
    for (const code of AUTH_ERROR_CODES) {
      const message = describeAuthError(code);
      expect(message, code).not.toBeNull();
      expect(message!.title.length, code).toBeGreaterThan(0);
      expect(message!.detail.length, code).toBeGreaterThan(0);
      expect(message!.action.length, code).toBeGreaterThan(0);
    }
  });

  it("never leaks the raw code back to the user", () => {
    for (const code of AUTH_ERROR_CODES) {
      const { title, detail, action } = describeAuthError(code)!;
      expect(`${title} ${detail} ${action}`, code).not.toContain(code);
    }
  });

  it("words Configuration as 'we couldn't finish', not 'the server is broken'", () => {
    const message = describeAuthError("Configuration")!;
    // Auth.js uses Configuration as a catch-all for any non-client-safe throw
    // — including plain "that action must be a POST" — so it must not accuse
    // the deployment of being misconfigured.
    const text = `${message.title} ${message.detail} ${message.action}`;
    expect(text).not.toMatch(/misconfigur|server error|status/i);
    expect(text).toMatch(/sign-in/i);
    // Always a way forward: retry, the password form, or a human.
    expect(text).toMatch(/administrator/i);
    expect(text).toMatch(/password/i);
  });

  it("explains an OAuthCallback failure as the handover not finishing", () => {
    const message = describeAuthError("OAuthCallback")!;
    expect(message.title).toMatch(/interactor/i);
    expect(message.detail).toMatch(/nothing was changed/i);
    expect(message.action).toMatch(/try interactor sso again/i);
  });

  it("distinguishes a failed account setup from a broken provider", () => {
    // The whole point of this code: the callback leg used to collapse a
    // database failure into "Configuration", which reads as "the SSO provider
    // is misconfigured" and is what sent the original diagnosis astray.
    const message = describeAuthError(ACCOUNT_SETUP_ERROR_CODE)!;
    expect(message.title).toMatch(/signed you in/i);
    expect(message.action).toMatch(/administrator/i);
    // It is our fault, not theirs — don't send them round the SSO loop again.
    expect(message.action).not.toMatch(/interactor sso/i);
  });

  it("tells a user with no email claim what to fix on their side", () => {
    const message = describeAuthError(SSO_NO_EMAIL_ERROR_CODE)!;
    expect(message.detail).toMatch(/email address/i);
    expect(message.action).toMatch(/add an email address/i);
    expect(message.action).toMatch(/password/i);
  });

  it("gives both CMS-emitted codes a human to escalate to", () => {
    // Neither of these is something the user can always resolve alone: a
    // managed Interactor identity may not let them add an email at all, and a
    // half-finished account setup is ours to fix. Each action names the CMS
    // administrator so nobody is left with only steps that can't work.
    for (const code of [SSO_NO_EMAIL_ERROR_CODE, ACCOUNT_SETUP_ERROR_CODE]) {
      expect(describeAuthError(code)!.action, code).toMatch(/administrator/i);
    }
  });

  it("reassures on codes where the user may fear losing work", () => {
    for (const code of [
      "Configuration",
      "OAuthCallback",
      "RefreshAccessTokenError",
      SSO_NO_EMAIL_ERROR_CODE,
      ACCOUNT_SETUP_ERROR_CODE,
    ]) {
      const { detail } = describeAuthError(code)!;
      expect(detail, code).toMatch(/nothing was changed|is safe|untouched/i);
    }
  });

  it("falls back to an actionable message for an unrecognised code", () => {
    const message = describeAuthError("SomethingBrandNew")!;
    expect(message.title).toBe("We couldn't sign you in");
    expect(message.action).toMatch(/password/i);
    expect(`${message.title} ${message.detail} ${message.action}`).not.toContain(
      "SomethingBrandNew"
    );
  });
});
