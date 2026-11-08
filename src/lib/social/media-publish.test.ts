import { beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./__fixtures__/core";

/**
 * Native media publishing, per network, against Core `/execute` responses
 * (hand-written in Core's envelope — see __fixtures__/core/README.md). Every
 * call goes through the real `channelExecute` and Core client with only
 * `fetch` stubbed, so what is checked is the wire: which capabilities run, in
 * what order, with which bytes, and what the post's id and URL come out as.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { INTERACTOR_CORE_URL: "https://core.test" } }));

interface CoreCall {
  capability: string;
  args: Record<string, unknown>;
  binary?: { content_type: string; data_base64: string };
  credential_id?: string;
}

const coreCalls: CoreCall[] = [];
/** Per capability, the fixture names (or a Response) to answer with, in order. */
let answers: Record<string, (string | Response)[]> = {};

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "app", expires_in: 900 }));
    }
    const body = JSON.parse(String(init?.body));
    coreCalls.push({
      capability: body.capability_name,
      args: body.arguments,
      binary: body.binary_body,
      credential_id: body.credential_id,
    });
    const next = answers[body.capability_name]?.shift();
    if (next === undefined) throw new Error(`unexpected capability ${body.capability_name}`);
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(coreFixture(next)));
  })
);

import { channelExecute } from "./core-execute";
import {
  getAdapter,
  linkedinLittleText,
  publishWithAdapter,
  type PublishContext,
  type PublishMedia,
} from "./capabilities";
import { describePublishError } from "./publish-errors";

const IMAGES: PublishMedia[] = [
  {
    media_id: "m1",
    url: "https://interactor-media.s3.us-west-2.amazonaws.com/www.interactor.com/images/1791400000000_launch.png",
    type: "image",
    alt: "The launch dashboard",
  },
  {
    media_id: "m2",
    url: "https://interactor-media.s3.us-west-2.amazonaws.com/www.interactor.com/images/1791400000001_team.jpg",
    type: "image",
  },
];

const BYTES: Record<string, Uint8Array> = {
  m1: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
  m2: new Uint8Array([0xff, 0xd8, 0xff, 2]),
};

/** A publish context with an in-memory upload record, counting reads. */
function memoryContext(recorded: Record<string, string> = {}) {
  const reads: string[] = [];
  const context: PublishContext = {
    readMedia: async (item) => {
      reads.push(item.media_id!);
      return {
        bytes: BYTES[item.media_id!],
        contentType: item.media_id === "m1" ? "image/png" : "image/jpeg",
      };
    },
    once: async (key, upload) => (recorded[key] ??= await upload()),
  };
  return { context, reads, recorded };
}

function channel(service_id: string) {
  return { service_id, external_user_id: "cms-ch-ch_1", credential_id: "cred_1" };
}

async function publish(service: string, accountId: string | null, context: PublishContext, link?: string) {
  return publishWithAdapter(
    getAdapter(service)!,
    { body: "Two pictures (from launch day)", link, media: IMAGES, accountId },
    channelExecute(channel(service)),
    context
  );
}

function sentBytes(call: CoreCall): Uint8Array {
  return new Uint8Array(Buffer.from(call.binary!.data_base64, "base64"));
}

beforeEach(() => {
  coreCalls.length = 0;
  answers = {};
});

