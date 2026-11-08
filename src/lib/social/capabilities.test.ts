import { describe, expect, it } from "vitest";
import {
  getAdapter,
  needsAccountIdUpfront,
  networkRules,
  serviceIdsForNetwork,
  splitRedditTitle,
  validateAgainstNetworkRules,
} from "./capabilities";
import { coreFixture } from "./__fixtures__/core";

/** An execute function answering each capability with its Core fixture body
 * (`<service>.<capability>.json`), recording what was asked for. */
function fixtureExecute(service: string, answers: Record<string, string | Error>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const execute = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error(`unexpected capability ${service}.${name}`);
    return coreFixture(answer).data;
  };
  return { execute, calls };
}

// G#26: network rules — per-service publish constraints enforced BEFORE a
// post is scheduled or published, not just documented.

describe("validateAgainstNetworkRules", () => {
  const linkedinChannel = {
    id: "chan1",
    service_id: "linkedin",
    service_name: "My LinkedIn",
    account_id: "urn:li:person:abc",
  };

  it("passes a post within every rule", () => {
    expect(validateAgainstNetworkRules(linkedinChannel, { body: "short and sweet" })).toEqual([]);
  });

  it("flags a body over the service's character limit", () => {
    // LinkedIn's adapter limit is 3000 (capabilities.ts) — distinct from the
    // 2800 the CMS's per-post Social tab counter uses (social-networks.ts),
    // a different subsystem with its own (tighter, by design) limit.
    const violations = validateAgainstNetworkRules(linkedinChannel, { body: "x".repeat(3001) });
    expect(violations).toEqual([
      expect.objectContaining({ code: "char_limit", channel_id: "chan1" }),
    ]);
  });

  it("flags a channel missing a required account id", () => {
    const violations = validateAgainstNetworkRules(
      { ...linkedinChannel, account_id: null },
      { body: "short" }
    );
    expect(violations).toEqual([
      expect.objectContaining({ code: "missing_account_id", channel_id: "chan1" }),
    ]);
  });

  it("flags Instagram missing required media", () => {
    const igChannel = {
      id: "chan2",
      service_id: "instagram",
      service_name: "Brand IG",
      account_id: "17841400000000000",
    };
    expect(validateAgainstNetworkRules(igChannel, { body: "no picture attached" })).toEqual([
      expect.objectContaining({ code: "missing_media", channel_id: "chan2" }),
    ]);
    expect(
      validateAgainstNetworkRules(igChannel, {
        body: "with a picture",
        media: [{ url: "https://example.com/a.jpg" }],
      })
    ).toEqual([]);
  });

  it("flags an unsupported service instead of silently passing", () => {
    const violations = validateAgainstNetworkRules(
      { id: "chan3", service_id: "mastodon", service_name: "Mastodon", account_id: null },
      { body: "hello" }
    );
    expect(violations).toEqual([expect.objectContaining({ code: "unsupported_service", channel_id: "chan3" })]);
  });

  it("can report more than one violation for the same channel", () => {
    const igChannel = { id: "chan4", service_id: "instagram", service_name: "Brand IG", account_id: null };
    const violations = validateAgainstNetworkRules(igChannel, { body: "x".repeat(2201) });
    expect(violations.map((v) => v.code).sort()).toEqual(["char_limit", "missing_account_id", "missing_media"]);
  });

  it("G#27: a manual-mode channel is never checked against adapter rules — there is no adapter", () => {
    // No SERVICE_ADAPTERS entry for "facebook-personal" at all — an
    // automated channel on this service_id would 422 as unsupported_service,
    // but a manual one has no publish path to validate against.
    const manualChannel = {
      id: "chan5",
      service_id: "facebook-personal",
      service_name: "Facebook (personal profile)",
      account_id: null,
      delivery_mode: "manual",
    };
    expect(validateAgainstNetworkRules(manualChannel, { body: "x".repeat(100000) })).toEqual([]);
  });
});

describe("networkRules", () => {
  it("reports every supported service's constraints", () => {
    const rules = networkRules();
    expect(rules.find((r) => r.service_id === "instagram")).toEqual({
      service_id: "instagram",
      display_name: "Instagram",
      char_limit: 2200,
      requires_account_id: true,
      requires_media: true,
      media_limits: expect.objectContaining({ maxItems: 10, mixed: true }),
      account_label: "Instagram business account",
      discovers_accounts: true,
      // No reply chain and no first comment: both are joined into the caption.
      threads: false,
      first_comment_char_limit: null,
    });
    expect(rules.find((r) => r.service_id === "twitter")).toEqual({
      service_id: "twitter",
      display_name: "X (Twitter)",
      char_limit: 280,
      requires_account_id: false,
      requires_media: false,
      media_limits: expect.objectContaining({ maxImages: 4, maxVideos: 1 }),
      account_label: null,
      discovers_accounts: false,
      threads: true,
      first_comment_char_limit: 280,
    });
  });
});

