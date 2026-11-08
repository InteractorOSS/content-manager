"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { localAuthHref } from "@/lib/sso-redirect";
import { Loader2, CheckCircle } from "lucide-react";

export default function PasswordPage() {
  // useSearchParams requires a Suspense boundary for prerendering.
  return (
    <Suspense>
      <PasswordPageInner />
    </Suspense>
  );
}

function PasswordPageInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  return token ? (
    <ResetForm token={token} />
  ) : (
    <RequestForm />
  );
}

function RequestForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request", email }),
    });

    setLoading(false);

    if (res.ok) {
      setDone(true);
    } else {
      setError("Something went wrong. Please try again.");
    }
  }

  if (done) {
    return (
      <AuthShell>
        <CheckCircle className="h-12 w-12 text-green-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white mb-2 text-center">Check your email</h2>
        <p className="text-slate-400 text-sm text-center mb-6">
          If an account exists for <span className="text-white">{email}</span>,
          we sent a link to reset your password.
        </p>
        <Link
          href={localAuthHref("/login")}
          className="block text-center text-blue-400 hover:text-blue-300 text-sm transition-colors"
        >
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we'll send a reset link">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

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
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="you@example.com"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2.5 transition-colors"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Sending…" : "Send reset link"}
        </button>

        <p className="text-center text-sm text-slate-400">
          <Link href={localAuthHref("/login")} className="text-blue-400 hover:text-blue-300 transition-colors">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    setError("");

    const res = await fetch("/api/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset", token, password }),
    });

    setLoading(false);

    if (res.ok) {
      setDone(true);
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Invalid or expired reset link. Please request a new one.");
    }
  }

  if (done) {
    return (
      <AuthShell>
        <CheckCircle className="h-12 w-12 text-green-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white mb-2 text-center">Password updated</h2>
        <p className="text-slate-400 text-sm text-center mb-6">
          Your password has been reset. You can now sign in.
        </p>
        <Link
          href={localAuthHref("/login")}
          className="block text-center text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 transition-colors"
        >
          Sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set new password" subtitle="Enter your new password below">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-slate-300 mb-1.5"
          >
            New password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="At least 8 characters"
          />
        </div>

        <div>
          <label
            htmlFor="confirm"
            className="block text-sm font-medium text-slate-300 mb-1.5"
          >
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2.5 transition-colors"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Updating…" : "Update password"}
        </button>
      </form>
    </AuthShell>
  );
}

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500 mb-4 shadow-lg">
            <span className="text-white font-bold text-2xl">I</span>
          </div>
          {title && <h1 className="text-2xl font-bold text-white">{title}</h1>}
          {subtitle && (
            <p className="text-slate-400 text-sm mt-1 text-center">{subtitle}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
