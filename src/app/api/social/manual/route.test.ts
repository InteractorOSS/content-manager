import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#27: the manual-delivery queue lists SocialPostTarget rows stuck at
// awaiting_manual — queried through the tenant-scoped socialPost (the
// target itself carries no organization_id of its own).

const actor = { user: { id: "u1" }, permissions: new Set<string>(["content:view"]) };

const socialPostFindMany = vi.fn();
const db = { socialPost: { findMany: socialPostFindMany } };

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: NextRequest, ...perms: string[]) => {
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, db, via: "token" };
  }),
}));

import { GET } from "./route";

const MANUAL_CHANNEL = {
  id: "chan1",
  service_id: "facebook-personal",
  service_name: "Facebook (personal profile)",
  delivery_mode: "manual",
};

beforeEach(() => {
  actor.permissions = new Set(["content:view"]);
  socialPostFindMany.mockReset();
});

function call() {
  return GET(new NextRequest("http://localhost/api/social/manual"));
}

describe("GET /api/social/manual", () => {
  it("flattens each post's awaiting_manual targets into one queue row per target", async () => {
    socialPostFindMany.mockResolvedValueOnce([
      {
        id: "sp1",
        body: "Check out our launch!",
        link: null,
        media: [],
        network: null,
        campaign: null,
        source_post: null,
        scheduled_at: null,
        targets: [
          {
            id: "t1",
            channel_id: "chan1",
            channel: MANUAL_CHANNEL,
            status: "awaiting_manual",
            body_override: null,
            inserted_at: new Date("2024-01-01"),
            updated_at: new Date("2024-01-02"),
          },
        ],
      },
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      id: "t1",
      status: "awaiting_manual",
      // G#28: no body_override on this target, so effective_body/paste_text
      // fall back to the post's own body — the precedence an external
      // caller with no other CMS context (e.g. a Claude-in-Chrome session)
      // must not have to re-derive itself.
      effective_body: "Check out our launch!",
      paste_text: "Check out our launch!",
      post: { id: "sp1", body: "Check out our launch!" },
    });
    expect(json.data[0].channel).toMatchObject({ id: "chan1", delivery_mode: "manual" });

    // Only awaiting_manual targets are asked for and returned — never every
    // target on the post.
    expect(socialPostFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { targets: { some: { status: "awaiting_manual" } } },
        include: expect.objectContaining({
          targets: expect.objectContaining({ where: { status: "awaiting_manual" } }),
        }),
      })
    );
  });

  it("resolves effective_body from body_override, and appends the post's link on its own line in paste_text", async () => {
    socialPostFindMany.mockResolvedValueOnce([
      {
        id: "sp2",
        body: "Generic copy for every network",
        link: "https://example.com/launch",
        media: [],
        network: "facebook",
        campaign: null,
        source_post: null,
        scheduled_at: null,
        targets: [
          {
            id: "t2",
            channel_id: "chan1",
            channel: MANUAL_CHANNEL,
            status: "awaiting_manual",
            body_override: "Facebook-specific copy",
            inserted_at: new Date("2024-01-01"),
            updated_at: new Date("2024-01-02"),
          },
        ],
      },
    ]);

    const res = await call();
    const json = await res.json();
    expect(json.data[0]).toMatchObject({
      id: "t2",
      body_override: "Facebook-specific copy",
      effective_body: "Facebook-specific copy",
      paste_text: "Facebook-specific copy\nhttps://example.com/launch",
    });
  });

  it("returns an empty list when nothing is awaiting manual posting", async () => {
    socialPostFindMany.mockResolvedValueOnce([]);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it("403s a token without content:view", async () => {
    actor.permissions = new Set();
    const res = await call();
    expect(res.status).toBe(403);
    expect(socialPostFindMany).not.toHaveBeenCalled();
  });
});