describe("serviceIdsForNetwork", () => {
  it("maps each AI fan-out network to its channel service id", () => {
    expect(serviceIdsForNetwork("linkedin")).toEqual(["linkedin"]);
    expect(serviceIdsForNetwork("twitter")).toEqual(["twitter"]);
    expect(serviceIdsForNetwork("facebook")).toEqual(["facebook-graph-api"]);
  });

  it("returns nothing for a network with no mapping", () => {
    expect(serviceIdsForNetwork("mastodon")).toEqual([]);
  });
});

describe("splitRedditTitle", () => {
  it("uses the first line as the title and the rest as the body", () => {
    expect(splitRedditTitle("We shipped Reddit support\n\nHere is how it works.")).toEqual({
      title: "We shipped Reddit support",
      text: "Here is how it works.",
    });
  });

  it("treats single-line copy as all title", () => {
    expect(splitRedditTitle("  Just a headline  ")).toEqual({ title: "Just a headline", text: "" });
  });

  it("cuts an over-long first line at a word and keeps it whole in the body", () => {
    const first = `${"word ".repeat(80)}end`;
    const { title, text } = splitRedditTitle(`${first}\nMore.`);
    expect(title.length).toBeLessThanOrEqual(300);
    expect(title.endsWith("…")).toBe(true);
    expect(text).toBe(`${first}\n\nMore.`);
  });
});

describe("reddit adapter", () => {
  const reddit = getAdapter("reddit")!;
  // A text post: nothing to read or upload.
  const context = {
    readMedia: async () => { throw new Error("no media expected"); },
    once: (_key: string, upload: () => Promise<string>) => upload(),
  };
  const ok = { json: { errors: [], data: { id: "abc", name: "t3_abc", url: "https://www.reddit.com/r/test/comments/abc/x/" } } };

  it("submits a text post to the channel's subreddit", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const result = await reddit.customPublish!(
      { body: "A title\nThe body", accountId: "r/test" },
      async (name, args) => {
        calls.push([name, args]);
        return ok;
      },
      context
    );
    expect(calls).toEqual([
      ["submit_post", { sr: "test", title: "A title", kind: "self", text: "The body" }],
    ]);
    expect(result).toEqual({
      externalId: "t3_abc",
      externalUrl: "https://www.reddit.com/r/test/comments/abc/x/",
    });
  });

  it("keeps the copy and puts the backlink at the end of the text", async () => {
    let sent: Record<string, unknown> = {};
    await reddit.customPublish!(
      { body: "A title\nThe body", link: "https://example.com/post", accountId: "test" },
      async (_name, args) => {
        sent = args;
        return ok;
      },
      context
    );
    expect(sent).toEqual({
      sr: "test",
      title: "A title",
      kind: "self",
      text: "The body\n\nhttps://example.com/post",
    });
  });

  it("fails with Reddit's own reason when it answers 200 with errors", async () => {
    await expect(
      reddit.customPublish!({ body: "A title", accountId: "test" }, async () => ({
        json: { errors: [["SUBREDDIT_NOTALLOWED", "you aren't allowed to post there.", "sr"]] },
      }), context)
    ).rejects.toThrow("Reddit did not accept the post: you aren't allowed to post there.");
  });

  it("fails when Reddit returns neither errors nor a post", async () => {
    await expect(
      reddit.customPublish!({ body: "A title", accountId: "test" }, async () => ({}), context)
    ).rejects.toThrow("Reddit did not return the new post");
  });
});

