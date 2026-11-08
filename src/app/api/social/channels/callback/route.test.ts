import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The connect callback is the leg that was broken in three separate ways at
 * once: the ids never arrived, anyone's session could bind a credential onto
 * anyone's channel, and whatever credential id was in the URL was written
 * without being checked. Each of those has a test here.
 *
 * The auth/actor/tenant seams are mocked wholesale (the pattern
 * src/app/api/cms/sites/route.test.ts uses for the guard) so the route's own
 * decisions are what's under test, not Prisma or NextAuth.
 */

let session: { user?: { id: string }; error?: string } | null = null;

type Channel = {
  id: string;
  organization_id: string;
  service_id: string;
  external_user_id: string;
  account_id: string | null;
  account_name: string | null;
  credential_id?: string | null;
};

/** org id → channels that org owns. */
const channelsByOrg = new Map<string, Channel[]>();
const channelUpdate = vi.fn();

let actorOrganizations: Array<{ id: string; name: string; slug: string; role: string }> = [];
let activeOrgId: string | null = null;
let permissions = new Set<string>();

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => session),
  oidcEnabled: false,
}));

vi.mock("@/lib/rbac", () => ({
  hasPermission: (
    actor: { permissions: Set<string> },
    permission: string
  ) => actor.permissions.has(permission),
  loadActor: vi.fn(
    async (
      _user: unknown,
      options?: { forceOrganizationId?: string | null }
    ) => {
      if (!session?.user) return null;
      const forced = options?.forceOrganizationId ?? null;
      const organizationId =
        forced && actorOrganizations.some((o) => o.id === forced)
          ? forced
          : activeOrgId;
      return {
        user: { id: "u1", email: "a@b.c", name: null, status: "active" },
        organizationId,
        membershipRole: "admin",
        organizations: actorOrganizations,
        roles: ["admin"],
        isSuperAdmin: false,
        permissions,
      };
    }
  ),
}));

vi.mock("@/lib/tenant-db", () => ({
  tenantDb: (organizationId: string) => ({
    socialChannel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (channelsByOrg.get(organizationId) ?? []).find((c) => c.id === where.id) ??
        null,
      update: (...args: unknown[]) => {
        channelUpdate(organizationId, ...args);
        return Promise.resolve({});
      },
      updateMany: (...args: unknown[]) => {
        siblingUpdate(organizationId, ...args);
        return Promise.resolve({ count: 0 });
      },
    },
  }),
}));

const siblingUpdate = vi.fn();
const getCredential = vi.fn();
const listCredentials = vi.fn();
vi.mock("@/lib/interactor", () => ({
  getCredential: (...a: unknown[]) => getCredential(...a),
  listCredentials: (...a: unknown[]) => listCredentials(...a),
}));

const discoverChannelAccounts = vi.fn();
vi.mock("@/lib/social/accounts", () => ({
  discoverChannelAccounts: (...a: unknown[]) => discoverChannelAccounts(...a),
}));

import { GET as pathGET } from "./[channelId]/route";
import { GET as legacyGET } from "./route";
import { recoverJoinedCallbackParams } from "@/lib/social/connect-callback";

const CHANNEL: Channel = {
  id: "ch_1",
  organization_id: "org_a",
  service_id: "slack",
  external_user_id: "cms-ch-ch_1",
  account_id: null,
  account_name: null,
};

function pathReq(query = "?credential_id=cred_1", channelId = "ch_1") {
  return pathGET(
    new NextRequest(
      `http://localhost/api/social/channels/callback/${channelId}${query}`
    ),
    { params: Promise.resolve({ channelId }) }
  );
}

function legacyReq(query: string) {
  return legacyGET(
    new NextRequest(`http://localhost/api/social/channels/callback${query}`)
  );
}

function location(res: Response) {
  return new URL(res.headers.get("location")!);
}

beforeEach(() => {
  session = { user: { id: "u1" } };
  activeOrgId = "org_a";
  actorOrganizations = [{ id: "org_a", name: "Acme", slug: "acme", role: "admin" }];
  permissions = new Set(["content:create"]);
  channelsByOrg.clear();
  channelsByOrg.set("org_a", [{ ...CHANNEL }]);
  channelUpdate.mockReset();
  siblingUpdate.mockReset();
  getCredential.mockReset();
  listCredentials.mockReset();
  // By default the service has no way to list its accounts.
  discoverChannelAccounts.mockReset().mockResolvedValue(null);
  getCredential.mockResolvedValue({
    id: "cred_1",
    service_id: "slack",
    external_user_id: "cms-ch-ch_1",
    status: "active",
    scopes: ["chat:write"],
    identity: { name: "#announcements" },
  });
});

