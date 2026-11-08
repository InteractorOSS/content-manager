import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_SOCIAL_PARTS } from "@/lib/social/parts";

// Saving a post's social copy as text: the '---' lines become parts, and the
// number of parts is bounded before anything is written (the same bound the
// structured `parts` field on /api/social/posts has).

const actor = {
  user: { id: "u1", email: "a@example.com", name: "A", status: "active" },
  organizationId: "org1",
  membershipRole: "author",
  roles: ["author"],
  permissions: new Set<string>(["content:view", "content:edit"]),
};

const socialFindMany = vi.fn(async () => [] as unknown[]);
const socialCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: "s-new",
  updated_at: new Date(),
  scheduled_at: null,
  published_at: null,
  ...data,
}));
const socialUpdate = vi.fn();

const db = {
  post: {
    findUnique: vi.fn(async () => ({ id: "p1", author_id: "u1", platforms: ["website"], status: "draft" })),
  },
  socialPost: { findMany: socialFindMany, create: socialCreate, update: socialUpdate, delete: vi.fn() },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async () => ({ actor, db, via: "session", apiToken: null })),
}));
const syncPostSocialDelivery = vi.fn();
vi.mock("@/lib/post-social-delivery", () => ({
  syncPostSocialDelivery: (...a: unknown[]) => syncPostSocialDelivery(...a),
}));

import { PUT } from "./route";

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/cms/posts/p1/social", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "p1" }) }
  );
}

const thread = (tweets: number) => Array.from({ length: tweets }, (_, i) => `Tweet ${i + 1}`).join("\n---\n");

beforeEach(() => vi.clearAllMocks());

describe("PUT /api/cms/posts/[id]/social", () => {
  it("stores an X thread as the root plus its parts", async () => {
    const res = await put({ network: "twitter", body: thread(3) });
    expect(res.status).toBe(200);
    expect(socialCreate).toHaveBeenCalledTimes(1);
    expect(socialCreate.mock.calls[0][0].data).toMatchObject({
      body: "Tweet 1",
      parts: [
        { kind: "thread", body: "Tweet 2" },
        { kind: "thread", body: "Tweet 3" },
      ],
    });
  });

  it("accepts a thread at the cap", async () => {
    const res = await put({ network: "twitter", body: thread(MAX_SOCIAL_PARTS + 1) });
    expect(res.status).toBe(200);
  });

  it("refuses a thread with too many parts, writing nothing", async () => {
    const res = await put({ network: "twitter", body: thread(40) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/40 parts.*at most 25/);
    expect(socialCreate).not.toHaveBeenCalled();
    expect(socialUpdate).not.toHaveBeenCalled();
    expect(syncPostSocialDelivery).not.toHaveBeenCalled();
  });

  it("refuses a second first comment instead of dropping it, writing nothing", async () => {
    const res = await put({
      network: "linkedin",
      body: "Post\n--- first comment\nOne\n--- first comment\nTwo",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only one first comment/);
    expect(socialCreate).not.toHaveBeenCalled();
    expect(socialUpdate).not.toHaveBeenCalled();
  });
});
