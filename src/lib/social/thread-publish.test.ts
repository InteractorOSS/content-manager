import { beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./__fixtures__/core";

/**
 * Posts as ordered parts, against Core `/execute` responses (hand-written in
 * Core's envelope — see __fixtures__/core/README.md): an X thread published
 * as a real reply chain, a failure at tweet 2 resumed without posting the
 * root again, and the first comment on LinkedIn and Facebook. Every call goes
 * through the real `channelExecute` and Core client with only `fetch` stubbed.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { INTERACTOR_CORE_URL: "https://core.test" } }));

interface CoreCall {
  capability: string;
  args: Record<string, unknown>;
  credential_id?: string;
}

const coreCalls: CoreCall[] = [];
let answers: Record<string, (string | Response)[]> = {};

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "app", expires_in: 900 }));
    }
    const body = JSON.parse(String(init?.body));
    coreCalls.push({ capability: body.capability_name, args: body.arguments, credential_id: body.credential_id });
    const next = answers[body.capability_name]?.shift();
    if (next === undefined) throw new Error(`unexpected capability ${body.capability_name}`);
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(coreFixture(next)));
  })
);

import { channelExecute } from "./core-execute";
import {
  getAdapter,
  publishPlan,
  publishWithAdapter,
  type PublishContext,
  type PublishedPart,
} from "./capabilities";
import { describePublishError } from "./publish-errors";
import type { SocialPart } from "./parts";

const THREAD: SocialPart[] = [
  { kind: "thread", body: "Second tweet of the thread" },
  { kind: "thread", body: "Third tweet of the thread" },
];

/** A context that records parts in memory, as the publisher does on the row. */
function partsContext(published: (PublishedPart | null)[] = []) {
  const recorded = [...published];
  const context: PublishContext = {
    readMedia: async () => {
      throw new Error("no media in these posts");
    },
    once: async (_key, upload) => upload(),
    published,
    recordPart: async (index, part) => {
      recorded[index] = part;
    },
  };
  return { context, recorded };
}

function channel(service_id: string) {
  return { service_id, external_user_id: "cms-ch-ch_1", credential_id: "cred_1" };
}

const X = { serviceId: "twitter", channel: channel("twitter") };

beforeEach(() => {
  coreCalls.length = 0;
  answers = {};
});

describe("X thread: a reply chain, each tweet answering the one before", () => {
  it("publishes a three-tweet thread as the root and two replies", async () => {
    answers = {
      create_post: ["twitter.create_post", "twitter.create_post.reply", "twitter.create_post.reply.second"],
    };
    const { context, recorded } = partsContext();
    const result = await publishWithAdapter(
      getAdapter("twitter")!,
      { body: "Ship it", link: "https://interactor.com/blog/ship-it", parts: THREAD },
      channelExecute(X.channel),
      context
    );

    expect(coreCalls.map((c) => [c.capability, c.args])).toEqual([
      // The backlink rides on the root only.
      ["create_post", { text: "Ship it\nhttps://interactor.com/blog/ship-it" }],
      ["create_post", { text: "Second tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210987" } }],
      ["create_post", { text: "Third tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210988" } }],
    ]);
    expect(coreCalls.every((c) => c.credential_id === "cred_1")).toBe(true);
    // The post's address is the root's.
    expect(result).toEqual({
      externalId: "1843219876543210987",
      externalUrl: "https://x.com/i/web/status/1843219876543210987",
    });
    // Each part recorded with its own id, in thread order.
    expect(recorded.map((p) => p && [p.kind, p.id])).toEqual([
      ["root", "1843219876543210987"],
      ["thread", "1843219876543210988"],
      ["thread", "1843219876543210989"],
    ]);
  });

  it("fails at tweet 2, then resumes from tweet 2 without posting the root again", async () => {
    answers = {
      create_post: [
        "twitter.create_post",
        new Response(JSON.stringify(coreFixture("execute.error_422")), { status: 422 }),
      ],
    };
    const first = partsContext();
    const failed = await publishWithAdapter(
      getAdapter("twitter")!,
      { body: "Ship it", parts: THREAD },
      channelExecute(X.channel),
      first.context
    ).catch((err: unknown) => err);

    // The root went out and is recorded; tweet 2 is not.
    expect(first.recorded.map((p) => p?.id ?? null)).toEqual(["1843219876543210987"]);
    const failure = describePublishError(failed, { service_name: "X", account_name: "@interactor" });
    expect(failure.message).toBe(
      "The first tweet is live on X (@interactor), but tweet 2 of 3 didn't go out: You are not allowed to create a Tweet with duplicate content. Tweet 2 needs changing: edit it, then retry this channel; a retry continues from tweet 2 without posting what is already live."
    );
    expect(failure.retryable).toBe(false);

    // The retry: same post, the recorded root handed back.
    coreCalls.length = 0;
    answers = { create_post: ["twitter.create_post.reply", "twitter.create_post.reply.second"] };
    const second = partsContext(first.recorded);
    const result = await publishWithAdapter(
      getAdapter("twitter")!,
      { body: "Ship it", parts: THREAD },
      channelExecute(X.channel),
      second.context
    );

    expect(coreCalls.map((c) => c.args)).toEqual([
      { text: "Second tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210987" } },
      { text: "Third tweet of the thread", reply: { in_reply_to_tweet_id: "1843219876543210988" } },
    ]);
    expect(result.externalId).toBe("1843219876543210987");
    expect(second.recorded.map((p) => p?.id)).toEqual([
      "1843219876543210987",
      "1843219876543210988",
      "1843219876543210989",
    ]);
  });

  it("posts the first comment as a reply to the last tweet, not a fork off the root", async () => {
    answers = { create_post: ["twitter.create_post", "twitter.create_post.reply", "twitter.create_post.reply.second"] };
    await publishWithAdapter(
      getAdapter("twitter")!,
      {
        body: "Ship it",
        parts: [
          { kind: "thread", body: "Second tweet of the thread" },
          { kind: "first_comment", body: "Read it: https://interactor.com/blog/ship-it" },
        ],
      },
      channelExecute(X.channel),
      partsContext().context
    );
    expect(coreCalls[2].args).toEqual({
      text: "Read it: https://interactor.com/blog/ship-it",
      reply: { in_reply_to_tweet_id: "1843219876543210988" },
    });
  });
});

