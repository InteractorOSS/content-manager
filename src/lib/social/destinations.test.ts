import { describe, expect, it } from "vitest";
import {
  DRAFT_NETWORKS,
  destinationState,
  networkForChannel,
  networkForService,
  parseDestinationOverride,
  selectedDestinationIds,
  serviceForNetwork,
  type DestinationChannel,
} from "./destinations";
import { SOCIAL_NETWORKS } from "@/lib/social-networks";
import { getAdapter } from "./capabilities";

const channel = (over: Partial<DestinationChannel>): DestinationChannel => ({
  id: "c1",
  service_id: "facebook-graph-api",
  status: "active",
  account_id: "744751622301298",
  default_target: true,
  delivery_mode: "automated",
  ...over,
});

describe("draft networks", () => {
  it("cover every network the AI fan-out writes for", () => {
    for (const network of SOCIAL_NETWORKS) expect(DRAFT_NETWORKS).toContain(network);
  });

  it("each publish through a service this build has an adapter for", () => {
    for (const network of DRAFT_NETWORKS) {
      expect(getAdapter(serviceForNetwork(network)), network).toBeDefined();
      expect(networkForService(serviceForNetwork(network))).toBe(network);
    }
  });

  it("an unknown service belongs to no network", () => {
    expect(networkForService("facebook-personal-profile")).toBeNull();
  });
});

describe("networkForChannel", () => {
  it("reads an automated channel's network off its service", () => {
    expect(networkForChannel({ service_id: "facebook-graph-api", delivery_mode: "automated" })).toBe("facebook");
  });

  it("reads a manual channel's network out of the name the person typed", () => {
    const manual = (service_id: string, service_name: string) =>
      networkForChannel({ service_id, service_name, delivery_mode: "manual" });
    expect(manual("facebook-personal-profile", "Facebook (personal profile)")).toBe("facebook");
    expect(manual("x-founder-account", "X founder account")).toBe("twitter");
    expect(manual("linkedin", "LinkedIn")).toBe("linkedin");
  });

  it("a manual channel that names no network belongs to none", () => {
    expect(
      networkForChannel({ service_id: "newsletter", service_name: "Newsletter", delivery_mode: "manual" })
    ).toBeNull();
    // "x" has to be a word of its own, not a letter inside one.
    expect(
      networkForChannel({ service_id: "mailbox", service_name: "Mailbox", delivery_mode: "manual" })
    ).toBeNull();
  });
});

describe("destinationState", () => {
  it("is ready when connected and pointing somewhere", () => {
    expect(destinationState(channel({}))).toBe("ready");
  });

  it("is trouble — kept, greyed out — when the connection needs attention", () => {
    expect(destinationState(channel({ status: "expired" }))).toBe("trouble");
    expect(destinationState(channel({ status: "error" }))).toBe("trouble");
  });

  it("is unavailable when the connection never finished or was revoked", () => {
    expect(destinationState(channel({ status: "pending" }))).toBe("unavailable");
    expect(destinationState(channel({ status: "revoked" }))).toBe("unavailable");
  });

  it("is unavailable when a network that needs a Page or channel has none chosen", () => {
    expect(destinationState(channel({ account_id: null }))).toBe("unavailable");
  });

  it("is ready without an account for a network that posts as the signed-in account", () => {
    expect(destinationState(channel({ service_id: "twitter", account_id: null }))).toBe("ready");
  });

  it("a manual channel needs no account id", () => {
    expect(
      destinationState(channel({ service_id: "facebook-personal", delivery_mode: "manual", account_id: null }))
    ).toBe("ready");
  });
});

describe("selectedDestinationIds", () => {
  const channels = [
    channel({ id: "page-a" }),
    channel({ id: "page-b", default_target: false }),
    channel({ id: "expired", status: "expired" }),
    channel({ id: "revoked", status: "revoked" }),
  ];

  it("uses the channels' defaults when the post made no choice", () => {
    expect([...selectedDestinationIds(channels, null)]).toEqual(["page-a", "expired"]);
  });

  it("uses the post's own choice when it made one", () => {
    expect([...selectedDestinationIds(channels, ["page-b"])]).toEqual(["page-b"]);
  });

  it("an empty choice means nowhere, not the defaults", () => {
    expect(selectedDestinationIds(channels, []).size).toBe(0);
  });

  it("drops a chosen destination that is gone or can't be offered", () => {
    expect([...selectedDestinationIds(channels, ["page-a", "deleted", "revoked"])]).toEqual(["page-a"]);
  });
});

describe("parseDestinationOverride", () => {
  it("reads a stored list and treats anything else as no choice", () => {
    expect(parseDestinationOverride(["a", "b"])).toEqual(["a", "b"]);
    expect(parseDestinationOverride([])).toEqual([]);
    expect(parseDestinationOverride(null)).toBeNull();
    expect(parseDestinationOverride("a")).toBeNull();
    expect(parseDestinationOverride(["a", 3])).toEqual(["a"]);
  });
});
