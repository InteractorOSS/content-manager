import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { coreFixture } from "./__fixtures__/core";

/**
 * The invariant these tests exist for: a post that enters "publishing" always
 * reaches a terminal status. Before this module was fixed, one transient error
 * from Core parked a post there forever — the target went back to "pending",
 * the roll-up refused to finish while it sat there, and no query anywhere ever
 * looked at a "publishing" post again.
 *
 * Prisma is replaced by a small in-memory store that implements EXACTLY the
 * query shapes the publisher issues and throws on anything else, so the fake
 * cannot quietly diverge from the code under test by accepting a filter it
 * doesn't really honour.
 */

// --- in-memory Prisma ------------------------------------------------------

interface ChannelRow {
  id: string;
  service_id: string;
  service_name: string;
  account_name: string | null;
  account_id: string | null;
  external_user_id: string;
  credential_id?: string | null;
  status: string;
}

interface PostRow {
  id: string;
  organization_id: string;
  status: string;
  body: string;
  link: string | null;
  media: unknown;
  parts?: unknown;
  network?: string | null;
  scheduled_at: Date | null;
  published_at: Date | null;
  updated_at: Date;
}

interface TargetRow {
  id: string;
  post_id: string;
  channel_id: string;
  body_override: string | null;
  media_override?: unknown;
  media_uploads?: unknown;
  published_parts?: unknown;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  error: string | null;
  external_post_id: string | null;
  external_url: string | null;
  published_at: Date | null;
  /** Prisma's `@updatedAt`; the fake bumps it on every write, as Postgres does. */
  updated_at: Date;
}

vi.mock("server-only", () => ({}));

const channels = new Map<string, ChannelRow>();
const posts = new Map<string, PostRow>();
const targets = new Map<string, TargetRow>();

interface MediaRow {
  id: string;
  organization_id: string;
  file_path: string;
  mime_type: string;
}
/** The media library, every org's rows in one table as in Postgres. */
const library = new Map<string, MediaRow>();

type Scalar = string | number | Date | null | undefined;

/** `status: "pending"`, `{ in: [...] }`, `{ notIn: [...] }`, `{ lte: date }`. */
function matchScalar(value: Scalar, filter: unknown): boolean {
  if (filter === null) return value === null;
  if (
    typeof filter === "string" ||
    typeof filter === "number" ||
    filter instanceof Date
  ) {
    return String(value) === String(filter);
  }
  if (filter && typeof filter === "object") {
    const f = filter as Record<string, unknown>;
    for (const key of Object.keys(f)) {
      if (key === "in") {
        if (!(f.in as unknown[]).includes(value as never)) return false;
      } else if (key === "notIn") {
        if ((f.notIn as unknown[]).includes(value as never)) return false;
      } else if (key === "lte") {
        if (value === null || value === undefined) return false;
        if ((value as Date).getTime() > (f.lte as Date).getTime()) return false;
      } else if (key === "lt") {
        if (value === null || value === undefined) return false;
        if ((value as Date).getTime() >= (f.lt as Date).getTime()) return false;
      } else {
        throw new Error(`fake prisma: unsupported scalar filter "${key}"`);
      }
    }
    return true;
  }
  throw new Error(`fake prisma: unsupported filter ${JSON.stringify(filter)}`);
}

function matchTarget(row: TargetRow, where: Record<string, unknown>): boolean {
  for (const [key, filter] of Object.entries(where)) {
    if (key === "OR") {
      const branches = filter as Record<string, unknown>[];
      if (!branches.some((b) => matchTarget(row, b))) return false;
      continue;
    }
    if (
      !["id", "post_id", "channel_id", "status", "next_attempt_at", "updated_at"].includes(
        key
      )
    ) {
      throw new Error(`fake prisma: unsupported target filter "${key}"`);
    }
    if (!matchScalar(row[key as keyof TargetRow] as Scalar, filter)) return false;
  }
  return true;
}

