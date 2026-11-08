import { beforeEach, describe, expect, it, vi } from "vitest";

const { accountFindMany, userFindMany, membershipFindMany, loadActor, orgSiteSlugs } = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  userFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
  loadActor: vi.fn(),
  orgSiteSlugs: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiTokenAccount: { findMany: accountFindMany },
    user: { findMany: userFindMany },
    membership: { findMany: membershipFindMany },
  },
}));
vi.mock("@/lib/rbac", () => ({ loadActor }));
vi.mock("@/lib/tenant-db", () => ({ tenantDb: (id: string) => ({ org: id }) }));
vi.mock("@/lib/sites-server", () => ({ orgSiteSlugs, orgSites: vi.fn() }));

import { parseWorkspace, resolveWorkspace } from "./workspaces";

const TOKEN = { id: "tok", user_id: "u-work" };
const ORG = (id: string, slug: string, name: string) => ({ id, slug, name });

beforeEach(() => {
  // admin@example.com owns the connection; writer@example.com was added.
  accountFindMany.mockReset().mockResolvedValue([{ user_id: "u-personal" }]);
  userFindMany.mockReset().mockResolvedValue([
    { id: "u-work", email: "admin@example.com" },
    { id: "u-personal", email: "writer@example.com" },
  ]);
  membershipFindMany.mockReset().mockResolvedValue([
    { user_id: "u-work", organization: ORG("org-int", "interactor", "Interactor") },
    { user_id: "u-personal", organization: ORG("org-pj", "acme", "Peter Jung") },
    { user_id: "u-personal", organization: ORG("org-son", "mysonceo", "MySonCEO") },
  ]);
  loadActor.mockReset().mockImplementation(async (u: { id: string }, o: { forceOrganizationId: string }) => ({
    user: { id: u.id },
    organizationId: o.forceOrganizationId,
  }));
  orgSiteSlugs.mockReset().mockResolvedValue(["website", "acme-site", "cms"]);
});

describe("parseWorkspace", () => {
  it("reads account/org/site, org/site and account/org", () => {
    expect(parseWorkspace("Writer@example.com/acme/acme-site")).toEqual({
      account: "writer@example.com",
      organization: "acme",
      site: "acme-site",
    });
    expect(parseWorkspace("interactor/cms")).toEqual({ account: null, organization: "interactor", site: "cms" });
    expect(parseWorkspace("admin@example.com/interactor")).toEqual({
      account: "admin@example.com",
      organization: "interactor",
      site: null,
    });
  });

  it("rejects malformed values", () => {
    for (const bad of ["", "a//b", "a/b/c", "x@y.com", "x@y.com/a/b/c"]) expect(parseWorkspace(bad)).toBeNull();
  });
});

describe("resolveWorkspace", () => {
  it("acts as the named account in the named organization, narrowed to the site", async () => {
    const r = await resolveWorkspace(TOKEN, "writer@example.com/acme/acme-site");
    expect(r).toMatchObject({ kind: "ok", organizationId: "org-pj", site: "acme-site" });
    expect(loadActor).toHaveBeenCalledWith({ id: "u-personal" }, { forceOrganizationId: "org-pj" });
  });

  it("finds the account from the organization when only one belongs to it", async () => {
    const r = await resolveWorkspace(TOKEN, "interactor/cms");
    expect(r).toMatchObject({ kind: "ok", organizationId: "org-int", site: "cms" });
    expect(loadActor).toHaveBeenCalledWith({ id: "u-work" }, { forceOrganizationId: "org-int" });
  });

  it("never guesses: no workspace on a several-organization connection is refused with the list", async () => {
    const r = await resolveWorkspace(TOKEN, null);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.message).toContain("admin@example.com/interactor");
      expect(r.message).toContain("writer@example.com/mysonceo");
    }
  });

  it("uses the only organization when there is just one", async () => {
    membershipFindMany.mockResolvedValue([{ user_id: "u-work", organization: ORG("org-int", "interactor", "Interactor") }]);
    expect(await resolveWorkspace(TOKEN, null)).toMatchObject({ kind: "ok", organizationId: "org-int" });
  });

  it("refuses an organization, account or site the connection can't reach", async () => {
    expect((await resolveWorkspace(TOKEN, "someone-else-org")).kind).toBe("refused");
    const other = await resolveWorkspace(TOKEN, "stranger@example.com/interactor");
    expect(other.kind === "refused" && other.message).toContain("isn't one of its accounts");
    expect((await resolveWorkspace(TOKEN, "interactor/no-such-site")).kind).toBe("refused");
    expect(loadActor.mock.calls.every(([u]) => u.id === "u-work")).toBe(true);
  });

  it("asks for the account when both belong to the organization", async () => {
    membershipFindMany.mockResolvedValue([
      { user_id: "u-work", organization: ORG("org-int", "interactor", "Interactor") },
      { user_id: "u-personal", organization: ORG("org-int", "interactor", "Interactor") },
    ]);
    const r = await resolveWorkspace(TOKEN, "interactor");
    expect(r.kind === "refused" && r.message).toContain("Name the account");
  });

  it("refuses when the account has since lost its membership", async () => {
    loadActor.mockResolvedValue({ user: { id: "u-work" }, organizationId: "somewhere-else" });
    expect((await resolveWorkspace(TOKEN, "interactor")).kind).toBe("refused");
  });
});