describe("account discovery", () => {
  it("lists the Pages a Facebook connection manages", async () => {
    const accounts = await getAdapter("facebook-graph-api")!.discoverAccounts!(async (name) => {
      expect(name).toBe("list_pages");
      return { data: [{ id: "744751622301298", name: "Interactor" }, { name: "no id" }] };
    });
    expect(accounts).toEqual([{ id: "744751622301298", name: "Interactor" }]);
  });

  it("lists a Slack workspace's channels by name", async () => {
    const accounts = await getAdapter("slack")!.discoverAccounts!(async () => ({
      channels: [{ id: "C0736NNAF6D", name: "random" }],
    }));
    expect(accounts).toEqual([{ id: "C0736NNAF6D", name: "#random" }]);
  });

  it("turns a LinkedIn member into a person URN", async () => {
    const accounts = await getAdapter("linkedin")!.discoverAccounts!(async (name) =>
      name === "get_me" ? { sub: "617WfN4yFW", name: "Peter Jung" } : { elements: [] }
    );
    expect(accounts).toEqual([
      { id: "urn:li:person:617WfN4yFW", name: "Peter Jung", detail: "Your profile" },
    ]);
  });

  it("offers the LinkedIn member and every company page they administer", async () => {
    const { execute, calls } = fixtureExecute("linkedin", {
      get_me: "linkedin.get_me",
      list_admin_organizations: "linkedin.list_admin_organizations",
    });
    const accounts = await getAdapter("linkedin")!.discoverAccounts!(execute);
    expect(accounts).toEqual([
      { id: "urn:li:person:782bbtaQ", name: "Peter Jung", detail: "Your profile" },
      { id: "urn:li:organization:90210457", name: "Interactor", detail: "Company page" },
      // No projected name: still offered, never as a raw URN.
      { id: "urn:li:organization:11223344", name: "Organization 11223344", detail: "Company page" },
    ]);
    // Only pages the member is an approved administrator of can be posted as.
    expect(calls[1].args).toMatchObject({ role: "ADMINISTRATOR", state: "APPROVED" });
  });

  it("still offers the LinkedIn member when organizations can't be listed", async () => {
    // A connection made before the organization scopes existed is refused.
    const { execute } = fixtureExecute("linkedin", {
      get_me: "linkedin.get_me",
      list_admin_organizations: new Error("403 Not enough permissions"),
    });
    const accounts = await getAdapter("linkedin")!.discoverAccounts!(execute);
    expect(accounts.map((a) => a.id)).toEqual(["urn:li:person:782bbtaQ"]);
  });

  it("skips LinkedIn organization rows it can't read, and duplicates", async () => {
    const accounts = await getAdapter("linkedin")!.discoverAccounts!(async (name) =>
      name === "get_me"
        ? { sub: "abc" }
        : {
            elements: [
              { organization: "urn:li:organizationBrand:5" },
              { organization: 42, localizedName: "Numeric" },
              { organization: "urn:li:organization:42" },
              {},
            ],
          }
    );
    expect(accounts.slice(1)).toEqual([
      { id: "urn:li:organization:42", name: "Numeric", detail: "Company page" },
    ]);
  });

  it("asks LinkedIn for the scopes that post as a company page", () => {
    expect(getAdapter("linkedin")!.connectScopes).toEqual(
      expect.arrayContaining(["w_member_social", "w_organization_social", "r_organization_admin"])
    );
  });

  it("lists only the Pages that have an Instagram business account, by username", async () => {
    const { execute, calls } = fixtureExecute("instagram", {
      list_pages: "instagram.list_pages",
    });
    const accounts = await getAdapter("instagram")!.discoverAccounts!(execute);
    expect(accounts).toEqual([
      { id: "17841405822304914", name: "@interactor.hq", detail: "Linked to the Page Interactor" },
      // No username: named by its Page rather than a bare id. The second
      // Page linked to @interactor.hq is not offered a second time.
      {
        id: "17841400000000001",
        name: "Instagram account linked to Interactor Events",
        detail: "Linked to the Page Interactor Events",
      },
    ]);
    expect(String(calls[0].args.fields)).toContain("instagram_business_account");
  });

  it("names an Instagram account with neither username nor Page in plain words", async () => {
    const accounts = await getAdapter("instagram")!.discoverAccounts!(async () => ({
      data: [{ instagram_business_account: { id: "17841499999999999" } }],
    }));
    expect(accounts).toEqual([{ id: "17841499999999999", name: "Instagram business account" }]);
  });

  it("asks Instagram for the Page permissions that find a linked account", () => {
    expect(getAdapter("instagram")!.connectScopes).toEqual(
      expect.arrayContaining(["pages_show_list", "business_management", "instagram_content_publish"])
    );
  });

  it("returns nothing, not a crash, for an unexpected response", async () => {
    expect(await getAdapter("facebook-graph-api")!.discoverAccounts!(async () => ({}))).toEqual([]);
    expect(await getAdapter("linkedin")!.discoverAccounts!(async () => ({}))).toEqual([]);
    expect(await getAdapter("instagram")!.discoverAccounts!(async () => ({}))).toEqual([]);
  });

  it("asks for the account id up front only when it cannot be listed", () => {
    expect(needsAccountIdUpfront(getAdapter("reddit")!)).toBe(true);
    expect(needsAccountIdUpfront(getAdapter("facebook-graph-api")!)).toBe(false);
    expect(needsAccountIdUpfront(getAdapter("linkedin")!)).toBe(false);
    expect(needsAccountIdUpfront(getAdapter("instagram")!)).toBe(false);
    expect(needsAccountIdUpfront(getAdapter("twitter")!)).toBe(false);
  });

  it("asks Facebook for the permissions that make a business-owned Page visible", () => {
    expect(getAdapter("facebook-graph-api")!.connectScopes).toEqual(
      expect.arrayContaining(["pages_show_list", "business_management"])
    );
  });
});
