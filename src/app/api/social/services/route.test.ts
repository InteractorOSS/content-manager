import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// G#26: /api/social/services now accepts a personal access token (not just a
// browser session) via requirePermissionApi — get_social_network_rules (MCP)
// delegates here with the caller's bearer token.

const actor = {
  user: { id: "u1", email: "a@example.com", name: "Author One" },
  permissions: new Set<string>(["content:view"]),
};
let via: "session" | "token" = "session";

vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(async (req: NextRequest, ...perms: string[]) => {
    const header = req.headers.get("authorization");
    if (header) via = "token";
    const missing = perms.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      return { error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }) };
    }
    return { actor, via };
  }),
}));

const serviceExists = vi.fn();
vi.mock("@/lib/interactor", () => ({
  InteractorError: class InteractorError extends Error {
    status?: number;
  },
  serviceExists: (...args: unknown[]) => serviceExists(...args),
}));

import { GET } from "./route";

beforeEach(() => {
  actor.permissions = new Set(["content:view"]);
  via = "session";
  serviceExists.mockReset().mockResolvedValue(true);
});

function req(token?: string) {
  return new NextRequest("http://localhost/api/social/services", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("GET /api/social/services", () => {
  it("authenticates via a bearer token, not just a session", async () => {
    const res = await GET(req("cms_pat_x"));
    expect(res.status).toBe(200);
    expect(via).toBe("token");
  });

  it("reports the network rules (char limit, account id / media requirements) per adapter", async () => {
    const res = await GET(req("cms_pat_x"));
    const json = await res.json();
    expect(json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service_id: "twitter",
          char_limit: 280,
          requires_account_id: false,
          requires_media: false,
        }),
        expect.objectContaining({
          service_id: "instagram",
          requires_account_id: true,
          requires_media: true,
        }),
      ])
    );
  });

  it("reports each network's media limits — what get_social_network_rules returns", async () => {
    const res = await GET(req("cms_pat_x"));
    const json = await res.json();
    const limits = Object.fromEntries(
      json.data.map((s: { service_id: string; media_limits: unknown }) => [s.service_id, s.media_limits])
    );
    expect(limits.twitter).toMatchObject({ maxImages: 4, maxVideos: 1, mixed: false });
    expect(limits.instagram).toMatchObject({ maxItems: 10, mixed: true });
    expect(limits.linkedin).toMatchObject({ maxImages: 20 });
    expect(limits["facebook-graph-api"]).toMatchObject({ maxImages: 10 });
    expect(limits.slack).toBeNull();
  });

  it("still lists adapters (marked available) when the Service Knowledge Base is unreachable", async () => {
    serviceExists.mockRejectedValue(new Error("core unreachable"));
    const res = await GET(req("cms_pat_x"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.every((s: { available: boolean }) => s.available)).toBe(true);
  });

  it("403s a token without content:view", async () => {
    actor.permissions = new Set();
    const res = await GET(req("cms_pat_x"));
    expect(res.status).toBe(403);
    expect(serviceExists).not.toHaveBeenCalled();
  });

  it("marks a service unavailable only when the catalog says it is absent", async () => {
    serviceExists.mockImplementation(async (slug: string) => slug !== "reddit");
    const res = await GET(req("cms_pat_x"));
    const json = await res.json();
    const bySlug = Object.fromEntries(
      json.data.map((s: { service_id: string; available: boolean }) => [s.service_id, s.available])
    );
    expect(bySlug.reddit).toBe(false);
    expect(bySlug.linkedin).toBe(true);
  });

  it("says which services fill the account id in after connecting", async () => {
    const res = await GET(req("cms_pat_x"));
    const json = await res.json();
    expect(json.data).toEqual(
      expect.arrayContaining([
        // A Page is picked from the account's own list…
        expect.objectContaining({
          service_id: "facebook-graph-api",
          discovers_accounts: true,
          account_id_upfront: false,
          account_label: "Facebook Page",
        }),
        // LinkedIn (profile or company page) and Instagram (the business
        // account linked to a Page) are picked too, with a next step for when
        // the connection reaches none.
        expect.objectContaining({
          service_id: "linkedin",
          discovers_accounts: true,
          account_id_upfront: false,
          no_accounts_help: expect.any(String),
        }),
        expect.objectContaining({
          service_id: "instagram",
          discovers_accounts: true,
          account_id_upfront: false,
          no_accounts_help: expect.stringContaining("linked"),
        }),
        // …a subreddit has to be typed.
        expect.objectContaining({
          service_id: "reddit",
          discovers_accounts: false,
          account_id_upfront: true,
          account_label: "subreddit",
        }),
      ])
    );
  });
});
