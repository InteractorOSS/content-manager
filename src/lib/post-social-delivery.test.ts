import { describe, expect, it, vi } from "vitest";
import {
  listPostDestinations,
  parseDestinationsSave,
  postBacklink,
  setPostDestinations,
  syncPostSocialDelivery,
} from "./post-social-delivery";
import type { TenantDb } from "@/lib/tenant-db";

type Channel = {
  id: string;
  service_id: string;
  service_name: string;
  account_name: string | null;
  account_id: string | null;
  status: string;
  default_target: boolean;
  delivery_mode: string;
};
type Draft = {
  id: string;
  network: string | null;
  link: string | null;
  status: string;
  targets: { id: string; channel_id: string; status: string }[];
};

/** The post's edit version; saving destinations must not move it. */
const VERSION = new Date("2026-10-01T00:00:00Z");

const page = (over: Partial<Channel>): Channel => ({
  id: "page-a",
  service_id: "facebook-graph-api",
  service_name: "Facebook Page",
  account_name: "Interactor",
  account_id: "1",
  status: "active",
  default_target: true,
  delivery_mode: "automated",
  ...over,
});

function fakeDb(opts: {
  post?: Record<string, unknown> | null;
  channels?: Channel[];
  sites?: { slug: string; url: string | null }[];
  drafts?: Draft[];
}) {
  const post =
    opts.post === null
      ? null
      : {
          id: "p1",
          slug: "hello-world",
          canonical_url: null,
          platforms: ["website"],
          social_destinations: null as unknown,
          updated_at: VERSION,
          ...opts.post,
        };
  const db = {
    post: {
      findUnique: vi.fn(async () => post),
      update: vi.fn(async ({ data }: { data: { social_destinations: unknown } }) => {
        // Prisma.DbNull is how a JSON column is cleared; a real database
        // reads it back as null.
        if (post) {
          post.social_destinations = Array.isArray(data.social_destinations) ? data.social_destinations : null;
        }
        return post;
      }),
    },
    socialChannel: { findMany: vi.fn(async () => opts.channels ?? []) },
    site: {
      findMany: vi.fn(async () => opts.sites ?? [{ slug: "website", url: "https://example.com/blog/" }]),
    },
    socialPost: {
      findMany: vi.fn(async () => (opts.drafts ?? []).filter((d) => d.status === "draft")),
      update: vi.fn(async () => ({})),
    },
    socialPostTarget: {
      createMany: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
  };
  return db as typeof db & TenantDb;
}

const postRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  slug: "hello-world",
  canonical_url: null as string | null,
  platforms: ["website"],
  social_destinations: null,
  ...over,
});

describe("postBacklink", () => {
  it("is the post's place on its first site that has a base URL", async () => {
    const db = fakeDb({});
    expect(await postBacklink(db, postRow())).toBe("https://example.com/blog/hello-world");
  });

  it("prefers the canonical URL", async () => {
    const db = fakeDb({});
    expect(await postBacklink(db, postRow({ canonical_url: " https://other.example/original " }))).toBe(
      "https://other.example/original"
    );
    expect(db.site.findMany).not.toHaveBeenCalled();
  });

  it("follows the post's own site order, skipping a site with no URL", async () => {
    const db = fakeDb({
      sites: [
        { slug: "second", url: "https://second.example" },
        { slug: "first", url: null },
      ],
    });
    expect(await postBacklink(db, postRow({ platforms: ["first", "second"] }))).toBe(
      "https://second.example/hello-world"
    );
  });

  it("is null rather than a guess when the post has no public address", async () => {
    expect(await postBacklink(fakeDb({ sites: [] }), postRow())).toBeNull();
    expect(await postBacklink(fakeDb({}), postRow({ platforms: [] }))).toBeNull();
  });
});

describe("listPostDestinations", () => {
  it("offers connected places, greys out the troubled, hides the unusable", async () => {
    const db = fakeDb({
      channels: [
        page({}),
        page({ id: "expired", status: "expired", account_name: "Old page" }),
        page({ id: "pending", status: "pending" }),
        page({ id: "manual", service_id: "facebook-personal", delivery_mode: "manual" }),
      ],
    });
    const result = await listPostDestinations(db, "p1");
    expect(result?.destinations.map((d) => [d.id, d.network, d.state, d.selected, d.manual])).toEqual([
      ["page-a", "facebook", "ready", true, false],
      ["expired", "facebook", "trouble", true, false],
      // A manual channel is a place too: its copy goes to the manual queue.
      ["manual", "facebook", "ready", true, true],
    ]);
    expect(result?.overridden).toBe(false);
    expect(result?.backlink).toBe("https://example.com/blog/hello-world");
  });

  it("reflects the post's own choice", async () => {
    const db = fakeDb({
      post: { social_destinations: ["page-b"] },
      channels: [page({}), page({ id: "page-b", default_target: false })],
    });
    const result = await listPostDestinations(db, "p1");
    expect(result?.overridden).toBe(true);
    expect(result?.destinations.map((d) => [d.id, d.selected, d.is_default])).toEqual([
      ["page-a", false, true],
      ["page-b", true, false],
    ]);
  });

  it("is null for a post that is gone", async () => {
    expect(await listPostDestinations(fakeDb({ post: null }), "p1")).toBeNull();
  });
});