function matchPost(row: PostRow, where: Record<string, unknown>): boolean {
  for (const [key, filter] of Object.entries(where)) {
    if (key === "OR") {
      const branches = filter as Record<string, unknown>[];
      if (!branches.some((b) => matchPost(row, b))) return false;
      continue;
    }
    if (key === "targets") {
      const rel = filter as { some?: Record<string, unknown>; none?: Record<string, unknown> };
      const mine = [...targets.values()].filter((t) => t.post_id === row.id);
      if (rel.some && !mine.some((t) => matchTarget(t, rel.some!))) return false;
      if (rel.none && mine.some((t) => matchTarget(t, rel.none!))) return false;
      continue;
    }
    if (!["id", "status", "scheduled_at"].includes(key)) {
      throw new Error(`fake prisma: unsupported post filter "${key}"`);
    }
    if (!matchScalar(row[key as keyof PostRow] as Scalar, filter)) return false;
  }
  return true;
}

function applyData<T extends object>(row: T, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in (value as object)) {
      (row as Record<string, unknown>)[key] =
        ((row as Record<string, number>)[key] ?? 0) +
        (value as { increment: number }).increment;
    } else {
      (row as Record<string, unknown>)[key] = value;
    }
  }
}

const fakePrisma = {
  media: {
    // Exactly the lookup the publisher makes: org-scoped, by id or file_path.
    findMany: async ({
      where,
    }: {
      where: {
        organization_id: string;
        OR: [{ id: { in: string[] } }, { file_path: { in: string[] } }];
        [key: string]: unknown;
      };
    }) => {
      const keys = Object.keys(where).sort().join(",");
      if (keys !== "OR,organization_id") throw new Error(`fake prisma: unsupported media filter "${keys}"`);
      const [{ id: ids }, { file_path: paths }] = where.OR;
      return [...library.values()]
        .filter(
          (m) =>
            m.organization_id === where.organization_id &&
            (ids.in.includes(m.id) || paths.in.includes(m.file_path))
        )
        .map((m) => ({ id: m.id, file_path: m.file_path, mime_type: m.mime_type }));
    },
  },
  socialPostTarget: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = targets.get(where.id);
      if (!row) return null;
      return {
        ...row,
        post: posts.get(row.post_id)!,
        channel: channels.get(row.channel_id)!,
      };
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      [...targets.values()]
        .filter((t) => matchTarget(t, where))
        .map((t) => ({ ...t, channel: channels.get(t.channel_id)! })),
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = targets.get(where.id);
      if (!row) throw new Error("fake prisma: target not found");
      applyData(row, data);
      row.updated_at = new Date();
      return { ...row };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const matched = [...targets.values()].filter((t) => matchTarget(t, where));
      matched.forEach((row) => {
        applyData(row, data);
        row.updated_at = new Date();
      });
      return { count: matched.length };
    },
  },
  socialPost: {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      [...posts.values()].filter((p) => matchPost(p, where)).map((p) => ({ ...p })),
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = posts.get(where.id);
      if (!row) throw new Error("fake prisma: post not found");
      applyData(row, data);
      return { ...row };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const matched = [...posts.values()].filter((p) => matchPost(p, where));
      matched.forEach((row) => applyData(row, data));
      return { count: matched.length };
    },
  },
};

// Getters, not values: vi.mock factories are hoisted above the store above,
// so the fake can only be read lazily, when the publisher actually queries.
vi.mock("@/lib/db", () => ({
  get prisma() {
    return fakePrisma;
  },
  get db() {
    return fakePrisma;
  },
}));

const executeServiceAction = vi.fn();
const executeServiceUpload = vi.fn();
const readMediaFile = vi.fn();

vi.mock("@/lib/media-storage", () => ({
  readMediaFile: (...args: unknown[]) => readMediaFile(...args),
  MediaFileMissingError: class MediaFileMissingError extends Error {
    name = "MediaFileMissingError";
  },
}));

class FakeInteractorError extends Error {
  name = "InteractorError";
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
    public retryAfterSeconds?: number
  ) {
    super(message);
  }
}

vi.mock("@/lib/interactor", () => ({
  executeServiceAction: (...args: unknown[]) => executeServiceAction(...args),
  executeServiceUpload: (...args: unknown[]) => executeServiceUpload(...args),
  // The real parser lives in interactor.ts, tested there; these cases only
  // need "no headers relayed".
  responseHeaders: () => ({}),
  get InteractorError() {
    return FakeInteractorError;
  },
}));

import {
  publishDuePosts,
  publishPost,
  publishTarget,
  sweepStalledTargets,
} from "./publisher";

// --- fixtures --------------------------------------------------------------

