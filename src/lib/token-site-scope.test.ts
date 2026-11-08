import { describe, expect, it } from "vitest";
import {
  parseTokenSiteScopes,
  siteScopeAllows,
  siteScopeBatchRefusal,
  siteScopeRefusal,
  siteScopeWhere,
} from "./token-site-scope";

/**
 * G#21: a token minted with site slugs may only act on content for those
 * sites; one minted with none keeps reaching every site in its org.
 */

const PM = ["product-manager"];

describe("siteScopeAllows — unscoped (backward compatible)", () => {
  it("allows every action on every post, including one targeting no site", () => {
    for (const action of ["read", "change", "target"] as const) {
      expect(siteScopeAllows([], ["website"], action)).toBe(true);
      expect(siteScopeAllows([], ["website", "intranet"], action)).toBe(true);
      expect(siteScopeAllows([], [], action)).toBe(true);
    }
  });
});

describe("siteScopeAllows — scoped", () => {
  it("allows every action on a post that only targets scoped sites", () => {
    for (const action of ["read", "change", "target"] as const) {
      expect(siteScopeAllows(PM, ["product-manager"], action)).toBe(true);
    }
  });

  it("denies every action on a post that only targets other sites", () => {
    for (const action of ["read", "change", "target"] as const) {
      expect(siteScopeAllows(PM, ["website"], action)).toBe(false);
    }
  });

  it("lets a token READ a post shared with another site but not CHANGE or retarget to it", () => {
    const shared = ["website", "product-manager"];
    expect(siteScopeAllows(PM, shared, "read")).toBe(true);
    expect(siteScopeAllows(PM, shared, "change")).toBe(false);
    expect(siteScopeAllows(PM, shared, "target")).toBe(false);
  });

  it("treats a post targeting no site as outside the scope", () => {
    for (const action of ["read", "change", "target"] as const) {
      expect(siteScopeAllows(PM, [], action)).toBe(false);
    }
  });

  it("covers several scoped sites at once", () => {
    const both = ["website", "product-manager"];
    expect(siteScopeAllows(both, ["website", "product-manager"], "change")).toBe(true);
    expect(siteScopeAllows(both, ["website", "intranet"], "change")).toBe(false);
  });
});

describe("siteScopeRefusal", () => {
  it("is null for a session / unscoped token", () => {
    expect(siteScopeRefusal(undefined, ["website"], "change")).toBeNull();
    expect(siteScopeRefusal({ site_scopes: [] }, ["website"], "change")).toBeNull();
  });

  it("is a 403 naming the token's scope and the sites outside it — not a 404", async () => {
    const res = siteScopeRefusal({ site_scopes: PM }, ["website", "product-manager"], "change");

    expect(res?.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toContain("product-manager");
    expect(body.error).toContain("website");
    expect(body.error).not.toMatch(/not found/i);
    expect(body.token_site_scopes).toEqual(PM);
    expect(body.post_sites).toEqual(["website", "product-manager"]);
  });

  it("appends a route-specific hint", async () => {
    const res = siteScopeRefusal({ site_scopes: PM }, ["website"], "target", "Pass platforms.");
    expect((await res!.json()).error).toMatch(/Pass platforms\.$/);
  });
});

describe("siteScopeWhere", () => {
  it("adds no filter for an unscoped token, and a hasSome filter for a scoped one", () => {
    expect(siteScopeWhere(undefined)).toEqual({});
    expect(siteScopeWhere({ site_scopes: [] })).toEqual({});
    expect(siteScopeWhere({ site_scopes: PM })).toEqual({ platforms: { hasSome: PM } });
  });
});

describe("parseTokenSiteScopes", () => {
  const allowed = ["website", "product-manager"];

  it("treats absent, null and [] as unscoped", () => {
    expect(parseTokenSiteScopes(undefined, allowed)).toEqual({ scopes: [] });
    expect(parseTokenSiteScopes(null, allowed)).toEqual({ scopes: [] });
    expect(parseTokenSiteScopes([], allowed)).toEqual({ scopes: [] });
  });

  it("accepts and dedupes known slugs", () => {
    expect(parseTokenSiteScopes(["product-manager", "product-manager"], allowed)).toEqual({
      scopes: ["product-manager"],
    });
  });

  it("refuses rather than narrows when any slug is unknown", () => {
    const result = parseTokenSiteScopes(["product-manager", "intranet"], allowed);
    expect(result.scopes).toBeUndefined();
    expect(result.error).toContain("intranet");
    expect(result.error).toContain("website, product-manager");
  });

  it("refuses a value that isn't a list of strings", () => {
    expect(parseTokenSiteScopes("website", allowed).error).toBeDefined();
    expect(parseTokenSiteScopes([1], allowed).error).toBeDefined();
  });
});

describe("siteScopeBatchRefusal", () => {
  const post = (slug: string, ...platforms: string[]) => ({ slug, platforms });

  it("lets an unscoped credential through without looking at the posts", () => {
    expect(siteScopeBatchRefusal(undefined, [post("a", "website")], "Nothing happened.")).toBeNull();
    expect(
      siteScopeBatchRefusal({ site_scopes: [] }, [post("a", "website")], "Nothing happened.")
    ).toBeNull();
  });

  it("lets a scoped token through when every matched post is its own", () => {
    expect(
      siteScopeBatchRefusal({ site_scopes: PM }, [post("a", "product-manager")], "Nothing happened.")
    ).toBeNull();
  });

  it("refuses the whole batch, naming the posts and carrying the consequence", async () => {
    const res = siteScopeBatchRefusal(
      { site_scopes: PM },
      [post("mine", "product-manager"), post("theirs", "website"), post("shared", "website", "product-manager")],
      "Nothing was deleted."
    );

    expect(res?.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toContain("theirs");
    expect(body.error).toContain("shared");
    expect(body.error).not.toContain("mine");
    expect(body.error).toContain("Nothing was deleted.");
    expect(body.out_of_scope_slugs).toEqual(["theirs", "shared"]);
    expect(body.out_of_scope_count).toBe(2);
  });

  it("names only the first few posts when a tag sits on many, but counts them all", async () => {
    const many = Array.from({ length: 9 }, (_, i) => post(`w${i}`, "website"));

    const body = await siteScopeBatchRefusal({ site_scopes: PM }, many, "Nothing happened.")!.json();
    expect(body.error).toContain("w4");
    expect(body.error).not.toContain("w5");
    expect(body.error).toContain("and 4 more");
    expect(body.out_of_scope_count).toBe(9);
  });
});
