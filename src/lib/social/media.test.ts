import { describe, expect, it } from "vitest";
import {
  matchLibraryMedia,
  mediaTypeFromMime,
  resolveTargetMedia,
  storedMediaOverride,
} from "./media";
import { SERVICE_ADAPTERS, networkRules, validateAgainstNetworkRules } from "./capabilities";
import { checkNetworkRules } from "./network-rules";

const img = { url: "https://cdn.example.com/i.png", type: "image" };
const vid = { url: "https://cdn.example.com/v.mp4", type: "video" };
const n = (count: number, item: typeof img) => Array.from({ length: count }, () => item);

const CHANNELS = {
  twitter: { id: "c_tw", service_id: "twitter", service_name: "Brand X", account_id: null },
  instagram: { id: "c_ig", service_id: "instagram", service_name: "Brand IG", account_id: "ig1" },
  linkedin: { id: "c_li", service_id: "linkedin", service_name: "Brand LI", account_id: "urn:li:organization:1" },
  facebook: { id: "c_fb", service_id: "facebook-graph-api", service_name: "Brand FB", account_id: "p1" },
  slack: { id: "c_sl", service_id: "slack", service_name: "Team", account_id: "C1" },
};

/** The media violations `media` gets on `channel`. */
function mediaViolations(channel: (typeof CHANNELS)[keyof typeof CHANNELS], media: typeof img[]) {
  return validateAgainstNetworkRules(channel, { body: "hi", media }).filter(
    (v) => v.code === "media_limit" || v.code === "missing_media"
  );
}

describe("mediaTypeFromMime", () => {
  it("maps images and videos and refuses everything else", () => {
    expect(mediaTypeFromMime("image/png")).toBe("image");
    expect(mediaTypeFromMime("video/mp4")).toBe("video");
    expect(mediaTypeFromMime("application/pdf")).toBeNull();
  });
});

describe("validateAgainstNetworkRules — per-network media count and type", () => {
  it("X: up to 4 images, or 1 video on its own", () => {
    expect(mediaViolations(CHANNELS.twitter, n(4, img))).toEqual([]);
    expect(mediaViolations(CHANNELS.twitter, n(1, vid))).toEqual([]);
    expect(mediaViolations(CHANNELS.twitter, n(5, img))).toEqual([
      {
        code: "media_limit",
        channel_id: "c_tw",
        message:
          "Brand X (X (Twitter)) takes up to 4 images, or 1 video on its own; this post has 5 images.",
      },
    ]);
    expect(mediaViolations(CHANNELS.twitter, n(2, vid))).toHaveLength(1);
    expect(mediaViolations(CHANNELS.twitter, [img, vid])[0].message).toMatch(/1 video and 1 image/);
  });

  it("Instagram: 1, or a carousel of 2 to 10 (videos may sit in it), and never none", () => {
    expect(mediaViolations(CHANNELS.instagram, n(1, img))).toEqual([]);
    expect(mediaViolations(CHANNELS.instagram, [...n(9, img), vid])).toEqual([]);
    expect(mediaViolations(CHANNELS.instagram, n(11, img))).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/carousel of 2 to 10; this post has 11 images/) }),
    ]);
    expect(mediaViolations(CHANNELS.instagram, [])).toEqual([
      expect.objectContaining({ code: "missing_media" }),
    ]);
  });

  it("LinkedIn: up to 20 images, and no video (the adapter uploads images only)", () => {
    expect(mediaViolations(CHANNELS.linkedin, n(20, img))).toEqual([]);
    expect(mediaViolations(CHANNELS.linkedin, n(1, vid))).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/no video.*1 video/) }),
    ]);
    expect(mediaViolations(CHANNELS.linkedin, n(21, img))).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/up to 20 images.*21 images/) }),
    ]);
    expect(mediaViolations(CHANNELS.linkedin, [img, vid])).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/1 video and 1 image/) }),
    ]);
  });

  it("Facebook: up to 10 photos, and no video (a Page post attaches photos only)", () => {
    expect(mediaViolations(CHANNELS.facebook, n(10, img))).toEqual([]);
    expect(mediaViolations(CHANNELS.facebook, n(1, vid))).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/no video.*1 video/) }),
    ]);
    expect(mediaViolations(CHANNELS.facebook, n(11, img))).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/up to 10 photos.*11 images/) }),
    ]);
    expect(mediaViolations(CHANNELS.facebook, [vid, img, img])).toEqual([
      expect.objectContaining({ code: "media_limit", message: expect.stringMatching(/1 video and 2 images/) }),
    ]);
  });

  it("a network that takes no native media refuses nothing", () => {
    expect(mediaViolations(CHANNELS.slack, n(30, img))).toEqual([]);
  });

  it("manual channels are never refused", () => {
    expect(mediaViolations({ ...CHANNELS.twitter, delivery_mode: "manual" } as never, n(9, img))).toEqual([]);
  });
});