function seedChannel(id: string, overrides: Partial<ChannelRow> = {}): ChannelRow {
  const row: ChannelRow = {
    id,
    service_id: "slack",
    service_name: "Slack",
    account_name: "#launches",
    account_id: "C123",
    external_user_id: `cms-ch-${id}`,
    status: "active",
    ...overrides,
  };
  channels.set(id, row);
  return row;
}

/** Library rows in `org` for every media item the tests attach. */
function seedLibrary(org: string): void {
  for (const m of [
    ...TWO_IMAGES,
    { media_id: "m_post", url: "https://cdn.example.com/post.png", type: "image" },
    { media_id: "m_ig", url: "https://cdn.example.com/square.png", type: "image" },
    { media_id: "v1", url: "https://cdn.example.com/clip.mp4", type: "video" },
  ]) {
    library.set(m.media_id, {
      id: m.media_id,
      organization_id: org,
      file_path: m.url,
      mime_type: m.type === "video" ? "video/mp4" : "image/png",
    });
  }
}

function seedPost(id: string, overrides: Partial<PostRow> = {}): PostRow {
  const row: PostRow = {
    id,
    organization_id: "org1",
    status: "scheduled",
    body: "Ship it",
    link: null,
    media: [],
    scheduled_at: new Date(Date.now() - 1000),
    published_at: null,
    updated_at: new Date(),
    ...overrides,
  };
  posts.set(id, row);
  return row;
}

function seedTarget(
  id: string,
  postId: string,
  channelId: string,
  overrides: Partial<TargetRow> = {}
): TargetRow {
  const row: TargetRow = {
    id,
    post_id: postId,
    channel_id: channelId,
    body_override: null,
    status: "pending",
    attempt_count: 0,
    next_attempt_at: null,
    error: null,
    external_post_id: null,
    external_url: null,
    published_at: null,
    updated_at: new Date(),
    ...overrides,
  };
  targets.set(id, row);
  return row;
}

const TWO_IMAGES = [
  { media_id: "m1", url: "https://cdn.example.com/1791400000000_launch.png", type: "image" },
  { media_id: "m2", url: "https://cdn.example.com/1791400000001_team.jpg", type: "image" },
];

