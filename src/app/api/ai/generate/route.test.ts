import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// G#26: the AI fan-out used to create SocialPost rows with zero
// SocialPostTarget rows — nothing to schedule until a human opened the queue
// and picked channels by hand. This exercises the fix: a network with an
// active connected channel gets that channel attached as a target at
// creation time; a network with none connected still gets its draft, just
// with no targets yet.

const actor = {
  user: { id: "u1", email: "a@example.com", name: "Author One", display_name: null, status: "active" },
  organizationId: "org1",
  organizations: [],
  permissions: new Set<string>(["content:create"]),
};

const generationJobCreate = vi.fn();
const generationJobUpdate = vi.fn();
const styleProfileFindFirst = vi.fn();
const postCreate = vi.fn();
const socialChannelFindMany = vi.fn();
const socialPostCreate = vi.fn();

const db = {
  generationJob: { create: generationJobCreate, update: generationJobUpdate },
  styleProfile: { findUnique: vi.fn(), findFirst: styleProfileFindFirst },
  post: { create: postCreate, findUnique: vi.fn(), findFirst: vi.fn() },
  socialChannel: { findMany: socialChannelFindMany },
  socialPost: { create: socialPostCreate },
};

vi.mock("@/lib/guard", () => ({
  requirePermission: vi.fn(async () => ({ actor, db })),
}));
vi.mock("@/lib/db", () => ({
  prisma: { styleGuideVersion: { findFirst: vi.fn(async () => null) } },
  isUniqueViolation: () => false,
}));
vi.mock("@/lib/ai/client", () => ({ aiConfigured: () => true, AI_MODEL: "test-model" }));

const generateSocialCopy = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  buildStyleSystem: () => "system prompt",
  generateBlogDraft: vi.fn(),
  generateSocialCopy: (...a: unknown[]) => generateSocialCopy(...a),
  isSocialFormat: (v: string) => ["linkedin", "twitter", "facebook"].includes(v),
  polishDraft: vi.fn(),
}));

import { POST } from "./route";

function call(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/ai/generate", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

const LINKEDIN_CHANNEL = { id: "chan_li", service_id: "linkedin" };
const TWITTER_CHANNEL = { id: "chan_tw", service_id: "twitter" };

beforeEach(() => {
  actor.permissions = new Set(["content:create"]);
  generationJobCreate.mockReset().mockResolvedValue({ id: "job1" });
  generationJobUpdate.mockReset().mockResolvedValue({});
  styleProfileFindFirst.mockReset().mockResolvedValue(null);
  socialChannelFindMany.mockReset().mockResolvedValue([]);
  socialPostCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `sp_${data.network}`,
    ...data,
  }));
  generateSocialCopy.mockReset().mockImplementation(async (_sys: string, format: string) => ({
    body: `${format} copy`,
    usage: { inputTokens: 10, outputTokens: 20 },
  }));
});

describe("POST /api/ai/generate — social fan-out target attachment (G#26)", () => {
  it("attaches every active channel matching the network as a target", async () => {
    socialChannelFindMany.mockResolvedValue([LINKEDIN_CHANNEL, TWITTER_CHANNEL]);

    const res = await call({
      source: { type: "text", text: "x".repeat(200) },
      mode: "create",
      formats: ["linkedin", "twitter"],
    });

    expect(res.status).toBe(201);
    // Looked up once, for both requested networks' service ids together.
    expect(socialChannelFindMany).toHaveBeenCalledWith({
      where: { service_id: { in: ["linkedin", "twitter"] }, status: "active" },
      select: { id: true, service_id: true },
    });

    const linkedinCreate = socialPostCreate.mock.calls.find((c) => c[0].data.network === "linkedin")![0];
    expect(linkedinCreate.data.targets.create).toEqual([{ channel_id: "chan_li" }]);
    const twitterCreate = socialPostCreate.mock.calls.find((c) => c[0].data.network === "twitter")![0];
    expect(twitterCreate.data.targets.create).toEqual([{ channel_id: "chan_tw" }]);

    const json = await res.json();
    const byNetwork = Object.fromEntries(
      (json.data.social_posts as { network: string; channel_ids: string[] }[]).map((p) => [p.network, p.channel_ids])
    );
    expect(byNetwork.linkedin).toEqual(["chan_li"]);
    expect(byNetwork.twitter).toEqual(["chan_tw"]);
  });

  it("still creates the draft with no targets when no channel is connected for that network", async () => {
    socialChannelFindMany.mockResolvedValue([]); // nothing connected

    const res = await call({
      source: { type: "text", text: "x".repeat(200) },
      mode: "create",
      formats: ["facebook"],
    });

    expect(res.status).toBe(201);
    const facebookCreate = socialPostCreate.mock.calls[0][0];
    expect(facebookCreate.data.targets.create).toEqual([]);

    const json = await res.json();
    expect(json.data.social_posts).toEqual([{ id: "sp_facebook", network: "facebook", channel_ids: [] }]);
  });

  it("only attaches a channel to the network it actually serves", async () => {
    // A Facebook Page channel must never end up as a LinkedIn post's target.
    socialChannelFindMany.mockResolvedValue([{ id: "chan_fb", service_id: "facebook-graph-api" }]);

    await call({
      source: { type: "text", text: "x".repeat(200) },
      mode: "create",
      formats: ["linkedin", "facebook"],
    });

    const linkedinCreate = socialPostCreate.mock.calls.find((c) => c[0].data.network === "linkedin")![0];
    expect(linkedinCreate.data.targets.create).toEqual([]);
    const facebookCreate = socialPostCreate.mock.calls.find((c) => c[0].data.network === "facebook")![0];
    expect(facebookCreate.data.targets.create).toEqual([{ channel_id: "chan_fb" }]);
  });

  it("does not look up channels at all when only the blog format is requested", async () => {
    const res = await call({
      source: { type: "text", text: "x".repeat(200) },
      mode: "create",
      formats: ["blog"],
    });
    // No blog draft mock configured -> generateBlogDraft rejects -> route
    // reports a clean 502 rather than crashing; the assertion under test is
    // that social-channel lookup is skipped entirely for an all-blog request.
    expect(res.status).toBe(502);
    expect(socialChannelFindMany).not.toHaveBeenCalled();
  });
});