describe("recoverJoinedCallbackParams", () => {
  it("recovers both ids when Core welded its query onto ours with a '?'", () => {
    expect(
      recoverJoinedCallbackParams("ch_1?credential_id=cred_1", null)
    ).toEqual({ channelId: "ch_1", credentialId: "cred_1" });
  });

  it("recovers both ids when the join character was '&'", () => {
    expect(
      recoverJoinedCallbackParams("ch_1&credential_id=cred_1&service_id=slack", null)
    ).toEqual({ channelId: "ch_1", credentialId: "cred_1" });
  });

  it("prefers a credential_id that arrived as its own parameter", () => {
    expect(
      recoverJoinedCallbackParams("ch_1?credential_id=stale", "cred_1")
    ).toEqual({ channelId: "ch_1", credentialId: "cred_1" });
  });

  it("passes an already-clean pair straight through", () => {
    expect(recoverJoinedCallbackParams("ch_1", "cred_1")).toEqual({
      channelId: "ch_1",
      credentialId: "cred_1",
    });
  });
});

describe("GET /api/social/channels/callback/[channelId]", () => {
  it("activates the channel with the verified credential", async () => {
    const res = await pathReq();

    expect(location(res).pathname + location(res).search).toBe(
      "/social/channels?connected=1"
    );
    expect(channelUpdate).toHaveBeenCalledTimes(1);
    const [org, args] = channelUpdate.mock.calls[0];
    expect(org).toBe("org_a");
    expect(args).toMatchObject({
      where: { id: "ch_1" },
      data: { credential_id: "cred_1", status: "active" },
    });
    // Identity details off the credential label the card when we have none.
    expect(args.data.account_name).toBe("#announcements");
  });

  it("sends a signed-out browser to sign in and back to this exact URL", async () => {
    session = null;
    const res = await pathReq();
    const url = location(res);

    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("callbackUrl")).toBe(
      "/api/social/channels/callback/ch_1?credential_id=cred_1"
    );
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses a channel in an organization the actor is not a member of", async () => {
    // The row exists — it just belongs to someone else's tenant.
    channelsByOrg.set("org_b", [{ ...CHANNEL, organization_id: "org_b" }]);
    channelsByOrg.set("org_a", []);

    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=channel_not_found");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("finds a channel in a non-active org the actor does belong to", async () => {
    activeOrgId = "org_a";
    actorOrganizations = [
      { id: "org_a", name: "Acme", slug: "acme", role: "admin" },
      { id: "org_b", name: "Beta", slug: "beta", role: "admin" },
    ];
    channelsByOrg.set("org_a", []);
    channelsByOrg.set("org_b", [{ ...CHANNEL, organization_id: "org_b" }]);

    const res = await pathReq();
    expect(location(res).search).toBe("?connected=1");
    expect(channelUpdate.mock.calls[0][0]).toBe("org_b");
  });

  it("refuses an unknown channel id", async () => {
    const res = await pathReq("?credential_id=cred_1", "ch_nope");
    expect(location(res).search).toBe("?connected=0&reason=channel_not_found");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the actor may not connect channels in that org", async () => {
    permissions = new Set(["content:view"]);
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=no_permission");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("brings back every other place the same connection posts to", async () => {
    await pathReq();
    expect(siblingUpdate).toHaveBeenCalledTimes(1);
    const [org, args] = siblingUpdate.mock.calls[0];
    expect(org).toBe("org_a");
    expect(args).toEqual({
      where: { external_user_id: "cms-ch-ch_1", id: { not: "ch_1" } },
      data: { credential_id: "cred_1", status: "active" },
    });
  });

  it("fills the account in when the connection can only mean one", async () => {
    discoverChannelAccounts.mockResolvedValue([
      { id: "744751622301298", name: "Interactor" },
    ]);
    await pathReq();
    const [, args] = channelUpdate.mock.calls[0];
    expect(args.data.account_id).toBe("744751622301298");
    // The card is labelled with the account it posts to (the Page), not the
    // person who signed in.
    expect(args.data.account_name).toBe("Interactor");
  });

  it("lists accounts as the credential just verified, not the row's old one", async () => {
    // A reconnect: the row still names the previous credential until the
    // activation write, so discovery must be told which one to ask as.
    channelsByOrg.set("org_a", [{ ...CHANNEL, credential_id: "cred_old" }]);
    discoverChannelAccounts.mockResolvedValue([]);
    await pathReq("?credential_id=cred_1");
    expect(discoverChannelAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        service_id: "slack",
        external_user_id: "cms-ch-ch_1",
        credential_id: "cred_1",
      })
    );
  });

  it("leaves the account for the reader to pick when there are several", async () => {
    discoverChannelAccounts.mockResolvedValue([
      { id: "1", name: "Page one" },
      { id: "2", name: "Page two" },
    ]);
    const res = await pathReq();
    // …and sends them straight to the picker for this channel.
    expect(location(res).search).toBe("?connected=1&choose=ch_1");
    expect(channelUpdate.mock.calls[0][1].data.account_id).toBeNull();
  });

  it("opens the picker when the connection can reach nothing yet", async () => {
    // An Instagram sign-in whose Pages have no business account linked: the
    // picker is where the reader is told what to fix.
    discoverChannelAccounts.mockResolvedValue([]);
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=1&choose=ch_1");
  });

  it("does not open a picker for a network with nothing to pick", async () => {
    discoverChannelAccounts.mockResolvedValue(null);
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=1");
  });

  it("keeps an account id the reader typed before connecting", async () => {
    channelsByOrg.set("org_a", [{ ...CHANNEL, account_id: "typed-id" }]);
    discoverChannelAccounts.mockResolvedValue([{ id: "other", name: "Other" }]);
    await pathReq();
    expect(discoverChannelAccounts).not.toHaveBeenCalled();
    expect(channelUpdate.mock.calls[0][1].data.account_id).toBe("typed-id");
  });

  it("still activates the channel when the network won't list its accounts", async () => {
    discoverChannelAccounts.mockRejectedValue(new Error("provider down"));
    const res = await pathReq();
    // The picker opens anyway: it asks again, and says so if it still can't.
    expect(location(res).search).toBe("?connected=1&choose=ch_1");
    expect(channelUpdate.mock.calls[0][1].data).toMatchObject({
      status: "active",
      account_id: null,
    });
  });

  it("says the network refused when Core comes back with an error", async () => {
    const res = await pathReq("?error=access_denied&error_description=The+user+cancelled");
    expect(location(res).search).toBe("?connected=0&reason=provider_refused");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses without a credential_id", async () => {
    const res = await pathReq("");
    expect(location(res).search).toBe("?connected=0&reason=missing_details");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses a credential for a different service", async () => {
    getCredential.mockResolvedValue({
      id: "cred_1",
      service_id: "facebook-graph-api",
      external_user_id: "cms-ch-ch_1",
    });
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=account_mismatch");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses a credential stored under another Core identity", async () => {
    getCredential.mockResolvedValue({
      id: "cred_1",
      service_id: "slack",
      external_user_id: "cms-ch-ch_other",
    });
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=account_mismatch");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("falls back to listing the identity's credentials when Core omits the owner", async () => {
    getCredential.mockResolvedValue({ id: "cred_1", service_id: "slack" });
    listCredentials.mockResolvedValue([{ id: "cred_1" }]);

    const res = await pathReq();
    expect(listCredentials).toHaveBeenCalledWith("cms-ch-ch_1");
    expect(location(res).search).toBe("?connected=1");
  });

  it("refuses when that fallback does not list the credential", async () => {
    getCredential.mockResolvedValue({ id: "cred_1", service_id: "slack" });
    listCredentials.mockResolvedValue([{ id: "cred_other" }]);

    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=account_mismatch");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses a credential Core does not return", async () => {
    getCredential.mockResolvedValue(null);
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=account_unverified");
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("refuses when Core cannot be reached to verify", async () => {
    getCredential.mockRejectedValue(new Error("502"));
    const res = await pathReq();
    expect(location(res).search).toBe("?connected=0&reason=account_unverified");
    expect(channelUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/social/channels/callback (legacy shape)", () => {
  it("activates a flow whose ids arrived welded into channel_id", async () => {
    const res = await legacyReq(
      `?channel_id=${encodeURIComponent("ch_1?credential_id=cred_1")}`
    );

    expect(location(res).search).toBe("?connected=1");
    expect(channelUpdate.mock.calls[0][1]).toMatchObject({
      data: { credential_id: "cred_1", status: "active" },
    });
  });

  it("still activates the clean two-parameter shape", async () => {
    const res = await legacyReq("?channel_id=ch_1&credential_id=cred_1");
    expect(location(res).search).toBe("?connected=1");
  });

  it("refuses with no ids at all", async () => {
    const res = await legacyReq("");
    expect(location(res).search).toBe("?connected=0&reason=missing_details");
    expect(channelUpdate).not.toHaveBeenCalled();
  });
});