beforeEach(() => {
  channels.clear();
  posts.clear();
  targets.clear();
  library.clear();
  seedLibrary("org1");
  executeServiceAction.mockReset();
  executeServiceUpload.mockReset();
  readMediaFile.mockReset();
  readMediaFile.mockImplementation(async (url: string) => ({
    bytes: new TextEncoder().encode(url),
    contentType: "image/png",
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- tests -----------------------------------------------------------------

describe("publishTarget", () => {
  it("parks a transiently failed target as pending WITH a due time, post still publishing", async () => {
    seedChannel("ch1");
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    executeServiceAction.mockRejectedValue(
      new FakeInteractorError(502, "upstream request failed")
    );

    await publishPost("p1");

    const target = targets.get("t1")!;
    expect(target.status).toBe("pending");
    expect(target.attempt_count).toBe(1);
    expect(target.next_attempt_at).toBeInstanceOf(Date);
    expect(target.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    // The sentence stored is the one a reader gets — no raw status code.
    expect(target.error).not.toMatch(/^\d{3}:/);
    expect(target.error).toContain("Slack");
    expect(posts.get("p1")!.status).toBe("publishing");
  });

  it("honours Core's own Retry-After instead of the default backoff", async () => {
    seedChannel("ch1");
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    executeServiceAction.mockRejectedValue(
      new FakeInteractorError(429, "slow down", undefined, 900)
    );

    const before = Date.now();
    await publishPost("p1");

    const waitMs = targets.get("t1")!.next_attempt_at!.getTime() - before;
    // 900s from Core, not the 60s first-attempt default.
    expect(waitMs).toBeGreaterThan(890_000);
    expect(waitMs).toBeLessThan(910_000);
  });

  it("fails an exhausted target and lands the post at failed", async () => {
    seedChannel("ch1");
    seedPost("p1");
    seedTarget("t1", "p1", "ch1", { attempt_count: 2 });
    executeServiceAction.mockRejectedValue(
      new FakeInteractorError(503, "unavailable")
    );

    await publishPost("p1");

    expect(targets.get("t1")!.status).toBe("failed");
    expect(targets.get("t1")!.next_attempt_at).toBeNull();
    expect(posts.get("p1")!.status).toBe("failed");
  });

  it("stops retrying a refusal another attempt cannot get past", async () => {
    seedChannel("ch1");
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    executeServiceAction.mockRejectedValue(
      new FakeInteractorError(401, "credential revoked")
    );

    await publishPost("p1");

    expect(targets.get("t1")!.status).toBe("failed");
    expect(targets.get("t1")!.error).toMatch(/Reconnect it/);
    expect(executeServiceAction).toHaveBeenCalledTimes(1);
  });

  it("never calls Core for a channel that is not connected", async () => {
    seedChannel("ch1", { status: "expired" });
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");

    await publishPost("p1");

    expect(executeServiceAction).not.toHaveBeenCalled();
    const target = targets.get("t1")!;
    expect(target.status).toBe("failed");
    expect(target.attempt_count).toBe(0);
    expect(target.error).toContain("Slack (#launches)");
    expect(target.error).toContain("expired");
    // The failure still counts, so the post lands terminal rather than hanging.
    expect(posts.get("p1")!.status).toBe("failed");
  });

  it("never sends a body the network's own limit rules out", async () => {
    // The routes refuse this on save now, so what reaches here is a row
    // stored before that check existed. Sending it can only come back as an
    // opaque provider rejection, which is the stuck-target mechanism arriving
    // through a different door.
    seedChannel("ch1", {
      service_id: "twitter",
      service_name: "X (Twitter)",
      account_name: "@interactor",
    });
    seedPost("p1", { body: "a".repeat(400) });
    seedTarget("t1", "p1", "ch1");

    await publishPost("p1");

    expect(executeServiceAction).not.toHaveBeenCalled();
    const target = targets.get("t1")!;
    expect(target.status).toBe("failed");
    // Nothing was sent, so no attempt was spent on it.
    expect(target.attempt_count).toBe(0);
    expect(target.error).toContain("X (Twitter) (@interactor)");
    expect(target.error).toContain("280 characters");
    expect(target.error).toMatch(/retry this channel/);
    expect(target.next_attempt_at).toBeNull();
    // And the post still lands terminal rather than hanging at "publishing".
    expect(posts.get("p1")!.status).toBe("failed");
  });

  it("measures a channel's own copy, not the shared body, against its limit", async () => {
    seedChannel("ch1", {
      service_id: "twitter",
      service_name: "X (Twitter)",
      account_name: "@interactor",
    });
    seedPost("p1", { body: "a".repeat(400) });
    seedTarget("t1", "p1", "ch1", { body_override: "Short enough for X" });
    executeServiceAction.mockResolvedValue({ data: { data: { id: "9" } } });

    await publishPost("p1");

    expect(executeServiceAction).toHaveBeenCalledTimes(1);
    expect(targets.get("t1")!.status).toBe("published");
  });

  it("publishes as the channel's own credential, not the identity's default", async () => {
    // One connection's rows share a credential, and a reconnect can leave an
    // older one on the same Core identity — so the row names which to use.
    seedChannel("ch1", { credential_id: "cred_current" });
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    executeServiceAction.mockResolvedValue({ data: { ts: "1700.5" } });

    await publishPost("p1");

    expect(executeServiceAction).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "slack",
        externalUserId: "cms-ch-ch1",
        credentialId: "cred_current",
      })
    );
    expect(targets.get("t1")!.status).toBe("published");
  });

  it("publishes a target's own media in place of the post's (punchlist S1)", async () => {
    seedChannel("ch1", { service_id: "instagram", service_name: "IG", account_id: "ig1" });
    seedPost("p1", {
      media: [{ media_id: "m_post", url: "https://cdn.example.com/post.png", type: "image" }],
    });
    seedTarget("t1", "p1", "ch1", {
      media_override: [{ media_id: "m_ig", url: "https://cdn.example.com/square.png", type: "image" }],
    });
    executeServiceAction
      .mockResolvedValueOnce({ data: { id: "container1" } })
      .mockResolvedValueOnce({ data: { id: "igpost1" } });

    await publishPost("p1");

    expect(executeServiceAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        capabilityName: "create_media_container",
        args: expect.objectContaining({ image_url: "https://cdn.example.com/square.png" }),
      })
    );
    expect(targets.get("t1")!.status).toBe("published");
  });

  it("falls back to the post's media when the target has no override", async () => {
    seedChannel("ch1", { service_id: "instagram", service_name: "IG", account_id: "ig1" });
    seedPost("p1", {
      media: [{ media_id: "m_post", url: "https://cdn.example.com/post.png", type: "image" }],
    });
    seedTarget("t1", "p1", "ch1", { media_override: null });
    executeServiceAction
      .mockResolvedValueOnce({ data: { id: "container1" } })
      .mockResolvedValueOnce({ data: { id: "igpost1" } });

    await publishPost("p1");

    expect(executeServiceAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: expect.objectContaining({ image_url: "https://cdn.example.com/post.png" }),
      })
    );
  });

  it("uploads each image once: a retry reuses what the failed attempt uploaded", async () => {
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_id: null });
    seedPost("p1", { media: [TWO_IMAGES[0], TWO_IMAGES[1]] });
    seedTarget("t1", "p1", "ch1");
    let n = 0;
    executeServiceUpload.mockImplementation(async () => ({ data: { data: { id: `x_media_${++n}` } } }));
    executeServiceAction
      .mockRejectedValueOnce(new FakeInteractorError(503, "unavailable"))
      .mockResolvedValueOnce({ data: { data: { id: "1843" } } });

    await publishTarget("t1");
    const parked = targets.get("t1")!;
    expect(parked.status).toBe("pending");
    // Recorded as they landed, so the next attempt can find them.
    expect(Object.values(parked.media_uploads as Record<string, { id: string }>).map((u) => u.id)).toEqual([
      "x_media_1",
      "x_media_2",
    ]);

    await publishTarget("t1");

    expect(executeServiceUpload).toHaveBeenCalledTimes(2);
    expect(readMediaFile).toHaveBeenCalledTimes(2);
    expect(executeServiceAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capabilityName: "create_post",
        args: expect.objectContaining({ media: { media_ids: ["x_media_1", "x_media_2"] } }),
      })
    );
    const done = targets.get("t1")!;
    expect(done.status).toBe("published");
    expect(done.external_url).toBe("https://x.com/i/web/status/1843");
    expect(done.media_uploads).toBe(Prisma.DbNull);
  });

  it("uploads again once a recorded upload is too old to trust", async () => {
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_id: null });
    seedPost("p1", { media: [TWO_IMAGES[0]] });
    seedTarget("t1", "p1", "ch1", {
      media_uploads: {
        "twitter:upload::m1": { id: "stale", at: new Date(Date.now() - 13 * 3600_000).toISOString() },
      },
    });
    executeServiceUpload.mockResolvedValue({ data: { data: { id: "fresh" } } });
    executeServiceAction.mockResolvedValue({ data: { data: { id: "1843" } } });

    await publishTarget("t1");

    expect(executeServiceUpload).toHaveBeenCalledTimes(1);
    expect(executeServiceAction).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.objectContaining({ media: { media_ids: ["fresh"] } }) })
    );
  });

  it("fails a stored post whose media the network won't take, without calling Core", async () => {
    // Facebook Pages take photos only; a row saved before that rule existed
    // must not go out as text with the video silently dropped.
    seedChannel("ch1", { service_id: "facebook-graph-api", service_name: "Facebook Page", account_id: "pg1" });
    seedPost("p1", { media: [{ media_id: "v1", url: "https://cdn.example.com/clip.mp4", type: "video" }] });
    seedTarget("t1", "p1", "ch1");

    await publishPost("p1");

    expect(executeServiceAction).not.toHaveBeenCalled();
    expect(executeServiceUpload).not.toHaveBeenCalled();
    const target = targets.get("t1")!;
    expect(target.status).toBe("failed");
    expect(target.attempt_count).toBe(0);
    expect(target.error).toBe(
      "Nothing was posted to Facebook Page (#launches). Facebook Page takes up to 10 photos (no video); this post has 1 video. Change the images or video for this channel, then retry it."
    );
  });

  it("stops at a library file that no longer exists, and says which", async () => {
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_id: null });
    seedPost("p1", { media: [TWO_IMAGES[0], TWO_IMAGES[1]] });
    seedTarget("t1", "p1", "ch1");
    executeServiceUpload.mockResolvedValue({ data: { data: { id: "x1" } } });
    readMediaFile
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "MediaFileMissingError" }));

    await publishTarget("t1");

    const target = targets.get("t1")!;
    expect(executeServiceAction).not.toHaveBeenCalled();
    expect(target.status).toBe("failed");
    expect(target.error).toBe(
      "Nothing was posted to X (#launches): image 2 of 2 (team.jpg) is no longer in your media library. Pick the file again or remove it from this post, then retry this channel."
    );
  });

  it("reads the bytes from the library row's file_path, never the url stored on the post", async () => {
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_id: null });
    // An imported or hand-edited row whose JSON names an internal address.
    seedPost("p1", {
      media: [{ media_id: "m1", url: "http://169.254.169.254/latest/meta-data/", type: "image" }],
    });
    seedTarget("t1", "p1", "ch1");
    executeServiceUpload.mockResolvedValue({ data: { data: { id: "x1" } } });
    executeServiceAction.mockResolvedValue({ data: { data: { id: "1843" } } });

    await publishTarget("t1");

    expect(readMediaFile).toHaveBeenCalledTimes(1);
    expect(readMediaFile).toHaveBeenCalledWith(TWO_IMAGES[0].url);
    expect(targets.get("t1")!.status).toBe("published");
  });

  it.each([
    ["another organization's", () => library.set("m2", { ...library.get("m2")!, organization_id: "org2" })],
    ["a deleted", () => library.delete("m2")],
  ])("fails a target naming %s media id without reading or sending anything", async (_, arrange) => {
    arrange();
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_id: null });
    seedPost("p1", { media: [TWO_IMAGES[0], TWO_IMAGES[1]] });
    seedTarget("t1", "p1", "ch1");

    await publishTarget("t1");

    expect(readMediaFile).not.toHaveBeenCalled();
    expect(executeServiceUpload).not.toHaveBeenCalled();
    expect(executeServiceAction).not.toHaveBeenCalled();
    const target = targets.get("t1")!;
    expect(target.status).toBe("failed");
    expect(target.attempt_count).toBe(0);
    expect(target.error).toBe(
      "Nothing was posted to X (#launches): image 2 of 2 (team.jpg) is no longer in your media library. Pick the file again or remove it from this post, then retry this channel."
    );
  });

  it("fails an item saved without a media_id whose url is no file in the org's library", async () => {
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_id: null });
    seedPost("p1", { media: [{ url: "https://www.interactor.com/old.webp", type: "image" }] });
    seedTarget("t1", "p1", "ch1");

    await publishTarget("t1");

    expect(readMediaFile).not.toHaveBeenCalled();
    expect(targets.get("t1")!.status).toBe("failed");
    expect(targets.get("t1")!.error).toMatch(/is no longer in your media library/);
  });

  it("does not re-publish a target another worker already claimed", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "publishing",
      next_attempt_at: new Date(Date.now() + 60_000),
    });

    await publishTarget("t1");

    expect(executeServiceAction).not.toHaveBeenCalled();
    expect(targets.get("t1")!.status).toBe("publishing");
  });

  it("posts one copy when two passes over the same post overlap", async () => {
    // The guard above proves a pre-claimed row is skipped; this proves the
    // interleaving itself — two workers starting from the same pending row.
    seedChannel("ch1");
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    executeServiceAction.mockResolvedValue({ data: { ts: "1700.4" } });

    await Promise.all([publishPost("p1"), publishPost("p1")]);

    expect(executeServiceAction).toHaveBeenCalledTimes(1);
    expect(targets.get("t1")!.attempt_count).toBe(1);
    expect(targets.get("t1")!.status).toBe("published");
    expect(posts.get("p1")!.status).toBe("published");
  });

  it("rolls a mixed post up to partially_published", async () => {
    seedChannel("ch1");
    seedChannel("ch2", { service_name: "Facebook Page", service_id: "facebook-graph-api", status: "revoked" });
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    seedTarget("t2", "p1", "ch2");
    executeServiceAction.mockResolvedValue({ data: { ts: "1700.1" } });

    await publishPost("p1");

    expect(targets.get("t1")!.status).toBe("published");
    expect(targets.get("t2")!.status).toBe("failed");
    expect(posts.get("p1")!.status).toBe("partially_published");
  });

  it("fails a post that was told to publish with no channels left", async () => {
    seedPost("p1");

    await publishPost("p1");

    expect(posts.get("p1")!.status).toBe("failed");
  });
});

