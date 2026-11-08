import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#26: /api/social/channels now accepts a personal access token (not just a
// browser session) via requirePermissionApi — list_social_channels (MCP)
// delegates here with the caller's bearer token.

const actor = {
  user: { id: "u1", email: "a@example.com", name: "Author One" },
  permissions: new Set<string>(["content:view", "content:create"]),
};
let via: "session" | "token" = "session";

const socialChannelFindMany = vi.fn();
const socialChannelCreate = vi.fn();
const socialChannelUpdate = vi.fn();
const socialChannelDelete = vi.fn();
const db = {
  socialChannel: {
    findMany: socialChannelFindMany,
    create: socialChannelCreate,
    update: socialChannelUpdate,
    delete: socialChannelDelete,
  },
};

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (req: NextRequest, ...perms: string[]) => {
    const header = req.headers.get("authorization");
    if (header) via = "token";
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, db, via };
  }),
}));

const initiateOAuth = vi.fn();
vi.mock("@/lib/interactor", () => ({
  InteractorError: class InteractorError extends Error {
    status?: number;
  },
  initiateOAuth: (...args: unknown[]) => initiateOAuth(...args),
}));

import { env } from "@/lib/env";
import { GET, POST } from "./route";

const CHANNEL = {
  id: "c1",
  service_id: "twitter",
  service_name: "X (Twitter)",
  account_id: null,
  account_name: null,
  status: "active",
  connected_by: null,
  inserted_at: new Date("2024-01-01"),
  updated_at: new Date("2024-01-01"),
};

beforeEach(() => {
  actor.permissions = new Set(["content:view", "content:create"]);
  via = "session";
  socialChannelFindMany.mockReset().mockResolvedValue([CHANNEL]);
  socialChannelCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "c_new",
    ...data,
    inserted_at: new Date(),
    updated_at: new Date(),
  }));
  socialChannelUpdate.mockReset().mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      service_id: "twitter",
      ...data,
      inserted_at: new Date(),
      updated_at: new Date(),
    })
  );
  socialChannelDelete.mockReset().mockResolvedValue(undefined);
  initiateOAuth.mockReset().mockResolvedValue({
    authorization_url: "https://interactor.example/oauth/start",
    flow_id: "flow_1",
  });
});

