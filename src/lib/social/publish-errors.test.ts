import { describe, expect, it } from "vitest";
import {
  channelNotConnectedFailure,
  charLimitRefusal,
  describePublishError,
  describeSocialActionFailure,
  describeStoredTargetError,
} from "./publish-errors";
import { PublishStepError } from "./capabilities";

const slack = {
  service_id: "slack",
  service_name: "Slack",
  account_name: "#launches",
};

function coreError(status: number, message: string, retryAfterSeconds?: number) {
  const err = new Error(message) as Error & {
    status: number;
    retryAfterSeconds?: number;
  };
  err.name = "InteractorError";
  err.status = status;
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

describe("describePublishError", () => {
  it("names the channel and never shows a raw status code", () => {
    const failure = describePublishError(coreError(502, "upstream failed"), slack);

    expect(failure.message).toContain("Slack (#launches)");
    expect(failure.message).not.toMatch(/502/);
    expect(failure.retryable).toBe(true);
  });

  it("carries Core's own Retry-After through", () => {
    const failure = describePublishError(
      coreError(429, "rate limited", 900),
      slack
    );

    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterSeconds).toBe(900);
  });

  it("stops retrying a dead credential and says to reconnect", () => {
    const failure = describePublishError(coreError(401, "no credential"), slack);

    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/Reconnect it on the Channels page/);
  });

  it("stops retrying a post the network rejected on its merits", () => {
    const failure = describePublishError(
      coreError(400, "text is too long"),
      slack
    );

    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("text is too long");
    expect(failure.message).toMatch(/Edit the post/);
  });

  it("treats an unexplained throw as worth one more try", () => {
    const failure = describePublishError(new Error("fetch failed"), slack);

    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("Slack (#launches)");
  });
});

describe("channelNotConnectedFailure", () => {
  it("says which channel and what to do, and never retries", () => {
    const failure = channelNotConnectedFailure(slack, "revoked");

    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("Slack (#launches)");
    expect(failure.message).toMatch(/removed at the network/);
    expect(failure.message).toMatch(/Reconnect it/);
  });
});

describe("describeStoredTargetError", () => {
  it("replaces the raw `502: ...` rows written before this module existed", () => {
    const shown = describeStoredTargetError("502: upstream request failed");

    expect(shown).not.toMatch(/502/);
    expect(shown).toMatch(/Retry it/);
  });

  it("passes a sentence we wrote straight through", () => {
    const written = "Slack is rate-limiting us, so the post hasn't gone out yet.";
    expect(describeStoredTargetError(written)).toBe(written);
  });

  it("has nothing to say about an empty error", () => {
    expect(describeStoredTargetError(null)).toBeNull();
    expect(describeStoredTargetError("   ")).toBeNull();
  });
});

describe("describeSocialActionFailure", () => {
  it("shows the route's own sentence", () => {
    const err = new Error("This post is being sent to its channels right now.");
    expect(describeSocialActionFailure(err, "fallback")).toBe(err.message);
  });

  it("swaps the API client's bare status fallback for a sentence", () => {
    expect(describeSocialActionFailure(new Error("HTTP 502"), "fallback")).toBe(
      "fallback"
    );
  });
});

describe("charLimitRefusal", () => {
  const twitter = {
    id: "ch_x",
    service_id: "twitter",
    service_name: "X (Twitter)",
    account_name: "@interactor",
  };
  const slackChannel = { ...slack, id: "ch_slack" };

  it("reads the limit off the adapter, not a second table", () => {
    // 280 is twitter's `charLimit` in capabilities.ts. If that number ever
    // moves, this refusal moves with it — that is the whole point of the
    // helper replacing the composer's private copy of the same five numbers.
    const failure = charLimitRefusal([twitter], "a".repeat(281), null);

    expect(failure?.message).toContain("X (Twitter) (@interactor)");
    expect(failure?.message).toContain("280 characters");
    expect(failure?.message).toContain("281 characters");
    expect(failure?.retryable).toBe(false);
  });

  it("accepts a body at exactly the limit", () => {
    expect(charLimitRefusal([twitter], "a".repeat(280), null)).toBeNull();
  });

  it("measures a channel's own copy against that channel, not the shared body", () => {
    // Shared body is fine for Slack; only X's custom copy is too long.
    const failure = charLimitRefusal(
      [slackChannel, twitter],
      "Short enough",
      { [twitter.id]: "a".repeat(300) }
    );

    expect(failure?.message).toContain("The custom copy for X (Twitter)");
    expect(failure?.message).not.toContain("Slack");
  });

  it("ignores a blank override and falls back to the shared body", () => {
    expect(
      charLimitRefusal([twitter], "a".repeat(281), { [twitter.id]: "   " })
    ).not.toBeNull();
    expect(
      charLimitRefusal([twitter], "Short", { [twitter.id]: "" })
    ).toBeNull();
  });

  it("uses the default limit for a service with no adapter", () => {
    const unknown = {
      id: "ch_ms",
      service_id: "myspace",
      service_name: "MySpace",
      account_name: "tom",
    };
    expect(charLimitRefusal([unknown], "a".repeat(5000), null)).toBeNull();
    expect(
      charLimitRefusal([unknown], "a".repeat(5001), null)?.message
    ).toContain("5,000 characters");
  });

  it("offers the fix the reader can actually make", () => {
    const shared = charLimitRefusal([twitter], "a".repeat(290), null);
    expect(shared?.message).toContain("Shorten the message by 10 characters");
    expect(shared?.message).toContain("write shorter copy just for X (Twitter)");

    const custom = charLimitRefusal([twitter], "ok", {
      [twitter.id]: "a".repeat(281),
    });
    expect(custom?.message).toContain("Shorten it by 1 character and save again.");
  });
});