describe("publishTarget: posts as ordered parts", () => {
  const THREAD = [
    { kind: "thread", body: "Second tweet of the thread" },
    { kind: "thread", body: "Third tweet of the thread" },
  ];
  const xChannel = () =>
    seedChannel("ch1", { service_id: "twitter", service_name: "X", account_name: "@interactor", account_id: null });
  /** What Core answers, by fixture, in order. */
  const answer = (...names: string[]) => {
    for (const name of names) executeServiceAction.mockResolvedValueOnce(coreFixture(name));
  };
  const sent = () =>
    executeServiceAction.mock.calls.map(([call]) => (call as { args: Record<string, unknown> }).args);

  it("publishes a thread as a reply chain and records every tweet's id on the target", async () => {
    xChannel();
    seedPost("p1", { body: "Ship it", parts: THREAD });
    seedTarget("t1", "p1", "ch1");
    answer("twitter.create_post", "twitter.create_post.reply", "twitter.create_post.reply.second");

    await publishPost("p1");

    expect(sent()).toEqual([
      { text: "Ship it" },
      { text: "Second tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210987" } },
      { text: "Third tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210988" } },
    ]);
    const target = targets.get("t1")!;
    expect(target.status).toBe("published");
    expect(target.external_url).toBe("https://x.com/i/web/status/1843219876543210987");
    expect((target.published_parts as { id: string }[]).map((p) => p.id)).toEqual([
      "1843219876543210987",
      "1843219876543210988",
      "1843219876543210989",
    ]);
    expect(posts.get("p1")!.status).toBe("published");
  });

  it("keeps the root live when tweet 2 fails, and the retry resumes at tweet 2 without reposting it", async () => {
    xChannel();
    seedPost("p1", { body: "Ship it", parts: THREAD });
    seedTarget("t1", "p1", "ch1");
    answer("twitter.create_post");
    executeServiceAction.mockRejectedValueOnce(new FakeInteractorError(503, "upstream request failed"));

    await publishPost("p1");

    let target = targets.get("t1")!;
    // Retryable, so back in the queue with a due time; the post isn't done.
    expect(target.status).toBe("pending");
    expect(target.next_attempt_at).toBeInstanceOf(Date);
    expect(posts.get("p1")!.status).toBe("publishing");
    // The root is live, recorded, and already the target's address.
    expect((target.published_parts as { id: string }[]).map((p) => p.id)).toEqual(["1843219876543210987"]);
    expect(target.external_url).toBe("https://x.com/i/web/status/1843219876543210987");
    expect(target.error).toBe(
      "The first tweet is live on X (@interactor), but tweet 2 of 3 didn't go out yet: the network couldn't take it just now. It will be tried again automatically; a retry continues from tweet 2 without posting what is already live."
    );

    // The scheduler's retry, once due.
    target.next_attempt_at = new Date(Date.now() - 1000);
    executeServiceAction.mockReset();
    answer("twitter.create_post.reply", "twitter.create_post.reply.second");
    await publishDuePosts();

    expect(sent()).toEqual([
      { text: "Second tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210987" } },
      { text: "Third tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210988" } },
    ]);
    target = targets.get("t1")!;
    expect(target.status).toBe("published");
    expect(target.attempt_count).toBe(2);
    expect(target.external_url).toBe("https://x.com/i/web/status/1843219876543210987");
    expect((target.published_parts as unknown[]).length).toBe(3);
    expect(posts.get("p1")!.status).toBe("published");
  });

  it("publishes X copy written before parts existed as the thread its --- lines describe", async () => {
    // The old AI fan-out stored a thread as one body; sent whole it was one
    // tweet over X's limit, which X could only refuse.
    xChannel();
    const tweet = (c: string) => c.repeat(200);
    seedPost("p1", { body: `${tweet("a")}\n---\n${tweet("b")}`, network: "twitter", parts: null });
    seedTarget("t1", "p1", "ch1");
    answer("twitter.create_post", "twitter.create_post.reply");

    await publishPost("p1");

    expect(sent()).toEqual([
      { text: tweet("a") },
      { text: tweet("b"), reply: { in_reply_to_tweet_id: "1843219876543210987" } },
    ]);
    expect(targets.get("t1")!.status).toBe("published");
  });

  it("refuses a stored thread with one tweet over the limit, naming that tweet, and sends nothing", async () => {
    xChannel();
    seedPost("p1", { body: "Short", parts: [{ kind: "thread", body: "b".repeat(300) }] });
    seedTarget("t1", "p1", "ch1");

    await publishPost("p1");

    expect(executeServiceAction).not.toHaveBeenCalled();
    const target = targets.get("t1")!;
    expect(target.status).toBe("failed");
    expect(target.attempt_count).toBe(0);
    expect(target.error).toBe(
      "Tweet 2 of 2 for X (@interactor) is 300 characters long, and X only accepts 280 characters. Shorten it by 20 characters, then retry this channel."
    );
  });
});