function req(url = "http://localhost/api/social/channels", token?: string) {
  return new NextRequest(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

function postReq(body: Record<string, unknown>, token?: string) {
  return new NextRequest("http://localhost/api/social/channels", {
    method: "POST",
    body: JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("GET /api/social/channels", () => {
  it("authenticates via a bearer token, not just a session", async () => {
    const res = await GET(req("http://localhost/api/social/channels", "cms_pat_x"));
    expect(res.status).toBe(200);
    expect(via).toBe("token");
    const json = await res.json();
    expect(json.data).toEqual([expect.objectContaining({ id: "c1", service_id: "twitter" })]);
  });

  it("403s a token without content:view", async () => {
    actor.permissions = new Set();
    const res = await GET(req("http://localhost/api/social/channels", "cms_pat_x"));
    expect(res.status).toBe(403);
    expect(socialChannelFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/social/channels", () => {
  it("starts an OAuth flow over a bearer token", async () => {
    const res = await POST(postReq({ service_id: "twitter" }, "cms_pat_x"));
    expect(res.status).toBe(201);
    expect(via).toBe("token");
    expect(initiateOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "twitter", externalUserId: "cms-ch-c_new" })
    );
    const json = await res.json();
    expect(json.data.authorization_url).toBe("https://interactor.example/oauth/start");
  });

  it("gives the channel its own Core identity and starts the flow with it", async () => {
    const res = await POST(postReq({ service_id: "slack" }));
    expect(res.status).toBe(201);

    // The row is created first because the identity is derived from its id.
    expect(socialChannelCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ delivery_mode: "automated", status: "pending" }),
    });
    expect(socialChannelUpdate).toHaveBeenCalledWith({
      where: { id: "c_new" },
      data: { external_user_id: "cms-ch-c_new" },
    });
    expect(initiateOAuth.mock.calls[0][0]).toMatchObject({
      externalUserId: "cms-ch-c_new",
    });
  });

  it("carries the channel id in the redirect PATH, not a query string", async () => {
    await POST(postReq({ service_id: "slack" }));

    const { successRedirectUrl, metadata } = initiateOAuth.mock.calls[0][0];
    expect(successRedirectUrl).toBe(
      `${env.NEXTAUTH_URL}/api/social/channels/callback/c_new`
    );
    expect(successRedirectUrl).not.toContain("?");
    // Core appends its own query; the result must still parse.
    const appended = new URL(`${successRedirectUrl}?credential_id=cred_1`);
    expect(appended.pathname.endsWith("/callback/c_new")).toBe(true);
    expect(appended.searchParams.get("credential_id")).toBe("cred_1");
    // Core-side identification of the flow is unchanged.
    expect(metadata).toMatchObject({ channel_id: "c_new" });
  });

  it("deletes the half-built row when the flow cannot be started", async () => {
    initiateOAuth.mockRejectedValue(new Error("core down"));

    const res = await POST(postReq({ service_id: "slack" }));
    expect(res.status).toBe(502);
    expect(socialChannelDelete).toHaveBeenCalledWith({ where: { id: "c_new" } });
  });

  it("explains in plain words when the CMS's own Interactor credentials are refused", async () => {
    const { InteractorError } = await import("@/lib/interactor");
    initiateOAuth.mockRejectedValue(
      new (InteractorError as unknown as new (m: string) => Error)(
        "Failed to obtain Interactor app token (401)"
      )
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(postReq({ service_id: "slack" }));
    const json = await res.json();
    expect(res.status).toBe(502);
    // What happened, that nothing changed, and who can fix it — not the raw cause.
    expect(json.error).toContain("couldn't sign in to Interactor");
    expect(json.error).toContain("Nothing was changed");
    expect(json.error).not.toContain("401");
    // The raw cause still reaches the process log for the operator.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("app token (401)"));
    logged.mockRestore();
  });

  it("422s an unsupported service", async () => {
    const res = await POST(postReq({ service_id: "not-a-real-service" }, "cms_pat_x"));
    expect(res.status).toBe(422);
    expect(socialChannelCreate).not.toHaveBeenCalled();
  });

  it("403s a token without content:create", async () => {
    actor.permissions = new Set(["content:view"]);
    const res = await POST(postReq({ service_id: "twitter" }, "cms_pat_x"));
    expect(res.status).toBe(403);
    expect(socialChannelCreate).not.toHaveBeenCalled();
  });

  // G#27: delivery_mode "manual" — a channel with no API access at all (e.g.
  // a personal Facebook profile), created directly with no OAuth flow.
  describe("delivery_mode: manual", () => {
    it("creates a manual channel immediately active, without starting OAuth", async () => {
      const res = await POST(
        postReq(
          {
            delivery_mode: "manual",
            service_id: "facebook-personal",
            service_name: "Facebook (personal profile)",
            account_name: "Jane's profile",
          },
          "cms_pat_x"
        )
      );
      expect(res.status).toBe(201);
      expect(initiateOAuth).not.toHaveBeenCalled();
      expect(socialChannelCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          service_id: "facebook-personal",
          service_name: "Facebook (personal profile)",
          delivery_mode: "manual",
          status: "active",
          account_name: "Jane's profile",
        }),
      });
      const json = await res.json();
      expect(json.data.channel.delivery_mode).toBe("manual");
      expect(json.data.authorization_url).toBeUndefined();
    });

    it("does not require a SERVICE_ADAPTERS entry — any service_id is allowed manually", async () => {
      const res = await POST(
        postReq({ delivery_mode: "manual", service_id: "not-a-real-service" }, "cms_pat_x")
      );
      expect(res.status).toBe(201);
    });

    it("422s a manual channel with no service_id", async () => {
      const res = await POST(postReq({ delivery_mode: "manual" }, "cms_pat_x"));
      expect(res.status).toBe(422);
      expect(socialChannelCreate).not.toHaveBeenCalled();
    });

    it("403s a manual channel without content:create", async () => {
      actor.permissions = new Set(["content:view"]);
      const res = await POST(
        postReq({ delivery_mode: "manual", service_id: "facebook-personal" }, "cms_pat_x")
      );
      expect(res.status).toBe(403);
      expect(socialChannelCreate).not.toHaveBeenCalled();
    });
  });
});
