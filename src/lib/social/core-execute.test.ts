import { beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./__fixtures__/core";

/**
 * The channel executor against modelled Core responses (transcribed from Core
 * source or assumed from G#44, none live-recorded — see __fixtures__/core/README.md):
 * what it sends (the channel's identity AND credential, on every variant), what
 * adapters get back (the provider body, and the headers Core relays), and what a
 * Core refusal becomes.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { INTERACTOR_CORE_URL: "https://core.test" } }));

const coreCalls: { body: Record<string, unknown> }[] = [];
let answers: unknown[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "app", expires_in: 900 }));
    }
    coreCalls.push({ body: JSON.parse(String(init?.body)) });
    const answer = answers.shift() ?? { data: {} };
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer));
  })
);

import { channelExecute } from "./core-execute";
import { discoverChannelAccounts } from "./accounts";
import { executeUpload, executeWithHeaders, getAdapter } from "./capabilities";
import { describePublishError } from "./publish-errors";

const CHANNEL = {
  service_id: "linkedin",
  external_user_id: "cms-ch-ch_1",
  credential_id: "cred_li",
};

beforeEach(() => {
  coreCalls.length = 0;
  answers = [];
});

describe("channelExecute", () => {
  it("runs every variant as the channel's credential", async () => {
    answers = [{ data: {} }, { data: {} }, { data: {} }];
    const execute = channelExecute(CHANNEL);
    await execute("get_me", {});
    await executeWithHeaders(execute, "create_rest_post", { commentary: "hi" });
    await executeUpload(execute, "upload_image", {}, {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    });
    expect(coreCalls.map((c) => [c.body.external_user_id, c.body.credential_id])).toEqual([
      ["cms-ch-ch_1", "cred_li"],
      ["cms-ch-ch_1", "cred_li"],
      ["cms-ch-ch_1", "cred_li"],
    ]);
    expect(coreCalls[2].body.binary_body).toEqual({
      content_type: "image/jpeg",
      data_base64: "AQID",
    });
  });

  it("hands an adapter the id LinkedIn returns only in x-restli-id", async () => {
    answers = [coreFixture("linkedin.create_rest_post")];
    const { data, headers } = await executeWithHeaders(
      channelExecute(CHANNEL),
      "create_rest_post",
      {}
    );
    expect(data).toEqual({});
    expect(headers["x-restli-id"]).toBe("urn:li:share:7248123456789012345");
    expect(headers["content-length"]).toBe("0");
  });

  it("keeps the plain call's body-only answer for existing adapters", async () => {
    answers = [coreFixture("twitter.create_post")];
    const data = await channelExecute({ ...CHANNEL, service_id: "twitter" })("create_post", {
      text: "Ship it",
    });
    const call = getAdapter("twitter")!.buildPublish!({ body: "Ship it" });
    expect(call.extractPostId!(data, {})).toBe("1843219876543210987");
  });

  it("sends no credential_id for a channel that has none stored", async () => {
    await channelExecute({ ...CHANNEL, credential_id: null })("get_me", {});
    expect("credential_id" in coreCalls[0].body).toBe(false);
  });
});

describe("a Core refusal", () => {
  it("turns Core's 422 provider refusal into a permanent failure in plain words", async () => {
    answers = [
      new Response(JSON.stringify(coreFixture("execute.error_422")), { status: 422 }),
    ];
    const err = await channelExecute({ ...CHANNEL, service_id: "twitter" })("create_post", {
      text: "Ship it",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    const failure = describePublishError(err, { service_name: "X" });
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("duplicate content");
    expect(failure.message).toBe(
      "X rejected this post: You are not allowed to create a Tweet with duplicate content. Edit the post and retry this channel."
    );
  });
});

describe("discoverChannelAccounts against modelled responses", () => {
  it("lists Facebook Pages as the channel's credential", async () => {
    answers = [coreFixture("facebook-graph-api.list_pages")];
    const accounts = await discoverChannelAccounts({
      service_id: "facebook-graph-api",
      external_user_id: "cms-ch-ch_fb",
      credential_id: "cred_fb",
    });
    expect(accounts).toEqual([
      { id: "744751622301298", name: "Interactor" },
      { id: "102938475610293", name: "Interactor Labs" },
    ]);
    expect(coreCalls[0].body).toMatchObject({
      capability_name: "list_pages",
      credential_id: "cred_fb",
    });
  });

  it("lists Slack channels", async () => {
    answers = [coreFixture("slack.conversations_list")];
    const accounts = await discoverChannelAccounts({
      service_id: "slack",
      external_user_id: "cms-ch-ch_sl",
      credential_id: "cred_sl",
    });
    expect(accounts).toEqual([
      { id: "C0123ANNOUNCE", name: "#announcements" },
      { id: "C0456LAUNCHES", name: "#launches" },
    ]);
  });

  it("names the LinkedIn member and the company pages they administer", async () => {
    answers = [
      coreFixture("linkedin.get_me"),
      coreFixture("linkedin.list_admin_organizations"),
    ];
    expect(await discoverChannelAccounts(CHANNEL)).toEqual([
      { id: "urn:li:person:782bbtaQ", name: "Peter Jung", detail: "Your profile" },
      { id: "urn:li:organization:90210457", name: "Interactor", detail: "Company page" },
      { id: "urn:li:organization:11223344", name: "Organization 11223344", detail: "Company page" },
    ]);
    // Both questions are asked as the channel's own credential.
    expect(coreCalls.map((c) => c.body.capability_name)).toEqual([
      "get_me",
      "list_admin_organizations",
    ]);
    expect(coreCalls.every((c) => c.body.credential_id === CHANNEL.credential_id)).toBe(true);
  });

  it("still offers the LinkedIn member when Core refuses the organization list", async () => {
    // A connection made before the org scopes: LinkedIn answers 403, which
    // Core relays as an error envelope and channelExecute throws.
    answers = [
      coreFixture("linkedin.get_me"),
      new Response(
        JSON.stringify({
          error: {
            code: "provider_forbidden",
            message: "The provider refused the request (HTTP 403): Not enough permissions to access: organizationAcls",
            provider: { status: 403, body: { status: 403 }, retry_after_seconds: null },
          },
        }),
        { status: 403 }
      ),
    ];
    expect(await discoverChannelAccounts(CHANNEL)).toEqual([
      { id: "urn:li:person:782bbtaQ", name: "Peter Jung", detail: "Your profile" },
    ]);
    expect(coreCalls.map((c) => c.body.capability_name)).toEqual([
      "get_me",
      "list_admin_organizations",
    ]);
  });

  it("lists the Instagram business accounts linked to the sign-in's Pages", async () => {
    answers = [coreFixture("instagram.list_pages")];
    const accounts = await discoverChannelAccounts({
      service_id: "instagram",
      external_user_id: "cms-ch-ch_ig",
      credential_id: "cred_ig",
    });
    expect(accounts).toEqual([
      { id: "17841405822304914", name: "@interactor.hq", detail: "Linked to the Page Interactor" },
      {
        id: "17841400000000001",
        name: "Instagram account linked to Interactor Events",
        detail: "Linked to the Page Interactor Events",
      },
    ]);
    expect(coreCalls[0].body).toMatchObject({ capability_name: "list_pages", credential_id: "cred_ig" });
  });

  it("asks nothing for a service that cannot list its accounts", async () => {
    expect(
      await discoverChannelAccounts({ service_id: "reddit", external_user_id: "x" })
    ).toBeNull();
    expect(coreCalls).toHaveLength(0);
  });
});