describe("publishDuePosts", () => {
  it("re-picks a post parked at publishing once its retry is due, and finishes it", async () => {
    seedChannel("ch1");
    seedPost("p1");
    seedTarget("t1", "p1", "ch1");
    executeServiceAction.mockRejectedValueOnce(
      new FakeInteractorError(502, "upstream request failed")
    );

    // Tick one: scheduled post is claimed, the only channel fails transiently.
    await publishDuePosts();
    expect(posts.get("p1")!.status).toBe("publishing");
    expect(targets.get("t1")!.status).toBe("pending");

    // Time passes past the backoff.
    targets.get("t1")!.next_attempt_at = new Date(Date.now() - 1000);
    executeServiceAction.mockResolvedValue({ data: { ts: "1700.2" } });

    // Tick two: nothing is "scheduled" any more, yet the post is picked up.
    const worked = await publishDuePosts();

    expect(worked).toBe(1);
    expect(targets.get("t1")!.status).toBe("published");
    expect(posts.get("p1")!.status).toBe("published");
  });

  it("leaves a retry alone until its due time", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "pending",
      attempt_count: 1,
      next_attempt_at: new Date(Date.now() + 300_000),
    });

    expect(await publishDuePosts()).toBe(0);
    expect(executeServiceAction).not.toHaveBeenCalled();
  });

  it("finishes a post whose targets are all terminal but never rolled up", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", { status: "published" });

    await publishDuePosts();

    expect(posts.get("p1")!.status).toBe("published");
  });
});

