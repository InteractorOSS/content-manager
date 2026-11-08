import { describe, expect, it } from "vitest";
import { formatManualQueueItem, formatSocialPost, formatTarget } from "./format";

const POST_MEDIA = [{ media_id: "m1", url: "https://cdn.example.com/1.png", type: "image" }];
const OWN_MEDIA = [{ media_id: "m2", url: "https://cdn.example.com/2.png", type: "image", alt: "Square crop" }];

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    channel_id: "c1",
    status: "awaiting_manual",
    body_override: null,
    media_override: null,
    next_attempt_at: null,
    published_at: null,
    inserted_at: new Date("2026-10-01T00:00:00Z"),
    updated_at: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    body: "Hello",
    link: null,
    media: POST_MEDIA,
    network: null,
    scheduled_at: null,
    published_at: null,
    approved_at: null,
    inserted_at: new Date("2026-10-01T00:00:00Z"),
    updated_at: new Date("2026-10-01T00:00:00Z"),
    targets: [],
    ...overrides,
  };
}

describe("formatTarget media_override", () => {
  it("serializes no override as null", () => {
    expect(formatTarget(target()).media_override).toBeNull();
    expect(formatTarget(target({ media_override: undefined })).media_override).toBeNull();
  });

  it("serializes an override as its list, and an empty override as []", () => {
    expect(formatTarget(target({ media_override: OWN_MEDIA })).media_override).toEqual(OWN_MEDIA);
    expect(formatTarget(target({ media_override: [] })).media_override).toEqual([]);
  });
});

describe("formatSocialPost", () => {
  it("serializes the post's media and each target's media_override", () => {
    const out = formatSocialPost(
      post({ targets: [target({ media_override: OWN_MEDIA }), target({ id: "t2", channel_id: "c2" })] })
    );
    expect(out.media).toEqual(POST_MEDIA);
    expect(out.targets.map((t: { media_override: unknown }) => t.media_override)).toEqual([OWN_MEDIA, null]);
  });

  it("reads a missing media column as no media", () => {
    expect(formatSocialPost(post({ media: null })).media).toEqual([]);
  });
});

describe("formatManualQueueItem media", () => {
  it("hands the person pasting the target's own media when it has an override", () => {
    const item = formatManualQueueItem(post(), target({ media_override: OWN_MEDIA }));
    expect(item.post.media).toEqual(OWN_MEDIA);
    expect(item.media_override).toEqual(OWN_MEDIA);
  });

  it("an empty override means nothing to attach", () => {
    expect(formatManualQueueItem(post(), target({ media_override: [] })).post.media).toEqual([]);
  });

  it("falls back to the post's media", () => {
    expect(formatManualQueueItem(post(), target()).post.media).toEqual(POST_MEDIA);
  });
});