describe("media limits live on the adapters and are reported", () => {
  it("networkRules() reports each adapter's own mediaLimits", () => {
    for (const rule of networkRules()) {
      expect(rule.media_limits).toEqual(SERVICE_ADAPTERS[rule.service_id].mediaLimits ?? null);
    }
    const byId = Object.fromEntries(networkRules().map((r) => [r.service_id, r.media_limits]));
    expect(byId.twitter).toMatchObject({ maxImages: 4, maxVideos: 1, mixed: false });
    expect(byId.slack).toBeNull();
  });
});

describe("resolveTargetMedia", () => {
  const post = { media: [img] };
  it("uses the target's own media when it has an override, even an empty one", () => {
    expect(resolveTargetMedia({ media_override: [vid] }, post)).toEqual([vid]);
    expect(resolveTargetMedia({ media_override: [] }, post)).toEqual([]);
  });
  it("falls back to the post's media when the target has none", () => {
    expect(resolveTargetMedia({ media_override: null }, post)).toEqual([img]);
    expect(resolveTargetMedia({}, post)).toEqual([img]);
    expect(resolveTargetMedia({}, {})).toEqual([]);
  });
});

describe("checkNetworkRules — each channel against its own effective media", () => {
  const db = {
    socialChannel: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        Object.values(CHANNELS).filter((c) => where.id.in.includes(c.id)),
    },
  };

  it("an override that fits clears one channel's violation and leaves the other's", async () => {
    const five = n(5, img);
    const without = await checkNetworkRules(db, ["c_tw", "c_li"], "hi", undefined, five);
    expect(without).toEqual([expect.objectContaining({ code: "media_limit", channel_id: "c_tw" })]);

    const withOverride = await checkNetworkRules(db, ["c_tw", "c_li"], "hi", undefined, five, {
      c_tw: n(2, img),
    });
    expect(withOverride).toEqual([]);
  });

  it("an override can break a channel the post's media would have fit", async () => {
    const violations = await checkNetworkRules(db, ["c_tw", "c_fb"], "hi", undefined, [img], {
      c_fb: n(11, img),
    });
    expect(violations).toEqual([expect.objectContaining({ code: "media_limit", channel_id: "c_fb" })]);
  });
});

describe("storedMediaOverride", () => {
  it("keeps an empty override distinct from none", () => {
    expect(storedMediaOverride(null)).toBeNull();
    expect(storedMediaOverride([])).toEqual([]);
  });
});

describe("matchLibraryMedia — posts saved before the picker", () => {
  const library = [
    { id: "m1", file_path: "https://cdn.example.com/1.png", mime_type: "image/png" },
    { id: "m9", file_path: "https://cdn.example.com/doc.pdf", mime_type: "application/pdf" },
  ];
  it("gives a legacy item the id of the library row with its url", () => {
    expect(matchLibraryMedia([{ url: "https://cdn.example.com/1.png", alt: "A" }], library)).toEqual([
      { url: "https://cdn.example.com/1.png", alt: "A", media_id: "m1", type: "image" },
    ]);
  });
  it("leaves an unmatched or non-visual item without an id, to be flagged", () => {
    const out = matchLibraryMedia(
      [{ url: "https://elsewhere.example/x.png" }, { url: "https://cdn.example.com/doc.pdf" }],
      library
    );
    expect(out.every((m) => !("media_id" in m))).toBe(true);
  });
  it("leaves items that already have an id alone", () => {
    const items = [{ media_id: "m5", url: "https://cdn.example.com/1.png" }];
    expect(matchLibraryMedia(items, library)).toBe(items);
  });
});

describe("violation wording", () => {
  it("doesn't name the network twice when the channel is named after it", () => {
    const channel = { id: "c", service_id: "twitter", service_name: "X (Twitter)", account_id: null };
    expect(mediaViolations(channel, n(5, img))[0].message).toBe(
      "X (Twitter) takes up to 4 images, or 1 video on its own; this post has 5 images."
    );
  });
});
