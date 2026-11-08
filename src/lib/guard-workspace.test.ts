import { beforeEach, describe, expect, it, vi } from "vitest";

const { tokenFindUnique, loadActor, resolveWorkspace } = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  loadActor: vi.fn(),
  resolveWorkspace: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { apiToken: { findUnique: tokenFindUnique, update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("@/lib/rbac", () => ({ loadActor }));
vi.mock("@/lib/tenant-db", () => ({ tenantDb: vi.fn() }));
vi.mock("@/lib/workspaces", async (orig) => ({
  ...(await orig<typeof import("@/lib/workspaces")>()),
  resolveWorkspace,
}));

import { actorFromApiTokenValue } from "./guard";

const RAW = "cms_pat_" + "x".repeat(40);
const row = (over: Record<string, unknown> = {}) => ({
  id: "tok",
  user_id: "u1",
  name: "Claude Code",
  token_prefix: "cms_pat_xxxx",
  organization_id: "org-int",
  all_organizations: false,
  site_scopes: [],
  expires_at: null,
  revoked_at: null,
  oauth_client_id: "c1",
  refresh_expires_at: null,
  ...over,
});
const actor = {
  user: { id: "u1", email: "admin@example.com" },
  organizationId: "org-int",
  organizations: [{ id: "org-int", slug: "interactor", name: "Interactor", role: "owner" }],
};

beforeEach(() => {
  tokenFindUnique.mockReset().mockResolvedValue(row());
  loadActor.mockReset().mockResolvedValue(actor);
  resolveWorkspace.mockReset();
});

describe("a one-organization token", () => {
  it("works as before with no workspace", async () => {
    const r = await actorFromApiTokenValue(RAW);
    expect(r).toMatchObject({ token: { organization_id: "org-int", all_organizations: false, site_scopes: [] } });
  });

  it("narrows to a site when the workspace names its own organization", async () => {
    const r = await actorFromApiTokenValue(RAW, "admin@example.com/interactor/cms");
    expect(r).toMatchObject({ token: { site_scopes: ["cms"], workspace: "admin@example.com/interactor/cms" } });
  });

  it("refuses a workspace naming another organization or account, instead of acting in its own", async () => {
    for (const ws of ["writer@example.com/acme", "acme/acme-site", "someone@else.com/interactor"]) {
      const r = await actorFromApiTokenValue(RAW, ws);
      expect(r && "refused" in r && r.refused).toContain("All my organizations");
    }
  });

  it("refuses a site outside the token's own site scope", async () => {
    tokenFindUnique.mockResolvedValue(row({ site_scopes: ["website"] }));
    const r = await actorFromApiTokenValue(RAW, "interactor/cms");
    expect(r && "refused" in r).toBe(true);
  });
});

describe("a workspace connection", () => {
  beforeEach(() => tokenFindUnique.mockResolvedValue(row({ organization_id: null, all_organizations: true })));

  it("acts where the workspace says, narrowed to its site", async () => {
    resolveWorkspace.mockResolvedValue({ kind: "ok", actor: { ...actor, organizationId: "org-pj" }, organizationId: "org-pj", site: "acme-site" });
    const r = await actorFromApiTokenValue(RAW, "writer@example.com/acme/acme-site");
    expect(resolveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: "tok" }), "writer@example.com/acme/acme-site");
    expect(r).toMatchObject({ token: { organization_id: "org-pj", all_organizations: true, site_scopes: ["acme-site"] } });
  });

  it("passes on the resolver's refusal", async () => {
    resolveWorkspace.mockResolvedValue({ kind: "refused", message: "say which one" });
    expect(await actorFromApiTokenValue(RAW, null)).toEqual({ refused: "say which one" });
  });

  it("is dead once revoked, like any token", async () => {
    tokenFindUnique.mockResolvedValue(row({ organization_id: null, all_organizations: true, revoked_at: new Date() }));
    expect(await actorFromApiTokenValue(RAW, "interactor")).toBeNull();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });
});