describe("X: upload_media for each image, then create_post with media_ids", () => {
  it("publishes two images natively", async () => {
    answers = {
      upload_media: ["twitter.upload_media", "twitter.upload_media.v1"],
      create_post: ["twitter.create_post"],
    };
    const { context } = memoryContext();
    const result = await publish("twitter", null, context, "https://interactor.com/blog/launch");

    expect(coreCalls.map((c) => c.capability)).toEqual(["upload_media", "upload_media", "create_post"]);
    expect(coreCalls[0]).toMatchObject({
      args: { media_category: "tweet_image" },
      binary: { content_type: "image/png" },
      credential_id: "cred_1",
    });
    expect(sentBytes(coreCalls[0])).toEqual(BYTES.m1);
    expect(sentBytes(coreCalls[1])).toEqual(BYTES.m2);
    // The v2 answer's data.id and the v1.1 answer's media_id_string, in order.
    expect(coreCalls[2].args).toEqual({
      text: "Two pictures (from launch day)\nhttps://interactor.com/blog/launch",
      media: { media_ids: ["1846101000000000001", "1846101000000000002"] },
    });
    expect(result).toEqual({
      externalId: "1843219876543210987",
      externalUrl: "https://x.com/i/web/status/1843219876543210987",
    });
  });

  it("does not upload again on a retry: the recorded media ids are reused", async () => {
    answers = {
      upload_media: ["twitter.upload_media", "twitter.upload_media.v1"],
      create_post: [new Response(JSON.stringify({ error: { message: "upstream" } }), { status: 503 }), "twitter.create_post"],
    };
    const { context, reads } = memoryContext();
    await expect(publish("twitter", null, context)).rejects.toThrow();
    await publish("twitter", null, context);

    expect(coreCalls.map((c) => c.capability)).toEqual([
      "upload_media",
      "upload_media",
      "create_post",
      "create_post",
    ]);
    expect(reads).toEqual(["m1", "m2"]);
    expect(coreCalls[3].args.media).toEqual({
      media_ids: ["1846101000000000001", "1846101000000000002"],
    });
  });

  it("sends a text-only post exactly as before", async () => {
    answers = { create_post: ["twitter.create_post"] };
    await publishWithAdapter(
      getAdapter("twitter")!,
      { body: "Ship it", link: "https://interactor.com/blog/ship-it" },
      channelExecute(channel("twitter")),
      memoryContext().context
    );
    expect(coreCalls).toEqual([
      expect.objectContaining({
        capability: "create_post",
        args: { text: "Ship it\nhttps://interactor.com/blog/ship-it" },
      }),
    ]);
  });
});

describe("LinkedIn: initialize_image_upload, PUT the bytes, then /rest/posts", () => {
  for (const [who, author] of [
    ["a member", "urn:li:person:782bbtaQ"],
    ["an organization", "urn:li:organization:2414183"],
  ] as const) {
    it(`publishes two images as ${who}, reading the post URN from x-restli-id`, async () => {
      answers = {
        initialize_image_upload: ["linkedin.initialize_image_upload", "linkedin.initialize_image_upload.second"],
        upload_image: ["linkedin.upload_image", "linkedin.upload_image"],
        // 201, empty body: the new id is ONLY in the header.
        create_rest_post: ["linkedin.create_rest_post"],
      };
      const result = await publish("linkedin", author, memoryContext().context, "https://interactor.com/blog/launch");

      expect(coreCalls.map((c) => c.capability)).toEqual([
        "initialize_image_upload",
        "upload_image",
        "initialize_image_upload",
        "upload_image",
        "create_rest_post",
      ]);
      // Each image is registered to the post's author, then PUT to its own URL.
      expect(coreCalls[0].args).toEqual({ initializeUploadRequest: { owner: author } });
      expect(coreCalls[1].args.upload_url).toMatch(/D4E10AQF1first/);
      expect(sentBytes(coreCalls[1])).toEqual(BYTES.m1);
      expect(coreCalls[3].args.upload_url).toMatch(/D4E10AQF2second/);
      expect(coreCalls[3].binary!.content_type).toBe("image/jpeg");

      expect(coreCalls[4].args).toEqual({
        author,
        commentary: "Two pictures \\(from launch day\\)\nhttps://interactor.com/blog/launch",
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        content: {
          multiImage: {
            images: [
              { id: "urn:li:image:D4E10AQF1first", altText: "The launch dashboard" },
              { id: "urn:li:image:D4E10AQF2second" },
            ],
          },
        },
      });
      expect(result).toEqual({
        externalId: "urn:li:share:7248123456789012345",
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7248123456789012345",
      });
    });
  }

  it("falls back to the body id when no header was relayed", async () => {
    answers = { create_rest_post: ["linkedin.create_rest_post.body_id"] };
    const result = await publishWithAdapter(
      getAdapter("linkedin")!,
      { body: "Text only", accountId: "urn:li:person:782bbtaQ" },
      channelExecute(channel("linkedin")),
      memoryContext().context
    );
    expect(coreCalls[0].args).not.toHaveProperty("content");
    expect(result.externalUrl).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7248123456789099999"
    );
  });

  it("posts one image as content.media", async () => {
    answers = {
      initialize_image_upload: ["linkedin.initialize_image_upload"],
      upload_image: ["linkedin.upload_image"],
      create_rest_post: ["linkedin.create_rest_post"],
    };
    await publishWithAdapter(
      getAdapter("linkedin")!,
      { body: "One", media: [IMAGES[0]], accountId: "urn:li:person:782bbtaQ" },
      channelExecute(channel("linkedin")),
      memoryContext().context
    );
    expect(coreCalls[2].args.content).toEqual({
      media: { id: "urn:li:image:D4E10AQF1first", altText: "The launch dashboard" },
    });
  });

  it("names the image and the step when LinkedIn won't start its upload", async () => {
    answers = {
      initialize_image_upload: [
        "linkedin.initialize_image_upload",
        new Response(
          JSON.stringify({
            error: {
              code: "provider_error",
              message: "The provider refused the request (HTTP 422): Invalid owner",
            },
          }),
          { status: 422 }
        ),
      ],
      upload_image: ["linkedin.upload_image"],
    };
    const err = await publish("linkedin", "urn:li:person:782bbtaQ", memoryContext().context).catch((e) => e);
    const failure = describePublishError(err, { service_name: "LinkedIn", account_name: "Acme" });
    expect(failure).toEqual({
      message:
        "LinkedIn (Acme) wouldn't start the upload of image 2 of 2 (team.jpg): Invalid owner. Nothing was posted. Replace that image or remove it from this channel, then retry this channel.",
      retryable: false,
    });
  });
});