describe("sweepStalledTargets", () => {
  it("hands a target stranded mid-flight back to the queue", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "publishing",
      attempt_count: 1,
      next_attempt_at: new Date(Date.now() - 60_000),
    });

    const swept = await sweepStalledTargets();

    expect(swept).toBe(1);
    expect(targets.get("t1")!.status).toBe("pending");
  });

  it("leaves an in-flight attempt inside its lease alone", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "publishing",
      attempt_count: 1,
      next_attempt_at: new Date(Date.now() + 120_000),
    });

    expect(await sweepStalledTargets()).toBe(0);
    expect(targets.get("t1")!.status).toBe("publishing");
  });

  it("rescues a target the OLD code stranded, which carries no lease deadline", async () => {
    // Every row written before `next_attempt_at` existed has it null, so the
    // lease has to come from `updated_at` or these posts stay at "publishing"
    // forever — the exact state this module was changed to remove.
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "publishing",
      attempt_count: 1,
      next_attempt_at: null,
      updated_at: new Date(Date.now() - 30 * 60_000),
    });
    executeServiceAction.mockResolvedValue({ data: { ts: "1700.3" } });

    const swept = await sweepStalledTargets();
    expect(swept).toBe(1);
    expect(targets.get("t1")!.status).toBe("pending");

    // And the post it was blocking now reaches a terminal status.
    await publishDuePosts();
    expect(targets.get("t1")!.status).toBe("published");
    expect(posts.get("p1")!.status).toBe("published");
  });

  it("leaves an old-style in-flight row alone until its lease has run", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "publishing",
      attempt_count: 1,
      next_attempt_at: null,
      updated_at: new Date(Date.now() - 60_000),
    });

    expect(await sweepStalledTargets()).toBe(0);
    expect(targets.get("t1")!.status).toBe("publishing");
    expect(executeServiceAction).not.toHaveBeenCalled();
  });

  it("fails a stranded target that has no attempts left, so the post can finish", async () => {
    seedChannel("ch1");
    seedPost("p1", { status: "publishing" });
    seedTarget("t1", "p1", "ch1", {
      status: "publishing",
      attempt_count: 3,
      next_attempt_at: new Date(Date.now() - 60_000),
    });

    await publishDuePosts();

    expect(targets.get("t1")!.status).toBe("failed");
    expect(targets.get("t1")!.error).toContain("Slack");
    expect(posts.get("p1")!.status).toBe("failed");
  });
});
