import { describe, expect, it } from "vitest";
import {
  LOCAL_AUTH_PAGES,
  SSO_ATTEMPT_LIMIT,
  SSO_ATTEMPT_WINDOW_MS,
  SSO_ESCAPE_PARAM,
  SSO_ESCAPE_VALUE,
  SSO_LOOP_REDIRECT,
  hasSsoEscape,
  isLocalAuthPage,
  localAuthHref,
  recordSsoAttempt,
  safeCallbackPath,
  shouldBounceToSso,
} from "./sso-redirect";
import { SSO_LOOP_ERROR_CODE, describeAuthError } from "./auth-errors";

function bounce(pathname: string, search = "", overrides = {}) {
  return shouldBounceToSso({
    pathname,
    searchParams: new URLSearchParams(search),
    oidcEnabled: true,
    isInteractorDomain: true,
    ...overrides,
  });
}

describe("isLocalAuthPage", () => {
  it("matches the local auth pages and their subpaths", () => {
    expect(isLocalAuthPage("/login")).toBe(true);
    expect(isLocalAuthPage("/register")).toBe(true);
    expect(isLocalAuthPage("/password")).toBe(true);
    expect(isLocalAuthPage("/password/reset")).toBe(true);
  });

  it("does not match unrelated paths that merely share a prefix", () => {
    expect(isLocalAuthPage("/dashboard")).toBe(false);
    expect(isLocalAuthPage("/logins-report")).toBe(false);
    expect(isLocalAuthPage("/api/auth/callback/interactor")).toBe(false);
  });
});

describe("shouldBounceToSso", () => {
  it("bounces an ordinary first visit on an interactor domain", () => {
    expect(bounce("/login")).toBe(true);
    expect(bounce("/register")).toBe(true);
    expect(bounce("/password")).toBe(true);
  });

  it("keeps the local page when the URL reports an error", () => {
    // This is the bug: NextAuth's pages.error is /login, so bouncing these
    // fed every auth failure straight back into SSO and the user saw nothing.
    expect(bounce("/login", "error=Configuration")).toBe(false);
    expect(bounce("/login", "error=OAuthCallback")).toBe(false);
    expect(bounce("/login", `error=${SSO_LOOP_ERROR_CODE}`)).toBe(false);
    // Even an empty error param stops the bounce rather than risking a loop.
    expect(bounce("/login", "error=")).toBe(false);
  });

  it("keeps the local page when the user asked to skip SSO", () => {
    expect(bounce("/login", `${SSO_ESCAPE_PARAM}=${SSO_ESCAPE_VALUE}`)).toBe(false);
    expect(bounce("/register", "sso=off")).toBe(false);
    expect(bounce("/password", "sso=off")).toBe(false);
    // Hand-typed variants still escape; only an explicit sso=on asks for SSO.
    expect(bounce("/login", "sso")).toBe(false);
    expect(bounce("/login", "sso=0")).toBe(false);
    expect(bounce("/login", "sso=on")).toBe(true);
  });

  it("still honours the legacy ?password=1 escape", () => {
    // The param was renamed away from a word that reads like a credential;
    // links already pasted into tickets and runbooks must keep working.
    expect(bounce("/login", "password=1")).toBe(false);
  });

  it("keeps a mailed password-reset deep link on the local page", () => {
    // A reset URL is generated for an email, so no in-app link builder can
    // attach the escape param to it. Bouncing it makes the reset unusable.
    expect(bounce("/password", "token=abc123")).toBe(false);
    expect(bounce("/password", "token=abc123&sso=off")).toBe(false);
  });

  it("builds in-app auth links that survive the middleware", () => {
    // The regression this guards: "Forgot password?" and "Create one" were
    // plain hrefs, so clicking either threw the user straight back into the
    // SSO they were escaping. Every link the auth pages draw goes through
    // localAuthHref, and every one of them must come back false here.
    for (const page of LOCAL_AUTH_PAGES) {
      const url = new URL(localAuthHref(page), "https://cms.interactor.com");
      expect(url.pathname, page).toBe(page);
      expect(hasSsoEscape(url.searchParams), page).toBe(true);
      expect(bounce(url.pathname, url.search), page).toBe(false);
    }
  });

  it("keeps extra params alongside the escape", () => {
    const url = new URL(
      localAuthHref("/password", { token: "abc123" }),
      "https://cms.interactor.com"
    );
    expect(url.searchParams.get("token")).toBe("abc123");
    expect(bounce(url.pathname, url.search)).toBe(false);
  });

  it("never bounces when SSO is unavailable or off an interactor domain", () => {
    expect(bounce("/login", "", { oidcEnabled: false })).toBe(false);
    expect(bounce("/login", "", { isInteractorDomain: false })).toBe(false);
  });

  it("leaves non-auth pages alone", () => {
    expect(bounce("/dashboard")).toBe(false);
    expect(bounce("/auth/sso")).toBe(false);
  });

  it("sends the loop-guard redirect somewhere that will not bounce again", () => {
    const url = new URL(SSO_LOOP_REDIRECT, "https://cms.interactor.com");
    expect(bounce(url.pathname, url.search)).toBe(false);
    // ...and to a code the login page can actually explain.
    expect(describeAuthError(url.searchParams.get("error"))).not.toBeNull();
  });
});

