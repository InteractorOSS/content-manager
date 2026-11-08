import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#27: marking a manual target posted. Tenancy is verified through the
// scoped socialPost (the target has no organization_id of its own), then
// the actual mutation is delegated to publisher.ts's markManualTargetPosted
// — mocked here the same way posts/[id]/publish/route.test.ts mocks
// publishPost, so this test stays a unit test of the route's own gating.

const actor = { user: { id: "u1" }, permissions: new Set<string>(["content:publish"]) };

const socialPostFindFirst = vi.fn();
const db = { socialPost: { findFirst: socialPostFindFirst } };

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: NextRequest, ...perms: string[]) => {
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, db, via: "token" };
  }),
}));

const markManualTargetPosted = vi.fn();
vi.mock("@/lib/social/publisher", () => ({
  markManualTargetPosted: (...args: unknown[]) => markManualTargetPosted(...args),
  canMarkPosted: (target: { status: string }) => target.status === "awaiting_manual",
}));

import { POST } from "./route";

const MANUAL_CHANNEL = { id: "chan1", delivery_mode: "manual" };
const AUTOMATED_CHANNEL = { id: "chan2", delivery_mode: "automated" };

function ctx() {
  return { params: Promise.resolve({ targetId: "t1" }) };
}
function call(body: Record<string, unknown> = {}) {
  return POST(
    new NextRequest("http://localhost/api/social/manual/t1/mark-posted", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    ctx()
  );
}

beforeEach(() => {
  actor.permissions = new Set(["content:publish"]);
  socialPostFindFirst.mockReset();
  markManualTargetPosted.mockReset().mockResolvedValue({
    id: "t1",
    post_id: "sp1",
    status: "published",
    external_url: "https://facebook.com/posts/123",
    channel: MANUAL_CHANNEL,
  });
});

describe("POST /api/social/manual/[targetId]/mark-posted", () => {
  it("marks a target posted and records the permalink the human got back", async () => {
    socialPostFindFirst.mockResolvedValueOnce({
      id: "sp1",
      targets: [{ id: "t1", status: "awaiting_manual", channel: MANUAL_CHANNEL }],
    });

    const res = await call({ external_url: "https://facebook.com/posts/123" });
    expect(res.status).toBe(200);
    expect(markManualTargetPosted).toHaveBeenCalledWith("t1", {
      externalUrl: "https://facebook.com/posts/123",
      externalPostId: null,
    });
    const json = await res.json();
    expect(json.data.status).toBe("published");
  });

  it("404s when the target doesn't exist (or belongs to another org)", async () => {
    socialPostFindFirst.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(markManualTargetPosted).not.toHaveBeenCalled();
  });

  it("422s a target whose channel isn't manual delivery", async () => {
    socialPostFindFirst.mockResolvedValueOnce({
      id: "sp1",
      targets: [{ id: "t1", status: "pending", channel: AUTOMATED_CHANNEL }],
    });
    const res = await call();
    expect(res.status).toBe(422);
    expect(markManualTargetPosted).not.toHaveBeenCalled();
  });

  it("409s a target that isn't actually awaiting_manual (e.g. already published)", async () => {
    socialPostFindFirst.mockResolvedValueOnce({
      id: "sp1",
      targets: [{ id: "t1", status: "published", channel: MANUAL_CHANNEL }],
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect(markManualTargetPosted).not.toHaveBeenCalled();
  });

  it("403s a token without content:publish", async () => {
    actor.permissions = new Set();
    const res = await call();
    expect(res.status).toBe(403);
    expect(socialPostFindFirst).not.toHaveBeenCalled();
  });

  it("trims blank permalink input down to null rather than storing whitespace", async () => {
    socialPostFindFirst.mockResolvedValueOnce({
      id: "sp1",
      targets: [{ id: "t1", status: "awaiting_manual", channel: MANUAL_CHANNEL }],
    });
    await call({ external_url: "   " });
    expect(markManualTargetPosted).toHaveBeenCalledWith("t1", {
      externalUrl: null,
      externalPostId: null,
    });
  });
});
