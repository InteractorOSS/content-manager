import { describe, expect, it, vi } from "vitest";
import { checkNetworkRules } from "./network-rules";

function fakeDb(
  channels: {
    id: string;
    service_id: string;
    service_name: string;
    account_id: string | null;
    delivery_mode?: string;
  }[]
) {
  return {
    socialChannel: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        channels.filter((c) => where.id.in.includes(c.id))
      ),
    },
  };
}

const TWITTER = { id: "c_tw", service_id: "twitter", service_name: "Brand X", account_id: null };
const LINKEDIN = { id: "c_li", service_id: "linkedin", service_name: "Brand LI", account_id: "urn:li:person:1" };

describe("checkNetworkRules", () => {
  it("returns no violations for an empty channel list without querying the db", async () => {
    const db = fakeDb([]);
    expect(await checkNetworkRules(db, [], "anything", undefined, [])).toEqual([]);
    expect(db.socialChannel.findMany).not.toHaveBeenCalled();
  });

  it("checks the post body against every named channel", async () => {
    const db = fakeDb([TWITTER, LINKEDIN]);
    const violations = await checkNetworkRules(db, ["c_tw", "c_li"], "x".repeat(281), undefined, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ code: "char_limit", channel_id: "c_tw" });
  });

  it("checks a channel's body_override instead of the shared body when one is set", async () => {
    const db = fakeDb([TWITTER]);
    // The shared body is over X's limit, but this channel has a short override.
    const violations = await checkNetworkRules(db, ["c_tw"], "x".repeat(281), { c_tw: "short override" }, []);
    expect(violations).toEqual([]);
  });

  it("falls back to the shared body when a channel's override is blank", async () => {
    const db = fakeDb([TWITTER]);
    const violations = await checkNetworkRules(db, ["c_tw"], "x".repeat(281), { c_tw: "   " }, []);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("char_limit");
  });

  it("G#27: skips rule-checking a manual-mode channel entirely", async () => {
    const manual = {
      id: "c_manual",
      service_id: "facebook-personal",
      service_name: "Facebook (personal profile)",
      account_id: null,
      delivery_mode: "manual",
    };
    const db = fakeDb([manual]);
    const violations = await checkNetworkRules(db, ["c_manual"], "x".repeat(100000), undefined, []);
    expect(violations).toEqual([]);
  });
});
