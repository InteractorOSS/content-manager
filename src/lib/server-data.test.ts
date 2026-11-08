import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These Server-Component data readers hit the raw `prisma` client (a Server
 * Component can't hold the request-scoped, tenant-filtered `db` that
 * requirePermission() hands to route handlers), so every query here used to
 * run with NO organization filter at all — the dashboard and the post editor
 * aggregated and displayed every organization's data to any signed-in user.
 * Pin the org filter so it can't silently drop again.
 */

const { post, category, media, contactSubmission, newsletterSubscription, waitlist } =
  vi.hoisted(() => ({
    post: { findMany: vi.fn(), findFirst: vi.fn() },
    category: { findMany: vi.fn() },
    media: { findMany: vi.fn() },
    contactSubmission: { count: vi.fn() },
    newsletterSubscription: { count: vi.fn() },
    waitlist: { count: vi.fn() },
  }));

vi.mock("@/lib/db", () => ({
  prisma: { post, category, media, contactSubmission, newsletterSubscription, waitlist },
}));

import {
  serverListPosts,
  serverGetPostBySlug,
  serverListCategories,
  serverListMedia,
  serverGetSubmissionCounts,
} from "./server-data";

beforeEach(() => {
  post.findMany.mockReset().mockResolvedValue([]);
  post.findFirst.mockReset().mockResolvedValue(null);
  category.findMany.mockReset().mockResolvedValue([]);
  media.findMany.mockReset().mockResolvedValue([]);
  contactSubmission.count.mockReset().mockResolvedValue(0);
  newsletterSubscription.count.mockReset().mockResolvedValue(0);
  waitlist.count.mockReset().mockResolvedValue(0);
});

describe("serverListPosts", () => {
  it("filters by the caller's organization", async () => {
    await serverListPosts("org-a");
    expect(post.findMany.mock.calls[0][0].where.organization_id).toBe("org-a");
  });

  it("returns nothing, without querying, for a caller with no organization", async () => {
    const result = await serverListPosts(null);
    expect(result).toEqual([]);
    expect(post.findMany).not.toHaveBeenCalled();
  });
});

describe("serverGetPostBySlug", () => {
  it("scopes the slug lookup to the caller's organization", async () => {
    await serverGetPostBySlug("some-slug", "org-a");
    expect(post.findFirst.mock.calls[0][0].where).toEqual({
      slug: "some-slug",
      organization_id: "org-a",
    });
  });

  it("returns null, without querying, for a caller with no organization", async () => {
    const result = await serverGetPostBySlug("some-slug", null);
    expect(result).toBeNull();
    expect(post.findFirst).not.toHaveBeenCalled();
  });
});

describe("serverListCategories / serverListMedia", () => {
  it("both filter by the caller's organization", async () => {
    await serverListCategories("org-a");
    await serverListMedia("org-a");
    expect(category.findMany.mock.calls[0][0].where.organization_id).toBe("org-a");
    expect(media.findMany.mock.calls[0][0].where.organization_id).toBe("org-a");
  });

  it("both return nothing, without querying, for a caller with no organization", async () => {
    expect(await serverListCategories(null)).toEqual([]);
    expect(await serverListMedia(null)).toEqual([]);
    expect(category.findMany).not.toHaveBeenCalled();
    expect(media.findMany).not.toHaveBeenCalled();
  });
});

describe("serverGetSubmissionCounts", () => {
  it("scopes every count to the caller's organization", async () => {
    await serverGetSubmissionCounts("org-a");
    expect(contactSubmission.count.mock.calls[0][0].where.organization_id).toBe("org-a");
    expect(newsletterSubscription.count.mock.calls[0][0].where.organization_id).toBe("org-a");
    expect(waitlist.count.mock.calls[0][0].where.organization_id).toBe("org-a");
  });

  it("returns all zeros, without querying, for a caller with no organization", async () => {
    const result = await serverGetSubmissionCounts(null);
    expect(result).toEqual({ newContacts: 0, activeNewsletter: 0, pendingWaitlist: 0 });
    expect(contactSubmission.count).not.toHaveBeenCalled();
  });
});