describe("first comment on LinkedIn and Facebook", () => {
  it("comments on the new LinkedIn post as its own author, using the URN from x-restli-id", async () => {
    answers = { create_rest_post: ["linkedin.create_rest_post"], create_comment: ["linkedin.create_comment"] };
    const { context, recorded } = partsContext();
    const result = await publishWithAdapter(
      getAdapter("linkedin")!,
      {
        body: "We shipped",
        accountId: "urn:li:organization:2414183",
        parts: [{ kind: "first_comment", body: "Read the full post: https://interactor.com/blog/launch" }],
      },
      channelExecute(channel("linkedin")),
      context
    );
    expect(coreCalls.map((c) => c.capability)).toEqual(["create_rest_post", "create_comment"]);
    expect(coreCalls[1].args).toEqual({
      "post-urn": "urn:li:share:7248123456789012345",
      actor: "urn:li:organization:2414183",
      object: "urn:li:share:7248123456789012345",
      message: { text: "Read the full post: https://interactor.com/blog/launch" },
    });
    expect(result.externalUrl).toBe("https://www.linkedin.com/feed/update/urn:li:share:7248123456789012345");
    expect(recorded[1]).toEqual({
      kind: "first_comment",
      id: "urn:li:comment:(urn:li:share:7248123456789012345,7248123499999999999)",
      url: null,
    });
  });

  it("comments on the new Facebook Page post", async () => {
    answers = { publish_page_post: ["facebook-graph-api.publish_page_post"], create_comment: ["facebook-graph-api.create_comment"] };
    await publishWithAdapter(
      getAdapter("facebook-graph-api")!,
      { body: "We shipped", accountId: "104857600000001", parts: [{ kind: "first_comment", body: "Details inside" }] },
      channelExecute(channel("facebook-graph-api")),
      partsContext().context
    );
    expect(coreCalls[1]).toMatchObject({
      capability: "create_comment",
      args: { "object-id": "104857600000001_122150000000000010", message: "Details inside" },
    });
  });

  it("says the post is live when only its first comment failed", async () => {
    answers = {
      publish_page_post: ["facebook-graph-api.publish_page_post"],
      create_comment: [new Response(JSON.stringify({ error: { message: "upstream" } }), { status: 503 })],
    };
    const err = await publishWithAdapter(
      getAdapter("facebook-graph-api")!,
      { body: "We shipped", accountId: "104857600000001", parts: [{ kind: "first_comment", body: "Details" }] },
      channelExecute(channel("facebook-graph-api")),
      partsContext().context
    ).catch((e: unknown) => e);
    const failure = describePublishError(err, { service_name: "Facebook Page", account_name: "Interactor" });
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/^The post is live on Facebook Page \(Interactor\), but the first comment didn't go out yet/);
    expect(failure.message).toMatch(/a retry continues from the first comment without posting what is already live\.$/);
  });
});

describe("publishPlan: what each network is sent", () => {
  it("joins a thread into one post where the network doesn't thread, and keeps nothing back", () => {
    expect(publishPlan("linkedin", "One", [...THREAD, { kind: "first_comment", body: "Link" }])).toEqual({
      posts: ["One\n\nSecond tweet of the thread\n\nThird tweet of the thread"],
      comment: "Link",
      joined: true,
    });
    expect(publishPlan("instagram", "Caption", [{ kind: "first_comment", body: "#tags" }])).toEqual({
      posts: ["Caption\n\n#tags"],
      comment: null,
      joined: true,
    });
    expect(publishPlan("twitter", "One", THREAD).posts).toEqual(["One", ...THREAD.map((p) => p.body)]);
  });
});
