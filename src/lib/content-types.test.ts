import { describe, it, expect } from "vitest";
import {
  mergeContentTypes,
  titleCaseSlug,
  contentTypeSchema,
  BUILT_IN_CONTENT_TYPES,
} from "./content-types";
import type { ContentType } from "@/types/cms";

const registered = (slug: string, name: string, sort_order = 100): ContentType => ({
  id: `ct_${slug}`,
  slug,
  name,
  description: null,
  sort_order,
});

describe("mergeContentTypes", () => {
  it("offers the built-in seeds to an org that has registered nothing", () => {
    expect(mergeContentTypes([]).map((t) => t.slug)).toEqual(
      BUILT_IN_CONTENT_TYPES.map((t) => t.slug)
    );
  });

  it("includes an org's own types alongside the seeds", () => {
    const merged = mergeContentTypes([registered("changelog", "Changelog")]);
    expect(merged.map((t) => t.slug)).toContain("changelog");
    expect(merged.map((t) => t.slug)).toContain("blog");
  });

  it("lets a registered row override a seed of the same slug", () => {
    // An org renaming "Blog" to "Journal" must not end up with both.
    const merged = mergeContentTypes([registered("blog", "Journal", 0)]);
    const blogs = merged.filter((t) => t.slug === "blog");
    expect(blogs).toHaveLength(1);
    expect(blogs[0].name).toBe("Journal");
  });

  it("folds in a type that is in use but was never registered", () => {
    // A post imported with `type: release-note` must stay selectable, or
    // re-saving it in the editor would silently retype it.
    const merged = mergeContentTypes([], ["release-note"]);
    const found = merged.find((t) => t.slug === "release-note");
    expect(found).toBeDefined();
    expect(found?.name).toBe("Release Note");
  });

  it("does not duplicate an in-use slug that is also registered or built in", () => {
    const merged = mergeContentTypes([registered("changelog", "Changelog")], [
      "changelog",
      "blog",
    ]);
    expect(merged.filter((t) => t.slug === "changelog")).toHaveLength(1);
    expect(merged.filter((t) => t.slug === "blog")).toHaveLength(1);
  });

  it("prefers a registered row's name over the derived in-use name", () => {
    const merged = mergeContentTypes([registered("release-note", "Release Notes")], [
      "release-note",
    ]);
    expect(merged.find((t) => t.slug === "release-note")?.name).toBe("Release Notes");
  });
});

describe("titleCaseSlug", () => {
  it.each([
    ["release-note", "Release Note"],
    ["faq", "Faq"],
    ["case-study-long", "Case Study Long"],
  ])("%s → %s", (slug, expected) => {
    expect(titleCaseSlug(slug)).toBe(expected);
  });
});

describe("contentTypeSchema", () => {
  it.each(["blog", "release-note", "a", "a1-b2"])("accepts %j", (s) => {
    expect(contentTypeSchema.safeParse(s).success).toBe(true);
  });

  it.each(["", "Blog", "has space", "-lead", "trail-", "double--dash", "under_score", "a".repeat(65)])(
    "rejects %j",
    (s) => {
      expect(contentTypeSchema.safeParse(s).success).toBe(false);
    }
  );
});
