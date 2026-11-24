import { describe, expect, it, vi, beforeEach } from "vitest";

const { findUnique, update, loadActor } = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), loadActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { postBrowseKey: { findUnique, update } } }));
vi.mock("@/lib/rbac", () => ({ loadActor }));
vi.mock("@/lib/tenant-db", () => ({ tenantDb: (org: string) => ({ org }) }));

import { looksLikeApiToken } from "@/lib/api-tokens";
import { looksLikeEditKey } from "@/lib/post-edit-keys";
import { looksLikeBrowseKey, looksLikeMirrorKey, resolveBrowseKey } from "./post-browse-keys";

const now = new Date("2026-09-24T12:00:00Z");
const live = {
  id: "bk1",
  user_id: "u1",
  organization_id: "org-blog",
  api_token_id: "tok",
  site_scopes: [],
  site: "acme-site",
  purpose: "list",
  revoked_at: null,
  expires_at: new Date("2026-09-24T13:00:00Z"),
  api_token: { revoked_at: null },
};

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue({});
  loadActor.mockReset().mockResolvedValue({ organizationId: "org-blog", user: { id: "u1" } });
});

describe("browse keys", () => {
  it("are accepted nowhere a token or an edit key is", () => {
    expect(looksLikeBrowseKey("cms_list_abc")).toBe(true);
    expect(looksLikeApiToken("cms_list_abc")).toBe(false);
    expect(looksLikeEditKey("cms_list_abc")).toBe(false);
  });

  it("resolve to their org, site and connection", async () => {
    findUnique.mockResolvedValue(live);
    const auth = await resolveBrowseKey("cms_list_x", now);
    expect(auth?.key).toMatchObject({ site: "acme-site", api_token_id: "tok", organization_id: "org-blog" });
  });

  it.each([
    ["revoked", { revoked_at: new Date() }],
    ["expired", { expires_at: new Date("2026-09-24T11:00:00Z") }],
    ["minted by a disconnected connection", { api_token: { revoked_at: new Date() } }],
  ])("are refused when %s", async (_l, patch) => {
    findUnique.mockResolvedValue({ ...live, ...patch });
    expect(await resolveBrowseKey("cms_list_x", now)).toBeNull();
  });

  it("are refused when the owner left the organization", async () => {
    findUnique.mockResolvedValue(live);
    loadActor.mockResolvedValue({ organizationId: "another-org", user: { id: "u1" } });
    expect(await resolveBrowseKey("cms_list_x", now)).toBeNull();
  });
});

describe("mirror keys", () => {
  it("have their own prefix, accepted nowhere a token, edit key or list key is", () => {
    expect(looksLikeMirrorKey("cms_mirror_abc")).toBe(true);
    expect(looksLikeBrowseKey("cms_mirror_abc")).toBe(false);
    expect(looksLikeApiToken("cms_mirror_abc")).toBe(false);
    expect(looksLikeEditKey("cms_mirror_abc")).toBe(false);
  });

  it("resolve only as a mirror, and a list key never does", async () => {
    findUnique.mockResolvedValue({ ...live, purpose: "mirror" });
    expect((await resolveBrowseKey("cms_mirror_x", now, "mirror"))?.key.site).toBe("acme-site");
    expect(await resolveBrowseKey("cms_mirror_x", now)).toBeNull();
    expect(await resolveBrowseKey("cms_list_x", now, "mirror")).toBeNull();
  });

  it("are refused when the row's purpose disagrees with the prefix", async () => {
    findUnique.mockResolvedValue(live); // a list row
    expect(await resolveBrowseKey("cms_mirror_x", now, "mirror")).toBeNull();
  });
});
