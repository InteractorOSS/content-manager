import { describe, expect, it, vi } from "vitest";
import { checkDuplicateTitleInOrg, checkPostReadiness, type ReadinessInput } from "./seo-readiness";

const GOOD_ANSWER_SUMMARY =
  "Interactor's SEO readiness check runs before every publish so a post never ships missing a meta " +
  "description, alt text or a real answer summary — the same check every editor and MCP client uses.";

function goodPost(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    title: "A Complete Guide To Post Readiness",
    seo_title: null,
    slug: "a-complete-guide-to-post-readiness",
    meta_description:
      "Learn how Interactor's readiness check keeps every post's SEO and AI-answer signals consistent before it ships.",
    content_html:
      "<p>Readiness is a discipline that keeps every post's SEO signals consistent before it ships.</p>" +
      "<h2>How does the check work?</h2>" +
      "<p>It runs 8 error checks and 6 warning checks, citing <a href=\"https://schema.org\">schema.org</a> " +
      "and linking to <a href=\"/docs/readiness\">our own docs</a> and <a href=\"/docs/mcp\">the MCP guide</a>.</p>" +
      "<p>92% of posts pass on the first try.</p>" +
      "<img src=\"/a.png\" alt=\"A diagram\">",
    answer_summary: GOOD_ANSWER_SUMMARY,
    featured_image: "/hero.png",
    featured_image_alt: "Hero image",
    ...overrides,
  };
}

describe("checkPostReadiness — errors", () => {
  it("passes a well-formed post with zero errors", () => {
    expect(checkPostReadiness(goodPost()).errors).toEqual([]);
  });

  it("flags a meta description outside 70-160 characters", () => {
    expect(checkPostReadiness(goodPost({ meta_description: "Too short." })).errors).toContainEqual(
      expect.objectContaining({ key: "meta_description_length" })
    );
    expect(checkPostReadiness(goodPost({ meta_description: null })).errors).toContainEqual(
      expect.objectContaining({ key: "meta_description_length" })
    );
  });

  it("flags an effective title outside 20-60 characters, honoring seo_title as the override", () => {
    expect(checkPostReadiness(goodPost({ title: "Short" })).errors).toContainEqual(
      expect.objectContaining({ key: "title_length" })
    );
    // seo_title is the effective title even though the plain title above is too short.
    expect(
      checkPostReadiness(goodPost({ title: "Short", seo_title: "A Complete Guide To Post Readiness" })).errors
    ).not.toContainEqual(expect.objectContaining({ key: "title_length" }));
  });

  it("flags a slug that isn't lowercase kebab-case or is too long", () => {
    expect(checkPostReadiness(goodPost({ slug: "Not_Kebab" })).errors).toContainEqual(
      expect.objectContaining({ key: "slug_format" })
    );
    expect(checkPostReadiness(goodPost({ slug: "x".repeat(76) })).errors).toContainEqual(
      expect.objectContaining({ key: "slug_format" })
    );
  });

  it("flags an <h1> inside the body", () => {
    expect(
      checkPostReadiness(goodPost({ content_html: "<h1>Duplicate heading</h1><p>Body</p>" })).errors
    ).toContainEqual(expect.objectContaining({ key: "h1_in_body" }));
  });

  it("flags a body image with no alt text", () => {
    expect(
      checkPostReadiness(goodPost({ content_html: '<p>Body</p><img src="/a.png">' })).errors
    ).toContainEqual(expect.objectContaining({ key: "image_alt_missing" }));
    expect(
      checkPostReadiness(goodPost({ content_html: '<p>Body</p><img src="/a.png" alt="">' })).errors
    ).toContainEqual(expect.objectContaining({ key: "image_alt_missing" }));
  });

  it("flags a featured image with no alt text, but not when there's no featured image at all", () => {
    expect(checkPostReadiness(goodPost({ featured_image_alt: "" })).errors).toContainEqual(
      expect.objectContaining({ key: "featured_image_alt_missing" })
    );
    expect(
      checkPostReadiness(goodPost({ featured_image: null, featured_image_alt: null })).errors
    ).not.toContainEqual(expect.objectContaining({ key: "featured_image_alt_missing" }));
  });

  it("flags an answer summary outside 25-80 words, including a missing one", () => {
    expect(checkPostReadiness(goodPost({ answer_summary: "Too short." })).errors).toContainEqual(
      expect.objectContaining({ key: "answer_summary_length" })
    );
    expect(checkPostReadiness(goodPost({ answer_summary: null })).errors).toContainEqual(
      expect.objectContaining({ key: "answer_summary_length" })
    );
    expect(
      checkPostReadiness(goodPost({ answer_summary: "word ".repeat(81) })).errors
    ).toContainEqual(expect.objectContaining({ key: "answer_summary_length" }));
  });

  it("flags a heading level that skips (H2 straight to H4)", () => {
    expect(
      checkPostReadiness(goodPost({ content_html: "<h2>Section</h2><h4>Skipped H3</h4><p>Body</p>" })).errors
    ).toContainEqual(expect.objectContaining({ key: "heading_level_skip" }));
  });

  it("does not flag a heading level increase of exactly one, or one that goes back down", () => {
    const html = "<h2>A</h2><h3>B</h3><p>t</p><h2>C</h2>";
    expect(checkPostReadiness(goodPost({ content_html: html })).errors).not.toContainEqual(
      expect.objectContaining({ key: "heading_level_skip" })
    );
  });
});