describe("describePublishError — one sentence per media step", () => {
  const x = { service_id: "twitter", service_name: "X", account_name: null };
  const item = { index: 2, total: 3, type: "image" as const, name: "team.jpg" };

  it("retries an upload the network couldn't take just now, and says nothing went out", () => {
    const failure = describePublishError(
      new PublishStepError("upload_media", item, coreError(503, "unavailable", 30)),
      x
    );
    expect(failure).toEqual({
      message:
        "X couldn't be reached while uploading image 2 of 3 (team.jpg), so nothing has been posted yet. It will be tried again automatically.",
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it("stops at an upload the network refused, naming the file and the fix", () => {
    const failure = describePublishError(
      new PublishStepError(
        "upload_media",
        item,
        coreError(422, "The provider refused the request (HTTP 400): media type unrecognized")
      ),
      x
    );
    expect(failure).toEqual({
      message:
        "X didn't accept image 2 of 3 (team.jpg): media type unrecognized. Nothing was posted. Replace that image or remove it from this channel, then retry this channel.",
      retryable: false,
    });
  });

  it("sends a refused authorization to Reconnect, as for the post itself", () => {
    const failure = describePublishError(
      new PublishStepError("start_upload", item, coreError(401, "token revoked")),
      x
    );
    expect(failure.message).toMatch(/no longer authorized.*Reconnect it on the Channels page/);
    expect(failure.retryable).toBe(false);
  });

  it("explains a carousel the network wouldn't assemble", () => {
    const failure = describePublishError(
      new PublishStepError("create_carousel", null, coreError(422, "Invalid children")),
      { service_id: "instagram", service_name: "Instagram", account_name: "@acme" }
    );
    expect(failure.message).toBe(
      "Instagram (@acme) couldn't put the carousel together: Invalid children. Nothing was posted. Check that each item is an image or video the network accepts, then retry this channel."
    );
  });

  it("retries a library file that couldn't be read for a passing reason", () => {
    const failure = describePublishError(
      new PublishStepError("read_media", { ...item, total: 1, index: 1 }, new Error("socket hang up")),
      x
    );
    expect(failure).toEqual({
      message:
        "Nothing has been posted to X yet: we couldn't read the image (team.jpg) from your media library just now. It will be tried again automatically.",
      retryable: true,
    });
  });

  it("stops at a file outside this CMS's media storage, without retrying", () => {
    const refused = Object.assign(new Error("not ours"), { name: "MediaFileRefusedError" });
    const failure = describePublishError(
      new PublishStepError("read_media", { ...item, total: 1, index: 1 }, refused),
      x
    );
    expect(failure).toEqual({
      message:
        "Nothing was posted to X: the image (team.jpg) isn't stored in this CMS's media storage, so it can't be sent. Upload the file to the media library, pick it for this post again, then retry this channel.",
      retryable: false,
    });
  });

  it("stops when this server has no media storage configured, naming who can fix it", () => {
    const unconfigured = Object.assign(new Error("no s3"), { name: "MediaStorageNotConfiguredError" });
    const failure = describePublishError(
      new PublishStepError("read_media", { ...item, total: 1, index: 1 }, unconfigured),
      x
    );
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/media storage isn't set up on this server.*Ask an administrator/);
  });

  it("retries a step that failed without a Core refusal", () => {
    const failure = describePublishError(
      new PublishStepError("upload_media", item, new Error("X did not return a media id for the upload")),
      x
    );
    expect(failure.message).toBe(
      "The post to X didn't go through while uploading image 2 of 3 (team.jpg): X did not return a media id for the upload. Nothing has been posted yet; it will be tried again automatically."
    );
    expect(failure.retryable).toBe(true);
  });
});
