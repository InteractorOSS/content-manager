import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#26: publish now accepts a bearer token, and is pre-checked against
// network rules so a violation comes back as a clear 422 instead of a
// network round-trip that publisher.ts can only report as a failed target.

const actor = { user: { id: "u1" }, permissions: new Set<string>(["content:publish"]) };

const socialPostFindUnique = vi.fn();
const socialChannelFindMany = vi.fn();
const db = {
  socialPost: { findUnique: socialPostFindUnique },
  socialChannel: { findMany: socialChannelFindMany },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: NextRequest, ...perms: string[]) => {
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, db, via: "token" };
  }),
}));

const publishPost = vi.fn();
vi.mock("@/lib/social/publisher", () => ({ publishPost: (...a: unknown[]) => publishPost(...a) }));

import { POST } from "./route";

const TWITTER_CHANNEL = { id: "c_tw", service_id: "twitter", service_name: "Brand X", account_id: null };

function ctx() {
  return { params: Promise.resolve({ id: "sp1" }) };
}
function call() {
  return POST(new NextRequest("http://localhost/api/social/posts/sp1/publish", { method: "POST" }), ctx());
}

beforeEach(() => {
  actor.permissions = new Set(["content:publish"]);
  socialPostFindUnique.mockReset();
  socialChannelFindMany.mockReset().mockResolvedValue([TWITTER_CHANNEL]);
  publishPost.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/social/posts/[id]/publish", () => {
  it("refuses to publish a post that breaks a target channel's network rules, without calling the publisher", async () => {
    socialPostFindUnique.mockResolvedValueOnce({
      id: "sp1",
      body: "x".repeat(281),
      media: [],
      status: "approved",
      targets: [{ channel_id: "c_tw", status: "pending", body_override: null }],
    });
    const res = await call();
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.violations).toEqual([expect.objectContaining({ code: "char_limit", channel_id: "c_tw" })]);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it("publishes when the copy fits every pending target's rules", async () => {
    socialPostFindUnique
      .mockResolvedValueOnce({
        id: "sp1",
        body: "short enough",
        media: [],
        status: "approved",
        targets: [{ channel_id: "c_tw", status: "pending", body_override: null }],
      })
      .mockResolvedValueOnce({ id: "sp1", status: "published", targets: [], media: [] });
    const res = await call();
    expect(res.status).toBe(200);
    expect(publishPost).toHaveBeenCalledWith("sp1");
  });

  it("skips already-published targets when checking rules (only pending ones matter)", async () => {
    socialChannelFindMany.mockResolvedValue([]); // pretend the channel vanished
    socialPostFindUnique
      .mockResolvedValueOnce({
        id: "sp1",
        body: "short enough",
        media: [],
        status: "partially_published",
        targets: [{ channel_id: "c_tw", status: "published", body_override: null }],
      })
      .mockResolvedValueOnce({ id: "sp1", status: "published", targets: [], media: [] });
    const res = await call();
    expect(res.status).toBe(200);
    expect(socialChannelFindMany).not.toHaveBeenCalled();
  });

  it("403s a token without content:publish", async () => {
    actor.permissions = new Set();
    const res = await call();
    expect(res.status).toBe(403);
    expect(socialPostFindUnique).not.toHaveBeenCalled();
  });
});

// "Publish now" used to refuse any post at `publishing` — which is exactly the
// status a post gets parked at when one channel fails, so the manual escape was
// closed on the only posts that needed it. It is a real conflict only while an
// attempt is actually in flight.
describe("POST /api/social/posts/[id]/publish — a post parked at publishing", () => {
  function parked(targets: { status: string }[], status = "publishing") {
    return {
      id: "sp1",
      body: "short enough",
      media: [],
      status,
      targets: targets.map((t, i) => ({
        id: `t${i + 1}`,
        channel_id: "c_tw",
        body_override: null,
        ...t,
      })),
    };
  }

  it("re-enters a post parked at publishing with nothing in flight", async () => {
    socialPostFindUnique.mockResolvedValue(parked([{ status: "failed" }]));

    const res = await call();

    expect(res.status).toBe(200);
    expect(publishPost).toHaveBeenCalledWith("sp1");
  });

  it("refuses while a channel is actually being sent to", async () => {
    socialPostFindUnique.mockResolvedValue(
      parked([{ status: "publishing" }, { status: "pending" }])
    );

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/right now/);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it("still refuses a post that is fully published", async () => {
    socialPostFindUnique.mockResolvedValue(
      parked([{ status: "published" }], "published")
    );

    const res = await call();

    expect(res.status).toBe(409);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it("refuses a post with no channels", async () => {
    socialPostFindUnique.mockResolvedValue(parked([]));

    const res = await call();

    expect(res.status).toBe(422);
    expect(publishPost).not.toHaveBeenCalled();
  });
});