describe("syncPostSocialDelivery", () => {
  it("gives a draft one target per chosen place of its network, and the backlink", async () => {
    const db = fakeDb({
      channels: [
        page({}),
        page({ id: "page-b" }),
        page({ id: "li", service_id: "linkedin", account_id: "urn:li:person:x" }),
      ],
      drafts: [{ id: "d1", network: "facebook", link: null, status: "draft", targets: [] }],
    });
    await syncPostSocialDelivery(db, "p1");
    expect(db.socialPostTarget.createMany).toHaveBeenCalledWith({
      data: [
        { post_id: "d1", channel_id: "page-a" },
        { post_id: "d1", channel_id: "page-b" },
      ],
    });
    expect(db.socialPost.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { link: "https://example.com/blog/hello-world" },
    });
  });

  it("removes a target the post no longer goes to, but never one already attempted", async () => {
    const db = fakeDb({
      post: { social_destinations: [] },
      channels: [page({}), page({ id: "page-b" })],
      drafts: [
        {
          id: "d1",
          network: "facebook",
          link: "https://example.com/blog/hello-world",
          status: "draft",
          targets: [
            { id: "t1", channel_id: "page-a", status: "pending" },
            { id: "t2", channel_id: "page-b", status: "published" },
          ],
        },
      ],
    });
    await syncPostSocialDelivery(db, "p1");
    expect(db.socialPostTarget.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } } });
    expect(db.socialPostTarget.createMany).not.toHaveBeenCalled();
    expect(db.socialPost.update).not.toHaveBeenCalled();
  });

  it("writes nothing when a draft already matches", async () => {
    const db = fakeDb({
      channels: [page({})],
      drafts: [
        {
          id: "d1",
          network: "facebook",
          link: "https://example.com/blog/hello-world",
          status: "draft",
          targets: [{ id: "t1", channel_id: "page-a", status: "pending" }],
        },
      ],
    });
    await syncPostSocialDelivery(db, "p1");
    expect(db.socialPostTarget.createMany).not.toHaveBeenCalled();
    expect(db.socialPostTarget.deleteMany).not.toHaveBeenCalled();
    expect(db.socialPost.update).not.toHaveBeenCalled();
  });

  it("leaves copy that was already submitted or scheduled alone", async () => {
    const db = fakeDb({
      channels: [page({})],
      drafts: [{ id: "d1", network: "facebook", link: null, status: "scheduled", targets: [] }],
    });
    await syncPostSocialDelivery(db, "p1");
    expect(db.socialPostTarget.createMany).not.toHaveBeenCalled();
    expect(db.socialPost.update).not.toHaveBeenCalled();
  });

  it("doesn't blank an existing link when the post has no public address", async () => {
    const db = fakeDb({
      sites: [],
      channels: [page({})],
      drafts: [
        {
          id: "d1",
          network: "facebook",
          link: "https://hand.example/typed",
          status: "draft",
          targets: [{ id: "t1", channel_id: "page-a", status: "pending" }],
        },
      ],
    });
    await syncPostSocialDelivery(db, "p1");
    expect(db.socialPost.update).not.toHaveBeenCalled();
  });
});

describe("setPostDestinations", () => {
  it("stores only this organization's channels, once each", async () => {
    const db = fakeDb({ channels: [page({}), page({ id: "page-b" })] });
    await setPostDestinations(db, "p1", ["page-b", "page-b", "someone-elses"]);
    expect(db.post.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { social_destinations: ["page-b"], updated_at: VERSION },
    });
  });

  it("does not move the post's edit version", async () => {
    // The writer editor treats a changed updated_at as someone else's edit.
    const db = fakeDb({ channels: [page({})] });
    await setPostDestinations(db, "p1", ["page-a"]);
    const [{ data }] = db.post.update.mock.calls[0] as unknown as [{ data: { updated_at: Date } }];
    expect(data.updated_at).toBe(VERSION);
  });

  it("null goes back to the channels' defaults", async () => {
    const db = fakeDb({ post: { social_destinations: ["page-b"] }, channels: [page({})] });
    const result = await setPostDestinations(db, "p1", null);
    const [{ data }] = db.post.update.mock.calls[0] as unknown as [{ data: { social_destinations: unknown } }];
    expect(Array.isArray(data.social_destinations)).toBe(false);
    expect(result?.overridden).toBe(false);
  });
});

describe("parseDestinationsSave", () => {
  it("accepts a list of ids or null", () => {
    expect(parseDestinationsSave({ channel_ids: ["a"] })).toEqual({ channelIds: ["a"] });
    expect(parseDestinationsSave({ channel_ids: [] })).toEqual({ channelIds: [] });
    expect(parseDestinationsSave({ channel_ids: null })).toEqual({ channelIds: null });
  });

  it("refuses anything else", () => {
    for (const bad of [{}, null, { channel_ids: "a" }, { channel_ids: [1] }]) {
      expect(parseDestinationsSave(bad)).toHaveProperty("error");
    }
  });
});
