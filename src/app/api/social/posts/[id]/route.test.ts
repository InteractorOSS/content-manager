import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#26: /api/social/posts/[id] now accepts a bearer token, and PUT refuses to
// move a post to "scheduled" when its copy breaks a target channel's network
// rules — whether that's this call's own channel_ids or the channels already
// on the post.

const actor = {
  user: { id: "u1", email: "a@example.com", name: "Author One" },
  permissions: new Set<string>(["content:view", "content:edit", "content:publish", "content:delete"]),
};

const socialPostFindUnique = vi.fn();
const socialPostUpdate = vi.fn();
const socialPostTargetDeleteMany = vi.fn();
const socialPostTargetCreateMany = vi.fn();
const socialPostTargetUpdateMany = vi.fn();
const socialChannelFindMany = vi.fn();
const socialPostDelete = vi.fn();

const MEDIA_ROWS = Array.from({ length: 5 }, (_, i) => ({
  id: `m${i + 1}`,
  file_path: `https://cdn.example.com/${i + 1}.png`,
  mime_type: "image/png",
  alt_text: null,
}));
// Stands in for the tenant-scoped findMany: another org's id isn't found.
const mediaFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
  MEDIA_ROWS.filter((r) => where.id.in.includes(r.id))
);

const db = {
  media: { findMany: mediaFindMany },
  socialPost: {
    findUnique: socialPostFindUnique,
    update: socialPostUpdate,
    delete: socialPostDelete,
  },
  socialPostTarget: {
    deleteMany: socialPostTargetDeleteMany,
    createMany: socialPostTargetCreateMany,
    updateMany: socialPostTargetUpdateMany,
  },
  socialChannel: { findMany: socialChannelFindMany },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (req: NextRequest, ...perms: string[]) => {
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, db, via: "token" };
  }),
}));

import { DELETE, GET, PUT } from "./route";

const TWITTER_CHANNEL = { id: "c_tw", service_id: "twitter", service_name: "Brand X", account_id: null };

const EXISTING_POST = {
  id: "sp1",
  body: "original body",
  media: [],
  status: "draft",
  targets: [{ id: "t1", channel_id: "c_tw", body_override: null }],
};

function ctx() {
  return { params: Promise.resolve({ id: "sp1" }) };
}

function putReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/social/posts/sp1", { method: "PUT", body: JSON.stringify(body) });
}

beforeEach(() => {
  actor.permissions = new Set(["content:view", "content:edit", "content:publish", "content:delete"]);
  socialPostFindUnique.mockReset().mockResolvedValue({ ...EXISTING_POST, targets: [...EXISTING_POST.targets] });
  socialPostUpdate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "sp1",
    ...data,
    targets: [],
    media: [],
    campaign: null,
    created_by: null,
    source_post: null,
    inserted_at: new Date(),
    updated_at: new Date(),
    scheduled_at: data.scheduled_at ?? null,
    published_at: null,
    approved_at: null,
  }));
  socialPostTargetDeleteMany.mockReset().mockResolvedValue({});
  socialPostTargetCreateMany.mockReset().mockResolvedValue({});
  socialPostTargetUpdateMany.mockReset().mockResolvedValue({});
  socialChannelFindMany.mockReset().mockResolvedValue([TWITTER_CHANNEL]);
  socialPostDelete.mockReset().mockResolvedValue({});
});

