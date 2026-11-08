import { describe, expect, it, vi } from "vitest";

const { organizationFindMany, tx } = vi.hoisted(() => ({
  organizationFindMany: vi.fn(async () => []),
  tx: {
    organization: { create: vi.fn(async ({ data }: { data: unknown }) => ({ id: "org-1", ...data as object })) },
    membership: { create: vi.fn(async () => undefined) },
    site: { create: vi.fn(async () => undefined) },
    user: { update: vi.fn(async () => undefined) },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organization: { findMany: organizationFindMany },
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
  },
}));

// Deterministic key so the assertion below doesn't have to special-case a
// random 32-hex-char value (see indexnow.test.ts for generateIndexNowKey's
// own coverage of the real generator).
vi.mock("@/lib/indexnow", () => ({ generateIndexNowKey: () => "fixed-indexnow-key" }));

import { canManageOrgSettings, createOrganizationWithOwner, slugifyOrgName } from "./organizations";

describe("slugifyOrgName", () => {
  it("kebabs a name", () => {
    expect(slugifyOrgName("Acme Inc")).toBe("acme-inc");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugifyOrgName("  Peter's   Org!!  ")).toBe("peter-s-org");
  });

  it("returns empty for a name with nothing usable, so callers can reject it", () => {
    expect(slugifyOrgName("!!!")).toBe("");
    expect(slugifyOrgName("   ")).toBe("");
  });

  it("caps length so the slug stays a usable URL handle", () => {
    expect(slugifyOrgName("x".repeat(200))).toHaveLength(48);
  });

  it("never leaves a leading or trailing hyphen", () => {
    const slug = slugifyOrgName("---Acme---");
    expect(slug).toBe("acme");
  });
});

describe("createOrganizationWithOwner", () => {
  /**
   * sites.ts deliberately has no cross-org built-in seeds, but the post
   * editor always sends an explicit `platforms` selection that the write
   * routes validate against the org's REGISTERED sites — with none, every
   * new post would be refused until someone finds Settings -> Sites first.
   * A brand-new org needs one real, generic (non-Interactor-branded) site
   * to publish to from the start.
   */
  it("registers a generic 'website' site for the new org", async () => {
    await createOrganizationWithOwner("user-1", "Acme");

    expect(tx.site.create).toHaveBeenCalledWith({
      data: {
        organization_id: "org-1",
        slug: "website",
        name: "Website",
        url: "https://example.com/acme",
        sort_order: 0,
        // A working IndexNow key from the moment the site exists (G#34) —
        // see the identical rationale on `POST /api/cms/sites`.
        indexnow_key: "fixed-indexnow-key",
      },
    });
  });
});

describe("canManageOrgSettings", () => {
  it("allows owner and admin", () => {
    expect(canManageOrgSettings("owner")).toBe(true);
    expect(canManageOrgSettings("admin")).toBe(true);
  });

  it("refuses every other membership role", () => {
    for (const role of ["editor", "reviewer", "author", "guest_author"]) {
      expect(canManageOrgSettings(role)).toBe(false);
    }
  });

  it("refuses a missing role rather than defaulting open", () => {
    expect(canManageOrgSettings(null)).toBe(false);
    expect(canManageOrgSettings(undefined)).toBe(false);
    expect(canManageOrgSettings("")).toBe(false);
  });
});
