import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_SLUGS,
  mergeSites,
  parseSiteSlugs,
  siteSlugSchema,
  siteUrlSchema,
} from "./sites";
import type { Site } from "@/types/cms";

function site(slug: string, name: string, sort_order = 10): Site {
  return {
    id: `row:${slug}`,
    slug,
    name,
    description: null,
    url: `https://${slug}.example.com`,
    sort_order,
    indexnow_key: null,
  };
}

describe("mergeSites", () => {
  /**
   * No cross-org built-ins: a shared "Interactor Website" default made no
   * sense once any org can self-serve sign up, and implied an affiliation
   * most orgs don't have. An org that has registered nothing, and has no
   * posts yet, sees an empty list.
   */
  it("returns nothing for an org that registered nothing and has no posts", () => {
    expect(mergeSites([])).toEqual([]);
  });

  it("keeps 'website' as the fallback default target for new posts", () => {
    expect(DEFAULT_SITE_SLUGS).toEqual(["website"]);
  });

  it("lets a registered row override an in-use slug of the same name", () => {
    const merged = mergeSites([site("website", "Our Marketing Site", 0)], ["website"]);
    const website = merged.find((s) => s.slug === "website");
    expect(website?.name).toBe("Our Marketing Site");
    // Still one entry — the registered row replaces the in-use placeholder.
    expect(merged.filter((s) => s.slug === "website")).toHaveLength(1);
  });

  /**
   * The reason a re-save can't silently narrow a post's distribution: a slug
   * nobody registered is still offered, so it survives the round trip. This
   * is also how DEFAULT_SITE_SLUGS ("website") becomes a real, selectable
   * entry the first time any post actually uses it.
   */
  it("folds in a slug already in use that nobody registered", () => {
    const merged = mergeSites([], ["intranet"]);
    const intranet = merged.find((s) => s.slug === "intranet");
    expect(intranet).toBeDefined();
    expect(intranet?.name).toBe("Intranet");
    expect(intranet?.id).toBe("in-use:intranet");
    // Nothing to link to until someone registers it for real.
    expect(intranet?.url).toBeNull();
  });

  it("prefers a registered row over an in-use slug of the same name", () => {
    const merged = mergeSites([site("intranet", "Staff Intranet")], ["intranet"]);
    expect(merged.filter((s) => s.slug === "intranet")).toHaveLength(1);
    expect(merged.find((s) => s.slug === "intranet")?.name).toBe("Staff Intranet");
  });

  it("sorts by sort_order then name, so the menu is stable", () => {
    const merged = mergeSites([site("zeta", "Zeta", 5), site("alpha", "Alpha", 5)]);
    expect(merged.map((s) => s.slug)).toEqual(["alpha", "zeta"]);
  });
});

describe("parseSiteSlugs", () => {
  const allowed = ["website", "product-manager"];

  it("returns null when the field was not sent, so callers keep the current value", () => {
    expect(parseSiteSlugs(undefined, allowed)).toBeNull();
    expect(parseSiteSlugs("website", allowed)).toBeNull();
  });

  it("keeps a post targetable at several sites at once", () => {
    expect(parseSiteSlugs(["website", "product-manager"], allowed)).toEqual([
      "website",
      "product-manager",
    ]);
  });

  it("drops slugs this org does not have", () => {
    expect(parseSiteSlugs(["website", "someone-elses-site"], allowed)).toEqual([
      "website",
    ]);
  });

  /**
   * An empty result is the signal callers turn into a 400 — storing it would
   * leave a post that no site would ever surface.
   */
  it("returns empty when nothing valid was sent, rather than falling back", () => {
    expect(parseSiteSlugs(["nope"], allowed)).toEqual([]);
    expect(parseSiteSlugs([], allowed)).toEqual([]);
  });

  it("dedupes and ignores non-strings", () => {
    expect(parseSiteSlugs(["website", "website", 42, null], allowed)).toEqual([
      "website",
    ]);
  });

  it("accepts a slug only because the caller allowed it, not because it is built in", () => {
    // The org removed "product-manager" from its registry: it is no longer offered.
    expect(parseSiteSlugs(["product-manager"], ["website"])).toEqual([]);
  });
});

describe("siteSlugSchema", () => {
  it("accepts lowercase kebab tokens", () => {
    for (const ok of ["website", "product-manager", "a1", "my-second-site"]) {
      expect(siteSlugSchema.safeParse(ok).success).toBe(true);
    }
  });

  it("rejects shapes that would not survive a URL or a frontmatter file", () => {
    for (const bad of ["", "Website", "my site", "trailing-", "-leading", "a--b", "a_b"]) {
      expect(siteSlugSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("bounds length, since slugs arrive from untrusted .md files", () => {
    expect(siteSlugSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(siteSlugSchema.safeParse("a".repeat(64)).success).toBe(true);
  });
});

describe("siteUrlSchema", () => {
  it("accepts a base URL", () => {
    expect(siteUrlSchema.safeParse("https://example.com").success).toBe(true);
    expect(siteUrlSchema.safeParse("https://example.com/blog").success).toBe(true);
  });

  it("rejects a missing or malformed URL", () => {
    for (const bad of ["", "not-a-url", "example.com"]) {
      expect(siteUrlSchema.safeParse(bad).success).toBe(false);
    }
  });
});
