import { beforeEach, describe, expect, it, vi } from "vitest";

// G#27: manual delivery mode — publishTarget must never call Interactor Core
// for a manual-mode channel, and mark-posted must record what a human got
// back and roll the post up correctly.
//
// Kept apart from publisher.test.ts on purpose: that file drives the retry
// reconciler through an in-memory Prisma, while these assert the exact writes
// the manual branch makes against plain call-recording mocks.

// publisher.ts is `import "server-only"`, which throws outside Next's RSC
// bundler (the reason every other test that touches it, e.g.
// posts/[id]/publish/route.test.ts, mocks "@/lib/social/publisher" wholesale
// instead of importing the real module). This file wants the real
// publishTarget/markManualTargetPosted logic under test, so it stubs the
// "server-only" package itself instead — nothing else in publisher.ts
// references it.
vi.mock("server-only", () => ({}));

const socialPostTargetFindUnique = vi.fn();
const socialPostTargetUpdate = vi.fn();
const socialPostTargetUpdateMany = vi.fn();
const socialPostTargetFindMany = vi.fn();
const socialPostUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    socialPostTarget: {
      findUnique: (...args: unknown[]) => socialPostTargetFindUnique(...args),
      update: (...args: unknown[]) => socialPostTargetUpdate(...args),
      updateMany: (...args: unknown[]) => socialPostTargetUpdateMany(...args),
      findMany: (...args: unknown[]) => socialPostTargetFindMany(...args),
    },
    socialPost: {
      update: (...args: unknown[]) => socialPostUpdate(...args),
    },
  },
}));

const executeServiceAction = vi.fn();
vi.mock("@/lib/interactor", () => ({
  InteractorError: class InteractorError extends Error {
    status?: number;
  },
  executeServiceAction: (...args: unknown[]) => executeServiceAction(...args),
  executeServiceUpload: vi.fn(),
  // The real parser lives in interactor.ts, tested there; these cases only
  // need "no headers relayed".
  responseHeaders: () => ({}),
}));

import { markManualTargetPosted, publishTarget } from "./publisher";

const MANUAL_CHANNEL = {
  id: "chan_manual",
  service_id: "facebook-personal",
  service_name: "Facebook (personal profile)",
  delivery_mode: "manual",
  account_id: null,
  external_user_id: "ext_1",
  status: "active",
};

const AUTOMATED_CHANNEL = {
  id: "chan_auto",
  service_id: "twitter",
  service_name: "X (Twitter)",
  delivery_mode: "automated",
  account_id: null,
  external_user_id: "ext_1",
  status: "active",
};

beforeEach(() => {
  socialPostTargetFindUnique.mockReset();
  socialPostTargetUpdate.mockReset().mockResolvedValue({ id: "t1", post_id: "sp1", channel: MANUAL_CHANNEL });
  socialPostTargetUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  socialPostTargetFindMany.mockReset().mockResolvedValue([]);
  socialPostUpdate.mockReset();
  executeServiceAction.mockReset();
});

describe("publishTarget — manual delivery mode", () => {
  it("routes a manual-mode channel's target to awaiting_manual, never calling Interactor Core", async () => {
    socialPostTargetFindUnique.mockResolvedValueOnce({
      id: "t1",
      post_id: "sp1",
      status: "pending",
      attempt_count: 0,
      body_override: null,
      post: { body: "hello", link: null, media: [] },
      channel: MANUAL_CHANNEL,
    });

    await publishTarget("t1");

    expect(executeServiceAction).not.toHaveBeenCalled();
    expect(socialPostTargetUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "awaiting_manual", error: null },
    });
  });

  it("is idempotent — does not re-update a target already awaiting_manual", async () => {
    socialPostTargetFindUnique.mockResolvedValueOnce({
      id: "t1",
      post_id: "sp1",
      status: "awaiting_manual",
      attempt_count: 0,
      body_override: null,
      post: { body: "hello", link: null, media: [] },
      channel: MANUAL_CHANNEL,
    });

    await publishTarget("t1");

    expect(socialPostTargetUpdate).not.toHaveBeenCalled();
    expect(executeServiceAction).not.toHaveBeenCalled();
  });

  it("still publishes an automated-mode channel through Interactor Core, unaffected by the manual branch", async () => {
    socialPostTargetFindUnique.mockResolvedValueOnce({
      id: "t2",
      post_id: "sp1",
      status: "pending",
      attempt_count: 0,
      body_override: null,
      post: { body: "hello", link: null, media: [] },
      channel: AUTOMATED_CHANNEL,
    });
    executeServiceAction.mockResolvedValueOnce({ data: { data: { id: "tweet_1" } } });

    await publishTarget("t2");

    expect(executeServiceAction).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "twitter" })
    );
    expect(socialPostTargetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "published" }) })
    );
  });
});

describe("markManualTargetPosted", () => {
  it("records the human-provided permalink and rolls the post up to published when nothing else is outstanding", async () => {
    socialPostTargetUpdate.mockResolvedValueOnce({
      id: "t1",
      post_id: "sp1",
      status: "published",
      channel: MANUAL_CHANNEL,
    });
    socialPostTargetFindMany.mockResolvedValueOnce([{ status: "published" }]);

    const result = await markManualTargetPosted("t1", {
      externalUrl: "https://facebook.com/posts/123",
      externalPostId: "123",
    });

    expect(socialPostTargetUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: {
        status: "published",
        published_at: expect.any(Date),
        external_url: "https://facebook.com/posts/123",
        external_post_id: "123",
        error: null,
      },
      include: { channel: true },
    });
    expect(result.status).toBe("published");
    expect(socialPostUpdate).toHaveBeenCalledWith({
      where: { id: "sp1" },
      data: { status: "published", published_at: expect.any(Date) },
    });
  });

  it("leaves the post at awaiting_manual when another target on it still needs a human", async () => {
    socialPostTargetUpdate.mockResolvedValueOnce({
      id: "t1",
      post_id: "sp1",
      status: "published",
      channel: MANUAL_CHANNEL,
    });
    socialPostTargetFindMany.mockResolvedValueOnce([
      { status: "published" },
      { status: "awaiting_manual" },
    ]);

    await markManualTargetPosted("t1", {});

    // awaiting_manual is not a delivered/terminal rollup — published_at
    // stays null even though this target's own status is now "published".
    expect(socialPostUpdate).toHaveBeenCalledWith({
      where: { id: "sp1" },
      data: { status: "awaiting_manual", published_at: null },
    });
  });

  it("records no permalink cleanly when the human didn't have one", async () => {
    socialPostTargetUpdate.mockResolvedValueOnce({
      id: "t1",
      post_id: "sp1",
      status: "published",
      channel: MANUAL_CHANNEL,
    });
    socialPostTargetFindMany.mockResolvedValueOnce([{ status: "published" }]);

    await markManualTargetPosted("t1", {});

    expect(socialPostTargetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ external_url: null, external_post_id: null }),
      })
    );
  });
});
