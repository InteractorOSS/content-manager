"use client";

import Link from "next/link";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

/** What the notice offers the reader. */
export type FailureAction = "retry" | "refresh" | "signin" | "none";

/**
 * One problem, in words a reader can act on, plus the one thing to do about it.
 * Structural on purpose, so each area keeps its own vocabulary of failures
 * (`MemberFailure` in src/lib/member-errors.ts, `ChannelConnectFailure` in
 * src/lib/social/connect-errors.ts) and they all render the same way.
 */
export interface NoticeFailure {
  message: string;
  action: FailureAction;
}

/**
 * The shared failure banner.
 *
 * Both tabs of `/users` and the social channels page render every refusal
 * through here, so a failure never arrives as a bare sentence the reader can't
 * act on — and never as "Forbidden" or "HTTP 500": the wording comes from the
 * area's own error module, which is the only thing allowed to read an error.
 *
 * Shared rather than duplicated per surface: two pages failing in visibly
 * different ways is the inconsistency the second copy would introduce on its
 * first divergent edit.
 */
export function FailureNotice({
  failure,
  onRetry,
  retryLabel = "Try again",
  retryPending = false,
  retryPendingLabel,
  onRefresh,
  refreshLabel = "Reload members",
  children,
  className,
}: {
  failure: NoticeFailure;
  onRetry?: () => void;
  /** What the retry button says — name the action it re-runs. */
  retryLabel?: string;
  /**
   * The retry is running. Disables the button and shows a spinner, so a slow
   * retry doesn't read as a button that did nothing and get pressed twice.
   */
  retryPending?: boolean;
  /** What the button says while the retry runs; defaults to `retryLabel`. */
  retryPendingLabel?: string;
  onRefresh?: () => void;
  /** What the refresh button says — it reloads whichever list this sits above. */
  refreshLabel?: string;
  /**
   * A second way forward beside the main action (the channels dialog adds
   * Reconnect next to Try again). Rendered in the same row.
   */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-col gap-3 rounded-md border border-destructive/50 bg-destructive/5 p-4 sm:flex-row sm:items-start ${className ?? ""}`}
    >
      <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="flex-1 space-y-3">
        <p className="text-sm text-foreground">{failure.message}</p>
        <div className="flex flex-wrap gap-2 empty:hidden">
          {failure.action === "retry" && onRetry && (
            <Button
              variant="outline"
              className="min-h-11"
              onClick={onRetry}
              disabled={retryPending}
              aria-busy={retryPending || undefined}
            >
              {retryPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {retryPending ? (retryPendingLabel ?? retryLabel) : retryLabel}
            </Button>
          )}
          {failure.action === "refresh" && onRefresh && (
            <Button variant="outline" className="min-h-11" onClick={onRefresh}>
              {refreshLabel}
            </Button>
          )}
          {failure.action === "signin" && (
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/login">Sign in again</Link>
            </Button>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