describe("Facebook Page: unpublished photo uploads, then a feed post with attached_media", () => {
  it("publishes two photos natively", async () => {
    answers = {
      upload_page_photo: ["facebook-graph-api.upload_page_photo", "facebook-graph-api.upload_page_photo.second"],
      publish_page_post: ["facebook-graph-api.publish_page_post"],
    };
    const result = await publish("facebook-graph-api", "104857600000001", memoryContext().context, "https://interactor.com/blog/launch");

    expect(coreCalls.map((c) => c.capability)).toEqual([
      "upload_page_photo",
      "upload_page_photo",
      "publish_page_post",
    ]);
    expect(coreCalls[0].args).toEqual({
      "page-id": "104857600000001",
      published: false,
      alt_text_custom: "The launch dashboard",
    });
    expect(sentBytes(coreCalls[1])).toEqual(BYTES.m2);
    // With photos, the backlink rides in the message: Graph's `link` would
    // replace the photos with a link preview.
    expect(coreCalls[2].args).toEqual({
      "page-id": "104857600000001",
      message: "Two pictures (from launch day)\nhttps://interactor.com/blog/launch",
      attached_media: [{ media_fbid: "122150000000000001" }, { media_fbid: "122150000000000002" }],
      published: true,
    });
    expect(result).toEqual({
      externalId: "104857600000001_122150000000000010",
      externalUrl: "https://www.facebook.com/104857600000001_122150000000000010",
    });
  });

  it("keeps a text post's link as a link preview", async () => {
    answers = { publish_page_post: ["facebook-graph-api.publish_page_post"] };
    await publishWithAdapter(
      getAdapter("facebook-graph-api")!,
      { body: "Read this", link: "https://interactor.com/blog/x", accountId: "104857600000001" },
      channelExecute(channel("facebook-graph-api")),
      memoryContext().context
    );
    expect(coreCalls[0].args).toEqual({
      "page-id": "104857600000001",
      message: "Read this",
      link: "https://interactor.com/blog/x",
      published: true,
    });
  });
});