describe("GET /api/social/posts/[id]", () => {
  it("404s an unknown post over a bearer token", async () => {
    socialPostFindUnique.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/social/posts/sp1"), ctx());
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/social/posts/[id]", () => {
  it("refuses to schedule when the post's existing channel breaks network rules", async () => {
    const res = await PUT(
      putReq({ body: "x".repeat(281), status: "scheduled", scheduled_at: "2099-01-01T00:00:00Z" }),
      ctx()
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.violations).toEqual([expect.objectContaining({ code: "char_limit", channel_id: "c_tw" })]);
    expect(socialPostUpdate).not.toHaveBeenCalled();
  });

  it("refuses an over-limit draft edit with a 400 naming the channel", async () => {
    const res = await PUT(putReq({ body: "x".repeat(281) }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Brand X");
    expect(socialPostUpdate).not.toHaveBeenCalled();
  });

  it("schedules when the copy fits every target channel's rules", async () => {
    const res = await PUT(
      putReq({ body: "short enough", status: "scheduled", scheduled_at: "2099-01-01T00:00:00Z" }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(socialPostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "scheduled" }) })
    );
  });

  it("checks newly-added channel_ids too, not just the post's existing targets", async () => {
    socialChannelFindMany.mockResolvedValue([
      TWITTER_CHANNEL,
      { id: "c_ig", service_id: "instagram", service_name: "Brand IG", account_id: "123" },
    ]);
    const res = await PUT(
      putReq({
        body: "short enough",
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw", "c_ig"], // Instagram requires media, none given
      }),
      ctx()
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.violations).toEqual([expect.objectContaining({ code: "missing_media", channel_id: "c_ig" })]);
  });

  it("does not re-check network rules for an edit that keeps the post a draft", async () => {
    socialPostFindUnique.mockResolvedValue({
      ...EXISTING_POST,
      targets: [{ id: "t1", channel_id: "c_ig", body_override: null }],
    });
    socialChannelFindMany.mockResolvedValue([
      { id: "c_ig", service_id: "instagram", service_name: "Brand IG", account_id: "123" },
    ]);
    // Instagram requires media and none is given — fine while it stays a draft.
    const res = await PUT(putReq({ body: "still drafting" }), ctx());
    expect(res.status).toBe(200);
    expect(socialPostUpdate).toHaveBeenCalled();
  });

  it("refuses a URL in place of library media and writes nothing", async () => {
    const res = await PUT(putReq({ media: [{ url: "https://example.com/x.png" }] }), ctx());
    expect(res.status).toBe(400);
    expect(socialPostUpdate).not.toHaveBeenCalled();
    expect(socialPostTargetUpdateMany).not.toHaveBeenCalled();
  });

  it("writes and clears a target's own media", async () => {
    const res = await PUT(
      putReq({ media: [{ media_id: "m1" }], media_overrides: { c_tw: [{ media_id: "m2" }] } }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(socialPostTargetUpdateMany).toHaveBeenCalledWith({
      where: { post_id: "sp1", channel_id: "c_tw" },
      data: { media_override: [{ media_id: "m2", url: "https://cdn.example.com/2.png", type: "image" }] },
    });
    expect(socialPostUpdate.mock.calls[0][0].data.media).toEqual([
      { media_id: "m1", url: "https://cdn.example.com/1.png", type: "image" },
    ]);

    socialPostTargetUpdateMany.mockClear();
    await PUT(putReq({ media_overrides: { c_tw: null } }), ctx());
    const cleared = socialPostTargetUpdateMany.mock.calls[0][0].data.media_override;
    expect(String(cleared)).toMatch(/DbNull/);
  });

  it("refuses to schedule when an existing target's own media breaks its limit", async () => {
    socialPostFindUnique.mockResolvedValue({
      ...EXISTING_POST,
      targets: [
        {
          id: "t1",
          channel_id: "c_tw",
          body_override: null,
          media_override: MEDIA_ROWS.map((r) => ({ media_id: r.id, url: r.file_path, type: "image" })),
        },
      ],
    });
    const res = await PUT(putReq({ status: "scheduled", scheduled_at: "2099-01-01T00:00:00Z" }), ctx());
    expect(res.status).toBe(422);
    expect(socialPostUpdate).not.toHaveBeenCalled();
  });

  it("409s an edit to an already-published post", async () => {
    socialPostFindUnique.mockResolvedValue({ ...EXISTING_POST, status: "published" });
    const res = await PUT(putReq({ body: "new copy" }), ctx());
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/social/posts/[id]", () => {
  it("403s without content:delete", async () => {
    actor.permissions = new Set(["content:view"]);
    const res = await DELETE(new NextRequest("http://localhost/api/social/posts/sp1", { method: "DELETE" }), ctx());
    expect(res.status).toBe(403);
    expect(socialPostDelete).not.toHaveBeenCalled();
  });
});
