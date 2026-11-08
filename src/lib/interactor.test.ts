import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

/**
 * Webhook signature verification, on its own. The route's behaviour (which
 * refusal an operator sees) is tested next to the route, in
 * src/app/api/webhooks/interactor/route.test.ts.
 *
 * `interactor.ts` is a "server-only" module and reads the parsed env, so both
 * are stubbed: the secret is what these cases vary.
 */

vi.mock("server-only", () => ({}));

const mocked = vi.hoisted(() => ({
  env: {
    INTERACTOR_CORE_URL: "https://core.test",
    INTERACTOR_WEBHOOK_SECRET: undefined as string | undefined,
  },
}));
vi.mock("@/lib/env", () => mocked);

import {
  executeServiceAction,
  executeServiceUpload,
  parseRetryAfter,
  responseHeaders,
  verifyWebhookSignature,
  webhookSigningConfigured,
} from "./interactor";

const SECRET = "whsec_test";
const BODY = JSON.stringify({ type: "credential.revoked", data: { id: "cred_1" } });

function sign(body: string, timestamp: string, secret = SECRET) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function nowSeconds(offsetSeconds = 0) {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

beforeEach(() => {
  mocked.env.INTERACTOR_WEBHOOK_SECRET = SECRET;
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed, fresh delivery", () => {
    const ts = nowSeconds();
    expect(verifyWebhookSignature(BODY, ts, sign(BODY, ts))).toBe(true);
  });

  it("refuses everything when no secret is configured", () => {
    // The whole point of this change: with no secret there is nothing to
    // verify against, so a valid-looking signature is worth no more than none.
    mocked.env.INTERACTOR_WEBHOOK_SECRET = undefined;
    const ts = nowSeconds();

    expect(verifyWebhookSignature(BODY, ts, sign(BODY, ts))).toBe(false);
    expect(verifyWebhookSignature(BODY, null, null)).toBe(false);
  });

  it("refuses a delivery with no signature or timestamp header", () => {
    expect(verifyWebhookSignature(BODY, nowSeconds(), null)).toBe(false);
    expect(verifyWebhookSignature(BODY, null, sign(BODY, nowSeconds()))).toBe(false);
  });

  it("refuses a signature made with a different secret", () => {
    const ts = nowSeconds();
    expect(verifyWebhookSignature(BODY, ts, sign(BODY, ts, "whsec_other"))).toBe(
      false
    );
  });

  it("refuses a signature that does not cover this body", () => {
    const ts = nowSeconds();
    const signedForSomethingElse = sign('{"type":"credential.ready"}', ts);
    expect(verifyWebhookSignature(BODY, ts, signedForSomethingElse)).toBe(false);
  });

  it("refuses a replay signed outside the 5-minute window", () => {
    const stale = nowSeconds(-6 * 60);
    expect(verifyWebhookSignature(BODY, stale, sign(BODY, stale))).toBe(false);

    const future = nowSeconds(6 * 60);
    expect(verifyWebhookSignature(BODY, future, sign(BODY, future))).toBe(false);
  });

  it("refuses a non-numeric or malformed-hex header rather than throwing", () => {
    expect(verifyWebhookSignature(BODY, "not-a-timestamp", sign(BODY, "x"))).toBe(
      false
    );
    expect(verifyWebhookSignature(BODY, nowSeconds(), "zzzz")).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  // When Core says how long to wait, the publisher waits that long instead of
  // guessing — so the header has to survive both spellings RFC 9110 allows.
  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter("  45 ")).toBe(45);
  });

  it("reads an HTTP date as seconds from now", () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const seconds = parseRetryAfter(at);
    expect(seconds).toBeGreaterThan(80);
    expect(seconds).toBeLessThanOrEqual(91);
  });

  it("gives nothing for an absent, unparseable, or past value", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(
      parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())
    ).toBeUndefined();
  });
});

describe("webhookSigningConfigured", () => {
  it("is true only when a secret is set", () => {
    expect(webhookSigningConfigured()).toBe(true);

    mocked.env.INTERACTOR_WEBHOOK_SECRET = undefined;
    expect(webhookSigningConfigured()).toBe(false);

    mocked.env.INTERACTOR_WEBHOOK_SECRET = "";
    expect(webhookSigningConfigured()).toBe(false);
  });
});