describe("checkPostReadiness — warnings", () => {
  it("passes a well-formed post with zero warnings", () => {
    expect(checkPostReadiness(goodPost()).warnings).toEqual([]);
  });

  it("warns when no H2 is phrased as a question", () => {
    expect(
      checkPostReadiness(goodPost({ content_html: "<h2>Not a question</h2><p>Body</p>" })).warnings
    ).toContainEqual(expect.objectContaining({ key: "no_question_heading" }));
  });

  it("warns with fewer than 2 internal links", () => {
    expect(
      checkPostReadiness(goodPost({ content_html: '<h2>Q?</h2><p><a href="/one">one</a></p>' })).warnings
    ).toContainEqual(expect.objectContaining({ key: "few_internal_links" }));
  });

  it("warns with no outbound link to an external source", () => {
    expect(
      checkPostReadiness(
        goodPost({ content_html: '<h2>Q?</h2><p><a href="/one">a</a> <a href="/two">b</a> 92%</p>' })
      ).warnings
    ).toContainEqual(expect.objectContaining({ key: "no_outbound_source" }));
  });

  it("warns with no statistic or number-with-context in the body", () => {
    expect(
      checkPostReadiness(
        goodPost({
          content_html:
            '<h2>Q?</h2><p><a href="/one">a</a> <a href="/two">b</a> <a href="https://x.com">c</a> plain text, no numbers.</p>',
        })
      ).warnings
    ).toContainEqual(expect.objectContaining({ key: "no_statistic" }));
  });

  it("warns when the opening sentence doesn't read as definitional", () => {
    expect(
      checkPostReadiness(goodPost({ content_html: "<p>Buckle up, this post has a lot to say.</p>" })).warnings
    ).toContainEqual(expect.objectContaining({ key: "no_definitional_sentence" }));
  });

  it("warns when the meta description starts with the title verbatim", () => {
    expect(
      checkPostReadiness(
        goodPost({
          title: "A Complete Guide",
          meta_description: "A Complete Guide to everything you need to know about readiness checks in Interactor.",
        })
      ).warnings
    ).toContainEqual(expect.objectContaining({ key: "title_meta_duplicate" }));
  });
});

describe("checkDuplicateTitleInOrg", () => {
  it("returns a finding when another post shares the exact title", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "other" });
    const finding = await checkDuplicateTitleInOrg({ post: { findFirst } }, "this-post", "Hello");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: { not: "this-post" }, title: "Hello" }, select: { id: true } });
    expect(finding).toEqual(expect.objectContaining({ key: "duplicate_title" }));
  });

  it("returns null when no other post shares the title", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const finding = await checkDuplicateTitleInOrg({ post: { findFirst } }, "this-post", "Hello");
    expect(finding).toBeNull();
  });
});
