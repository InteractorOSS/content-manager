import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/social/channels/[id]/accounts asks the network as the channel's
 * own credential, so the channel must be one of the caller's: it needs
 * content:edit, it is looked up only through the tenant-scoped db, and a
 * channel from another organization is a 404 that never reaches Core.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { INTERACTOR_CORE_URL: "https://core.test" } }));

type Row = {
  id: string;
  service_id: string;
  external_user_id: string;
  credential_id: string | null;
  delivery_mode: string;
  status: string;
};

const ACME_LINKEDIN: Row = {
  id: "ch_acme",
  service_id: "linkedin",
  external_user_id: "cms-ch-ch_acme",
  credential_id: "cred_acme",
  delivery_mode: "api",
  status: "active",
};
const OTHER_ORG_LINKEDIN: Row = { ...ACME_LINKEDIN, id: "ch_other", credential_id: "cred_other" };
const channelsByOrg = new Map<string, Row[]>([
  ["org_acme", [ACME_LINKEDIN]],
  ["org_other", [OTHER_ORG_LINKEDIN]],
]);

// The tenant-scoped client the guard hands out: it only ever sees its own
// org's rows, like tenantDb's ANDed organization_id.
const tenantScoped = (organizationId: string) => ({
  socialChannel: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      (channelsByOrg.get(organizationId) ?? []).find((c) => c.id === where.id) ?? null,
  },
});

let permissions = new Set<string>(["content:view", "content:edit"]);
const requirePermissionApi = vi.fn(async (_req: NextRequest, ...perms: string[]) => {
  const missing = perms.filter((p) => !permissions.has(p));
  if (missing.length > 0) {
    return {
      error: NextResponse.json({ error: "Forbidden", missing_permissions: missing }, { status: 403 }),
    };
  }
  return { actor: { organizationId: "org_acme" }, db: tenantScoped("org_acme"), via: "session" };
});
vi.mock("@/lib/guard", () => ({
  requirePermissionApi: (req: NextRequest, ...perms: string[]) =>
    requirePermissionApi(req, ...perms),
}));

// The raw client would see every tenant; the route must never reach for it.
vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("raw prisma used"); } }),
  db: new Proxy({}, { get: () => { throw new Error("raw prisma used"); } }),
}));

const coreCalls: Record<string, unknown>[] = [];
let answers: unknown[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "app", expires_in: 900 }));
    }
    coreCalls.push(JSON.parse(String(init?.body)));
    const answer = answers.shift();
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer ?? { data: {} }));
  })
);

import { GET } from "./route";

const call = (id: string) =>
  GET(new NextRequest(`http://localhost/api/social/channels/${id}/accounts`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  permissions = new Set(["content:view", "content:edit"]);
  requirePermissionApi.mockClear();
  coreCalls.length = 0;
  answers = [];
});

describe("GET /api/social/channels/[id]/accounts", () => {
  it("requires content:edit", async () => {
    permissions = new Set(["content:view"]);
    const res = await call(ACME_LINKEDIN.id);
    expect(res.status).toBe(403);
    expect(requirePermissionApi.mock.calls[0].slice(1)).toEqual(["content:edit"]);
    expect(coreCalls).toHaveLength(0);
  });

  it("answers 404 for another organization's channel without asking Core", async () => {
    const res = await call(OTHER_ORG_LINKEDIN.id);
    expect(res.status).toBe(404);
    expect(coreCalls).toHaveLength(0);
  });

  it("lists the caller's own channel's accounts as that channel's credential", async () => {
    answers = [
      { data: { sub: "782bbtaQ", name: "Peter Jung" } },
      { data: { elements: [] } },
    ];
    const res = await call(ACME_LINKEDIN.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.supported).toBe(true);
    expect(json.data.accounts[0]).toMatchObject({ id: "urn:li:person:782bbtaQ" });
    expect(coreCalls.every((c) => c.credential_id === "cred_acme")).toBe(true);
  });

  it("puts a network failure in plain words, never a status code", async () => {
    answers = [new Response(JSON.stringify({ error: "upstream" }), { status: 502 })];
    const res = await call(ACME_LINKEDIN.id);
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toMatch(/Nothing was changed/);
    expect(error).not.toMatch(/\b5\d\d\b|upstream/);
  });
});
