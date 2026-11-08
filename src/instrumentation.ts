/**
 * In-process scheduler: every minute, publish social posts whose scheduled
 * time has passed. Runs only in the Node.js server runtime (not edge, not
 * during build). External cron can hit POST /api/social/scheduler instead —
 * publishDuePosts() claims posts atomically, so both can coexist.
 */

const TICK_MS = 60_000;
const CONTENT_SYNC_TICK_MS = 60_000;

const globalScheduler = globalThis as unknown as {
  __socialSchedulerStarted?: boolean;
  __contentSyncSchedulerStarted?: boolean;
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The Interactor Core webhook receiver fails closed: with no signing secret
  // it refuses every delivery (503), so channel status silently stops tracking
  // expired/revoked credentials. Say so loudly at boot rather than letting an
  // operator discover it from a stale channel card weeks later. Deliberately
  // NOT a requirement in the env schema — parseEnv() throws in production on
  // any schema failure, so that would take the whole CMS down over a webhook
  // misconfiguration.
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.INTERACTOR_WEBHOOK_SECRET
  ) {
    console.error(
      "[startup] INTERACTOR_WEBHOOK_SECRET is not set: POST /api/webhooks/interactor " +
        "will refuse every Interactor Core delivery with 503, and social channel " +
        "status will not stay in sync. Set it to the signing secret from the Core " +
        "webhook registration and restart."
    );
  }

  // Say it at boot, not only when the first upload is refused
  // (src/lib/media-storage.ts).
  const { isS3Configured } = await import("@/lib/s3");
  if (process.env.NODE_ENV === "production" && !isS3Configured()) {
    console.error(
      "[media-storage] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set: every media upload and generated featured image will be refused until S3 is configured"
    );
  }

  if (
    process.env.SOCIAL_SCHEDULER_DISABLED !== "true" &&
    !globalScheduler.__socialSchedulerStarted
  ) {
    globalScheduler.__socialSchedulerStarted = true;
    const { publishDuePosts } = await import("@/lib/social/publisher");
    const timer = setInterval(() => {
      publishDuePosts().catch((err) => {
        console.error("[social-scheduler] tick failed:", err);
      });
    }, TICK_MS);
    // Don't hold the process open just for the scheduler.
    timer.unref?.();
  }

  // Outbound half of Phase 2 file-based content sync (see
  // FILE-BASED-CONTENT-PLAN.md) — pushes changed posts to the connected
  // GitHub repo. Off by default; a no-op even when on until a repo is
  // connected at /settings/content-sync.
  if (
    process.env.GITHUB_CONTENT_SYNC_ENABLED === "true" &&
    !globalScheduler.__contentSyncSchedulerStarted
  ) {
    globalScheduler.__contentSyncSchedulerStarted = true;
    const { syncDirtyPostsToGithub } = await import("@/lib/content-sync-scheduler");
    const timer = setInterval(() => {
      syncDirtyPostsToGithub().catch((err) => {
        console.error("[content-sync-scheduler] tick failed:", err);
      });
    }, CONTENT_SYNC_TICK_MS);
    timer.unref?.();
  }
}
