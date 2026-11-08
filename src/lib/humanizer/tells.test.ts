import { describe, expect, it } from "vitest";
import { findHumanizerTells, proseOf } from "@/lib/humanizer/tells";
import { checkPostReadiness } from "@/lib/seo-readiness";

const keys = (html: string, extra: Record<string, string> = {}) =>
  findHumanizerTells({ content_html: html, ...extra }).map((t) => t.key);

describe("findHumanizerTells", () => {
  it("finds nothing in plain human prose", () => {
    expect(
      keys(
        "<h2>How do retries work?</h2><p>The client retries a failed request three times, waiting one second, then two, then four. We picked three after the March outage, when a fourth retry would have made the queue worse.</p>"
      )
    ).toEqual([]);
  });

  it("reports a not-X-but-Y contrast on one sighting, in each of its shapes", () => {
    expect(keys("<p>It's not just a song, it's a statement.</p>")).toContain("humanizer_not_x_but_y");
    expect(keys("<p>Caching is not only faster but cheaper to run.</p>")).toContain("humanizer_not_x_but_y");
    expect(keys("<p>This does not mean every choice is equal. It means nobody checks.</p>")).toContain(
      "humanizer_not_x_but_y"
    );
    expect(keys("<p>The build did not finish, but the tests ran.</p>")).not.toContain("humanizer_not_x_but_y");
  });

  it("reports closers, chatbot residue and knowledge disclaimers on one sighting", () => {
    expect(keys("<p>Caching cuts repeat work.</p><p>That is the real win.</p>")).toContain("humanizer_closer");
    expect(keys("<p>Great question! The revolution began in 1789. I hope this helps!</p>")).toContain(
      "humanizer_chatbot_residue"
    );
    expect(keys("<p>Certainly! Here is the list.</p>")).toContain("humanizer_chatbot_residue");
    expect(keys("<p>We will certainly ship it.</p>")).not.toContain("humanizer_chatbot_residue");
    expect(keys("<p>Based on available information, it was founded in the 1990s.</p>")).toContain(
      "humanizer_knowledge_disclaimer"
    );
  });

  it("treats dashes as weak alone: three or more, and never a number range", () => {
    expect(keys("<p>One dash — here — is fine.</p>")).not.toContain("humanizer_dashes");
    expect(keys("<p>A — b. C — d. E &mdash; f.</p>")).toContain("humanizer_dashes");
    expect(keys("<p>From 2020–2024, 10–12 people, pages 3–9.</p>")).not.toContain("humanizer_dashes");
  });

  it("reports stock AI words only in a group", () => {
    expect(keys("<p>A pivotal release.</p>")).not.toContain("humanizer_ai_words");
    const tells = findHumanizerTells({
      content_html: "<p>A pivotal release that showcases the vibrant landscape. Pivotal again.</p>",
    });
    expect(tells.find((t) => t.key === "humanizer_ai_words")?.message).toMatch(/^4 words/);
  });

  it("leaves code and quotations alone", () => {
    const html =
      "<pre><code>a — b — c — d</code></pre><blockquote><p>It's not just a song, it's a statement.</p></blockquote><p>Plain text.</p>";
    expect(keys(html)).toEqual([]);
    expect(proseOf(html)).not.toContain("statement");
  });

  it("reports bold-label lists and decorative headings", () => {
    const list =
      "<ul><li><strong>Speed:</strong> faster</li><li><strong>Cost:</strong> lower</li><li><p><b>Safety</b>: better</p></li></ul>";
    expect(keys(list)).toContain("humanizer_bold_labels");
    expect(keys("<ul><li><strong>Speed:</strong> faster</li></ul>")).not.toContain("humanizer_bold_labels");
    expect(keys("<h2>Strategic Negotiations And Global Partnerships</h2><h2>Building Durable Customer Relationships</h2>")).toContain(
      "humanizer_decorative_headings"
    );
    expect(keys("<h2>🚀 Launch phase</h2>")).toContain("humanizer_decorative_headings");
    expect(keys("<h2>How does the Business Model Canvas work?</h2><h2>What it costs</h2>")).not.toContain(
      "humanizer_decorative_headings"
    );
  });

  it("checks the title, excerpt, meta description and answer summary too", () => {
    expect(keys("<p>Body.</p>", { meta_description: "It's not just a CMS, it's a platform." })).toContain(
      "humanizer_not_x_but_y"
    );
  });

  it("lands in the readiness check as warnings, never errors", () => {
    const result = checkPostReadiness({
      title: "A title that is long enough to pass",
      seo_title: null,
      slug: "a-title",
      meta_description: null,
      content_html: "<p>It's not just a song, it's a statement.</p>",
      answer_summary: null,
      featured_image: null,
      featured_image_alt: null,
    });
    expect(result.warnings.map((w) => w.key)).toContain("humanizer_not_x_but_y");
    expect(result.errors.some((e) => e.key.startsWith("humanizer"))).toBe(false);
  });
});