// --- /execute ----------------------------------------------------------------

/** Answers the app-token request, then records each Core call's JSON body. */
function stubCore(answer: unknown = { data: { ok: true }, metadata: {} }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "app", expires_in: 900 }));
      }
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(answer));
    })
  );
  return calls;
}

describe("executeServiceAction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the channel's credential as credential_id", async () => {
    const calls = stubCore();
    await executeServiceAction({
      serviceId: "facebook-graph-api",
      capabilityName: "list_pages",
      args: { fields: "id,name" },
      externalUserId: "cms-ch-ch_1",
      credentialId: "cred_9",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://core.test/api/v1/execute");
    expect(calls[0].body).toEqual({
      execution_type: "service_action",
      service_id: "facebook-graph-api",
      capability_name: "list_pages",
      arguments: { fields: "id,name" },
      external_user_id: "cms-ch-ch_1",
      credential_id: "cred_9",
    });
  });

  it("leaves credential_id off when the caller has none, so Core picks as before", async () => {
    const calls = stubCore();
    await executeServiceAction({
      serviceId: "github",
      capabilityName: "get_file",
      args: {},
      externalUserId: "u1",
    });
    await executeServiceAction({
      serviceId: "github",
      capabilityName: "get_file",
      args: {},
      externalUserId: "u1",
      credentialId: null,
    });
    expect(calls.map((c) => "credential_id" in c.body)).toEqual([false, false]);
  });

  it("returns the provider's response headers Core relays", async () => {
    stubCore({
      data: {},
      metadata: { response_headers: { "X-RestLi-Id": "urn:li:share:1" } },
    });
    const result = await executeServiceAction({
      serviceId: "linkedin",
      capabilityName: "create_rest_post",
      args: {},
      externalUserId: "u1",
    });
    expect(responseHeaders(result)).toEqual({ "x-restli-id": "urn:li:share:1" });
  });
});

describe("executeServiceUpload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bytes base64-encoded beside the arguments, as the same credential", async () => {
    const calls = stubCore();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await executeServiceUpload({
      serviceId: "twitter",
      capabilityName: "upload_media",
      args: { media_category: "tweet_image" },
      externalUserId: "cms-ch-ch_2",
      credentialId: "cred_x",
      body: { bytes, contentType: "image/png" },
    });
    expect(calls[0].body).toMatchObject({
      capability_name: "upload_media",
      arguments: { media_category: "tweet_image" },
      credential_id: "cred_x",
      binary_body: { content_type: "image/png" },
    });
    const sent = (calls[0].body.binary_body as { data_base64: string }).data_base64;
    expect(new Uint8Array(Buffer.from(sent, "base64"))).toEqual(bytes);
  });
});

describe("responseHeaders", () => {
  it("lowercases names and joins repeated values", () => {
    expect(
      responseHeaders({
        metadata: {
          response_headers: {
            "Content-Type": "application/json",
            "Set-Cookie": ["a=1", "b=2"],
            "Content-Length": 0,
          },
        },
      })
    ).toEqual({
      "content-type": "application/json",
      "set-cookie": "a=1, b=2",
      "content-length": "0",
    });
  });

  it("accepts a list of [name, value] pairs", () => {
    expect(
      responseHeaders({
        metadata: {
          response_headers: [
            ["X-RestLi-Id", "urn:li:share:1"],
            ["Vary", "Accept"],
            ["vary", "Origin"],
          ],
        },
      })
    ).toEqual({ "x-restli-id": "urn:li:share:1", vary: "Accept, Origin" });
  });

  it("is empty — never a throw — when Core sent none or something unexpected", () => {
    expect(responseHeaders({})).toEqual({});
    expect(responseHeaders({ metadata: {} })).toEqual({});
    expect(responseHeaders({ metadata: { response_headers: "x-restli-id: 1" } })).toEqual({});
    expect(
      responseHeaders({ metadata: { response_headers: { a: null, b: { c: 1 }, "": "x" } } })
    ).toEqual({});
  });
});
