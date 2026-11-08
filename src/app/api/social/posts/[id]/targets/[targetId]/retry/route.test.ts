import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "Retry this channel" is the manual half of the publishing invariant, so the
 * three ways it must refuse matter as much as the way it works:
 *
 *  - another org's target never runs (it is reached only THROUGH the
 *    tenant-scoped post, so it cannot be found at all);
 *  - an already-published target never runs, because retrying it would post
 *    the same copy to the network twice;
 *  - a target mid-flight never runs, for the same reason.
 *
 * The guard and the publisher are mocked wholesale — what's under test is the
 * route's own decisions.
 */

const ORG = "org1";

interface TargetRow {
  id: string;
  post_id: string;
  channel_id: string;
  status: string;
  attempt_count: number;
  error: string | null;
  next_attempt_at: Date | null;
}

interface PostRow {
  id: string;
  organization_id: string;
  status: string;
  targets: TargetRow[];
}

const postRows = new Map<string, PostRow>();
const permissions = new Set<string>(["content:publish"]);
const targetUpdates: { where: unknown; data: unknown }[] = [];
const postUpdates: { where: unknown; data: unknown }[] = [];

/** A tenant-scoped client: a post outside `ORG` simply does not resolve. */
const db = {
  socialPost: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const post = postRows.get(where.id);
      if (!post || post.organization_id !== ORG) return null;
      return { ...post, targets: post.targets.map((t) => ({ ...t })) };
    },
    updateMany: async (args: { where: unknown; data: unknown }) => {
      postUpdates.push(args);
      return { count: 1 };
    },
  },
  socialPostTarget: {
    updateMany: async (args: { where: unknown; data: unknown }) => {
      targetUpdates.push(args);
      return { count: 1 };
    },
  },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (_req: unknown, ...perms: string[]) => {
    const { NextResponse } = await import("next/server");
    const missing = perms.filter((p) => !permissions.has(p));
    if (missing.length > 0) {
      return {
        error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    return { actor: { user: { id: "u1" }, organizationId: ORG }, db };
  }),
}));

const publishTarget = vi.fn();
const rollUpPostStatus = vi.fn();
vi.mock("@/lib/social/publisher", () => ({
  publishTarget: (...a: unknown[]) => publishTarget(...a),
  rollUpPostStatus: (...a: unknown[]) => rollUpPostStatus(...a),
}));

import { POST } from "./route";

function call(postId: string, targetId: string) {
  return POST(
    new NextRequest(
      `http://localhost/api/social/posts/${postId}/targets/${targetId}/retry`,
      { method: "POST" }
    ),
    { params: Promise.resolve({ id: postId, targetId }) }
  );
}

function seed(overrides: Partial<TargetRow> = {}, postOverrides: Partial<PostRow> = {}) {
  postRows.set("p1", {
    id: "p1",
    organization_id: ORG,
    status: "publishing",
    targets: [
      {
        id: "t1",
        post_id: "p1",
        channel_id: "ch1",
        status: "failed",
        attempt_count: 3,
        error: "Slack couldn't be reached just now.",
        next_attempt_at: null,
        ...overrides,
      },
    ],
    ...postOverrides,
  });
}

beforeEach(() => {
  postRows.clear();
  targetUpdates.length = 0;
  postUpdates.length = 0;
  publishTarget.mockReset();
  rollUpPostStatus.mockReset();
  permissions.clear();
  permissions.add("content:publish");
});

describe("POST /api/social/posts/[id]/targets/[targetId]/retry", () => {
  it("queues the target, publishes it, and re-rolls the post", async () => {
    seed();

    const res = await call("p1", "t1");

    expect(res.status).toBe(200);
    expect(targetUpdates).toHaveLength(1);
    const data = targetUpdates[0].data as Record<string, unknown>;
    expect(data.status).toBe("pending");
    // A person asking again is a new decision, not a continuation of the
    // automatic attempts that already gave up.
    expect(data.attempt_count).toBe(0);
    expect(data.error).toBeNull();
    expect(data.next_attempt_at).toBeInstanceOf(Date);
    expect(publishTarget).toHaveBeenCalledWith("t1");
    expect(rollUpPostStatus).toHaveBeenCalledWith("p1");
  });

  it("refuses a target that already went out, rather than posting twice", async () => {
    seed({ status: "published" });

    const res = await call("p1", "t1");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This post is already live on that channel. Retrying would post it a second time.",
    });
    expect(publishTarget).not.toHaveBeenCalled();
  });

  it("refuses a target that is being tried right now", async () => {
    seed({ status: "publishing" });

    const res = await call("p1", "t1");

    expect(res.status).toBe(409);
    expect(publishTarget).not.toHaveBeenCalled();
  });

  it("never runs a target belonging to another organization", async () => {
    seed({}, { organization_id: "org2" });

    const res = await call("p1", "t1");

    expect(res.status).toBe(404);
    expect(publishTarget).not.toHaveBeenCalled();
    expect(targetUpdates).toHaveLength(0);
  });

  it("refuses a target id that is not on this post", async () => {
    seed();

    const res = await call("p1", "t-other");

    expect(res.status).toBe(404);
    expect(publishTarget).not.toHaveBeenCalled();
  });

  it("refuses a caller without content:publish", async () => {
    seed();
    permissions.clear();

    const res = await call("p1", "t1");

    expect(res.status).toBe(403);
    expect(publishTarget).not.toHaveBeenCalled();
  });
});