describe("recordSsoAttempt", () => {
  const now = 1_700_000_000_000;

  it("starts a fresh window when there is no cookie", () => {
    const first = recordSsoAttempt(undefined, now);
    expect(first.count).toBe(1);
    expect(first.tripped).toBe(false);
    expect(first.cookieValue).toBe(`1.${now}`);
  });

  it("counts up within the window, keeping the original start time", () => {
    let value: string | undefined;
    for (let i = 1; i <= SSO_ATTEMPT_LIMIT; i++) {
      const result = recordSsoAttempt(value, now + i);
      expect(result.count).toBe(i);
      expect(result.tripped).toBe(false);
      expect(result.cookieValue).toBe(`${i}.${now + 1}`);
      value = result.cookieValue;
    }

    const overLimit = recordSsoAttempt(value, now + SSO_ATTEMPT_LIMIT + 1);
    expect(overLimit.count).toBe(SSO_ATTEMPT_LIMIT + 1);
    expect(overLimit.tripped).toBe(true);
  });

  it("resets once the window has elapsed", () => {
    const stale = `${SSO_ATTEMPT_LIMIT}.${now}`;
    const later = recordSsoAttempt(stale, now + SSO_ATTEMPT_WINDOW_MS + 1);
    expect(later.count).toBe(1);
    expect(later.tripped).toBe(false);
  });

  it("treats a malformed or future-dated cookie as a fresh start", () => {
    for (const raw of ["", "junk", "abc.def", "0.0", "-3.100", `1.${now + 5000}`]) {
      const result = recordSsoAttempt(raw, now);
      expect(result.count, raw).toBe(1);
      expect(result.tripped, raw).toBe(false);
    }
  });
});

describe("safeCallbackPath", () => {
  it("keeps same-origin paths, including the OAuth consent page with its query", () => {
    expect(safeCallbackPath("/dashboard")).toBe("/dashboard");
    expect(safeCallbackPath("/oauth/authorize?client_id=x&state=y")).toBe(
      "/oauth/authorize?client_id=x&state=y"
    );
  });

  it("refuses anything that would leave the origin", () => {
    expect(safeCallbackPath("https://evil.example")).toBeNull();
    expect(safeCallbackPath("//evil.example")).toBeNull();
    expect(safeCallbackPath("/\\evil.example")).toBeNull();
    expect(safeCallbackPath("javascript:alert(1)")).toBeNull();
    expect(safeCallbackPath(null)).toBeNull();
  });
});
