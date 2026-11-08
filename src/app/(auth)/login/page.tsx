"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn, getProviders } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { describeAuthError, type AuthErrorMessage } from "@/lib/auth-errors";
import { localAuthHref, safeCallbackPath } from "@/lib/sso-redirect";

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary for prerendering
  // (same pattern as src/app/(auth)/password/page.tsx).
  return (
    <Suspense fallback={<LoginPageShell />}>
      <LoginPageInner />
    </Suspense>
  );
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900";

function LoginPageInner() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // undefined = the form hasn't been submitted yet, so the ?error= from the
  // URL is still the thing worth showing. null = submitted, nothing wrong.
  const [formAlert, setFormAlert] = useState<AuthErrorMessage | null | undefined>(
    undefined
  );
  const [loading, setLoading] = useState(false);
  const [ssoAvailable, setSsoAvailable] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);

  // NextAuth redirects every auth failure to pages.error, which is this page.
  // Translating the code here is what stops SSO failures being silent.
  const urlAlert = describeAuthError(searchParams.get("error"));
  const alert = formAlert !== undefined ? formAlert : urlAlert;
  const hadSsoFailure = !!urlAlert;
  // Where to land after signing in — the OAuth consent page passes itself
  // here; anything not a same-origin path falls back to the dashboard.
  const callbackUrl = safeCallbackPath(searchParams.get("callbackUrl")) ?? "/dashboard";

  useEffect(() => {
    getProviders().then((providers) => {
      if (providers?.interactor) setSsoAvailable(true);
    });
  }, []);

  async function handleSSO() {
    setSsoLoading(true);
    await signIn("interactor", { callbackUrl });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormAlert(null);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (!result || result.error) {
      setFormAlert(
        result?.code === "mfa_required"
          ? {
              title: "This account needs multi-factor authentication",
              detail:
                "The email and password form can't complete the second step yet.",
              action: ssoAvailable
                ? "Use \"Sign in with Interactor SSO\" above — it handles the extra step for you."
                : "Sign in at auth.interactor.com, or contact a CMS administrator.",
            }
          : // Translate whatever code came back rather than assuming the
            // password was wrong. callbacks.signIn runs for the credentials
            // provider too and can answer with AccountSetupIncomplete, so a
            // database outage on this path — the documented ?sso=off escape
            // when SSO is down — must not be reported as a bad password. A
            // genuine bad password still arrives as CredentialsSignin and
            // reads exactly as before.
            describeAuthError(result?.error) ??
            (describeAuthError("CredentialsSignin") as AuthErrorMessage)
      );
      return;
    }

    // Full-page navigation so the browser sends a fresh request with the
    // new session cookie — avoids RSC navigation racing the cookie commit.
    window.location.href = callbackUrl;
  }

  return (
    <LoginPageShell>
      {alert && <AuthAlert message={alert} />}

      {ssoAvailable && (
        <>
          <button
            type="button"
            onClick={handleSSO}
            disabled={ssoLoading || loading}
            className={`w-full min-h-11 flex items-center justify-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 transition-colors mb-4 ${FOCUS_RING}`}
          >
            {ssoLoading && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            )}
            {ssoLoading
              ? "Connecting to Interactor…"
              : hadSsoFailure
                ? "Try Interactor SSO again"
                : "Sign in with Interactor SSO"}
          </button>
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-slate-700" />
            <span className="text-xs text-slate-500">or continue with email</span>
            <div className="h-px flex-1 bg-slate-700" />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-slate-300 mb-1.5"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="w-full min-h-11 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <div className="flex justify-between items-center gap-3 mb-1.5">
            <label
              htmlFor="password"
              className="block text-sm font-medium text-slate-300"
            >
              Password
            </label>
            {/*
              localAuthHref, not a bare "/password": on an interactor.com host
              the middleware bounces a plain local auth URL into SSO, so this
              link would throw the user back into the very thing they are
              trying to get around. See src/lib/sso-redirect.ts.
            */}
            <Link
              href={localAuthHref("/password")}
              className={`inline-flex min-h-11 items-center rounded px-1 text-xs text-blue-400 hover:text-blue-300 transition-colors ${FOCUS_RING}`}
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="w-full min-h-11 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className={`w-full min-h-11 flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 transition-colors ${FOCUS_RING}`}
        >
          {loading && (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        Don&apos;t have an account?{" "}
        <Link
          href={localAuthHref("/register")}
          className={`inline-flex min-h-11 items-center rounded px-1 text-blue-400 hover:text-blue-300 transition-colors ${FOCUS_RING}`}
        >
          Create one
        </Link>
      </p>
    </LoginPageShell>
  );
}

/**
 * Plain-language sign-in problem, in the page's existing red banner styling.
 * role="alert" announces it to screen readers, and the icon means colour
 * isn't the only thing marking it as a problem.
 */
function AuthAlert({ message }: { message: AuthErrorMessage }) {
  return (
    <div
      role="alert"
      className="mb-4 flex gap-3 rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-200"
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-red-400 mt-0.5" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold text-red-100">{message.title}</p>
        <p className="text-red-200/90">{message.detail}</p>
        <p className="text-red-200/90">{message.action}</p>
      </div>
    </div>
  );
}

function LoginPageShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500 mb-4 shadow-lg">
            <span className="text-white font-bold text-2xl">I</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Interactor CMS</h1>
          <p className="text-slate-400 text-sm mt-1">Sign in to your account</p>
        </div>
        {children}
      </div>
    </div>
  );
}
