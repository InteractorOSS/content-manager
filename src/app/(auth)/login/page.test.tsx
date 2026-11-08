// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { signIn } from "next-auth/react";
import {
  ACCOUNT_SETUP_ERROR_CODE,
  AUTH_ERROR_CODES,
  SSO_NO_EMAIL_ERROR_CODE,
  describeAuthError,
} from "@/lib/auth-errors";
import { shouldBounceToSso } from "@/lib/sso-redirect";

const searchParams = { value: new URLSearchParams() };

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams.value,
}));

vi.mock("next-auth/react", () => ({
  // Resolves with the interactor provider so the SSO button renders.
  getProviders: () => Promise.resolve({ interactor: { id: "interactor" } }),
  signIn: vi.fn(),
}));

const { default: LoginPage } = await import("./page");

function renderWithError(code?: string) {
  searchParams.value = new URLSearchParams(code ? { error: code } : {});
  return render(<LoginPage />);
}

afterEach(() => {
  cleanup();
  searchParams.value = new URLSearchParams();
});

describe("login page ?error= handling", () => {
  it("shows nothing alarming on a clean visit", () => {
    renderWithError();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("surfaces a Configuration failure in plain language", () => {
    renderWithError("Configuration");
    const alert = screen.getByRole("alert");
    const message = describeAuthError("Configuration")!;
    expect(alert.textContent).toContain(message.title);
    expect(alert.textContent).toContain(message.detail);
    expect(alert.textContent).toContain(message.action);
    // The raw code never reaches the page.
    expect(alert.textContent).not.toContain("Configuration");
  });

  it("surfaces an OAuthCallback failure in plain language", () => {
    renderWithError("OAuthCallback");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      describeAuthError("OAuthCallback")!.title
    );
    expect(alert.textContent).not.toContain("OAuthCallback");
  });

  it("tells a user whose account setup failed that sign-in itself worked", () => {
    // Emitted by callbacks.signIn (src/lib/auth-callbacks.ts) when the
    // database work behind sign-in fails. Before this code existed the same
    // failure arrived as "Configuration" and was indistinguishable from a
    // genuinely misconfigured SSO provider.
    renderWithError(ACCOUNT_SETUP_ERROR_CODE);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/signed you in/i);
    expect(alert.textContent).toMatch(/administrator/i);
    expect(alert.textContent).not.toContain(ACCOUNT_SETUP_ERROR_CODE);
  });

  it("tells a user with no email claim what to fix", () => {
    renderWithError(SSO_NO_EMAIL_ERROR_CODE);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/no email address/i);
    expect(alert.textContent).not.toContain(SSO_NO_EMAIL_ERROR_CODE);
  });

  it("renders a message for every code, and for an unknown one", () => {
    for (const code of [...AUTH_ERROR_CODES, "TotallyUnknownCode"]) {
      renderWithError(code);
      const alert = screen.getByRole("alert");
      expect(alert.textContent, code).toContain(describeAuthError(code)!.title);
      expect(alert.textContent, code).not.toContain(code);
      cleanup();
    }
  });

  it("always leaves a way into the app after a failure", async () => {
    renderWithError("Configuration");
    // The password form is the escape hatch when SSO is the thing that broke.
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    // ...and SSO can be retried once the provider list loads.
    expect(
      await screen.findByRole("button", { name: "Try Interactor SSO again" })
    ).toBeTruthy();
  });

  it("offers SSO as a first step, not a retry, without an error", async () => {
    renderWithError();
    expect(
      await screen.findByRole("button", { name: "Sign in with Interactor SSO" })
    ).toBeTruthy();
  });

  it("does not send its own links back into the SSO the user is escaping", () => {
    // Both destinations are local auth pages, so on an interactor.com host a
    // bare href would be bounced into /auth/sso by the middleware — dropping
    // the error context and, when SSO is the broken thing, looping until the
    // guard trips. The links must carry the escape param.
    renderWithError("Configuration");

    for (const name of ["Forgot password?", "Create one"]) {
      const href = screen.getByRole("link", { name }).getAttribute("href")!;
      const url = new URL(href, "https://cms.interactor.com");
      expect(
        shouldBounceToSso({
          pathname: url.pathname,
          searchParams: url.searchParams,
          oidcEnabled: true,
          isInteractorDomain: true,
        }),
        name
      ).toBe(false);
    }
  });
});

describe("email + password submit failures", () => {
  const signInMock = vi.mocked(signIn);

  beforeEach(() => {
    signInMock.mockReset();
  });

  function submitCredentials() {
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "someone@interactor.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("still says the password was wrong when it was", async () => {
    signInMock.mockResolvedValue({
      error: "CredentialsSignin",
      code: "credentials",
      status: 401,
      ok: false,
      url: null,
    } as never);

    renderWithError();
    submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      describeAuthError("CredentialsSignin")!.title
    );
  });

  it("reports a failed account setup as ours to fix, not a wrong password", async () => {
    // callbacks.signIn runs for the credentials provider too, and answers a
    // provisioning/org-resolution failure with
    // /login?error=AccountSetupIncomplete; next-auth/react parses that back
    // into result.error when the page submits with redirect:false. Blaming the
    // user's password here would repeat — on the ?sso=off escape-hatch path,
    // the one people are told to use when SSO is down — exactly the
    // misdiagnosis of our own database failure this goal exists to remove.
    signInMock.mockResolvedValue({
      error: ACCOUNT_SETUP_ERROR_CODE,
      code: undefined,
      status: 200,
      ok: true,
      url: null,
    } as never);

    renderWithError();
    submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      describeAuthError(ACCOUNT_SETUP_ERROR_CODE)!.title
    );
    expect(alert.textContent).not.toMatch(/didn't match/i);
    expect(alert.textContent).not.toContain(ACCOUNT_SETUP_ERROR_CODE);
  });

  it("explains an SSO account with no email even on the password form", async () => {
    signInMock.mockResolvedValue({
      error: SSO_NO_EMAIL_ERROR_CODE,
      status: 200,
      ok: true,
      url: null,
    } as never);

    renderWithError();
    submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no email address/i);
    expect(alert.textContent).not.toContain(SSO_NO_EMAIL_ERROR_CODE);
  });

  it("keeps the MFA hint ahead of the generic code mapping", async () => {
    // A real MFA account comes back as CredentialsSignin with code=mfa_required;
    // the code is the more specific signal, so it must still win.
    signInMock.mockResolvedValue({
      error: "CredentialsSignin",
      code: "mfa_required",
      status: 401,
      ok: false,
      url: null,
    } as never);

    renderWithError();
    submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/multi-factor/i);
  });

  it("falls back to the sign-in message when nothing comes back at all", async () => {
    signInMock.mockResolvedValue(undefined as never);

    renderWithError();
    submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      describeAuthError("CredentialsSignin")!.title
    );
  });

  it("replaces a stale ?error= banner with what this attempt returned", async () => {
    signInMock.mockResolvedValue({
      error: ACCOUNT_SETUP_ERROR_CODE,
      status: 200,
      ok: true,
      url: null,
    } as never);

    renderWithError("Configuration");
    expect(screen.getByRole("alert").textContent).toContain(
      describeAuthError("Configuration")!.title
    );

    submitCredentials();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        describeAuthError(ACCOUNT_SETUP_ERROR_CODE)!.title
      )
    );
  });
});