describe("Instagram: carousel item containers, a CAROUSEL container, then publish", () => {
  it("publishes two images as a carousel with its permalink", async () => {
    answers = {
      create_media_container: [
        "instagram.create_media_container",
        "instagram.create_media_container.second",
        "instagram.create_media_container.carousel",
      ],
      publish_media: ["instagram.publish_media"],
      get_media: ["instagram.get_media"],
    };
    const { context, reads } = memoryContext();
    const result = await publish("instagram", "17841400000000000", context, "https://interactor.com/blog/launch");

    expect(coreCalls.map((c) => c.capability)).toEqual([
      "create_media_container",
      "create_media_container",
      "create_media_container",
      "publish_media",
      "get_media",
    ]);
    expect(coreCalls[0].args).toEqual({
      "ig-user-id": "17841400000000000",
      image_url: IMAGES[0].url,
      alt_text: "The launch dashboard",
      is_carousel_item: true,
    });
    expect(coreCalls[1].args).toEqual({
      "ig-user-id": "17841400000000000",
      image_url: IMAGES[1].url,
      is_carousel_item: true,
    });
    expect(coreCalls[2].args).toEqual({
      "ig-user-id": "17841400000000000",
      media_type: "CAROUSEL",
      children: "17889455560051441,17889455560051442",
      caption: "Two pictures (from launch day)\nhttps://interactor.com/blog/launch",
    });
    expect(coreCalls[3].args).toEqual({
      "ig-user-id": "17841400000000000",
      creation_id: "17889455560051450",
    });
    // Graph fetches each file from its URL itself: no bytes are read here.
    expect(reads).toEqual([]);
    expect(result).toEqual({
      externalId: "17920238422030506",
      externalUrl: "https://www.instagram.com/p/DAbC123xYz9/",
    });
  });

  it("reuses the item containers on a retry", async () => {
    answers = {
      create_media_container: [
        "instagram.create_media_container",
        "instagram.create_media_container.second",
        "instagram.create_media_container.carousel",
        "instagram.create_media_container.carousel",
      ],
      publish_media: [
        new Response(JSON.stringify({ error: { message: "busy" } }), { status: 502 }),
        "instagram.publish_media",
      ],
      get_media: ["instagram.get_media"],
    };
    const { context } = memoryContext();
    await expect(publish("instagram", "17841400000000000", context)).rejects.toThrow();
    await publish("instagram", "17841400000000000", context);
    expect(coreCalls.filter((c) => c.args.is_carousel_item)).toHaveLength(2);
  });

  it("keeps a single image as one container, and still publishes without a permalink", async () => {
    answers = {
      create_media_container: ["instagram.create_media_container"],
      publish_media: ["instagram.publish_media"],
      get_media: [new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 })],
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await publishWithAdapter(
      getAdapter("instagram")!,
      { body: "One", media: [IMAGES[1]], accountId: "17841400000000000" },
      channelExecute(channel("instagram")),
      memoryContext().context
    );
    expect(coreCalls[0].args).toEqual({
      "ig-user-id": "17841400000000000",
      image_url: IMAGES[1].url,
      caption: "One",
    });
    expect(result).toEqual({ externalId: "17920238422030506", externalUrl: undefined });
  });

  it("says which carousel item Instagram couldn't use", async () => {
    answers = {
      create_media_container: [
        "instagram.create_media_container",
        new Response(
          JSON.stringify({
            error: {
              message: "The provider refused the request (HTTP 400): The aspect ratio is not supported.",
            },
          }),
          { status: 422 }
        ),
      ],
    };
    const err = await publish("instagram", "17841400000000000", memoryContext().context).catch((e) => e);
    expect(describePublishError(err, { service_name: "Instagram" }).message).toBe(
      "Instagram couldn't use image 2 of 2 (team.jpg): The aspect ratio is not supported. Nothing was posted. Replace that image or remove it from this channel, then retry this channel."
    );
  });
});

describe("linkedinLittleText", () => {
  it("escapes the reserved characters and keeps hashtags as hashtags", () => {
    expect(linkedinLittleText("Launch (beta) @team #AI_tools, 50% off [now] #1")).toBe(
      "Launch \\(beta\\) \\@team {hashtag|\\#|AI\\_tools}, 50% off \\[now\\] {hashtag|\\#|1}"
    );
  });

  it("leaves a # inside a word or a URL fragment alone, escaped", () => {
    expect(linkedinLittleText("C# and https://x.com/a#b")).toBe("C\\# and https://x.com/a\\#b");
  });
});
