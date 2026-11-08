import { describe, expect, it } from "vitest";
import {
  describeChannelConnectFailure,
  type ChannelConnectReason,
} from "./connect-errors";

const REASONS: ChannelConnectReason[] = [
  "missing_details",
  "channel_not_found",
  "no_permission",
  "account_unverified",
  "account_mismatch",
  "provider_refused",
];

describe("describeChannelConnectFailure", () => {
  it("says nothing was connected, for every reason the callback can send", () => {
    for (const reason of REASONS) {
      const failure = describeChannelConnectFailure(reason);
      expect(failure.message).toContain("nothing was connected");
      // Never the machine token itself.
      expect(failure.message).not.toContain(reason);
    }
  });

  it("offers a next step for every reason", () => {
    for (const reason of REASONS) {
      const { action, message } = describeChannelConnectFailure(reason);
      if (action === "none") {
        // No button, so the sentence itself has to say what to do.
        expect(message).toMatch(/Ask /);
      } else {
        expect(action).toBe("retry");
      }
    }
  });

  it("sends someone who cannot fix it themselves to an administrator", () => {
    const failure = describeChannelConnectFailure("no_permission");
    expect(failure.action).toBe("none");
    expect(failure.message).toContain("administrator");
  });

  it("falls back to a generic sentence for an unrecognised code", () => {
    for (const raw of ["missing_params", "", null, undefined, "<script>"]) {
      const failure = describeChannelConnectFailure(raw);
      expect(failure.message).toBe(
        "The connection didn't finish, so nothing was connected. Start the connection again."
      );
      expect(failure.action).toBe("retry");
    }
  });
});
