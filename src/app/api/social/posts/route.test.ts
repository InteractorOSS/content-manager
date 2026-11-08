import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#26: /api/social/posts now accepts a personal access token (not just a
// browser session) via requirePermissionApi, and refuses to schedule a post
// that would break a target channel's network rules.

const actor = {
  user: { id: "u1", email: "a@example.com", name: "Author One" },
  permissions: new Set<string>(["content:view", "content:create", "content:publish"]),
};
let apiToken: { id: string } | null = null;
let via: "session" | "token" = "session";

const socialPostFindMany = vi.fn();
const socialPostCreate = vi.fn();
const socialChannelFindMany = vi.fn();

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
  socialPost: { findMany: socialPostFindMany, create: socialPostCreate },
  socialChannel: { findMany: socialChannelFindMany },
  media: { findMany: mediaFindMany },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (req: NextRequest, ...perms: string[]) => {
    const header = req.headers.get("authorization");
    if (header) via = "token";
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, db, via, apiToken };
  }),
}));

import { GET, POST } from "./route";

const TWITTER_CHANNEL = { id: "c_tw", service_id: "twitter", service_name: "Brand X", account_id: null };

beforeEach(() => {
  actor.permissions = new Set(["content:view", "content:create", "content:publish"]);
  apiToken = null;
  via = "session";
  mediaFindMany.mockClear();
  socialPostFindMany.mockReset().mockResolvedValue([]);
  socialChannelFindMany.mockReset().mockResolvedValue([TWITTER_CHANNEL]);
  socialPostCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
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
});

function postReq(body: Record<string, unknown>, token?: string) {
  return new NextRequest("http://localhost/api/social/posts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("GET /api/social/posts", () => {
  it("authenticates via a bearer token, not just a session", async () => {
    const res = await GET(new NextRequest("http://localhost/api/social/posts", { headers: { authorization: "Bearer cms_pat_x" } }));
    expect(res.status).toBe(200);
    expect(via).toBe("token");
  });
});

describe("POST /api/social/posts", () => {
  it("creates a draft over a bearer token", async () => {
    const res = await POST(postReq({ body: "hello world" }, "cms_pat_x"));
    expect(res.status).toBe(201);
    expect(via).toBe("token");
    expect(socialPostCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "draft" }) })
    );
  });

  it("refuses to schedule a post that breaks a target channel's network rules", async () => {
    const res = await POST(
      postReq({
        body: "x".repeat(281), // over X's 280-char limit
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.violations).toEqual([expect.objectContaining({ code: "char_limit", channel_id: "c_tw" })]);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  // The character limit also holds for a draft, which the schedule-time
  // network rules above never see: a 400 naming the channel
  // (src/lib/social/char-limits-server.ts).
  it("refuses an over-limit draft with a 400 naming the channel", async () => {
    const res = await POST(postReq({ body: "x".repeat(281), channel_ids: ["c_tw"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Brand X");
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("refuses a bare image URL with a plain 400 and writes nothing", async () => {
    const res = await POST(postReq({ body: "hi", media: [{ url: "https://example.com/x.png" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/media library/);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("refuses media from outside the caller's org and writes nothing", async () => {
    const res = await POST(postReq({ body: "hi", media: [{ media_id: "other_org_file" }] }));
    expect(res.status).toBe(400);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("refuses more than 20 items, or alt text over 1000 characters, and writes nothing", async () => {
    const many = await POST(
      postReq({ body: "hi", media: Array.from({ length: 21 }, () => ({ media_id: "m1" })) })
    );
    expect(many.status).toBe(400);
    expect((await many.json()).error).toMatch(/at most 20/);
    const longAlt = await POST(postReq({ body: "hi", media: [{ media_id: "m1", alt: "x".repeat(1001) }] }));
    expect(longAlt.status).toBe(400);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("refuses a per-channel override carrying a URL", async () => {
    const res = await POST(
      postReq({ body: "hi", channel_ids: ["c_tw"], media_overrides: { c_tw: [{ url: "https://x/y.png" }] } })
    );
    expect(res.status).toBe(400);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("stores library media rebuilt from the row, and a target's own media", async () => {
    const res = await POST(
      postReq({
        body: "hi",
        channel_ids: ["c_tw"],
        media: [{ media_id: "m1", url: "https://ignored.example/z.png" }],
        media_overrides: { c_tw: [{ media_id: "m2", alt: "Square crop" }] },
      })
    );
    expect(res.status).toBe(201);
    // The post's media and the override were resolved in one lookup.
    expect(mediaFindMany).toHaveBeenCalledTimes(1);
    const data = socialPostCreate.mock.calls[0][0].data;
    expect(data.media).toEqual([{ media_id: "m1", url: "https://cdn.example.com/1.png", type: "image" }]);
    expect(data.targets.create).toEqual([
      expect.objectContaining({
        channel_id: "c_tw",
        media_override: [
          { media_id: "m2", url: "https://cdn.example.com/2.png", type: "image", alt: "Square crop" },
        ],
      }),
    ]);
  });

  it("refuses to schedule five images to X with a media_limit violation", async () => {
    const res = await POST(
      postReq({
        body: "hi",
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
        media: MEDIA_ROWS.map((r) => ({ media_id: r.id })),
      })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).violations).toEqual([
      expect.objectContaining({ code: "media_limit", channel_id: "c_tw" }),
    ]);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });

  it("checks a channel's own media, not the post's, against its limit", async () => {
    const res = await POST(
      postReq({
        body: "hi",
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
        media: MEDIA_ROWS.map((r) => ({ media_id: r.id })),
        media_overrides: { c_tw: [{ media_id: "m1" }] },
      })
    );
    expect(res.status).toBe(201);
  });

  it("schedules a post within the target channel's rules", async () => {
    const res = await POST(
      postReq({
        body: "short enough",
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
      })
    );
    expect(res.status).toBe(201);
    expect(socialPostCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "scheduled" }) })
    );
  });

  it("a per-channel override that fits is enough even if the shared body doesn't", async () => {
    const res = await POST(
      postReq({
        body: "x".repeat(281),
        body_overrides: { c_tw: "short override" },
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
      })
    );
    expect(res.status).toBe(201);
  });

  it("without content:publish, a scheduled post lands in pending_review instead", async () => {
    actor.permissions = new Set(["content:create"]);
    const res = await POST(
      postReq({
        body: "short enough",
        status: "scheduled",
        scheduled_at: "2099-01-01T00:00:00Z",
        channel_ids: ["c_tw"],
      })
    );
    expect(res.status).toBe(201);
    expect(socialPostCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "pending_review" }) })
    );
  });

  it("403s a token without content:create", async () => {
    actor.permissions = new Set();
    const res = await POST(postReq({ body: "hello" }, "cms_pat_x"));
    expect(res.status).toBe(403);
    expect(socialPostCreate).not.toHaveBeenCalled();
  });
});
